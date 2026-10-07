# SP3b — Density and terrain shape: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SP3a's provisional terrain with real 3D voxel terrain. A data-driven density DAG is compiled to closures, with a bit-exact reference interpreter and exact interval early-outs. The new T stage fills each column with stone, water and air: overhangs, jagged peaks and surface detail. A 3D `surfaceEstimate` searches the same field. The world's shape is measured on voxels (T1-T5) after a user-approved retune, and the machinery is proven exact (DT1, DT2).

**Architecture:**
- **Density (`gen/density`).** An `Expr` (JSON data) is validated, then compiled to four closures over scratch arrays:
  - `columnFn` at the 5 × 5 corner columns;
  - `positionFn` at the 16 × 16 positions;
  - `cornerFn` at the 5 × 49 × 5 corners;
  - `voxelFn` per voxel.

  A tree-walking reference interpreter must agree bit for bit. Per-cell interval bounds let whole 4 × 8 × 4 cells skip evaluation.
- **T stage.** It runs the density over a column with early-outs, applies the v0 water rule from each position's own top, writes aux A and aux B, and bumps `GENERATOR_VERSION` to 4.
- **Metrics and tools.**
  - DT2 compares probe with bulk and compiled with reference.
  - T1-T5 measure the voxel world.
  - U2 covers the terrain stage.
  - The bench gates T at 4 ms.
  - The slice job splits across workers.
  - The review slices show the result.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`, `node:zlib`, `--expose-gc` through `vm`), Bun 1 for the JavaScriptCore golden check, headless Chrome over CDP for the browser tools. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md`, revised by this plan's dry run (§16). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`.

**Dry run.** Every task below was executed before this plan was written, as one commit per task on a scratch branch (`dry/sp3b`).
- **How it ran.** Tasks 2-6 (density) and Task 7 (store and harness) were built as parallel chains and joined in plan order without conflicts.
- **Retune.** Task 12's retune was approved by the user after a measurement showed T1.band, T2 and T3 failing on the default world. The user also decided T3's lowland-only, full-tier gate.
- **Where the content comes from.** Code blocks and diffs are copied from the commits. Every `Expected:` line is what the replay printed: each task's tests applied over its parent fail, the commit passes, and then the whole suite passes.

Results:
- **Tests and metrics:** `npm test` passes 1,816 tests (135 files). The quick and full metric tiers are green: DT1 = 0, DT2 = 0, T1-T5 pass, and every 2D metric still passes after the retune.
- **Determinism:** 52 goldens match in V8 (`?selftest=1` in Chrome) and in Bun (JavaScriptCore).
- **Bench:** `terrain.real` p50 ≈ 1.45 ms per column, against the 4 ms gate. `density.corner` ≈ 188 ns.
- **Slice:** 6 workers make a 512-column line ≈ 3.7 × faster.
- **UI smoke test:** 77/77.

The task notes give the details.

## Global Constraints

- **Language and tooling:** TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or constructor parameter properties), `verbatimModuleSyntax`; ES2022 modules. **No new runtime or dev dependencies.**
- **Determinism rules.** They apply to `gen/**` (all of `gen/density/**`), `core/**`, `world/blocks/**` and the `DET_FILES`, plus SP3b's `metrics/sp3bGoldens.ts`:
  - only the Math allowlist (no `Math.fround`, no `**`, no `Math.pow`), with transcendentals through `core/detMath`;
  - no `Intl`, `localeCompare`, `toLocale*`, `normalize`, `TextEncoder` or `TextDecoder`;
  - no `Math.random`, `Date.now`, `performance.now` or `console`;
  - no `new Function` and no `eval`.
- **Import aliasing.** In `gen/**`, `core/noise/**`, `core/spline/**`, `metrics/**` and `world/blocks/**`, imported values are used only through top-level `const X = binding;` aliases. Types come in through `import type`, and namespace imports are not used.
  - An aliased assertion function cannot keep its assertion signature (TS2775): call `validateExpr` and throw `ExprValidationError` yourself.
- **No numeric exports from gen.** `gen/**` exports no numeric constants and no numeric data. Index arithmetic is exported as functions.
- **Layer imports** (`test/arch/rules/imports.ts`):
  - `gen` may value-import `world/blocks/**` and may only type-import `world/store/api.ts`;
  - `src/` never imports `test/**`;
  - only `engine/` spawns workers.
- **Coordinates.** colKeys are numeric only. The world window is half-open, `[−2^19, 2^19)`. North is −z and east is +x.
- **Goldens.**
  - `GENERATOR_VERSION` goes 3 → 4 in Task 8, and every golden record uses `npm run test:goldens`.
  - Task 12's retune re-records after restoring `test/goldens.json` from `main`, because the tool refuses a changed key at an unchanged version.
  - Against `main`, only these may change: `generatorVersion`, `sp1.params`, the `sp2a.*` keys the retune moves and `sp3a.region.T.*`. The only keys added are `sp3b.density.default` and `sp3b.density.ops`.
- **Governance.** Every commit that changes `test/thresholds.lock.json` also appends one line to the SP3b spec's `## Threshold log` (CI checks this per push).
- **TDD.** Write the test, run it and see it fail for the stated reason, implement, run it and see it pass. `npm run typecheck && npm test` must be green before every commit.
- **Processes.** Never kill, signal or touch processes you did not start. The browser tools start their own `vite preview` on a free port (never 5183) and their own headless Chrome with a short `--profile-dir $(mktemp -d /tmp/wi10-XXXX)`, and stop only what they started.
- **Bench.** The bench needs a quiet machine: nothing else may load the CPU while `npm run bench` or `npm run bench:record` runs.
- **Outward-facing actions.** Pushes and merges happen only with the user's go-ahead.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc`.
- **Staging.** `git add` takes explicit paths only.

## Review Focus

1. **A density noise set to remap 'uniform'.** Picking 'uniform' in the remap select of `density.noises.jag` in the ?map panel (it is 2D with double on, so nothing locked it), pasting a preset or URL that carries it, or any random valid parameter set: the schema accepted it, but `validateExpr` rejects a density noise whose remap is not 'none', so every T column threw (the Voxels mode failed with an INTERNAL error, the region harness and DT metrics could not run). A reasonable person expects the editor to refuse the value, like its other noise rules, and the world to keep generating. Fixed in Task 6: the density noises are `remapNone`, the schema refuses 'uniform' (REMAP_NOT_ALLOWED) and the panel locks the select.
   Tests: Task 6 "a density noise refuses remap 'uniform' (validateExpr rejects the expression, so no T column could be generated)", "the remap of a density noise is locked at 'none', 2D jag included: the schema refuses 'uniform'", "random valid density groups (the params harness) compile, and their driver equals the probe"
2. **Density and shape sliders at their schema ends.** `detailAmpLo` 8 above `detailAmpHi` 0, both 8, a 16-octave detail noise with lacunarity 4 and clampSigma 8, overhang λ 16 with yScale 100 or λ 8192 with yScale 0.01, jag clampSigma 1 or 8, σ 64 with jag 128, offset 320 or −64, σ and jag at −16: DT2 and the fuzz only run the defaults and random trees. A person dragging a slider to its end expects the voxels to stay exactly the density's sign (the early-outs never change a voxel, compiled equals reference) and the T to stay far from full evaluation.
   Test: Task 6 "%s: driver == probe at every voxel, probe == reference, and the bounds still decide most cells"
3. **Terrain and water at the world's vertical ends.** With offset 320, σ 64 and jag 128 the stone reaches y 319, the last row, and with offset −64 the sea goes down to the bedrock; the T tests only covered the default world and a σ 40 one. A person expects the Voxels mode to show stone up to the top row (WORLD_SURFACE_WG 320, nothing clipped or wrapped) and water down to the floor by the v0 rule, with heightmaps that match the voxels.
   Test: Task 8 "the world's vertical ends: stone up to y 319 (offset 320, σ 64, jag 128) and a sea down to the floor (offset −64, σ 64) follow the rule, with their heightmaps"
4. **surfaceEst3 when the surface sits at the top or bottom of the world.** At offset 320 the search starts clamped to 319 and most positions end there; at offset −64 it starts on the floor and must step up through floating rocks. Only hand-built fields tested the ends. T5 and later consumers (spawn, structures) expect an end or a real sign change of the terrain tap, and the true top wherever the column has a single surface.
   Test: Task 9 "%s: an end or a sign change of the terrain tap, and the top of every single-surface position"
5. **The CI region cache drifting from the dump keys.** The `actions/cache` step must cache `test/.cache/regions` only (a cached bundled worker would run stale generator code in the metrics), run before `npm run test:metrics`, have no `restore-keys`, and hash every file a dump's `srcKey` reads; a `SRC_KEY_SCOPE` entry outside the key's globs would restore dumps that can never hit and, since a cache key is never overwritten, leave CI cold for good. Nothing checked the workflow file.
   Tests: Task 7 "one actions/cache step: the dumps only, before npm run test:metrics, with no restore-keys", "its key hashes every file a dump's srcKey reads (a srcKey change is always a new key) and the lock file"

## Branch

Create `sp3b/density-terrain` from `main` before Task 1: `git switch -c sp3b/density-terrain`.

## How to apply the code blocks

- **New files:** create them with exactly the content shown.
- **Modified files:** each diff is `git diff` output. Apply it from the repository root with `git apply` (or `git apply --3way`), in task order; every diff applies on top of all earlier tasks.
- **Generated files** come from the commands shown:
  - `test/thresholds.lock.json`, `test/schema-shape.lock.json` and `test/goldens.json` are shown as the dry run's output, and yours must match;
  - `test/baselines.json`, the review PNGs and the uiSmoke screenshot are produced on your machine;
  - the retune's before/after images (Task 16) are copied from the dry run's evidence set.
- **Expected outputs** come from the dry-run replay on the reference machine (i7-12700H, 20 threads, Node 24.21, Chrome 153). Timings vary; counts must match.
- **Order inside a task:** the failing tests first (Step 1), watched failing (Step 2), then the implementation. Test-support code under `test/harness/`, `test/arch/rules/`, `test/bench/` and `test/tools/` is part of the implementation step, because the tests fail without it.
- **Dry-run notes** under each task record the rulings the dry run made, and the executor follows them. "Task N" in a note means that task's dry-run commit. Notes headed "From …" combine several rulings sections, including the user's decisions on the retune and on T3.

---

### Task 1: Governance: start SP3b; SP3c → SP3d, new SP3c

**Spec:** §12, §14 (the parts `test/arch/masterSpec.test.ts` checks)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-26-architecture-design.md`
- Modify: `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md`
- Modify: `src/core/ids.ts`
- Modify: `src/core/params/profiles.ts`
- Modify: `test/arch/sp.test.ts`
- Modify: `test/harness/sp.ts`
- Modify: `test/thresholds.lock.json`
- Modify: `test/unit/presetFile.test.ts`
- Modify: `test/unit/profiles.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/core/ids.ts`:
    - `export const CURRENT_SP: SubProjectId = 'SP3b';`
  - `test/harness/sp.ts`:
    - `export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'];`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/sp.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/sp.test.ts b/test/arch/sp.test.ts
index 927abcd..6dc4de0 100644
--- a/test/arch/sp.test.ts
+++ b/test/arch/sp.test.ts
@@ -15,24 +15,30 @@ describe('started sub-projects', () => {
     expect(CURRENT_SP).toBe(currentSpOf(STARTED_SPS));
   });
 
-  test('currentSpOf stops at the first unstarted SP (SP4 alongside SP3c)', () => {
+  test('SP3b has started and is the current SP (SP3b spec §12)', () => {
+    expect(STARTED_SPS).toEqual(['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b']);
+    expect(CURRENT_SP).toBe('SP3b');
+  });
+
+  test('currentSpOf stops at the first unstarted SP (SP4 alongside SP3c and SP3d)', () => {
     const upTo3b = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'] as const;
     expect(currentSpOf([])).toBeNull();
     expect(currentSpOf(['SP0', 'SP1'])).toBe('SP1');
     expect(currentSpOf([...upTo3b, 'SP4'])).toBe('SP3b');
-    expect(currentSpOf([...upTo3b, 'SP4', 'SP3c'])).toBe('SP4');
+    expect(currentSpOf([...upTo3b, 'SP4', 'SP3c'])).toBe('SP3c');
+    expect(currentSpOf([...upTo3b, 'SP4', 'SP3c', 'SP3d'])).toBe('SP4');
   });
 
-  test('SP_DEPS covers all 18 sub-projects and SP_ORDER follows it', () => {
+  test('SP_DEPS covers all 19 sub-projects and SP_ORDER follows it', () => {
     expect(SP_ORDER).toEqual([
-      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP4', 'SP5', 'SP6', 'SP7',
+      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP3d', 'SP4', 'SP5', 'SP6', 'SP7',
       'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
     ]);
     for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
     expect(SP_ORDER).toEqual([...SUB_PROJECTS]);
     expect([SP_DEPS.SP2a, SP_DEPS.SP2b]).toEqual([['SP1'], ['SP2a']]);
-    expect([SP_DEPS.SP3a, SP_DEPS.SP3b, SP_DEPS.SP3c, SP_DEPS.SP4, SP_DEPS.SP6]).toEqual([
-      ['SP2b'], ['SP3a'], ['SP3b'], ['SP3b'], ['SP3b', 'SP5'],
+    expect([SP_DEPS.SP3a, SP_DEPS.SP3b, SP_DEPS.SP3c, SP_DEPS.SP3d, SP_DEPS.SP4, SP_DEPS.SP6]).toEqual([
+      ['SP2b'], ['SP3a'], ['SP3b'], ['SP3c'], ['SP3b'], ['SP3c', 'SP5'],
     ]);
   });
 
@@ -47,7 +53,7 @@ describe('started sub-projects', () => {
   });
 
   test('parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started', () => {
-    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
+    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP4', 'SP3c', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
     expect(validateStarted(path)).toEqual([]);
   });
 
@@ -56,10 +62,17 @@ describe('started sub-projects', () => {
     expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
   });
 
-  test('parallel SPs: SP3c may start after SP4; SP4 needs SP3b, SP3c needs SP3b', () => {
+  test('parallel SPs: SP3c and SP3d may start after SP4; SP4 and SP3c need SP3b, SP3d needs SP3c', () => {
     const upTo3a = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'];
-    expect(validateStarted([...upTo3a, 'SP3b', 'SP4', 'SP3c'])).toEqual([]);
+    expect(validateStarted([...upTo3a, 'SP3b', 'SP4', 'SP3c', 'SP3d'])).toEqual([]);
     expect(validateStarted([...upTo3a, 'SP4'])).toEqual(['SP4 started before its dependency SP3b']);
     expect(validateStarted([...upTo3a, 'SP3c'])).toEqual(['SP3c started before its dependency SP3b']);
+    expect(validateStarted([...upTo3a, 'SP3b', 'SP3d'])).toEqual(['SP3d started before its dependency SP3c']);
+  });
+
+  test('SP6 needs SP3c (surface rules) and SP5, not SP3d', () => {
+    const upTo3b = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'];
+    expect(validateStarted([...upTo3b, 'SP4', 'SP5', 'SP6'])).toEqual(['SP6 started before its dependency SP3c']);
+    expect(validateStarted([...upTo3b, 'SP4', 'SP5', 'SP3c', 'SP6'])).toEqual([]);
   });
 });
```

Modify `test/unit/presetFile.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/presetFile.test.ts b/test/unit/presetFile.test.ts
index 4d12c14..a6d1676 100644
--- a/test/unit/presetFile.test.ts
+++ b/test/unit/presetFile.test.ts
@@ -144,7 +144,7 @@ describe('readPresetText', () => {
     ['reserved name', doc({ name: 'default' }), ['name: RESERVED_NAME — "default" is a built-in profile name']],
     ['unknown profile', doc({ profile: 'nope' }), ['profile: UNKNOWN_PROFILE — unknown profile "nope"']],
     ['newer schema version', doc({ schemaVersion: 2 }), ['schemaVersion: NEWER_SCHEMA_VERSION — schemaVersion 2 is newer than this build (1)']],
-    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3c']],
+    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3d']],
     ['a profile that is not ready, with invalid params: import issues first', doc({ profile: 'archipelago', params: { climate: { scaleMull: 4 } } }), [
       'params.climate.scaleMull: UNKNOWN_KEY — unknown key "scaleMull"',
     ]],
@@ -250,7 +250,7 @@ describe('presets tab logic', () => {
     ['not JSON', '{"format":', [/^file is not JSON: ./]],
     ['an invalid parameter', doc({ params: { rivers: { widthMin: 999 } } }), ['params.rivers.widthMin: OUT_OF_RANGE — 999 outside [1, 64]']],
     ['an unknown key', doc({ extra: true }), ['extra: UNKNOWN_KEY — unknown key "extra"']],
-    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3c']],
+    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3d']],
   ])('a refused file (%s) lists its issues and leaves the session alone', (_name, text, issues) => {
     const s = edited();
     const state = s.state;
```

Modify `test/unit/profiles.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/profiles.test.ts b/test/unit/profiles.test.ts
index 98915d9..3bcd3cc 100644
--- a/test/unit/profiles.test.ts
+++ b/test/unit/profiles.test.ts
@@ -16,16 +16,17 @@ describe('profiles', () => {
   test('ids, readiness and overlays', () => {
     expect(Object.keys(PROFILES)).toEqual([...PROFILE_IDS]);
     expect(PROFILE_IDS.map((id) => [id, PROFILES[id].readyFrom])).toEqual([
-      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3c'], ['amplified', 'SP3c'], ['floating_islands', 'SP3c'], ['cave_heavy', 'SP6'],
+      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3d'], ['amplified', 'SP3d'], ['floating_islands', 'SP3d'], ['cave_heavy', 'SP6'],
     ]);
     expect(resolveProfile('large_biomes').climate.scaleMul).toBe(4);
     expect(resolveProfile('archipelago').climate.C.wavelength).toBe(840);
     expect(resolveProfile('default')).toBe(DEFAULTS);
   });
   test('readiness follows CURRENT_SP', () => {
-    expect(CURRENT_SP).toBe('SP3a');
+    expect(CURRENT_SP).toBe('SP3b');
     expect(PROFILE_IDS.filter((id) => isProfileReady(id))).toEqual(['default', 'large_biomes']);
-    expect(isProfileReady('archipelago', 'SP3c')).toBe(true);
+    expect(isProfileReady('archipelago', 'SP3d')).toBe(true);
+    expect(isProfileReady('archipelago', 'SP3c')).toBe(false);
     expect(isProfileReady('archipelago', 'SP3b')).toBe(false);
     expect(isProfileReady('large_biomes', 'SP1')).toBe(false);
   });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/sp.test.ts test/unit/presetFile.test.ts test/unit/profiles.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× SP3b has started and is the current SP (SP3b spec §12) 4ms
× currentSpOf stops at the first unstarted SP (SP4 alongside SP3c and SP3d) 1ms
× SP_DEPS covers all 19 sub-projects and SP_ORDER follows it 1ms
× parallel SPs: SP3c and SP3d may start after SP4; SP4 and SP3c need SP3b, SP3d needs SP3c 1ms
× SP6 needs SP3c (surface rules) and SP5, not SP3d 1ms
× ids, readiness and overlays 6ms
× readiness follows CURRENT_SP 1ms
× a profile that is not ready 5ms
× a refused file (a profile that is not ready) lists its issues and leaves the session alone 3ms
FAIL  |unit| test/unit/presetFile.test.ts > readPresetText > a profile that is not ready
AssertionError: expected { ok: false, …(1) } to deeply equal { ok: false, …(1) }
FAIL  |unit| test/unit/presetFile.test.ts > presets tab logic > a refused file (a profile that is not ready) lists its issues and leaves the session alone
AssertionError: expected 'profile archipelago arrives in SP3c' to match 'profile archipelago arrives in SP3d'
FAIL  |unit| test/unit/profiles.test.ts > profiles > ids, readiness and overlays
… (13 more lines)
Test Files  3 failed (3)
Tests  9 failed | 78 passed (87)
```

- [ ] **Step 3: Implement**

Modify `CLAUDE.md` (apply with `git apply`):

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index c3ccb7e..af5368c 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -6,7 +6,7 @@ This file provides guidance to Claude Code (claude.ai/code) when working with co
 
 Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.
 
-**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3), SP3a complete (2026-10-03, GENERATOR_VERSION 3). SP3b is next.
+**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3), SP3a complete (2026-10-03, GENERATOR_VERSION 3). SP3b (density and terrain shape) in progress.
 
 ## Source of truth
 
```

Modify `docs/superpowers/specs/2026-09-26-architecture-design.md` (apply with `git apply`):

````diff
diff --git a/docs/superpowers/specs/2026-09-26-architecture-design.md b/docs/superpowers/specs/2026-09-26-architecture-design.md
index 696a821..dde3c9a 100644
--- a/docs/superpowers/specs/2026-09-26-architecture-design.md
+++ b/docs/superpowers/specs/2026-09-26-architecture-design.md
@@ -320,7 +320,7 @@ Byte offsets (amended by SP3a): `WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WOR
 ```ts
 type Seed64 = readonly [lo: number, hi: number];   // u32 words, value = hi·2^32 + lo, normalised with >>> 0 (SP1); Hash64 alike
 type RegenScope = 'live' | 'remesh' | 'decorate' | 'terrain' | 'climate';
-type SubProjectId = 'SP0'|'SP1'|'SP2a'|'SP2b'|'SP3a'|'SP3b'|'SP3c'|'SP4'|'SP5'|'SP6'|'SP7'|'SP8a'|'SP8b'|'SP8c'|'SP9'|'SP10'|'SP11'|'SP12';
+type SubProjectId = 'SP0'|'SP1'|'SP2a'|'SP2b'|'SP3a'|'SP3b'|'SP3c'|'SP3d'|'SP4'|'SP5'|'SP6'|'SP7'|'SP8a'|'SP8b'|'SP8c'|'SP9'|'SP10'|'SP11'|'SP12';
 type StageId = 'climate'|'shape'|'surfaceEst'|'biome2d'|'terrain'|'decorate'|'light'|'mesh'|'lod'|'map';
 interface ParamMeta { path: string; label: string; doc: string; unit?: string;
   kind: 'number'|'int'|'bool'|'enum'|'noise'|'spline'|'expr'|'boxTable'|'ruleTree'|'featureList'|'structureSets';
@@ -1640,7 +1640,7 @@ Each sub-project runs its own cycle:
 
 Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Sizes: S ≈ 2-4 days, M ≈ 1-2 weeks, L ≈ 2-3 weeks of focused work.
 
-**Cut lines.** Every SP names a cut line: what may slip if it overruns. A slipped item moves to a named receiving SP by amending this section, and the receiving SP adds it to its exit. Default receivers: SP0 Vercel preview check → SP4; SP2b share preview and cross-section → SP10 (both delivered in SP2b, so nothing moved); SP3c inspector pins → SP10; SP5 worlds-menu polish and palette search → SP10; SP7 vertex waves → SP11; SP8a animation frames → SP11; SP8a fence gates and trapdoors → SP12; SP8b giant trees, boulders and fossils → SP12; SP8c HRTF → SP11; SP9 jungle temple and village depth > 4 → SP12; SP11 Ultra shadows, 3D clouds and Fabulous water → SP12; SP6 underground-only carver and spaghetti-2D rarity bands → SP12; SP7 extra lava reactions → SP12; SP10 seed sweep and column-status heatmap → SP12. SP12's exit requires no open cut-line items, unless the user explicitly dropped one and the impact on its D-decision is recorded.
+**Cut lines.** Every SP names a cut line: what may slip if it overruns. A slipped item moves to a named receiving SP by amending this section, and the receiving SP adds it to its exit. Default receivers: SP0 Vercel preview check → SP4; SP2b share preview and cross-section → SP10 (both delivered in SP2b, so nothing moved); SP3b worker-split slice → SP3d; SP3d inspector pins → SP10; SP5 worlds-menu polish and palette search → SP10; SP7 vertex waves → SP11; SP8a animation frames → SP11; SP8a fence gates and trapdoors → SP12; SP8b giant trees, boulders and fossils → SP12; SP8c HRTF → SP11; SP9 jungle temple and village depth > 4 → SP12; SP11 Ultra shadows, 3D clouds and Fabulous water → SP12; SP6 underground-only carver and spaghetti-2D rarity bands → SP12; SP7 extra lava reactions → SP12; SP10 seed sweep and column-status heatmap → SP12. SP12's exit requires no open cut-line items, unless the user explicitly dropped one and the impact on its D-decision is recorded.
 
 **SP0 — Scaffold and guardrails** (S; no dependencies)
 - Repository scaffold at the root: Vite, TS strict, three `~0.186.1`, vitest projects (unit / arch / metrics-fast / metrics-quick / metrics-full / bench; see the SP0 spec).
@@ -1677,6 +1677,8 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 
 SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a spec's Decisions): the context review sized it at 9-12 weeks, three to four times an "L". SP4 and SP6 depend on SP3b; SP3c can run alongside SP4.
 
+SP3b was split on 2026-10-07 into SP3b (density and terrain shape) and a new SP3c (surface rules and terrain palette), and the former SP3c (draft presets, inspector and slice viewer) became SP3d (amended by SP3b; the SP3b spec's Decision 1 and §12). SP4 depends on SP3b and SP6 on SP3c; SP3c and SP3d can run alongside SP4.
+
 **SP3a — Block registry, voxel store and region harness** (M; SP2b). Spec: `2026-10-02-sp3a-blocks-store-harness-design.md`.
 - SAB store (two slab pools over growable buffers, CAS free stacks, refcounts, torus table, section descriptors, aux, per-scope epoch cells), on a SharedArrayBuffer or a plain ArrayBuffer; the block registry with air, stone and bedrock and `test/stateIds.lock.json`. **The u16 block-state encoding, the fluid byte and the light byte are frozen here, together with the property model, the registry API and the append-only id rule (§2.2).** Frozen means the encoding, the property kinds and the API; later SPs still add block types, SoA columns and per-state values (the block list grows in SP6, SP8a, SP8b and SP9).
 - A provisional T stage that fills columns from the 2D world (bedrock, stone, water up to surfaceWaterLevel, air) through the store API.
@@ -1685,23 +1687,31 @@ SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a
 - **Exit:** DT1 on the provisional T; M1 (registry parts); slab fuzz extended to promotion, sharing and the torus (4 threads × 100k ops, both pools, growth; 0 double allocations, 0 lost slots, exact refcounts); `?selftest=1` with the sp3a region hashes.
 - **Cut line:** none named by the SP3a spec.
 
-**SP3b — Density, surfaceEstimate, terrain and surface rules** (L; SP3a)
+**SP3b — Density and terrain shape** (L; SP3a). Spec: `2026-10-07-sp3b-density-terrain-design.md`.
 - Density: Expr, closure compiler with stage placement, reference interpreter, interval bounds with early-outs, probe; the default terrain expression without caves, with the `islands` DAG term (−1e6 by default).
-- surfaceEstimate by bisection (replaces the 2D relief on the map).
-- Surface-rule data tree, compiler and whole-column scan (bedrock, deepslate, palettes, snowline, cliffs).
-- The real T stage with the general v0 water fill so oceans, rivers and lakes are visible early (air at y ≤ surfaceWaterLevel above surfaceEst − 12 becomes water sources; everything else stays dry; SP3a's provisional T is its no-overhang case); it writes aux B and bumps the `terrain` stage and `GENERATOR_VERSION`; the terrain palette appends to the registry and the lock.
-- The CI `actions/cache` step for `test/.cache/regions` before `npm run test:metrics` (moved from SP3a, whose provisional T regenerates a 32 × 32 region in about a second).
-- **Deliverable:** voxel terrain from the density DAG with surface rules and water, in the harness slices and the Voxels mode.
-- **Exit:** DT1 on the real T, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 on voxel terrain (true top from WORLD_SURFACE_WG), T4, T5; B4 (voxel parts: snow in desert, coast-band beach/stony shore/snowy beach share, land-biome tops below sea level outside rivers and lakes); S1 (buried surface blocks and y mod 16 parts), S2, S3 (snowline part); P1 bench: T without caves ≤ 4 ms p50.
-- Received from SP3a (its spec §10): T3's redefinition before it gates and T1's lowland band; the cost of the biome height filter on the real `surfaceEst` (column stage, map and share preview); the Expr ops' exact semantics and interval rules; an `sp3b.registry` golden over the appended states; SP2a minors 5 and 6 (handed to SP3 by SP2b); the ocean-floor σ/jag stripe, lake-rim islets and the shoreline zoom fringe.
-- **Cut line:** set by the SP3b spec.
-
-**SP3c — Draft presets, inspector and slice viewer** (M; SP3b)
-- Draft `floating_islands`, `amplified` and `archipelago` presets (terms, splines and params; surface-rule branch for islands), so per-preset goldens and SP11's LOD island scan have a target; their profiles become selectable (`readyFrom: 'SP3c'`).
-- In-app slice viewer and density node inspector.
+- `surfaceEst3`: the 3D surfaceEstimate by bisection on the `terrain` tap, used by T5 and later consumers; the map, the biome picker and the column stage keep the 2D `surfaceEst` (amended by SP3b).
+- The real T stage (air, stone, bedrock and water) with the general v0 water fill so oceans, rivers and lakes are visible early (air with top − 12 < y ≤ surfaceWaterLevel, `top` being the position's highest stone, becomes water sources; everything else stays dry; SP3a's provisional T is its no-overhang case); it writes aux B and bumps the `terrain` stage and `GENERATOR_VERSION`.
+- The slice job split across workers; the CI `actions/cache` step for `test/.cache/regions` before `npm run test:metrics` (moved from SP3a, whose provisional T regenerates a 32 × 32 region in about a second).
+- **Deliverable:** 3D voxel terrain from the density DAG with water, in the harness slices and the Voxels mode.
+- **Exit:** as the SP3b spec §11: DT1 on the real T, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 (stratified over same-family borders), T4 and T5 on voxel terrain (true top from WORLD_SURFACE_WG); every 2D metric still passes; P1 bench: T without caves ≤ 4 ms p50.
+- Received from SP3a (its spec §10): T3's redefinition before it gates and T1's lowland band; the cost of the biome height filter on the real `surfaceEst` (settled by keeping the 2D estimate there); the Expr ops' exact semantics and interval rules; SP2a minor 5 (handed to SP3 by SP2b; minor 6 moves to SP3c); the ocean-floor σ/jag stripe.
+- **Cut line:** the worker-split slice (→ SP3d).
+
+**SP3c — Surface rules and terrain palette** (M; SP3b)
+- Surface-rule data tree, compiler and whole-column scan (§3.11: bedrock, deepslate, palettes, snowline, cliffs); bedrock dithered over −63 … −60.
+- The terrain palette appends to the registry and the lock, with an `sp3c.registry` golden over the appended states.
+- B4's voxel parts (snow in desert, coast-band beach/stony shore/snowy beach share, land-biome tops below sea level outside rivers and lakes), a voxel river-water check (SP2a minor 6) and S1 (buried surface blocks and y mod 16 parts), S2, S3 (snowline part).
+- **Deliverable:** set by the SP3c spec.
+- Received from SP3b (its spec §13): the `sp3b.registry` golden named by SP3a, renamed `sp3c.registry`; SP2a minor 6; lake-rim islets and the shoreline zoom fringe.
+- **Exit:** set by the SP3c spec.
+- **Cut line:** set by the SP3c spec.
+
+**SP3d — Draft presets, inspector and slice viewer** (M; SP3c)
+- Draft `floating_islands`, `amplified` and `archipelago` presets (terms, splines and params; surface-rule branch for islands), so per-preset goldens and SP11's LOD island scan have a target; their profiles become selectable (`readyFrom: 'SP3d'`).
+- In-app slice viewer and density node inspector; `density.defs` as an editable JSON leaf with mutes, and SP3b's `SLIDE`, floor and ceiling terms as data (the SP3b spec §13).
 - **Deliverable:** live terrain cross-sections and the node inspector.
 - Received from SP3a (its spec §10): archipelago (≈ 60 % ocean) against B1's 45 % ocean-family cap (decide per-preset gating); amplified's offset multiplier and the 320 range.
-- **Exit:** set by the SP3c spec.
+- **Exit:** set by the SP3d spec.
 - **Cut line:** inspector pins (→ SP10).
 
 **SP4 — Streaming renderer and light** (L; SP3b)
@@ -1722,7 +1732,7 @@ SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a
 - **Exit:** L3 (including shafts); E1-E7 (including the fault-injected flush and the unload/reload race); G2 (edit part: edit → visible p95 ≤ 50 ms); relight ≤ 3 ms p95; physics and palette unit tests.
 - **Cut line:** worlds-menu polish (rename, duplicate, thumbnails) and palette search (→ SP10).
 
-**SP6 — Caves, carvers and cave biomes** (L; SP3b, SP5 for in-game review)
+**SP6 — Caves, carvers and cave biomes** (L; SP3c, SP5 for in-game review)
 - Cave family terms in the default DAG (cheese / layer / pillars, spaghetti 2D and 3D with rarity, noodle, entrances, roughness, cheese roof term, lake roof); worm and canyon carvers (detMath, LRU); 3D quart cave-biome picker (lush, dripstone, **abyss**) with cave floor and ceiling surface rules; the abyss surface-palette blocks (decided in this SP's spec); debug cave-type tag channel, cave-type tint in the slice viewer, map cave slice and cave-biome layers; `cave_heavy` preset; cave culling.
 - **Deliverable:** explorable caves with visible surface entrances and ravines.
 - **Exit:** C1-C6, B3, R3; re-asserted with caves: L2, S1 (grass at sky 0), DT1, DT2 (probe == bulk); P1: T ≤ 10 ms p50; DAG closure overhead vs a hand-inlined default expression measured and recorded (codegen kill criterion, §7).
@@ -1775,7 +1785,7 @@ SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a
 
 **SP12 — Extreme presets and final tuning** (M; SP11)
 - Finalise amplified, archipelago, floating_islands, large_biomes and cave_heavy; goldens per preset; profile gallery in docs; baselines refreshed; README; received cut-line items.
-- A "continental" profile (user request, 2026-09-29): large continents with islands in open ocean, via a much longer C wavelength (about 8000) and deep-ocean-dominated low C; it may move to SP3b or SP3c by amending this section. With it (user request, 2026-09-30): small islands or archipelagos at extremely low C, with no rivers on islets.
+- A "continental" profile (user request, 2026-09-29): large continents with islands in open ocean, via a much longer C wavelength (about 8000) and deep-ocean-dominated low C; it may move to SP3b or SP3d by amending this section. With it (user request, 2026-09-30): small islands or archipelagos at extremely low C, with no rivers on islets.
 - The volcanic cone (reserved by SP2a, its spec §10): sparse cells in hot high ground add a cone and crater to `offset` and assign the volcano biome by mask; lava in the crater uses SP7's fluids. It may move to an earlier SP by amending this section.
 - **Exit:** Z1-Z4; cave_heavy C1 10-22 %; every other active metric green per preset; DT1 goldens stable; no open cut-line items (unless explicitly dropped by the user with the D-decision impact recorded).
 
@@ -1783,7 +1793,7 @@ SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a
 
 Critical path: SP0 → SP1 → SP2a → SP2b → SP3a → SP3b → SP4 → SP5 → SP6 → SP7 → SP8b → SP9 → SP10 → SP11 → SP12.
 
-In parallel: SP8a's texture parts after SP4 (alongside SP5-SP7; its shape collision/raycast parts after SP5); SP8c after SP7 (alongside SP8a/SP8b); the persistence codec and `.wiworld` format after SP3a; SP3c alongside SP4; the LOD and cloud parts of SP11 after SP4.
+In parallel: SP8a's texture parts after SP4 (alongside SP5-SP7; its shape collision/raycast parts after SP5); SP8c after SP7 (alongside SP8a/SP8b); the persistence codec and `.wiworld` format after SP3a; SP3c and SP3d alongside SP4; the LOD and cloud parts of SP11 after SP4.
 
 Visible value in every SP: a map in SP2a (edited live in SP2b), voxel slices in SP3a, terrain in SP3b, flight in SP4, editing in SP5, caves in SP6, water in SP7. The riskiest integrations sit early: the SAB store and the u16 state format in SP3a, BatchedMesh in SP4 week 1, and fluid byte → light → mesh → edit → diff → IDB → reload in SP3a-SP5.
 
````

Modify `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
index ec2ba51..0146f97 100644
--- a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
+++ b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
@@ -519,3 +519,5 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
 ## Threshold log
 
 (One line per commit that changes `test/thresholds.lock.json`.)
+
+- Task 1: `STARTED_SPS` gains `SP3b` (SP3b split into SP3b and a new SP3c; the old SP3c becomes SP3d); no threshold rows change.
```

Modify `src/core/ids.ts` (apply with `git apply`):

```diff
diff --git a/src/core/ids.ts b/src/core/ids.ts
index e11990b..918a326 100644
--- a/src/core/ids.ts
+++ b/src/core/ids.ts
@@ -1,20 +1,23 @@
-/** Sub-project ids of master spec §10 (SP2 split into SP2a and SP2b on 2026-09-28; SP3 into SP3a, SP3b and SP3c on 2026-10-02). */
+/**
+ * Sub-project ids of master spec §10 (SP2 split into SP2a and SP2b on 2026-09-28; SP3 into SP3a, SP3b and SP3c on
+ * 2026-10-02; SP3b into SP3b and a new SP3c on 2026-10-07, the old SP3c becoming SP3d).
+ */
 export type SubProjectId =
-  | 'SP0' | 'SP1' | 'SP2a' | 'SP2b' | 'SP3a' | 'SP3b' | 'SP3c' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
-  | 'SP8a' | 'SP8b' | 'SP8c' | 'SP9' | 'SP10' | 'SP11' | 'SP12';
+  | 'SP0' | 'SP1' | 'SP2a' | 'SP2b' | 'SP3a' | 'SP3b' | 'SP3c' | 'SP3d' | 'SP4' | 'SP5' | 'SP6'
+  | 'SP7' | 'SP8a' | 'SP8b' | 'SP8c' | 'SP9' | 'SP10' | 'SP11' | 'SP12';
 
 /** Every sub-project in master §10 order. */
 export const SUB_PROJECTS: readonly SubProjectId[] = [
-  'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP4', 'SP5', 'SP6', 'SP7',
+  'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP3d', 'SP4', 'SP5', 'SP6', 'SP7',
   'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
 ];
 
 /**
  * The sub-project this build belongs to; hides profiles whose readyFrom comes later (SP2a spec §4.4).
  * It is the last SP of the longest prefix of SUB_PROJECTS whose members have all started (SP3a spec §9),
- * so an SP running alongside an earlier unstarted one (SP4 before SP3c) does not advance it.
+ * so an SP running alongside an earlier unstarted one (SP4 before SP3c or SP3d) does not advance it.
  */
-export const CURRENT_SP: SubProjectId = 'SP3a';
+export const CURRENT_SP: SubProjectId = 'SP3b';
 
 /** Every metric id of master spec §6.4 (E1-E6 expanded). */
 export type MetricId =
```

Modify `src/core/params/profiles.ts` (apply with `git apply`):

```diff
diff --git a/src/core/params/profiles.ts b/src/core/params/profiles.ts
index 30d3506..43f121e 100644
--- a/src/core/params/profiles.ts
+++ b/src/core/params/profiles.ts
@@ -17,9 +17,9 @@ export const PROFILE_IDS: readonly ProfileId[] = ['default', 'large_biomes', 'ar
 export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
   default: { overlay: {}, readyFrom: 'SP1' },
   large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2a' },
-  archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3c' },
-  amplified: { overlay: {}, readyFrom: 'SP3c' },
-  floating_islands: { overlay: {}, readyFrom: 'SP3c' },
+  archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3d' },
+  amplified: { overlay: {}, readyFrom: 'SP3d' },
+  floating_islands: { overlay: {}, readyFrom: 'SP3d' },
   cave_heavy: { overlay: {}, readyFrom: 'SP6' },
 };
 
```

Modify `test/harness/sp.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/sp.ts b/test/harness/sp.ts
index 7897de9..87ca7ff 100644
--- a/test/harness/sp.ts
+++ b/test/harness/sp.ts
@@ -9,9 +9,10 @@ export const SP_DEPS: Readonly<Record<SubProjectId, readonly SubProjectId[]>> =
   SP3a: ['SP2b'],
   SP3b: ['SP3a'],
   SP3c: ['SP3b'],
+  SP3d: ['SP3c'],
   SP4: ['SP3b'],
   SP5: ['SP4'],
-  SP6: ['SP3b', 'SP5'],
+  SP6: ['SP3c', 'SP5'],
   SP7: ['SP6', 'SP5'],
   SP8a: ['SP4'],
   SP8b: ['SP7', 'SP8a'],
@@ -28,7 +29,7 @@ export const SP_ORDER = Object.keys(SP_DEPS) as SubProjectId[];
  * Append-only list of sub-projects whose first commit has landed.
  * Each SP appends its id in its first commit. Part of the locked governance state.
  */
-export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'];
+export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'];
 
 export function spIndex(sp: SubProjectId): number {
   return SP_ORDER.indexOf(sp);
@@ -37,7 +38,7 @@ export function spIndex(sp: SubProjectId): number {
 /**
  * The SP3a spec §9 rule for `CURRENT_SP`: the last SP of the longest prefix of `order` whose members
  * have all started (null when the first has not). An SP running alongside an earlier unstarted one
- * (SP4 before SP3c) therefore does not advance it.
+ * (SP4 before SP3c or SP3d) therefore does not advance it.
  */
 export function currentSpOf(started: readonly SubProjectId[], order: readonly SubProjectId[] = SP_ORDER): SubProjectId | null {
   let last: SubProjectId | null = null;
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:accept-thresholds`

The command writes `test/thresholds.lock.json`; the dry run's result:

Modify `test/thresholds.lock.json` (apply with `git apply`):

```diff
diff --git a/test/thresholds.lock.json b/test/thresholds.lock.json
index 21b67dd..aceca3f 100644
--- a/test/thresholds.lock.json
+++ b/test/thresholds.lock.json
@@ -1,12 +1,13 @@
 {
-  "sha256": "bd21cc78065fc7dd58240d261fc72635a7443a7a187c9bfeb8cb9fe75140fd86",
+  "sha256": "b78d7a082ab396925346c6700bf7152eb24baed96d19dc82df9c405b28bb14f4",
   "canonical": {
     "startedSps": [
       "SP0",
       "SP1",
       "SP2a",
       "SP2b",
-      "SP3a"
+      "SP3a",
+      "SP3b"
     ],
     "thresholds": {
       "B1": {
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/sp.test.ts test/unit/presetFile.test.ts test/unit/profiles.test.ts`

Expected: PASS (exit 0)

```
Test Files  3 passed (3)
Tests  87 passed (87)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  121 passed | 2 skipped (123)
Tests  1577 passed | 3 skipped (1580)
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md src/core/ids.ts src/core/params/profiles.ts test/arch/sp.test.ts test/harness/sp.ts test/thresholds.lock.json test/unit/presetFile.test.ts test/unit/profiles.test.ts
git commit -F - <<'EOF'
chore(governance): start SP3b; SP3b split into SP3b/SP3c, old SP3c becomes SP3d

- SubProjectId, SUB_PROJECTS and SP_DEPS insert a new 'SP3c' (surface
  rules and terrain palette) after 'SP3b' and rename the old 'SP3c' to
  'SP3d' (SP3c <- SP3b, SP3d <- SP3c, SP4 <- SP3b, SP6 <- SP3c, SP5),
  SP3b spec §12.
- STARTED_SPS gains 'SP3b'; CURRENT_SP = 'SP3b'.
- archipelago, amplified and floating_islands move to readyFrom 'SP3d'.
- Master §2.5 SubProjectId line and §10: SP3b narrowed to density and
  terrain shape, the new SP3c block, SP3d (old SP3c), SP6 header, cut-line
  receivers, parallelism and SP12 continental line (SP3b spec §14).
- Thresholds lock accepted (startedSps only); Threshold-log line in the
  SP3b spec; CLAUDE.md status.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `cc760da` on `dry/sp3a`; 10 files changed, 79 insertions(+), 48 deletions(-)):

Commit Task 1 on `dry/sp3b` (worktree `P/dry`, from main `f7f9a11`). RED (commit's test files over the parent): 9 failed in 3 files (sp.test ×5, profiles ×2, presetFile ×2), plus 3 `tsc -p tsconfig.test.json` errors ('SP3d' unknown). GREEN: typecheck clean; `npm test` 121 files passed, 2 skipped; 1577 tests passed, 3 skipped; `GOVERNANCE_BASE=main` governance test passes.

- Ruling: Task 1 makes every §10 change tied to the id change, not only the headers masterSpec.test.ts parses: the SP3b block is narrowed (scope, deliverable, exit summarised from SP3b §11, received items, cut line "the worker-split slice (→ SP3d)"), a new SP3c block holds the surface-rule items moved out of the old SP3b block (§3.11 tree, palette + `sp3c.registry`, bedrock dither, B4 voxel parts, voxel river-water check, S1-S3), the old SP3c block becomes SP3d (`readyFrom: 'SP3d'`, + `density.defs`/`SLIDE` as data from SP3b §13), SP6 header "(L; SP3c, SP5 for in-game review)", cut-line receivers ("SP3b worker-split slice → SP3d; SP3d inspector pins → SP10"), parallelism line, SP12 continental line, and a dated split paragraph after SP3a's — a header rename alone would leave old-SP3c content under the new SP3c id — cost if wrong: Task 15 has less to do; none otherwise.
- Ruling: left for Task 15 (not id-related): §2.5 `ColumnView.auxB()`, §3.6, §3.7 (line ≈590 "SP3b introduces the density-tap search below and bumps the `surfaceEst` stage version", now false), §6.4, §1 module layout, SP1 spec N5 note, SP3a spec §3.5 note, README status — cost if wrong: the master's §3.7 contradicts SP3b §5 until Task 15.
- Ruling: the new SP3c block's Deliverable, Exit and Cut line say "set by the SP3c spec" (SP3a Task 1 precedent: name no item §14 does not give); its metric scope (B4 voxel parts, S1-S3) is a bullet, not an exit — cost if wrong: wording only.
- Ruling: parallelism line reads "SP3c and SP3d alongside SP4", and SP12's continental line "it may move to SP3b or SP3d" (only the old-SP3c reference replaced) — cost if wrong: wording only.
- Ruling: `currentSpOf` example: `[...upTo3b, 'SP4', 'SP3c']` now yields 'SP3c' (SP3d unstarted) and a new case with SP3d yields 'SP4'; the "SP8c before SP8b" path gains 'SP3c' after 'SP4' because SP6 now needs SP3c; new tests pin `STARTED_SPS`/`CURRENT_SP`, "SP3d needs SP3c" and "SP6 needs SP3c" — cost if wrong: none.
- Ruling: Threshold-log line "Task 1: `STARTED_SPS` gains `SP3b` (SP3b split into SP3b and a new SP3c; the old SP3c becomes SP3d); no threshold rows change." (mirrors SP3a's Task 1 line) — cost if wrong: wording only.
- Ruling: `test/unit/lock.test.ts` untouched (its fixture's startedSps/activeFrom are self-contained, unlike SP3a's Task 1) — cost if wrong: none.
- Spec defect: §14 "the parallelism line "alongside SP4" … becomes SP3d" → the new SP3c (← SP3b only) can also run alongside SP4: "SP3c and SP3d alongside SP4".
- Spec defect: §14 omits master §10 SP2a's "a 2D `surfaceEst = offset` (SP3b replaces it)", false after Decision 2 → add to Task 15's §3.7 amendment: "(SP3b keeps it for the map, biomes and column stage; `surfaceEst3` is voxel-only)".

---

### Task 2: gen/density: Expr, validation, op semantics and interval rules

**Spec:** §1

**Files:**
- Create: `src/gen/density/expr.ts`
- Create: `src/gen/density/nodes.ts`
- Create: `test/unit/densityExpr.test.ts`
- Create: `test/unit/densityNodes.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/gen/density/expr.ts`:
    - `export interface ConstExpr { readonly op: 'const'; readonly v: number }`
    - `export interface YExpr { readonly op: 'y' }`
    - `export interface ColExpr { readonly op: 'col'; readonly field: SampleField }`
    - `export interface Noise2Expr { readonly op: 'noise2'; readonly id: string }`
    - `export interface NoiseExpr { readonly op: 'noise'; readonly id: string }`
    - `export type BinaryOp = 'add' | 'mul' | 'min' | 'max';`
    - `export interface BinaryExpr { readonly op: BinaryOp; readonly a: Expr; readonly b: Expr }`
    - `export type UnaryOp = 'neg' | 'abs' | 'square';`
    - `export interface UnaryExpr { readonly op: UnaryOp; readonly x: Expr }`
    - `export interface ClampExpr { readonly op: 'clamp'; readonly x: Expr; readonly lo: number; readonly hi: number }`
    - `export type SlideKnot = readonly [y: number, v: number];`
    - `export interface SlideExpr { readonly op: 'slide'; readonly x: Expr; readonly knots: readonly SlideKnot[] }`
    - `export interface InterpolatedExpr { readonly op: 'interpolated'; readonly x: Expr }`
    - `export interface RangeChoiceExpr`
    - `export interface TapExpr { readonly op: 'tap'; readonly name: string; readonly x: Expr }`
    - `export interface RefExpr { readonly op: 'ref'; readonly name: string }`
    - `export type Expr =`
    - `export type ExprOp = Expr['op'];`
    - `export interface DensityExpr`
    - `export const EXPR_OPS: readonly ExprOp[] = [`
    - `export const EXPR_CHILD_KEYS: { readonly [K in ExprOp]: readonly string[] } =`
    - `export function exprChildren(e: Expr): Expr[]`
    - `export interface DensityNoiseInfo`
    - `export type DensityNoiseLookup = (id: string) => DensityNoiseInfo | undefined;`
    - `export type ExprErrorCode =`
    - `export interface ExprIssue`
    - `export class ExprValidationError extends Error`
    - `export function validateExpr(value: unknown, noises: DensityNoiseLookup): ExprIssue[]`
    - `export function assertValidExpr(value: unknown, noises: DensityNoiseLookup): asserts value is DensityExpr`
    - `export function exprHash(e: Expr, memo: WeakMap<Expr, string> = new WeakMap()): string`
  - `src/gen/density/nodes.ts`:
    - `export function valAdd(a: number, b: number): number { return a + b; }`
    - `export function valMul(a: number, b: number): number { return a * b; }`
    - `export function valMin(a: number, b: number): number { return b < a ? b : a; }`
    - `export function valMax(a: number, b: number): number { return b > a ? b : a; }`
    - `export function valNeg(x: number): number { return -x; }`
    - `export function valAbs(x: number): number { return Math.abs(x); }`
    - `export function valSquare(x: number): number { return x * x; }`
    - `export function valClamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }`
    - `export function slideAt(knots: readonly SlideKnot[], y: number): number`
    - `export function valSlide(x: number, knots: readonly SlideKnot[], y: number): number { return x * slideAt(knots, y); }`
    - `export function inRange(x: number, lo: number, hi: number): boolean { return lo <= x && x < hi; }`
    - `export type DelegatedExpr = ColExpr | Noise2Expr | NoiseExpr | InterpolatedExpr | RefExpr;`
    - `export interface NodeEnv`
    - `export function evalNode(e: Expr, env: NodeEnv): number`
    - `export function ivSet(lo: number, hi: number, out: Float64Array, k: number): void`
    - `export function ivNoise(clampSigma: number, out: Float64Array, k: number): void`
    - `export function ivAdd(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void`
    - `export function ivMul(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void`
    - `export function ivMin(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void`
    - `export function ivMax(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void`
    - `export function ivNeg(x0: number, x1: number, out: Float64Array, k: number): void`
    - `export function ivAbs(x0: number, x1: number, out: Float64Array, k: number): void`
    - `export function ivSquare(x0: number, x1: number, out: Float64Array, k: number): void`
    - `export function ivClamp(x0: number, x1: number, lo: number, hi: number, out: Float64Array, k: number): void`
    - `export function ivSlideFactor(knots: readonly SlideKnot[], y0: number, y1: number, out: Float64Array, k: number): void`
    - `export function ivSlide(x0: number, x1: number, knots: readonly SlideKnot[], y0: number, y1: number, out: Float64Array, k: number): void`
    - `export function rangeChoiceCase(x0: number, x1: number, lo: number, hi: number): 'inside' | 'outside' | 'both'`
    - `export function ivHull(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void`
    - `export function ivWiden(lo: number, hi: number, out: Float64Array, k: number): void`
    - `export type DensityClass = 'column' | 'cell' | 'voxel';`
    - `export function ownClass(op: ExprOp, inside: boolean): DensityClass`
    - `export function joinClass(a: DensityClass, b: DensityClass): DensityClass`
    - `export function exprClass(e: Expr, inside: boolean, defs: Readonly<Record<string, Expr>>, memo: WeakMap<Expr, boolean> = new WeakMap()): DensityClass`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/densityExpr.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  assertValidExpr, EXPR_CHILD_KEYS, EXPR_OPS, exprChildren, exprHash, ExprValidationError, validateExpr,
  type DensityExpr, type DensityNoiseInfo, type Expr,
} from '../../src/gen/density/expr';

const NOISES = new Map<string, DensityNoiseInfo>([
  ['jag', { dims: 2, remap: 'none', clampSigma: 3 }],
  ['overhang', { dims: 3, remap: 'none', clampSigma: 3 }],
  ['flat', { dims: 2, remap: 'uniform', clampSigma: 3 }],
]);
const LOOKUP = (id: string): DensityNoiseInfo | undefined => NOISES.get(id);
const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const doc = (root: unknown, defs: Record<string, unknown> = {}): unknown => ({ root, defs });
const issues = (value: unknown): string[] => validateExpr(value, LOOKUP).map((i) => `${i.path}: ${i.code}`);

/** Uses every op once (and `ref` into a def). */
const EVERY_OP: DensityExpr = {
  root: {
    op: 'max',
    a: {
      op: 'add',
      a: { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: { op: 'ref', name: 'shape' } } },
      b: { op: 'mul', a: { op: 'noise', id: 'overhang' }, b: { op: 'clamp', x: { op: 'col', field: 'E' }, lo: 0, hi: 1 } },
    },
    b: {
      op: 'rangeChoice', x: { op: 'noise2', id: 'jag' }, lo: -1, hi: 1,
      inside: { op: 'min', a: { op: 'abs', x: C(-2) }, b: { op: 'square', x: C(3) } },
      outside: { op: 'neg', x: C(1e6) },
    },
  },
  defs: {
    shape: { op: 'add', a: { op: 'col', field: 'offset' }, b: { op: 'slide', x: { op: 'neg', x: Y }, knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] } },
  },
};

describe('Expr structure', () => {
  test('EXPR_OPS lists the 17 ops of SP3b spec §1.1 and EXPR_CHILD_KEYS their child slots in evaluation order', () => {
    expect([...EXPR_OPS].sort()).toEqual(['abs', 'add', 'clamp', 'col', 'const', 'interpolated', 'max', 'min', 'mul', 'neg',
      'noise', 'noise2', 'rangeChoice', 'ref', 'slide', 'square', 'tap', 'y']);
    expect(EXPR_CHILD_KEYS.add).toEqual(['a', 'b']);
    expect(EXPR_CHILD_KEYS.rangeChoice).toEqual(['x', 'inside', 'outside']);
    expect(EXPR_CHILD_KEYS.slide).toEqual(['x']);
    for (const op of ['const', 'y', 'col', 'noise2', 'noise', 'ref'] as const) expect(EXPR_CHILD_KEYS[op]).toEqual([]);
  });

  test('exprChildren returns the children in evaluation order', () => {
    const a = C(1), b = C(2), x = C(0);
    expect(exprChildren({ op: 'min', a, b })).toEqual([a, b]);
    const rc: Expr = { op: 'rangeChoice', x, lo: 0, hi: 1, inside: a, outside: b };
    const kids = exprChildren(rc);
    expect(kids[0]).toBe(x);
    expect(kids[1]).toBe(a);
    expect(kids[2]).toBe(b);
    expect(exprChildren({ op: 'ref', name: 'q' })).toEqual([]);
  });
});

describe('validateExpr (SP3b spec §1.1)', () => {
  test('an expression that uses every op validates', () => {
    expect(validateExpr(EVERY_OP, LOOKUP)).toEqual([]);
    expect(() => assertValidExpr(EVERY_OP, LOOKUP)).not.toThrow();
  });

  test('the top level is {root, defs}', () => {
    expect(issues(null)).toEqual([': NOT_OBJECT']);
    expect(issues({ root: C(1) })).toEqual(['defs: NOT_OBJECT']);
    expect(issues({ root: C(1), defs: [] })).toEqual(['defs: NOT_OBJECT']);
    expect(issues({ root: C(1), defs: {}, extra: 1 })).toEqual(['extra: UNKNOWN_KEY']);
    expect(issues({ defs: {} })).toEqual(['root: NOT_OBJECT']);
  });

  test('unknown ops and keys are reported at their real node paths', () => {
    const bad = { op: 'add', a: C(1), b: { op: 'max', a: C(0), b: { op: 'neg', x: { op: 'sin', x: Y } } } };
    expect(issues(doc(bad))).toEqual(['root.b.b.x: UNKNOWN_OP']);
    expect(issues(doc(C(1), { terrain: { op: 'neg', x: { op: 'const', v: 1, w: 2 } } }))).toEqual(['defs.terrain.x.w: UNKNOWN_KEY']);
    expect(issues(doc({ op: 'add', a: C(1) }))).toEqual(['root.b: NOT_OBJECT']);
    expect(issues(doc({ op: 'neg', x: 3 }))).toEqual(['root.x: NOT_OBJECT']);
  });

  test('non-finite or non-numeric constants are rejected', () => {
    expect(issues(doc(C(NaN)))).toEqual(['root.v: NOT_FINITE']);
    expect(issues(doc(C(Infinity)))).toEqual(['root.v: NOT_FINITE']);
    expect(issues(doc({ op: 'const', v: '1' }))).toEqual(['root.v: NOT_FINITE']);
    expect(issues(doc({ op: 'clamp', x: Y, lo: NaN, hi: 1 }))).toEqual(['root.lo: NOT_FINITE']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 0, hi: Infinity, inside: C(1), outside: C(0) }))).toEqual(['root.hi: NOT_FINITE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [1, NaN]] }))).toEqual(['root.knots[1]: NOT_FINITE']);
    expect(validateExpr(doc(C(-0)), LOOKUP)).toEqual([]);
  });

  test('col reads only the continuous ColumnSample fields', () => {
    expect(issues(doc({ op: 'col', field: 'offset' }))).toEqual([]);
    expect(issues(doc({ op: 'col', field: 'offsetX' }))).toEqual(['root.field: BAD_FIELD']);
    expect(issues(doc({ op: 'col', field: 'surfaceWaterLevel' }))).toEqual(['root.field: BAD_FIELD']);
    expect(issues(doc({ op: 'col', field: 'toString' }))).toEqual(['root.field: BAD_FIELD']);
  });

  test('noise ids must be known density noises of the right dimension with remap none', () => {
    expect(issues(doc({ op: 'noise2', id: 'jag' }))).toEqual([]);
    expect(issues(doc({ op: 'noise', id: 'overhang' }))).toEqual([]);
    expect(issues(doc({ op: 'noise', id: 'nope' }))).toEqual(['root.id: UNKNOWN_NOISE']);
    expect(issues(doc({ op: 'noise', id: 3 }))).toEqual(['root.id: UNKNOWN_NOISE']);
    expect(issues(doc({ op: 'noise', id: 'jag' }))).toEqual(['root.id: NOISE_DIMS']);
    expect(issues(doc({ op: 'noise2', id: 'overhang' }))).toEqual(['root.id: NOISE_DIMS']);
    expect(issues(doc({ op: 'noise2', id: 'flat' }))).toEqual(['root.id: NOISE_REMAP']);
  });

  test('ref names must exist and must not form a cycle', () => {
    expect(issues(doc({ op: 'ref', name: 'missing' }))).toEqual(['root.name: UNKNOWN_REF']);
    expect(issues(doc({ op: 'ref', name: 'toString' }))).toEqual(['root.name: UNKNOWN_REF']);
    expect(issues(doc({ op: 'ref', name: 'a' }, { a: { op: 'neg', x: { op: 'ref', name: 'a' } } }))).toEqual(['defs.a.x: REF_CYCLE']);
    expect(issues(doc({ op: 'ref', name: 'a' }, { a: { op: 'ref', name: 'b' }, b: { op: 'abs', x: { op: 'ref', name: 'a' } } })))
      .toEqual(['defs.b.x: REF_CYCLE']);
    expect(issues(doc({ op: 'add', a: { op: 'ref', name: 'a' }, b: { op: 'ref', name: 'a' } }, { a: C(1) }))).toEqual([]);
    const cyc = validateExpr(doc(C(0), { a: { op: 'ref', name: 'b' }, b: { op: 'ref', name: 'a' } }), LOOKUP);
    expect(cyc.map((i) => i.message)).toEqual(['ref cycle defs.a → defs.b → defs.a']);
  });

  test('an interpolated inside another is rejected, also through a ref', () => {
    const inner = { op: 'interpolated', x: Y };
    expect(issues(doc({ op: 'interpolated', x: { op: 'neg', x: inner } }))).toEqual(['root.x.x: NESTED_INTERPOLATED']);
    expect(issues(doc({ op: 'interpolated', x: { op: 'ref', name: 'd' } }, { d: { op: 'abs', x: inner } }))).toEqual(['defs.d.x: NESTED_INTERPOLATED']);
    // The same def used inside and outside an interpolated is reported once.
    const both = doc({ op: 'add', a: { op: 'ref', name: 'd' }, b: { op: 'interpolated', x: { op: 'ref', name: 'd' } } }, { d: inner });
    expect(issues(both)).toEqual(['defs.d: NESTED_INTERPOLATED']);
    // Siblings are fine.
    expect(issues(doc({ op: 'add', a: inner, b: inner }))).toEqual([]);
  });

  test('clamp needs lo ≤ hi, rangeChoice lo < hi, slide ≥ 2 strictly increasing knots', () => {
    expect(issues(doc({ op: 'clamp', x: Y, lo: 1, hi: 1 }))).toEqual([]);
    expect(issues(doc({ op: 'clamp', x: Y, lo: 2, hi: 1 }))).toEqual(['root: CLAMP_ORDER']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 1, hi: 1, inside: C(1), outside: C(0) }))).toEqual(['root: RANGE_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1]] }))).toEqual(['root.knots: KNOTS_SHAPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: 'x' }))).toEqual(['root.knots: KNOTS_SHAPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1], [1, 2, 3]] }))).toEqual(['root.knots[1]: KNOTS_SHAPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1], [0, 2]] }))).toEqual(['root.knots[1]: KNOTS_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1], [-1, 2]] }))).toEqual(['root.knots[1]: KNOTS_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0.25, 1], [0.5, 2]] }))).toEqual([]);
  });

  test('tap names are non-empty strings and unique', () => {
    expect(issues(doc({ op: 'tap', name: '', x: Y }))).toEqual(['root.name: BAD_NAME']);
    expect(issues(doc({ op: 'add', a: { op: 'tap', name: 't', x: Y }, b: { op: 'tap', name: 't', x: C(0) } }))).toEqual(['root.b.name: DUPLICATE_TAP']);
    // A tap inside a def referenced twice is one tap.
    expect(issues(doc({ op: 'add', a: { op: 'ref', name: 'd' }, b: { op: 'ref', name: 'd' } }, { d: { op: 'tap', name: 't', x: Y } }))).toEqual([]);
  });

  test('issues are collected in pre-order, root before defs; assertValidExpr throws them', () => {
    const value = doc({ op: 'add', a: C(NaN), b: { op: 'col', field: 'Q' } }, { d: { op: 'nope' } });
    expect(issues(value)).toEqual(['root.a.v: NOT_FINITE', 'root.b.field: BAD_FIELD', 'defs.d: UNKNOWN_OP']);
    let err: unknown;
    try { assertValidExpr(value, LOOKUP); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ExprValidationError);
    expect((err as ExprValidationError).issues.length).toBe(3);
    expect((err as Error).message).toContain('root.a.v: NOT_FINITE');
  });
});

describe('exprHash (structural)', () => {
  test('equal structure gives an equal 16-hex hash regardless of object identity and key order', () => {
    const a: Expr = { op: 'clamp', x: { op: 'add', a: Y, b: C(1) }, lo: 0, hi: 2 };
    const b = JSON.parse('{"hi":2,"lo":0,"x":{"b":{"v":1,"op":"const"},"a":{"op":"y"},"op":"add"},"op":"clamp"}') as Expr;
    expect(exprHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(exprHash(b)).toBe(exprHash(a));
  });

  test('every field distinguishes, including −0, operand order and names', () => {
    const k = (v: number): [number, number] => [v, v];
    const variants: Expr[] = [
      C(0), C(-0), C(1), C(1e-300), Y,
      { op: 'col', field: 'offset' }, { op: 'col', field: 'E' },
      { op: 'noise2', id: 'jag' }, { op: 'noise', id: 'jag' }, { op: 'noise', id: 'overhang' },
      { op: 'add', a: Y, b: C(1) }, { op: 'add', a: C(1), b: Y }, { op: 'mul', a: Y, b: C(1) },
      { op: 'min', a: Y, b: C(1) }, { op: 'max', a: Y, b: C(1) },
      { op: 'neg', x: Y }, { op: 'abs', x: Y }, { op: 'square', x: Y }, { op: 'interpolated', x: Y },
      { op: 'clamp', x: Y, lo: 0, hi: 1 }, { op: 'clamp', x: Y, lo: 0, hi: 2 }, { op: 'clamp', x: Y, lo: -0, hi: 1 },
      { op: 'slide', x: Y, knots: [k(0), [1, 1]] }, { op: 'slide', x: Y, knots: [k(0), [1, 2]] }, { op: 'slide', x: Y, knots: [k(0), [1, 1], [2, 1]] },
      { op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: C(1), outside: C(0) },
      { op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: C(0), outside: C(1) },
      { op: 'rangeChoice', x: Y, lo: 0, hi: 2, inside: C(1), outside: C(0) },
      { op: 'tap', name: 'a', x: Y }, { op: 'tap', name: 'b', x: Y },
      { op: 'ref', name: 'a' }, { op: 'ref', name: 'b' },
    ];
    const hashes = new Set(variants.map((v) => exprHash(v)));
    expect(hashes.size).toBe(variants.length);
  });

  test('the memo records every sub-tree and gives the same result', () => {
    const memo = new WeakMap<Expr, string>();
    const h = exprHash(EVERY_OP.root, memo);
    expect(h).toBe(exprHash(EVERY_OP.root));
    const root = EVERY_OP.root as Expr & { a: Expr };
    expect(memo.get(root)).toBe(h);
    expect(memo.get(root.a)).toBe(exprHash(root.a));
  });
});
```

Create `test/unit/densityNodes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef } from '../../src/core/noise/types';
import type { ColExpr, Expr, InterpolatedExpr, Noise2Expr, NoiseExpr, RefExpr, SlideKnot } from '../../src/gen/density/expr';
import {
  evalNode, exprClass, inRange, ivAbs, ivAdd, ivClamp, ivHull, ivMax, ivMin, ivMul, ivNeg, ivNoise, ivSet, ivSlide,
  ivSlideFactor, ivSquare, ivWiden, joinClass, ownClass, rangeChoiceCase, slideAt, valAbs, valAdd, valClamp, valMax,
  valMin, valMul, valNeg, valSlide, valSquare, type NodeEnv,
} from '../../src/gen/density/nodes';
import { nextDown, nextUp, testFloat, testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const COL_E: Expr = { op: 'col', field: 'E' };
const N2: Expr = { op: 'noise2', id: 'jag' };
const N3: Expr = { op: 'noise', id: 'overhang' };
const READS: Record<string, number> = { 'col:E': 0.25, 'col:offset': 70, 'noise2:jag': 0.5, 'noise:overhang': -1.5 };
type ReadExpr = ColExpr | Noise2Expr | NoiseExpr | InterpolatedExpr | RefExpr;

/** A test walker over evalNode: children recurse, reads come from READS, and every child visit is logged. */
function evaluate(e: Expr, y: number, log: Expr[] = []): number {
  const env: NodeEnv = {
    y,
    child: (c) => { log.push(c); return evaluate(c, y, log); },
    read: (r: ReadExpr) => {
      const key = r.op === 'col' ? `col:${r.field}` : r.op === 'noise2' || r.op === 'noise' ? `${r.op}:${r.id}` : r.op;
      const v = READS[key];
      if (v === undefined) throw new Error(`no read for ${key}`);
      return v;
    },
  };
  return evalNode(e, env);
}

const OUT = new Float64Array(4);
const iv = (f: (out: Float64Array, k: number) => void): [number, number] => { f(OUT, 2); return [OUT[2]!, OUT[3]!]; };
const inside = (v: number, [lo, hi]: [number, number]): boolean => lo <= v && v <= hi;

/** A random endpoint: small integers, zeros, or a log-uniform magnitude in [1e-6, 1e9] with a random sign. */
function endpoint(next: () => number): number {
  const r = next() % 8;
  if (r === 0) return 0;
  if (r === 1) return -0;
  if (r === 2) return (next() % 21) - 10;
  const mag = Math.exp(Math.log(1e-6) + (Math.log(1e9) - Math.log(1e-6)) * testFloat(next));
  return next() % 2 === 0 ? mag : -mag;
}
function randIv(next: () => number): [number, number] {
  const a = endpoint(next), b = endpoint(next);
  return a <= b ? [a, b] : [b, a];
}
/** Points of [lo, hi]: both ends, their neighbours inside, zero if inside, and uniform draws. */
function pointsIn(next: () => number, [lo, hi]: [number, number]): number[] {
  const out = [lo, hi];
  if (lo < hi) out.push(nextUp(lo), nextDown(hi));
  if (lo <= 0 && hi >= 0) out.push(0, -0);
  for (let i = 0; i < 6; i++) {
    const t = testFloat(next);
    const v = lo + (hi - lo) * t;
    if (v >= lo && v <= hi) out.push(v);
  }
  return out;
}

/** Interval soundness of a binary op: every value of points inside the operand intervals lies in the result. */
function soundBinary(seed: number, val: (a: number, b: number) => number, rule: (a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number) => void): void {
  const next = testRng(seed);
  for (let n = 0; n < 2000; n++) {
    const A = randIv(next), B = randIv(next);
    const r = iv((o, k) => rule(A[0], A[1], B[0], B[1], o, k));
    for (const a of pointsIn(next, A)) for (const b of pointsIn(next, B)) {
      const v = val(a, b);
      if (!inside(v, r)) throw new Error(`${v} = op(${a}, ${b}) outside [${r}] for [${A}] × [${B}]`);
    }
  }
}
function soundUnary(seed: number, val: (x: number) => number, rule: (x0: number, x1: number, out: Float64Array, k: number) => void): void {
  const next = testRng(seed);
  for (let n = 0; n < 4000; n++) {
    const X = randIv(next);
    const r = iv((o, k) => rule(X[0], X[1], o, k));
    for (const x of pointsIn(next, X)) {
      const v = val(x);
      if (!inside(v, r)) throw new Error(`${v} = op(${x}) outside [${r}] for [${X}]`);
    }
  }
}

describe('leaves', () => {
  test('const: value v, interval [v, v], class COLUMN', () => {
    expect(Object.is(evaluate(C(-0), 0), -0)).toBe(true);
    expect(evaluate(C(2.5), 7)).toBe(2.5);
    expect(iv((o, k) => ivSet(2.5, 2.5, o, k))).toEqual([2.5, 2.5]);
    expect(exprClass(C(1), false, {})).toBe('column');
    expect(exprClass(C(1), true, {})).toBe('column');
  });

  test("y: the point's y, interval the cell's [y0, y1], never COLUMN", () => {
    expect(evaluate(Y, -64)).toBe(-64);
    expect(evaluate(Y, 13)).toBe(13);
    expect(iv((o, k) => ivSet(-64, -56, o, k))).toEqual([-64, -56]);
    expect(exprClass(Y, false, {})).toBe('voxel');
    expect(exprClass(Y, true, {})).toBe('cell');
  });

  test('col, noise2, noise are reads of the caller; col and noise2 are COLUMN, noise is y-dependent', () => {
    expect(evaluate(COL_E, 0)).toBe(0.25);
    expect(evaluate(N2, 0)).toBe(0.5);
    expect(evaluate(N3, 0)).toBe(-1.5);
    expect(exprClass(COL_E, false, {})).toBe('column');
    expect(exprClass(N2, true, {})).toBe('column');
    expect(exprClass(N3, false, {})).toBe('voxel');
    expect(exprClass(N3, true, {})).toBe('cell');
  });

  test('noise interval [−clampSigma, clampSigma] holds for real NormalNoise samples', () => {
    for (const clampSigma of [0.5, 1.5, 3]) {
      const def = completeNoiseDef({ wavelength: 8, octaves: 2, clampSigma });
      const nz = new NormalNoise([1, 2], 'density.test', def);
      const r = iv((o, k) => ivNoise(clampSigma, o, k));
      expect(r).toEqual([-clampSigma, clampSigma]);
      let hitEdge = false;
      for (let i = 0; i < 4000; i++) {
        const x = (i * 7) % 113 - 56, y = (i * 13) % 97 - 48, z = (i * 3) % 89;
        const a = nz.z2(x, z), b = nz.z3(x, y, z);
        expect(inside(a, r) && inside(b, r)).toBe(true);
        if (Math.abs(b) === clampSigma) hitEdge = true;
      }
      if (clampSigma === 0.5) expect(hitEdge).toBe(true);
    }
  });
});

describe('binary ops: a then b, IEEE in the written order', () => {
  test('evaluation order is a, then b', () => {
    for (const op of ['add', 'mul', 'min', 'max'] as const) {
      const a = C(1), b = C(2);
      const log: Expr[] = [];
      evaluate({ op, a, b }, 0, log);
      expect(log[0]).toBe(a);
      expect(log[1]).toBe(b);
      expect(log.length).toBe(2);
    }
  });

  test('add: a + b, −0 rules, endpoint interval', () => {
    expect(evaluate({ op: 'add', a: C(0.1), b: C(0.2) }, 0)).toBe(0.1 + 0.2);
    expect(Object.is(valAdd(-0, -0), -0)).toBe(true);
    expect(Object.is(valAdd(-0, 0), 0)).toBe(true);
    expect(iv((o, k) => ivAdd(-1, 2, 3, 5, o, k))).toEqual([2, 7]);
    soundBinary(201, valAdd, ivAdd);
    expect(exprClass({ op: 'add', a: COL_E, b: N2 }, false, {})).toBe('column');
    expect(exprClass({ op: 'add', a: COL_E, b: Y }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'add', a: Y, b: COL_E }, true, {})).toBe('cell');
  });

  test('mul: a · b, signed zeros, the min and max of the four endpoint products', () => {
    expect(evaluate({ op: 'mul', a: C(3), b: C(-0.5) }, 0)).toBe(-1.5);
    expect(Object.is(valMul(-0, 5), -0)).toBe(true);
    expect(Object.is(valMul(-0, -5), 0)).toBe(true);
    expect(iv((o, k) => ivMul(-2, 3, -5, 4, o, k))).toEqual([-15, 12]);
    expect(iv((o, k) => ivMul(1, 2, 3, 4, o, k))).toEqual([3, 8]);
    soundBinary(202, valMul, ivMul);
    expect(exprClass({ op: 'mul', a: N3, b: C(2) }, true, {})).toBe('cell');
  });

  test('min: b < a ? b : a, ties (also +0 against −0) return a, endpoint-wise interval', () => {
    expect(valMin(3, 2)).toBe(2);
    expect(valMin(2, 3)).toBe(2);
    expect(Object.is(valMin(0, -0), 0)).toBe(true);
    expect(Object.is(valMin(-0, 0), -0)).toBe(true);
    expect(Object.is(evaluate({ op: 'min', a: C(-0), b: C(0) }, 0), -0)).toBe(true);
    expect(iv((o, k) => ivMin(-1, 5, 2, 3, o, k))).toEqual([-1, 3]);
    soundBinary(203, valMin, ivMin);
    expect(exprClass({ op: 'min', a: C(1), b: COL_E }, false, {})).toBe('column');
  });

  test('max: b > a ? b : a, ties (also +0 against −0) return a, endpoint-wise interval', () => {
    expect(valMax(3, 2)).toBe(3);
    expect(valMax(2, 3)).toBe(3);
    expect(Object.is(valMax(0, -0), 0)).toBe(true);
    expect(Object.is(valMax(-0, 0), -0)).toBe(true);
    expect(Object.is(evaluate({ op: 'max', a: C(0), b: C(-0) }, 0), 0)).toBe(true);
    expect(iv((o, k) => ivMax(-1, 5, 2, 3, o, k))).toEqual([2, 5]);
    soundBinary(204, valMax, ivMax);
    expect(exprClass({ op: 'max', a: C(1), b: N3 }, false, {})).toBe('voxel');
  });
});

describe('unary ops', () => {
  test('neg: −x (neg 0 is −0), interval [−x1, −x0]', () => {
    expect(evaluate({ op: 'neg', x: C(2) }, 0)).toBe(-2);
    expect(Object.is(valNeg(0), -0)).toBe(true);
    expect(iv((o, k) => ivNeg(-1, 4, o, k))).toEqual([-4, 1]);
    soundUnary(301, valNeg, ivNeg);
    expect(exprClass({ op: 'neg', x: Y }, true, {})).toBe('cell');
  });

  test('abs: |x| (|−0| is +0), exact image interval', () => {
    expect(evaluate({ op: 'abs', x: C(-2) }, 0)).toBe(2);
    expect(Object.is(valAbs(-0), 0)).toBe(true);
    expect(iv((o, k) => ivAbs(-3, 2, o, k))).toEqual([0, 3]);
    expect(iv((o, k) => ivAbs(1, 4, o, k))).toEqual([1, 4]);
    expect(iv((o, k) => ivAbs(-4, -1, o, k))).toEqual([1, 4]);
    soundUnary(302, valAbs, ivAbs);
    expect(exprClass({ op: 'abs', x: N2 }, false, {})).toBe('column');
  });

  test('square: x · x (square −0 is +0), exact image interval', () => {
    expect(evaluate({ op: 'square', x: C(-3) }, 0)).toBe(9);
    expect(Object.is(valSquare(-0), 0)).toBe(true);
    expect(iv((o, k) => ivSquare(-3, 2, o, k))).toEqual([0, 9]);
    expect(iv((o, k) => ivSquare(2, 3, o, k))).toEqual([4, 9]);
    expect(iv((o, k) => ivSquare(-3, -2, o, k))).toEqual([4, 9]);
    soundUnary(303, valSquare, ivSquare);
    expect(exprClass({ op: 'square', x: N3 }, false, {})).toBe('voxel');
  });

  test('clamp: x < lo ? lo : x > hi ? hi : x (−0 stays −0), monotone interval', () => {
    const cl = (x: number): Expr => ({ op: 'clamp', x: C(x), lo: 0, hi: 1 });
    expect(evaluate(cl(-2), 0)).toBe(0);
    expect(evaluate(cl(5), 0)).toBe(1);
    expect(evaluate(cl(0.5), 0)).toBe(0.5);
    expect(Object.is(valClamp(-0, 0, 1), -0)).toBe(true);
    expect(Object.is(valClamp(0, -1, -0), 0)).toBe(true);
    expect(iv((o, k) => ivClamp(-5, 0.5, 0, 1, o, k))).toEqual([0, 0.5]);
    expect(iv((o, k) => ivClamp(3, 7, 0, 1, o, k))).toEqual([1, 1]);
    const next = testRng(304);
    for (let n = 0; n < 500; n++) {
      const [lo, hi] = randIv(next);
      soundUnaryOnce(next, (x) => valClamp(x, lo, hi), (x0, x1, o, k) => ivClamp(x0, x1, lo, hi, o, k));
    }
    expect(exprClass({ op: 'clamp', x: COL_E, lo: 0, hi: 1 }, false, {})).toBe('column');
  });
});

function soundUnaryOnce(next: () => number, val: (x: number) => number, rule: (x0: number, x1: number, out: Float64Array, k: number) => void): void {
  for (let n = 0; n < 8; n++) {
    const X = randIv(next);
    const r = iv((o, k) => rule(X[0], X[1], o, k));
    for (const x of pointsIn(next, X)) if (!inside(val(x), r)) throw new Error(`${val(x)} = op(${x}) outside [${r}]`);
  }
}

describe('slide', () => {
  const SLIDE: SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

  test('segments are half-open, constant beyond the end knots (also at the last knot)', () => {
    expect(slideAt(SLIDE, -100)).toBe(0);
    expect(slideAt(SLIDE, -64)).toBe(0);
    expect(slideAt(SLIDE, -52)).toBe(0.5);
    expect(slideAt(SLIDE, -40)).toBe(1);
    expect(slideAt(SLIDE, 239.5)).toBe(1);
    expect(slideAt(SLIDE, 280)).toBe(0.5);
    expect(slideAt(SLIDE, 320)).toBe(0);
    expect(slideAt(SLIDE, 400)).toBe(0);
    // At an interior knot the right segment starts: its value is exactly v_k.
    const K: SlideKnot[] = [[0, 0], [3, 1], [10, -0.3]];
    expect(slideAt(K, 3)).toBe(1);
    expect(slideAt(K, nextDown(3))).toBeLessThan(1);
  });

  test('s(y) = v_k + (y − y_k) · ((v_{k+1} − v_k) / (y_{k+1} − y_k)) bit for bit', () => {
    const next = testRng(401);
    let otherOrderDiffers = 0;
    for (let n = 0; n < 20000; n++) {
      const y0 = -100 + 200 * testFloat(next), y1 = y0 + 1e-3 + 50 * testFloat(next);
      const v0 = -3 + 6 * testFloat(next), v1 = -3 + 6 * testFloat(next);
      const y = y0 + (y1 - y0) * testFloat(next);
      if (!(y >= y0 && y < y1)) continue;
      const pinned = v0 + (y - y0) * ((v1 - v0) / (y1 - y0));
      expect(Object.is(slideAt([[y0, v0], [y1, v1]], y), pinned)).toBe(true);
      if (pinned !== v0 + ((y - y0) * (v1 - v0)) / (y1 - y0)) otherOrderDiffers++;
    }
    expect(otherOrderDiffers).toBeGreaterThan(0);
  });

  test('value x · s(y), class never COLUMN', () => {
    expect(evaluate({ op: 'slide', x: C(4), knots: SLIDE }, -52)).toBe(2);
    expect(valSlide(4, SLIDE, -52)).toBe(2);
    expect(Object.is(valSlide(-0, SLIDE, 0), -0)).toBe(true);
    const log: Expr[] = [];
    const x = C(3);
    evaluate({ op: 'slide', x, knots: SLIDE }, 0, log);
    expect(log).toEqual([x]);
    expect(exprClass({ op: 'slide', x: C(1), knots: SLIDE }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'slide', x: COL_E, knots: SLIDE }, true, {})).toBe('cell');
  });

  test('interval: s at y0 and y1, and both the left formula and v_k at interior knots', () => {
    expect(iv((o, k) => ivSlideFactor(SLIDE, -64, -56, o, k))).toEqual([0, 1 / 3]);
    expect(iv((o, k) => ivSlideFactor(SLIDE, -48, 256, o, k))).toEqual([2 / 3, 1]);
    expect(iv((o, k) => ivSlideFactor(SLIDE, -100, 400, o, k))).toEqual([0, 1]);
    expect(iv((o, k) => ivSlide(-2, 3, SLIDE, -48, 256, o, k))).toEqual([-2, 3]);
    const next = testRng(402);
    for (let n = 0; n < 3000; n++) {
      const count = 2 + (next() % 4);
      const knots: SlideKnot[] = [];
      let y = -50 + 20 * testFloat(next);
      for (let i = 0; i < count; i++) {
        knots.push([y, next() % 5 === 0 ? endpoint(next) : -2 + 4 * testFloat(next)]);
        y += 1e-3 + 30 * testFloat(next);
      }
      let a = -70 + 140 * testFloat(next), b = -70 + 140 * testFloat(next);
      if (next() % 3 === 0) a = knots[next() % count]![0];
      if (next() % 3 === 0) b = knots[next() % count]![0];
      const [y0, y1] = a <= b ? [a, b] : [b, a];
      const s = iv((o, k) => ivSlideFactor(knots, y0, y1, o, k));
      const ys = [y0, y1, nextUp(y0), nextDown(y1), y0 + (y1 - y0) * testFloat(next)];
      for (let i = 0; i < count; i++) {
        const [yk, vk] = knots[i]!;
        if (yk > y0 && yk <= y1) {
          ys.push(yk, nextDown(yk));
          expect(inside(vk, s)).toBe(true);
          if (i > 0) {
            const [ya, va] = knots[i - 1]!;
            expect(inside(va + (yk - ya) * ((vk - va) / (yk - ya)), s)).toBe(true);
          }
        }
      }
      for (const q of ys) if (q >= y0 && q <= y1) expect(inside(slideAt(knots, q), s)).toBe(true);
      const X = randIv(next);
      const r = iv((o, k) => ivSlide(X[0], X[1], knots, y0, y1, o, k));
      for (const x of pointsIn(next, X)) for (const q of ys) if (q >= y0 && q <= y1) {
        if (!inside(valSlide(x, knots, q), r)) throw new Error(`slide(${x}, ${q}) outside [${r}]`);
      }
    }
  });
});

describe('structure', () => {
  test('interpolated: a read of the caller; class VOXEL; nothing interpolated inside it', () => {
    expect(() => evaluate({ op: 'interpolated', x: Y }, 0)).toThrow(/no read for interpolated/);
    expect(exprClass({ op: 'interpolated', x: C(1) }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'interpolated', x: Y }, false, {})).toBe('voxel');
    expect(() => exprClass({ op: 'interpolated', x: Y }, true, {})).toThrow(/interpolated/);
  });

  test('rangeChoice: x first, then only the chosen branch; lo ≤ x < hi chooses inside', () => {
    const x = C(0.5), a = C(10), b = C(20);
    const log: Expr[] = [];
    expect(evaluate({ op: 'rangeChoice', x, lo: 0, hi: 1, inside: a, outside: b }, 0, log)).toBe(10);
    expect(log).toEqual([x, a]);
    expect(log[1]).toBe(a);
    const log2: Expr[] = [];
    expect(evaluate({ op: 'rangeChoice', x: C(1), lo: 0, hi: 1, inside: a, outside: b }, 0, log2)).toBe(20);
    expect(log2[1]).toBe(b);
    expect(log2.length).toBe(2);
    expect(inRange(0, 0, 1)).toBe(true);
    expect(inRange(-0, 0, 1)).toBe(true);
    expect(inRange(1, 0, 1)).toBe(false);
    expect(inRange(nextDown(0), 0, 1)).toBe(false);
  });

  test('rangeChoice interval: inside if x ⊆ [lo, hi), outside if disjoint, hull otherwise', () => {
    expect(rangeChoiceCase(0.2, 0.5, 0, 1)).toBe('inside');
    expect(rangeChoiceCase(0, nextDown(1), 0, 1)).toBe('inside');
    expect(rangeChoiceCase(1, 2, 0, 1)).toBe('outside');
    expect(rangeChoiceCase(-1, nextDown(0), 0, 1)).toBe('outside');
    expect(rangeChoiceCase(-1, 0, 0, 1)).toBe('both');
    expect(rangeChoiceCase(0.5, 1, 0, 1)).toBe('both');
    expect(rangeChoiceCase(-5, 5, 0, 1)).toBe('both');
    expect(iv((o, k) => ivHull(-1, 2, 5, 6, o, k))).toEqual([-1, 6]);
    expect(iv((o, k) => ivHull(3, 4, -2, 3.5, o, k))).toEqual([-2, 4]);
    const next = testRng(501);
    for (let n = 0; n < 4000; n++) {
      const X = randIv(next), R = randIv(next);
      if (!(R[0] < R[1])) continue;
      const c = rangeChoiceCase(X[0], X[1], R[0], R[1]);
      for (const x of pointsIn(next, X)) {
        const inR = inRange(x, R[0], R[1]);
        if (c === 'inside') expect(inR).toBe(true);
        if (c === 'outside') expect(inR).toBe(false);
      }
    }
    expect(exprClass({ op: 'rangeChoice', x: COL_E, lo: 0, hi: 1, inside: C(1), outside: N3 }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'rangeChoice', x: COL_E, lo: 0, hi: 1, inside: C(1), outside: N2 }, true, {})).toBe('column');
  });

  test('tap and ref pass the child through (value, interval, class)', () => {
    const x = C(7);
    const log: Expr[] = [];
    expect(evaluate({ op: 'tap', name: 't', x }, 0, log)).toBe(7);
    expect(log).toEqual([x]);
    expect(() => evaluate({ op: 'ref', name: 'd' }, 0)).toThrow(/no read for ref/);
    const defs = { d: { op: 'add', a: Y, b: C(1) } as Expr, e: COL_E, f: { op: 'ref', name: 'e' } as Expr };
    expect(exprClass({ op: 'ref', name: 'd' }, false, defs)).toBe('voxel');
    expect(exprClass({ op: 'ref', name: 'd' }, true, defs)).toBe('cell');
    expect(exprClass({ op: 'tap', name: 't', x: { op: 'ref', name: 'f' } }, false, defs)).toBe('column');
    expect(() => exprClass({ op: 'ref', name: 'zz' }, false, defs)).toThrow(/zz/);
  });
});

describe('class rule (SP3b spec §2.1)', () => {
  test('ownClass and joinClass: COLUMN < CELL < VOXEL', () => {
    expect(ownClass('const', false)).toBe('column');
    expect(ownClass('noise2', true)).toBe('column');
    expect(ownClass('add', false)).toBe('column');
    for (const op of ['y', 'slide', 'noise'] as const) {
      expect(ownClass(op, true)).toBe('cell');
      expect(ownClass(op, false)).toBe('voxel');
    }
    expect(ownClass('interpolated', false)).toBe('voxel');
    expect(joinClass('column', 'cell')).toBe('cell');
    expect(joinClass('voxel', 'cell')).toBe('voxel');
    expect(joinClass('column', 'column')).toBe('column');
  });

  test('the memo is shared across calls and DAG-shaped trees stay linear', () => {
    let e: Expr = { op: 'add', a: COL_E, b: N2 };
    for (let i = 0; i < 60; i++) e = { op: 'add', a: e, b: e };
    const memo = new WeakMap<Expr, boolean>();
    expect(exprClass(e, false, {}, memo)).toBe('column');
    expect(memo.get(e)).toBe(true);
    let f: Expr = Y;
    for (let i = 0; i < 60; i++) f = { op: 'max', a: f, b: f };
    expect(exprClass(f, true, {}, memo)).toBe('cell');
  });
});

describe('widening (SP3b spec §1.2)', () => {
  test('w = 1e-9 · (1 + max(|lo|, |hi|)) on both ends', () => {
    const w = 1e-9 * (1 + 1e9);
    expect(iv((o, k) => ivWiden(-1e9, 0, o, k))).toEqual([-1e9 - w, w]);
    expect(iv((o, k) => ivWiden(2, 3, o, k))).toEqual([2 - 4e-9, 3 + 4e-9]);
    const next = testRng(601);
    for (let n = 0; n < 5000; n++) {
      const [lo, hi] = randIv(next);
      const [a, b] = iv((o, k) => ivWiden(lo, hi, o, k));
      expect(a < lo && b > hi).toBe(true);
      // A lerp of two values inside [lo, hi] stays inside the widened interval.
      const p = lo + (hi - lo) * testFloat(next), q = lo + (hi - lo) * testFloat(next);
      const t = testFloat(next);
      const l = p + t * (q - p);
      expect(l >= a && l <= b).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/densityExpr.test.ts test/unit/densityNodes.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/densityExpr.test.ts [ test/unit/densityExpr.test.ts ]
Error: Cannot find module '../../src/gen/density/expr' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityExpr.test.ts
FAIL  |unit| test/unit/densityNodes.test.ts [ test/unit/densityNodes.test.ts ]
Error: Cannot find module '../../src/gen/density/nodes' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityNodes.test.ts
Test Files  2 failed (2)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `src/gen/density/expr.ts`:

```ts
/**
 * The density expression model (SP3b spec §1.1): `Expr` is plain JSON, tagged objects with an `op` field; named
 * sub-expressions live in `defs` next to the root and are used through `ref`. This module holds the node types, the
 * child slots in evaluation order, `validateExpr` (run before ref resolution and CSE, so its paths name real nodes:
 * `root.a.b.x`, `defs.terrain.x`) and the structural hash the compiler's CSE keys on (§2.1).
 * Per-op semantics (values, intervals, classes) are in nodes.ts.
 */
import { createFnv64, hex64, utf8Bytes } from '../../core/hash';
import { SAMPLE_FIELDS, type SampleField } from '../column/columnStage';

const FNV = createFnv64;
const HEX = hex64;
const UTF8 = utf8Bytes;
const FIELDS = SAMPLE_FIELDS;

export interface ConstExpr { readonly op: 'const'; readonly v: number }
export interface YExpr { readonly op: 'y' }
/** A continuous ColumnSample field (never a level field: `col` is limited to finite fields until SP6). */
export interface ColExpr { readonly op: 'col'; readonly field: SampleField }
/** z2(x, z) of the density noise `id` (schema leaf `density.noises.<id>`, dims 2). */
export interface Noise2Expr { readonly op: 'noise2'; readonly id: string }
/** z3(x, y, z) of the density noise `id` (dims 3). */
export interface NoiseExpr { readonly op: 'noise'; readonly id: string }
export type BinaryOp = 'add' | 'mul' | 'min' | 'max';
export interface BinaryExpr { readonly op: BinaryOp; readonly a: Expr; readonly b: Expr }
export type UnaryOp = 'neg' | 'abs' | 'square';
export interface UnaryExpr { readonly op: UnaryOp; readonly x: Expr }
export interface ClampExpr { readonly op: 'clamp'; readonly x: Expr; readonly lo: number; readonly hi: number }
export type SlideKnot = readonly [y: number, v: number];
export interface SlideExpr { readonly op: 'slide'; readonly x: Expr; readonly knots: readonly SlideKnot[] }
export interface InterpolatedExpr { readonly op: 'interpolated'; readonly x: Expr }
export interface RangeChoiceExpr {
  readonly op: 'rangeChoice'; readonly x: Expr; readonly lo: number; readonly hi: number; readonly inside: Expr; readonly outside: Expr;
}
export interface TapExpr { readonly op: 'tap'; readonly name: string; readonly x: Expr }
export interface RefExpr { readonly op: 'ref'; readonly name: string }

export type Expr =
  | ConstExpr | YExpr | ColExpr | Noise2Expr | NoiseExpr | BinaryExpr | UnaryExpr | ClampExpr | SlideExpr
  | InterpolatedExpr | RangeChoiceExpr | TapExpr | RefExpr;
export type ExprOp = Expr['op'];

/** A whole density expression: the root and its named sub-expressions. */
export interface DensityExpr {
  readonly root: Expr;
  readonly defs: Readonly<Record<string, Expr>>;
}

/** Every op, in SP3b spec §1.1's table order. */
export const EXPR_OPS: readonly ExprOp[] = [
  'const', 'y', 'col', 'noise2', 'noise', 'add', 'mul', 'min', 'max', 'neg', 'abs', 'square', 'clamp', 'slide',
  'interpolated', 'rangeChoice', 'tap', 'ref',
];

/** The child slots of each op, in evaluation order (a then b; x then the chosen rangeChoice branch). */
export const EXPR_CHILD_KEYS: { readonly [K in ExprOp]: readonly string[] } = {
  const: [], y: [], col: [], noise2: [], noise: [], ref: [],
  add: ['a', 'b'], mul: ['a', 'b'], min: ['a', 'b'], max: ['a', 'b'],
  neg: ['x'], abs: ['x'], square: ['x'], clamp: ['x'], slide: ['x'], interpolated: ['x'], tap: ['x'],
  rangeChoice: ['x', 'inside', 'outside'],
};

/** The non-child keys of each op (besides `op`). */
const SCALAR_KEYS: { readonly [K in ExprOp]: readonly string[] } = {
  const: ['v'], y: [], col: ['field'], noise2: ['id'], noise: ['id'], ref: ['name'],
  add: [], mul: [], min: [], max: [], neg: [], abs: [], square: [], interpolated: [],
  clamp: ['lo', 'hi'], slide: ['knots'], tap: ['name'], rangeChoice: ['lo', 'hi'],
};

/** The children of a node in evaluation order. */
export function exprChildren(e: Expr): Expr[] {
  const node = e as unknown as Record<string, Expr>;
  return EXPR_CHILD_KEYS[e.op].map((k) => node[k]!);
}

/** What the validator (and later the interval rules) need to know about a density noise. */
export interface DensityNoiseInfo {
  readonly dims: 2 | 3;
  readonly remap: 'none' | 'uniform';
  readonly clampSigma: number;
}
/** The density noises an expression may use, by id (Task 6 builds it from the schema's `density.noises`). */
export type DensityNoiseLookup = (id: string) => DensityNoiseInfo | undefined;

export type ExprErrorCode =
  | 'NOT_OBJECT' | 'UNKNOWN_OP' | 'UNKNOWN_KEY' | 'NOT_FINITE' | 'BAD_FIELD' | 'UNKNOWN_NOISE' | 'NOISE_DIMS'
  | 'NOISE_REMAP' | 'BAD_NAME' | 'DUPLICATE_TAP' | 'UNKNOWN_REF' | 'REF_CYCLE' | 'NESTED_INTERPOLATED'
  | 'CLAMP_ORDER' | 'RANGE_ORDER' | 'KNOTS_SHAPE' | 'KNOTS_ORDER';

export interface ExprIssue {
  /** The node path: `root`, `root.a.b.x`, `defs.terrain.x`, `root.knots[2]`; '' is the top-level object. */
  readonly path: string;
  readonly code: ExprErrorCode;
  readonly message: string;
}

export class ExprValidationError extends Error {
  readonly issues: readonly ExprIssue[];
  constructor(issues: readonly ExprIssue[]) {
    super(`invalid density expression: ${issues.map((i) => `${i.path === '' ? '<top>' : i.path}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const OP_SET = new Set<string>(EXPR_OPS);
const TOP_KEYS = ['root', 'defs'];

/**
 * The single density-expression validator (SP3b spec §1.1). Collects every issue, never throws: structural issues in
 * DFS pre-order (root, then defs in key order), then unknown refs and ref cycles, then interpolated nesting (only when
 * the refs resolve). [] means the value is a `DensityExpr` the compiler and the reference accept. Beyond the spec's
 * list it also rejects unknown keys, a noise used with the wrong dimension and duplicate tap names (rulings, Task 2).
 */
export function validateExpr(value: unknown, noises: DensityNoiseLookup): ExprIssue[] {
  const issues: ExprIssue[] = [];
  const push = (path: string, code: ExprErrorCode, message: string) => issues.push({ path, code, message });
  if (!isRecord(value)) {
    push('', 'NOT_OBJECT', 'a density expression is an object {root, defs}');
    return issues;
  }
  for (const k of Object.keys(value)) if (!TOP_KEYS.includes(k)) push(k, 'UNKNOWN_KEY', `unknown key "${k}"`);
  const rawDefs = value['defs'];
  const defs: Record<string, unknown> | null = isRecord(rawDefs) ? rawDefs : null;
  const defNames = defs === null ? [] : Object.keys(defs);
  const hasDef = (name: string) => defs !== null && Object.hasOwn(defs, name);
  const taps = new Map<string, string>();
  /** Ref nodes per owner ('' = root, else the def name), in pre-order. */
  const refs = new Map<string, Array<{ path: string; name: string }>>();

  const walk = (node: unknown, path: string, owner: string): void => {
    if (!isRecord(node)) { push(path, 'NOT_OBJECT', 'an expression node must be an object with an op'); return; }
    const op = node['op'];
    if (typeof op !== 'string' || !OP_SET.has(op)) { push(path, 'UNKNOWN_OP', `unknown op ${JSON.stringify(op)}`); return; }
    const o = op as ExprOp;
    const at = (k: string) => `${path}.${k}`;
    for (const k of Object.keys(node)) {
      if (k !== 'op' && !SCALAR_KEYS[o].includes(k) && !EXPR_CHILD_KEYS[o].includes(k)) push(at(k), 'UNKNOWN_KEY', `unknown key "${k}" on ${o}`);
    }
    const finite = (k: string): boolean => {
      if (isFiniteNumber(node[k])) return true;
      push(at(k), 'NOT_FINITE', `${o}.${k} must be a finite number`);
      return false;
    };
    const child = (k: string) => walk(node[k], at(k), owner);
    switch (o) {
      case 'const': finite('v'); break;
      case 'y': break;
      case 'col': {
        const f = node['field'];
        if (typeof f !== 'string' || !(FIELDS as readonly string[]).includes(f)) push(at('field'), 'BAD_FIELD', `col.field ${JSON.stringify(f)} is not a continuous ColumnSample field`);
        break;
      }
      case 'noise2': case 'noise': {
        const id = node['id'];
        const info = typeof id === 'string' ? noises(id) : undefined;
        const dims = o === 'noise2' ? 2 : 3;
        if (info === undefined) push(at('id'), 'UNKNOWN_NOISE', `unknown density noise ${JSON.stringify(id)}`);
        else if (info.dims !== dims) push(at('id'), 'NOISE_DIMS', `${o} needs a ${dims}D noise; ${String(id)} is ${info.dims}D`);
        else if (info.remap !== 'none') push(at('id'), 'NOISE_REMAP', `density noise ${String(id)} must have remap 'none'`);
        break;
      }
      case 'add': case 'mul': case 'min': case 'max': child('a'); child('b'); break;
      case 'neg': case 'abs': case 'square': case 'interpolated': child('x'); break;
      case 'clamp': {
        child('x');
        const lo = finite('lo'), hi = finite('hi');
        if (lo && hi && (node['lo'] as number) > (node['hi'] as number)) push(path, 'CLAMP_ORDER', 'clamp needs lo ≤ hi');
        break;
      }
      case 'slide': {
        child('x');
        const knots = node['knots'];
        if (!Array.isArray(knots) || knots.length < 2) { push(at('knots'), 'KNOTS_SHAPE', 'slide needs at least 2 knots [y, v]'); break; }
        let prev = -Infinity;
        for (let i = 0; i < knots.length; i++) {
          const kp = `${path}.knots[${i}]`;
          const kn: unknown = knots[i];
          if (!Array.isArray(kn) || kn.length !== 2) { push(kp, 'KNOTS_SHAPE', 'a knot is a pair [y, v]'); prev = NaN; continue; }
          if (!isFiniteNumber(kn[0]) || !isFiniteNumber(kn[1])) { push(kp, 'NOT_FINITE', 'knot y and v must be finite'); prev = NaN; continue; }
          if (kn[0] <= prev) push(kp, 'KNOTS_ORDER', 'knot y must be strictly increasing');
          prev = kn[0];
        }
        break;
      }
      case 'rangeChoice': {
        child('x');
        const lo = finite('lo'), hi = finite('hi');
        if (lo && hi && (node['lo'] as number) >= (node['hi'] as number)) push(path, 'RANGE_ORDER', 'rangeChoice needs lo < hi');
        child('inside');
        child('outside');
        break;
      }
      case 'tap': {
        const name = node['name'];
        if (typeof name !== 'string' || name === '') push(at('name'), 'BAD_NAME', 'tap.name must be a non-empty string');
        else if (taps.has(name)) push(at('name'), 'DUPLICATE_TAP', `tap ${JSON.stringify(name)} already used at ${taps.get(name)!}`);
        else taps.set(name, path);
        child('x');
        break;
      }
      case 'ref': {
        const name = node['name'];
        if (typeof name !== 'string' || !hasDef(name)) push(at('name'), 'UNKNOWN_REF', `unknown def ${JSON.stringify(name)}`);
        else {
          const list = refs.get(owner) ?? [];
          list.push({ path, name });
          refs.set(owner, list);
        }
        break;
      }
    }
  };

  if (!('root' in value)) push('root', 'NOT_OBJECT', 'missing root');
  else walk(value['root'], 'root', '');
  if (defs === null) push('defs', 'NOT_OBJECT', 'defs must be an object of named expressions');
  else for (const name of defNames) walk(defs[name], `defs.${name}`, name);
  const structuralOk = issues.length === 0;

  // Ref cycles: DFS over the defs graph; each back edge is one issue at the ref that closes it.
  let cycles = false;
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    state.set(name, 'open');
    stack.push(name);
    for (const r of refs.get(name) ?? []) {
      const s = state.get(r.name);
      if (s === 'open') {
        cycles = true;
        const loop = [...stack.slice(stack.indexOf(r.name)), r.name].map((n) => `defs.${n}`).join(' → ');
        push(r.path, 'REF_CYCLE', `ref cycle ${loop}`);
      } else if (s === undefined) visit(r.name);
    }
    stack.pop();
    state.set(name, 'done');
  };
  for (const name of defNames) if (!state.has(name)) visit(name);

  // Interpolated nesting through refs, from the root, then from the defs the root does not reach (each def once per flag).
  if (structuralOk && !cycles) {
    const reported = new Set<string>();
    const seen = new Set<string>();
    const nest = (node: Expr, path: string, outer: string | null): void => {
      if (node.op === 'interpolated') {
        if (outer !== null && !reported.has(path)) {
          reported.add(path);
          push(path, 'NESTED_INTERPOLATED', `an interpolated inside another (the outer one at ${outer})`);
        }
        nest(node.x, `${path}.x`, outer ?? path);
        return;
      }
      if (node.op === 'ref') {
        const key = `${node.name}|${outer === null ? 0 : 1}`;
        if (seen.has(key)) return;
        seen.add(key);
        nest((defs as Record<string, Expr>)[node.name]!, `defs.${node.name}`, outer);
        return;
      }
      const rec = node as unknown as Record<string, Expr>;
      for (const k of EXPR_CHILD_KEYS[node.op]) nest(rec[k]!, `${path}.${k}`, outer);
    };
    nest(value['root'] as Expr, 'root', null);
    for (const name of defNames) nest({ op: 'ref', name }, `defs.${name}`, null);
  }
  return issues;
}

/** Throws an ExprValidationError listing every issue unless `value` is a valid DensityExpr. */
export function assertValidExpr(value: unknown, noises: DensityNoiseLookup): asserts value is DensityExpr {
  const issues = validateExpr(value, noises);
  if (issues.length > 0) throw new ExprValidationError(issues);
}

const DV = new DataView(new ArrayBuffer(8));

/**
 * Structural hash of a node (SP3b spec §2.1 CSE): FNV-1a 64 over the op name, its scalar fields (numbers as IEEE
 * bits, so −0 ≠ +0; strings as length + UTF-8) and its children's hashes in slot order, as 16 hex digits. A `ref` hashes
 * by name (the compiler hashes after resolving refs). `memo` caches every sub-tree's hash by identity, so hashing all
 * nodes of a tree (or a DAG) is linear. Not pinned by a golden: the value may change between versions.
 */
export function exprHash(e: Expr, memo: WeakMap<Expr, string> = new WeakMap()): string {
  const cached = memo.get(e);
  if (cached !== undefined) return cached;
  const h = FNV();
  const str = (s: string) => {
    const b = UTF8(s);
    h.updateU32LE(b.length).update(b);
  };
  const num = (v: number) => {
    DV.setFloat64(0, v, true);
    h.updateU32LE(DV.getUint32(0, true)).updateU32LE(DV.getUint32(4, true));
  };
  str(e.op);
  switch (e.op) {
    case 'const': num(e.v); break;
    case 'col': str(e.field); break;
    case 'noise2': case 'noise': str(e.id); break;
    case 'clamp': case 'rangeChoice': num(e.lo); num(e.hi); break;
    case 'slide':
      h.updateU32LE(e.knots.length);
      for (const [y, v] of e.knots) { num(y); num(v); }
      break;
    case 'tap': case 'ref': str(e.name); break;
    default: break;
  }
  const rec = e as unknown as Record<string, Expr>;
  for (const k of EXPR_CHILD_KEYS[e.op]) str(exprHash(rec[k]!, memo));
  const out = HEX(h.digest());
  memo.set(e, out);
  return out;
}
```

Create `src/gen/density/nodes.ts`:

```ts
/**
 * Per-op semantics of the density DAG (SP3b spec §1.1, §1.2, §2.1), shared by the compiler, the reference
 * interpreter and the bounds: the scalar value of each op, the one-step evaluator `evalNode` (which pins the
 * evaluation order), the interval rules (with the widening helper) and the class rule.
 *
 * Values: IEEE double, round to nearest, in the written order, never fused or reassociated. Every binary op evaluates
 * a, then b. min/max compare with < / > and return a on ties (also +0 against −0); −0 is a valid density.
 *
 * Intervals are written as two doubles `out[k] = lo`, `out[k + 1] = hi` (allocation-free). Endpoint arithmetic is
 * sound because rounding is monotone; interpolation is not, so callers widen what leaves an `interpolated` node and
 * every voxel-level COLUMN read with `ivWiden`. Endpoints are assumed finite.
 */
import type { ColExpr, Expr, ExprOp, InterpolatedExpr, Noise2Expr, NoiseExpr, RefExpr, SlideKnot } from './expr';

export function valAdd(a: number, b: number): number { return a + b; }
export function valMul(a: number, b: number): number { return a * b; }
export function valMin(a: number, b: number): number { return b < a ? b : a; }
export function valMax(a: number, b: number): number { return b > a ? b : a; }
export function valNeg(x: number): number { return -x; }
/** |x|; |−0| is +0. */
export function valAbs(x: number): number { return Math.abs(x); }
export function valSquare(x: number): number { return x * x; }
/** x < lo ? lo : x > hi ? hi : x (−0 inside the range stays −0). */
export function valClamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/**
 * The slide factor s(y): v_0 below the first knot, v_last at and above the last, and on the half-open segment
 * [y_k, y_{k+1}) `v_k + (y − y_k) · ((v_{k+1} − v_k) / (y_{k+1} − y_k))`, in that order.
 */
export function slideAt(knots: readonly SlideKnot[], y: number): number {
  const n = knots.length;
  const first = knots[0]!;
  if (y < first[0]) return first[1];
  const last = knots[n - 1]!;
  if (y >= last[0]) return last[1];
  let k = 0;
  while (y >= knots[k + 1]![0]) k++;
  const [yk, vk] = knots[k]!;
  const [y1, v1] = knots[k + 1]!;
  return vk + (y - yk) * ((v1 - vk) / (y1 - yk));
}

/** slide's value: x · s(y). */
export function valSlide(x: number, knots: readonly SlideKnot[], y: number): number { return x * slideAt(knots, y); }

/** rangeChoice's test: lo ≤ x < hi chooses `inside`. */
export function inRange(x: number, lo: number, hi: number): boolean { return lo <= x && x < hi; }

/** The reads a node delegates to its caller, whose placement rules (§2.1, §2.2) decide where they are taken. */
export type DelegatedExpr = ColExpr | Noise2Expr | NoiseExpr | InterpolatedExpr | RefExpr;

/** What `evalNode` needs from the walker that calls it. */
export interface NodeEnv {
  /** The current point's y (the voxel's, or the corner's inside `interpolated`). */
  readonly y: number;
  /** A child's value, through the caller's placement rules. */
  child(e: Expr): number;
  /** `col`, `noise2`, `noise`, `interpolated` and `ref`: the caller samples, interpolates or resolves them. */
  read(e: DelegatedExpr): number;
}

/**
 * One node's value from its children (SP3b spec §1.1): children are visited in slot order (a then b), and only the
 * chosen branch of a rangeChoice is evaluated, after its x.
 */
export function evalNode(e: Expr, env: NodeEnv): number {
  switch (e.op) {
    case 'const': return e.v;
    case 'y': return env.y;
    case 'col': case 'noise2': case 'noise': case 'interpolated': case 'ref': return env.read(e);
    case 'add': { const a = env.child(e.a); return valAdd(a, env.child(e.b)); }
    case 'mul': { const a = env.child(e.a); return valMul(a, env.child(e.b)); }
    case 'min': { const a = env.child(e.a); return valMin(a, env.child(e.b)); }
    case 'max': { const a = env.child(e.a); return valMax(a, env.child(e.b)); }
    case 'neg': return valNeg(env.child(e.x));
    case 'abs': return valAbs(env.child(e.x));
    case 'square': return valSquare(env.child(e.x));
    case 'clamp': return valClamp(env.child(e.x), e.lo, e.hi);
    case 'slide': return valSlide(env.child(e.x), e.knots, env.y);
    case 'rangeChoice': { const x = env.child(e.x); return inRange(x, e.lo, e.hi) ? env.child(e.inside) : env.child(e.outside); }
    case 'tap': return env.child(e.x);
  }
}

// ---- Interval rules (SP3b spec §1.2) ----

/** [lo, hi] as is: `const` is [v, v], `y` the cell's [y0, y1]. */
export function ivSet(lo: number, hi: number, out: Float64Array, k: number): void {
  out[k] = lo;
  out[k + 1] = hi;
}

/** `noise2` / `noise`: [−clampSigma, clampSigma]. */
export function ivNoise(clampSigma: number, out: Float64Array, k: number): void {
  out[k] = -clampSigma;
  out[k + 1] = clampSigma;
}

export function ivAdd(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = a0 + b0;
  out[k + 1] = a1 + b1;
}

/** The min and max of the four endpoint products. */
export function ivMul(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  const p = a0 * b0, q = a0 * b1, r = a1 * b0, s = a1 * b1;
  let lo = p, hi = p;
  if (q < lo) lo = q; if (q > hi) hi = q;
  if (r < lo) lo = r; if (r > hi) hi = r;
  if (s < lo) lo = s; if (s > hi) hi = s;
  out[k] = lo;
  out[k + 1] = hi;
}

export function ivMin(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = b0 < a0 ? b0 : a0;
  out[k + 1] = b1 < a1 ? b1 : a1;
}

export function ivMax(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = b0 > a0 ? b0 : a0;
  out[k + 1] = b1 > a1 ? b1 : a1;
}

export function ivNeg(x0: number, x1: number, out: Float64Array, k: number): void {
  out[k] = -x1;
  out[k + 1] = -x0;
}

/** The exact image of |x|. */
export function ivAbs(x0: number, x1: number, out: Float64Array, k: number): void {
  if (x0 >= 0) { out[k] = x0; out[k + 1] = x1; }
  else if (x1 <= 0) { out[k] = -x1; out[k + 1] = -x0; }
  else { out[k] = 0; out[k + 1] = -x0 > x1 ? -x0 : x1; }
}

/** The exact image of x · x. */
export function ivSquare(x0: number, x1: number, out: Float64Array, k: number): void {
  const a = x0 * x0, b = x1 * x1;
  if (x0 >= 0) { out[k] = a; out[k + 1] = b; }
  else if (x1 <= 0) { out[k] = b; out[k + 1] = a; }
  else { out[k] = 0; out[k + 1] = a > b ? a : b; }
}

/** The exact image of clamp (monotone). */
export function ivClamp(x0: number, x1: number, lo: number, hi: number, out: Float64Array, k: number): void {
  out[k] = valClamp(x0, lo, hi);
  out[k + 1] = valClamp(x1, lo, hi);
}

/**
 * The range of s over [y0, y1]: s(y0), s(y1) and, at each interior knot y_k ∈ (y0, y1], both v_k and the left
 * segment's formula at y_k (which can differ from v_k by an ulp). s is monotone between knots, so this is sound.
 */
export function ivSlideFactor(knots: readonly SlideKnot[], y0: number, y1: number, out: Float64Array, k: number): void {
  let lo = slideAt(knots, y0), hi = lo;
  const e = slideAt(knots, y1);
  if (e < lo) lo = e; if (e > hi) hi = e;
  for (let i = 0; i < knots.length; i++) {
    const [yk, vk] = knots[i]!;
    if (yk <= y0) continue;
    if (yk > y1) break;
    if (vk < lo) lo = vk; if (vk > hi) hi = vk;
    if (i > 0) {
      const [ya, va] = knots[i - 1]!;
      const left = va + (yk - ya) * ((vk - va) / (yk - ya));
      if (left < lo) lo = left; if (left > hi) hi = left;
    }
  }
  out[k] = lo;
  out[k + 1] = hi;
}

/** slide: x's interval times s's range over [y0, y1] (the mul rule). */
export function ivSlide(x0: number, x1: number, knots: readonly SlideKnot[], y0: number, y1: number, out: Float64Array, k: number): void {
  ivSlideFactor(knots, y0, y1, out, k);
  ivMul(x0, x1, out[k]!, out[k + 1]!, out, k);
}

/** Which rangeChoice branches an interval of x can reach: x ⊆ [lo, hi) → inside, disjoint → outside, else both. */
export function rangeChoiceCase(x0: number, x1: number, lo: number, hi: number): 'inside' | 'outside' | 'both' {
  if (x0 >= lo && x1 < hi) return 'inside';
  if (x1 < lo || x0 >= hi) return 'outside';
  return 'both';
}

/** The hull of two intervals (rangeChoice when both branches are reachable). */
export function ivHull(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = b0 < a0 ? b0 : a0;
  out[k + 1] = b1 > a1 ? b1 : a1;
}

/** Widening: both ends move out by w = 1e-9 · (1 + max(|lo|, |hi|)). */
export function ivWiden(lo: number, hi: number, out: Float64Array, k: number): void {
  const w = 1e-9 * (1 + Math.max(Math.abs(lo), Math.abs(hi)));
  out[k] = lo - w;
  out[k + 1] = hi + w;
}

// ---- Class rule (SP3b spec §2.1) ----

/** Stage placement classes, ordered COLUMN < CELL < VOXEL. */
export type DensityClass = 'column' | 'cell' | 'voxel';

/**
 * A node's own class: `y`, `slide` and `noise` are y-dependent (CELL inside `interpolated`, VOXEL outside, never
 * COLUMN); `interpolated` is VOXEL (evaluated per voxel from its CELL corners) and is never inside another; every other
 * op adds nothing (COLUMN), so `const`, `col` and `noise2` sub-trees stay COLUMN.
 */
export function ownClass(op: ExprOp, inside: boolean): DensityClass {
  switch (op) {
    case 'y': case 'slide': case 'noise': return inside ? 'cell' : 'voxel';
    case 'interpolated':
      if (inside) throw new Error('an interpolated inside another has no class');
      return 'voxel';
    default: return 'column';
  }
}

export function joinClass(a: DensityClass, b: DensityClass): DensityClass {
  if (a === 'voxel' || b === 'voxel') return 'voxel';
  if (a === 'cell' || b === 'cell') return 'cell';
  return 'column';
}

/**
 * A node's class: the highest of its own and its children's (children of `interpolated` are inside it), with `ref`
 * resolved through `defs`. Equivalently COLUMN when the sub-tree has no y-dependent op, else CELL inside and VOXEL
 * outside. Nesting is validateExpr's to reject; only a
 * directly nested `interpolated` throws here. `memo` (node → is COLUMN) may be shared across calls and makes DAG-shaped trees linear.
 */
export function exprClass(e: Expr, inside: boolean, defs: Readonly<Record<string, Expr>>, memo: WeakMap<Expr, boolean> = new WeakMap()): DensityClass {
  if (e.op === 'interpolated') ownClass('interpolated', inside);
  if (isColumn(e, defs, memo)) return 'column';
  return inside ? 'cell' : 'voxel';
}

function resolve(name: string, defs: Readonly<Record<string, Expr>>): Expr {
  if (!Object.hasOwn(defs, name)) throw new Error(`unknown def ${name}`);
  return defs[name]!;
}

function isColumn(e: Expr, defs: Readonly<Record<string, Expr>>, memo: WeakMap<Expr, boolean>): boolean {
  const cached = memo.get(e);
  if (cached !== undefined) return cached;
  let r: boolean;
  switch (e.op) {
    case 'const': case 'col': case 'noise2': r = true; break;
    case 'y': case 'slide': case 'noise': case 'interpolated': r = false; break;
    case 'ref': r = isColumn(resolve(e.name, defs), defs, memo); break;
    case 'add': case 'mul': case 'min': case 'max': r = isColumn(e.a, defs, memo) && isColumn(e.b, defs, memo); break;
    case 'rangeChoice': r = isColumn(e.x, defs, memo) && isColumn(e.inside, defs, memo) && isColumn(e.outside, defs, memo); break;
    default: r = isColumn(e.x, defs, memo); break;
  }
  memo.set(e, r);
  return r;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/densityExpr.test.ts test/unit/densityNodes.test.ts`

Expected: PASS (exit 0)

```
Test Files  2 passed (2)
Tests  40 passed (40)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  123 passed | 2 skipped (125)
Tests  1617 passed | 3 skipped (1620)
```

- [ ] **Step 6: Commit**

```bash
git add src/gen/density/expr.ts src/gen/density/nodes.ts test/unit/densityExpr.test.ts test/unit/densityNodes.test.ts
git commit -F - <<'EOF'
feat(gen/density): Expr model, validation, op semantics and interval rules

SP3b spec §1: expr.ts holds the Expr node types, child slots in evaluation
order, validateExpr (issues with real node paths, before ref resolution) and
the structural hash for CSE; nodes.ts holds each op's value, the one-step
evaluator that pins evaluation order, ties and -0, slide's half-open segments,
the interval rules with the widening helper, and the class rule.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `0db6f72` on `dry/sp3a`; 4 files changed, 1214 insertions(+)):

Commit Task 2 on `dry/sp3b-density` (worktree `P/dry-density`, from `dry/sp3b` Task 1; 4 files, 1214 insertions). RED (the commit's test files over the parent): both files fail to import (`Cannot find module '../../src/gen/density/expr'` / `…/nodes'`), "no tests", plus 6 `tsc -p tsconfig.test.json` errors. GREEN: typecheck clean (1.3 s); the two files 40 tests in 0.5 s; `npm test` 123 files passed, 2 skipped; 1617 tests passed, 3 skipped (29.6 s wall).

- Ruling (API, `src/gen/density/expr.ts`): node interfaces `ConstExpr {op:'const', v}`, `YExpr`, `ColExpr {field: SampleField}`, `Noise2Expr {id}`, `NoiseExpr {id}`, `BinaryExpr {op: BinaryOp ('add'|'mul'|'min'|'max'), a, b}`, `UnaryExpr {op: UnaryOp ('neg'|'abs'|'square'), x}`, `ClampExpr {x, lo, hi}`, `SlideExpr {x, knots: readonly SlideKnot[]}` with `SlideKnot = readonly [y, v]`, `InterpolatedExpr {x}`, `RangeChoiceExpr {x, lo, hi, inside, outside}`, `TapExpr {name, x}`, `RefExpr {name}`; `Expr` their union, `ExprOp = Expr['op']`; `DensityExpr {root: Expr; defs: Readonly<Record<string, Expr>>}` (defs required, may be `{}`). `EXPR_OPS` (18 ops, spec table order), `EXPR_CHILD_KEYS[op]` (child slots in evaluation order: a,b / x / x,inside,outside), `exprChildren(e): Expr[]`. Noises are injected: `DensityNoiseInfo {dims: 2|3; remap: 'none'|'uniform'; clampSigma}`, `DensityNoiseLookup = (id) => DensityNoiseInfo | undefined` — Task 3's fuzz passes a test Map, Task 6 builds it from the schema's `density.noises.<id>` leaves (dims from the leaf, remap/clampSigma from params) — cost if wrong: one adapter.
- Ruling (validation API): `validateExpr(value: unknown, noises): ExprIssue[]` never throws (same shape as `validateSpline`: `{path, code, message}`, codes `NOT_OBJECT UNKNOWN_OP UNKNOWN_KEY NOT_FINITE BAD_FIELD UNKNOWN_NOISE NOISE_DIMS NOISE_REMAP BAD_NAME DUPLICATE_TAP UNKNOWN_REF REF_CYCLE NESTED_INTERPOLATED CLAMP_ORDER RANGE_ORDER KNOTS_SHAPE KNOTS_ORDER`); `assertValidExpr(value, noises)` throws `ExprValidationError` (`.issues`, message `invalid density expression: <path>: <code>; …`). Order: structural issues in DFS pre-order (root, then defs in key order), then ref cycles (one issue per back edge, at the ref that closes it, message `ref cycle defs.a → defs.b → defs.a`), then interpolated nesting through refs (only when no structural issue and no cycle; reported once at the inner node's source path). Paths: `root`, `root.a.b.x`, `defs.<name>.x`, `root.knots[i]`, `''` for the top object. Task 4 calls `assertValidExpr` first — cost if wrong: none.
- Ruling (validation beyond §1.1's list): it also rejects unknown keys (top level and per op: typos in SP3d's JSON leaf), non-numeric constants, `noise2` on a 3D noise / `noise` on a 2D one (`NOISE_DIMS`: a schema noise leaf has one `dims`, and N2-N6 measure it in that dimension), an empty or duplicate `tap` name (the probe and metrics look taps up by name; a tap inside a def referenced twice counts once, as its source occurrence), and `col` of a level field (`lakeLevel`, `lakeFloor`, `surfaceWaterLevel`: §14 "col is limited to finite fields until SP6"; only `SAMPLE_FIELDS`). Knot y need not be integers. — cost if wrong: an expression SP3d wants would be refused; relaxing is one line each.
- Ruling (hash): `exprHash(e, memo = new WeakMap()): string` — 16 hex digits, Merkle FNV-1a 64 (`createFnv64`) over the op name, scalar fields (numbers as IEEE bits so −0 ≠ +0; strings as u32 length + UTF-8; knots count + pairs) and the children's hashes in slot order; `ref` hashes by name; tap names count. The memo makes a whole tree or DAG linear and Task 4 should share one memo across all nodes. Task 4's CSE key: `` `${exprHash(node, memo)}|${inside ? 1 : 0}` `` after ref resolution. The value is not pinned by a test or golden — cost if wrong: none (a 64-bit collision would merge two CSE nodes: ~1e-15 for a few hundred nodes).
- Ruling (API, `src/gen/density/nodes.ts`, values): `valAdd valMul valMin valMax valNeg valAbs valSquare valClamp(x, lo, hi)`, `slideAt(knots, y)` (the factor s), `valSlide(x, knots, y) = x · s(y)`, `inRange(x, lo, hi) = lo ≤ x && x < hi`. `evalNode(e, env: NodeEnv): number` is the one-step evaluator: `NodeEnv {y; child(e): number; read(e: DelegatedExpr): number}` with `DelegatedExpr = ColExpr | Noise2Expr | NoiseExpr | InterpolatedExpr | RefExpr` — the caller (Task 3's reference) supplies placement (corner vs position reads, trilinear interpolation, ref resolution) through `child`/`read`; evalNode pins a-then-b and "x, then only the chosen rangeChoice branch". Task 4's closures must use these `val*`/`slideAt` functions (or identical expressions) so compiled == reference bit for bit — cost if wrong: none.
- Ruling (signed zero): `abs(−0) = +0` (`Math.abs`, |x| as written), `neg(0) = −0`, `square(−0) = +0`, `clamp` returns x itself inside [lo, hi] so −0 stays −0, min/max ties return a (`min(0, −0) = 0`, `min(−0, 0) = −0`), `inRange(−0, 0, hi)` is true — cost if wrong: DT2 and goldens would pin the other choice; none before Task 9.
- Ruling (slide): s is computed `vk + (y − yk) * ((v1 − vk) / (y1 − yk))` with a linear segment scan per call (the test shows the other multiplication order differs on random knots). One function serves both paths (the compiler may precompute nothing that changes bits; recomputing the slope gives the same double) — cost if wrong: none.
- Ruling (interval API): every rule writes `out[k] = lo, out[k + 1] = hi` into a caller's `Float64Array` (no allocation): `ivSet(lo, hi)` (const [v, v], y [y0, y1]), `ivNoise(clampSigma)`, `ivAdd`, `ivMul` (four endpoint products), `ivMin`, `ivMax` (endpoint-wise), `ivNeg`, `ivAbs`, `ivSquare` (exact images), `ivClamp(x0, x1, lo, hi)`, `ivSlideFactor(knots, y0, y1)` (s(y0), s(y1), and at each knot in (y0, y1] both v_k and the left formula), `ivSlide(x0, x1, knots, y0, y1)` (= ivMul of x and the factor), `rangeChoiceCase(x0, x1, lo, hi): 'inside' | 'outside' | 'both'` plus `ivHull` for 'both', `ivWiden(lo, hi)` (w = 1e-9·(1 + max(|lo|, |hi|)); the 1e-9 is module-private because gen exports no numeric constants, which is also why classes and cases are strings). No interval dispatcher: Task 5 composes these per node and owns the placement-dependent leaves (corner-column hull for `col` inside `interpolated`, 4×4-position hull + widening for voxel-level COLUMN values, widening after `interpolated`). Soundness is fuzzed per op with endpoints log-uniform in [1e-6, 1e9], ±0 and small integers — cost if wrong: none.
- Ruling (for Task 5): `y`'s interval per cell is the caller's; [y0, y0 + 8] (the cell's corner span) is sound for both CELL (corners y0, y0 + 8) and VOXEL (y0 … y0 + 7) use; a tighter [y0, y0 + 7] at voxel level is also sound — cost if wrong: looser early-outs only.
- Ruling (class API): `DensityClass = 'column' | 'cell' | 'voxel'`, `ownClass(op, inside)` (`y`, `slide`, `noise`: cell inside / voxel outside; `interpolated`: voxel, throws when inside; all others column), `joinClass(a, b)`, `exprClass(e, inside, defs, memo?: WeakMap<Expr, boolean>)` (memo = "sub-tree is COLUMN", independent of `inside`, shareable across calls; refs resolved through defs, unknown name throws). `interpolated` is VOXEL even over a COLUMN child (spec §2.1 says only "evaluated per voxel"); a COLUMN sub-tree inside `interpolated` stays COLUMN (Task 4 places it in `columnFn`, the inside flag separates it from the same sub-tree at voxel level). `exprClass` throws only on a directly nested `interpolated`; nesting is validateExpr's job — cost if wrong: none.
- Ruling (for Task 3): trilinear interpolation is not in Task 2. Task 3 should add `lerp(a, b, t) = a + t * (b − a)` (and its fixed x → z → y order helper) to `nodes.ts`, so reference and compile share one definition — cost if wrong: a duplicated one-liner.

---

### Task 3: gen/density: geometry, the reference interpreter and the fuzz generator

**Spec:** §2.1 (placement rules as they apply to a tree walk), §2.2, §2.3 reference

**Files:**
- Modify: `src/gen/density/expr.ts`
- Modify: `src/gen/density/nodes.ts`
- Create: `src/gen/density/reference.ts`
- Create: `test/harness/densityFuzz.ts`
- Create: `test/unit/densityFuzz.test.ts`
- Create: `test/unit/densityReference.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/expr.ts` (Task 2): `EXPR_CHILD_KEYS`, `ExprValidationError`, `exprChildren`, `type DensityExpr`, `type DensityNoise`, `type DensityNoiseSource`, `type Expr`, `type InterpolatedExpr`, `type SlideKnot`, `type TapExpr`, `validateExpr`
  - `src/gen/density/nodes.ts` (Task 2): `cellXZ`, `cellY`, `cornerY`, `evalNode`, `fracXZ`, `fracY`, `trilerp`, `type DelegatedExpr`, `type NodeEnv`
- Produces (exports added by this task):
  - `src/gen/density/expr.ts`:
    - `export interface DensityNoise extends DensityNoiseInfo`
    - `export type DensityNoiseSource = (id: string) => DensityNoise | undefined;`
  - `src/gen/density/nodes.ts`:
    - `export function cellXZ(l: number): number { return l >> 2; }`
    - `export function fracXZ(l: number): number { return (l - 4 * (l >> 2)) / 4; }`
    - `export function cellY(y: number): number { return (y + 64) >> 3; }`
    - `export function fracY(y: number): number { return (y + 64 - 8 * ((y + 64) >> 3)) / 8; }`
    - `export function cornerY(k: number): number { return -64 + 8 * k; }`
    - `export function lerp(a: number, b: number, t: number): number { return a + t * (b - a); }`
    - `export function trilerp(`
  - `src/gen/density/reference.ts`:
    - `export interface DensityReference`
    - `export function createDensityReference(expr: DensityExpr, noises: DensityNoiseSource): DensityReference`
    - `export function findTap(expr: DensityExpr, name: string): { readonly node: TapExpr; readonly inside: boolean } | undefined`
    - `export function interpolatedNodes(expr: DensityExpr): InterpolatedExpr[]`
  - `test/harness/densityFuzz.ts`:
    - `export interface FuzzNoiseSpec { readonly id: string; readonly dims: 2 | 3; readonly def: NoiseDef }`
    - `export const FUZZ_NOISE_SPECS: readonly FuzzNoiseSpec[] = [`
    - `export function densityNoiseOf(n: NormalNoise, dims: 2 | 3): DensityNoise`
    - `export function fuzzNoiseSource(seed: Seed64 = [0x5eed, 0x3b]): DensityNoiseSource`
    - `export function fuzzConstant(next: () => number): number`
    - `export function exprHeight(e: Expr, defs: Readonly<Record<string, Expr>>): number`
    - `export interface DensityFuzzOptions`
    - `export function randomDensityExpr(next: () => number, opts: DensityFuzzOptions = {}): DensityExpr`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/densityFuzz.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { EXPR_OPS, exprChildren, exprHash, validateExpr, type DensityExpr, type Expr, type ExprOp } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { FUZZ_NOISE_SPECS, exprHeight, fuzzConstant, fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

/** Every node reachable from the root and the defs (each def walked once). */
function nodesOf(e: DensityExpr): Expr[] {
  const out: Expr[] = [];
  const walk = (n: Expr) => { out.push(n); for (const c of exprChildren(n)) walk(c); };
  walk(e.root);
  for (const d of Object.values(e.defs)) walk(d);
  return out;
}

const hashOf = (e: DensityExpr): string => [exprHash(e.root), ...Object.entries(e.defs).map(([k, d]) => `${k}:${exprHash(d)}`)].join('|');

describe('densityFuzz: random valid Expr trees (SP3b spec §10)', () => {
  const noises = fuzzNoiseSource();
  const trees = (seed: number, n: number): DensityExpr[] => {
    const next = testRng(seed);
    return Array.from({ length: n }, () => randomDensityExpr(next));
  };

  test('the test noise map: 2D and 3D noises with remap none, each sampled by its own dimension', () => {
    expect(FUZZ_NOISE_SPECS.map((n) => n.dims).sort()).toEqual([2, 2, 3, 3]);
    for (const { id, dims } of FUZZ_NOISE_SPECS) {
      const n = noises(id)!;
      expect(n).toMatchObject({ dims, remap: 'none' });
      const v = dims === 2 ? n.z2(13, -7) : n.z3(13, 70, -7);
      expect(Math.abs(v)).toBeLessThanOrEqual(n.clampSigma);
      expect(v).not.toBe(dims === 2 ? n.z2(17, -7) : n.z3(13, 78, -7));
    }
    expect(noises('jag')).toBeUndefined();
  });

  test('every tree validates, stays within the depth bound and is reproducible from its seed', () => {
    const a = trees(11, 400), b = trees(11, 400);
    for (let i = 0; i < a.length; i++) {
      expect(validateExpr(a[i], noises)).toEqual([]);
      expect(exprHeight(a[i]!.root, a[i]!.defs)).toBeLessThanOrEqual(6);
      expect(hashOf(a[i]!)).toBe(hashOf(b[i]!));
    }
    expect(new Set(a.map(hashOf)).size).toBeGreaterThan(390);
  });

  test('every op, refs inside and outside interpolated, ±0 and both rangeChoice branches occur', () => {
    const all = trees(12, 400);
    const ops = new Set<ExprOp>();
    for (const e of all) for (const n of nodesOf(e)) ops.add(n.op);
    expect([...ops].sort()).toEqual([...EXPR_OPS].sort());
    expect(all.filter((e) => interpolatedNodes(e).length > 0).length).toBeGreaterThan(80);
    const refInside = all.some((e) => interpolatedNodes(e).some((i) => JSON.stringify(i.x).includes('"ref"')));
    expect(refInside).toBe(true);
    const consts = all.flatMap(nodesOf).flatMap((n) => (n.op === 'const' ? [n.v] : []));
    expect(consts.some((v) => Object.is(v, -0))).toBe(true);
    expect(consts.some((v) => Object.is(v, 0))).toBe(true);
    expect(consts.some((v) => Math.abs(v) > 1e8)).toBe(true);
    expect(consts.some((v) => v !== 0 && Math.abs(v) < 1e-5)).toBe(true);
  });

  test('constants: 0, −0, small integers and log-uniform magnitudes in [1e-6, 1e9] with both signs', () => {
    const next = testRng(13);
    const vs = Array.from({ length: 20000 }, () => fuzzConstant(next));
    for (const v of vs) {
      expect(Number.isFinite(v)).toBe(true);
      if (v !== 0) expect(Math.abs(v)).toBeGreaterThanOrEqual(1e-6);
      expect(Math.abs(v)).toBeLessThanOrEqual(1e9);
    }
    const decades = new Set(vs.filter((v) => v !== 0 && !Number.isInteger(v)).map((v) => Math.floor(Math.log10(Math.abs(v)))));
    for (let d = -6; d <= 8; d++) expect(decades.has(d)).toBe(true);
    expect(vs.some((v) => v < -1)).toBe(true);
    expect(vs.some((v) => v > 1)).toBe(true);
  });

  test('the reference gives finite values on every tree, at voxels and at corners', () => {
    const s = buildColumnSample(ctxFor('42'), -4, 9, newColumnSample());
    const next = testRng(14);
    for (const e of trees(15, 150)) {
      const r = createDensityReference(e, noises);
      for (let n = 0; n < 4; n++) {
        const x = -64 + (next() % 16), y = -64 + (next() % 384), z = 144 + (next() % 16);
        expect(Number.isFinite(r.voxel(s, x, y, z))).toBe(true);
      }
      for (const node of interpolatedNodes(e)) expect(Number.isFinite(r.corner(s, node.x, next() % 5, next() % 49, next() % 5))).toBe(true);
    }
  });
});
```

Create `test/unit/densityReference.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr, InterpolatedExpr } from '../../src/gen/density/expr';
import { ExprValidationError } from '../../src/gen/density/expr';
import { cellXZ, cellY, cornerY, fracXZ, fracY, lerp, trilerp } from '../../src/gen/density/nodes';
import { createDensityReference, findTap, interpolatedNodes } from '../../src/gen/density/reference';
import { buildColumnSample, latticeIndex, newColumnSample, readField, SAMPLE_FIELDS, type ColumnSample } from '../../src/gen/column/columnStage';
import { fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: (typeof SAMPLE_FIELDS)[number]): Expr => ({ op: 'col', field });
const n2 = (id: string): Expr => ({ op: 'noise2', id });
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): InterpolatedExpr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });

/** A fake density noise: z2/z3 are plain functions of world coordinates; every call is logged. */
function fake(dims: 2 | 3, f: (x: number, y: number, z: number) => number, log: number[][] = []): DensityNoise {
  return {
    dims, remap: 'none', clampSigma: 4,
    z2: (x, z) => { log.push([x, z]); return f(x, 0, z); },
    z3: (x, y, z) => { log.push([x, y, z]); return f(x, y, z); },
  };
}
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

/** A hand-built ColumnSample at column (2, −3): E is i + 10·j on the lattice, every other field 0. */
function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) s.f.E[latticeIndex(i, j)] = i + 10 * j;
  return s;
}
const X0 = 32;   // 16 · cx
const Z0 = -48;  // 16 · cz

describe('geometry (SP3b spec §2.2)', () => {
  test('cells are 4 × 8 × 4, corners at y = −64 + 8k', () => {
    expect([0, 3, 4, 7, 8, 15].map(cellXZ)).toEqual([0, 0, 1, 1, 2, 3]);
    expect([0, 1, 3, 4, 15].map(fracXZ)).toEqual([0, 0.25, 0.75, 0, 0.75]);
    expect([-64, -57, -56, 0, 318, 319].map(cellY)).toEqual([0, 0, 1, 8, 47, 47]);
    expect([-64, -63, -57, -56, 319].map(fracY)).toEqual([0, 0.125, 0.875, 0, 0.875]);
    expect([0, 1, 8, 48].map(cornerY)).toEqual([-64, -56, 0, 320]);
  });

  test('lerp is a + t · (b − a), in that order', () => {
    const next = testRng(301);
    for (let n = 0; n < 2000; n++) {
      const a = (testFloat(next) - 0.5) * 1e6, b = (testFloat(next) - 0.5) * 1e-3, t = testFloat(next);
      expect(Object.is(lerp(a, b, t), a + t * (b - a))).toBe(true);
    }
    // The other common form, (1 − t) · a + t · b, gives another double here.
    expect(lerp(0.1, 0.7, 0.3)).not.toBe((1 - 0.3) * 0.1 + 0.3 * 0.7);
  });

  test('trilerp lerps along x on the four x-edges, then along z, then along y', () => {
    const next = testRng(302);
    let discriminating = 0;
    for (let n = 0; n < 2000; n++) {
      const c = Array.from({ length: 8 }, () => (testFloat(next) - 0.5) * 10 ** (next() % 12));
      const [c000, c100, c001, c101, c010, c110, c011, c111] = c as [number, number, number, number, number, number, number, number];
      const tx = (next() % 4) / 4, ty = (next() % 8) / 8, tz = (next() % 4) / 4;
      const L = (a: number, b: number, t: number) => a + t * (b - a);
      const xzy = L(L(L(c000, c100, tx), L(c001, c101, tx), tz), L(L(c010, c110, tx), L(c011, c111, tx), tz), ty);
      const yzx = L(L(L(c000, c010, ty), L(c001, c011, ty), tz), L(L(c100, c110, ty), L(c101, c111, ty), tz), tx);
      expect(Object.is(trilerp(c000, c100, c001, c101, c010, c110, c011, c111, tx, ty, tz), xzy)).toBe(true);
      if (!Object.is(xzy, yzx)) discriminating++;
    }
    expect(discriminating).toBeGreaterThan(100);
  });
});

describe('reference interpreter: hand-computed values', () => {
  const s = handSample();

  test('const, y and arithmetic at a voxel', () => {
    const r = createDensityReference(only(add(Y, C(0.5))), source({}));
    expect(r.voxel(s, X0 + 3, 70, Z0 + 9)).toBe(70.5);
    expect(r.voxel(s, X0, -64, Z0)).toBe(-63.5);
    expect(r.voxel(s, X0 + 15, 319, Z0 + 15)).toBe(319.5);
  });

  test('col at a voxel is the bilinear readout; at a corner it is the lattice value exactly', () => {
    const r = createDensityReference(only(col('E')), source({}));
    expect(r.voxel(s, X0 + 6, 0, Z0 + 10)).toBe(1.5 + 25);
    expect(r.voxel(s, X0 + 6, 0, Z0 + 10)).toBe(readField(s, 'E', X0 + 6, Z0 + 10));
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) expect(r.corner(s, col('E'), i, 17, j)).toBe(i + 10 * j);
    // A lattice value the bilinear readout cannot reach at x = 16: v00 + (v10 − v00) · 1 ≠ v10.
    const t = handSample();
    t.f.E[latticeIndex(3, 0)] = 1e17;
    t.f.E[latticeIndex(4, 0)] = 0.1;
    expect(readField(t, 'E', X0 + 16, Z0)).not.toBe(0.1);
    expect(r.corner(t, col('E'), 4, 0, 0)).toBe(0.1);
  });

  test('noises sample unscaled world coordinates: the voxel at a voxel, the corner at a corner', () => {
    const log: number[][] = [];
    const noises = source({ a: fake(2, (x, _y, z) => x + 0.5 * z, log), b: fake(3, (x, y, z) => x + 2 * y + 4 * z, log) });
    const r = createDensityReference(only(add(n2('a'), n3('b'))), noises);
    expect(r.voxel(s, X0 + 5, 70, Z0 + 2)).toBe(37 + 0.5 * -46 + (37 + 140 + 4 * -46));
    expect(log).toEqual([[37, -46], [37, 70, -46]]);
    log.length = 0;
    expect(r.corner(s, add(n2('a'), n3('b')), 1, 3, 4)).toBe(36 + 0.5 * -32 + (36 + 2 * -40 + 4 * -32));
    expect(log).toEqual([[36, -32], [36, -40, -32]]);
  });

  test('interpolated reproduces y and affine fields exactly, and interpolates a non-affine noise in x, z, y order', () => {
    const affine = fake(3, (x, y, z) => 0.25 * x - 0.5 * y + 2 * z);
    const bumpy = fake(3, (x, y, z) => Math.sin(x * 0.3) * 1e3 + Math.cos(z * 0.7) * 7 + y * y * 0.001);
    const r = createDensityReference(only(interp(Y)), source({ a: affine, b: bumpy }));
    for (let y = -64; y <= 319; y++) expect(r.voxel(s, X0 + (y & 15), y, Z0 + ((y >> 4) & 15))).toBe(y);
    const ra = createDensityReference(only(interp(n3('a'))), source({ a: affine }));
    for (const [lx, y, lz] of [[0, -64, 0], [5, 70, 9], [15, 319, 15], [3, -57, 12]] as const) {
      expect(ra.voxel(s, X0 + lx, y, Z0 + lz)).toBe(0.25 * (X0 + lx) - 0.5 * y + 2 * (Z0 + lz));
    }
    const rb = createDensityReference(only(interp(n3('b'))), source({ b: bumpy }));
    const f = (x: number, y: number, z: number) => bumpy.z3(x, y, z);
    for (const [lx, y, lz] of [[1, 70, 2], [7, -61, 13], [14, 300, 5]] as const) {
      const ci = lx >> 2, cj = lz >> 2, ck = (y + 64) >> 3;
      const x0 = X0 + 4 * ci, z0 = Z0 + 4 * cj, y0 = -64 + 8 * ck;
      const tx = (lx - 4 * ci) / 4, ty = (y + 64 - 8 * ck) / 8, tz = (lz - 4 * cj) / 4;
      const L = (a: number, b: number, t: number) => a + t * (b - a);
      const e00 = L(f(x0, y0, z0), f(x0 + 4, y0, z0), tx), e01 = L(f(x0, y0, z0 + 4), f(x0 + 4, y0, z0 + 4), tx);
      const e10 = L(f(x0, y0 + 8, z0), f(x0 + 4, y0 + 8, z0), tx), e11 = L(f(x0, y0 + 8, z0 + 4), f(x0 + 4, y0 + 8, z0 + 4), tx);
      const want = L(L(e00, e01, tz), L(e10, e11, tz), ty);
      expect(Object.is(rb.voxel(s, X0 + lx, y, Z0 + lz), want)).toBe(true);
      expect(rb.voxel(s, X0 + lx, y, Z0 + lz)).not.toBe(f(X0 + lx, y, Z0 + lz));
    }
  });

  test('placement: y and slide read the voxel y outside interpolated and the corner y inside', () => {
    const slide: Expr = { op: 'slide', x: C(1), knots: [[-64, 0], [-60, 1], [400, 1]] };
    const r = createDensityReference(only(slide), source({}));
    expect(r.voxel(s, X0, -62, Z0)).toBe(0.5);
    const ri = createDensityReference(only(interp(slide)), source({}));
    expect(ri.voxel(s, X0, -62, Z0)).toBe(0.25); // corners s(−64) = 0 and s(−56) = 1, ty = 2/8
    // noise2 at a voxel is sampled at the voxel; inside interpolated it is the bilinear blend of its corners.
    const q = fake(2, (x, _y, z) => x * x + z);
    const r2 = createDensityReference(only(n2('q')), source({ q }));
    const r2i = createDensityReference(only(interp(n2('q'))), source({ q }));
    expect(r2.voxel(s, X0 + 2, 10, Z0)).toBe(34 * 34 - 48);
    expect(r2i.voxel(s, X0 + 2, 10, Z0)).toBe(lerp(32 * 32 - 48, 36 * 36 - 48, 0.5));
  });

  test('rangeChoice evaluates x, then only the chosen branch', () => {
    const boom = fake(3, () => { throw new Error('evaluated'); });
    const e: Expr = { op: 'rangeChoice', x: Y, lo: 0, hi: 64, inside: C(1), outside: n3('boom') };
    const r = createDensityReference(only(e), source({ boom }));
    expect(r.voxel(s, X0, 0, Z0)).toBe(1);
    expect(r.voxel(s, X0, 63, Z0)).toBe(1);
    expect(() => r.voxel(s, X0, 64, Z0)).toThrow('evaluated');
    expect(() => r.voxel(s, X0, -1, Z0)).toThrow('evaluated');
  });

  test('ref resolves through defs at the placement of its use', () => {
    const defs = { h: add(Y, col('E')) };
    const r = createDensityReference(only({ op: 'max', a: { op: 'ref', name: 'h' }, b: interp({ op: 'ref', name: 'h' }) }, defs), source({}));
    // At lx = 2, lz = 0: E = 0.5 (bilinear) at the voxel; inside interpolated the corners give the same affine value.
    expect(r.voxel(s, X0 + 2, 5, Z0)).toBe(5.5);
  });

  test('taps: outside interpolated the tap is its x at the voxel; inside, its corners interpolated', () => {
    const q = fake(3, (x, y, z) => x * y + z);
    const root: Expr = add({ op: 'tap', name: 'outer', x: interp({ op: 'tap', name: 'inner', x: n3('q') }) }, { op: 'tap', name: 'v', x: Y });
    const r = createDensityReference(only(root, { unused: { op: 'tap', name: 'lost', x: C(1) } }), source({ q }));
    const [x, y, z] = [X0 + 5, 33, Z0 + 7];
    const interpolatedQ = createDensityReference(only(interp(n3('q'))), source({ q })).voxel(s, x, y, z);
    expect(r.tap(s, 'outer', x, y, z)).toBe(interpolatedQ);
    expect(r.tap(s, 'inner', x, y, z)).toBe(interpolatedQ);
    expect(r.tap(s, 'v', x, y, z)).toBe(33);
    expect(r.voxel(s, x, y, z)).toBe(interpolatedQ + 33);
    expect(() => r.tap(s, 'lost', x, y, z)).toThrow(/no tap "lost"/);
    expect(() => r.tap(s, 'nope', x, y, z)).toThrow(/no tap "nope"/);
    expect(findTap(r.expr, 'inner')).toMatchObject({ inside: true });
    expect(findTap(r.expr, 'outer')).toMatchObject({ inside: false });
    expect(findTap(r.expr, 'lost')).toBeUndefined();
  });

  test('interpolatedNodes lists each reachable interpolated once, in evaluation order', () => {
    const a = interp(Y), b = interp(col('E'));
    const defs = { d: a, unused: interp(C(2)) };
    const e = only(add({ op: 'ref', name: 'd' }, add(b, { op: 'ref', name: 'd' })), defs);
    expect(interpolatedNodes(e)).toEqual([a, b]);
    expect(interpolatedNodes(e)[0]).toBe(a);
  });

  test('rejects invalid expressions and points outside the sample', () => {
    expect(() => createDensityReference(only(n3('missing')), source({}))).toThrow(ExprValidationError);
    expect(() => createDensityReference(only(interp(interp(Y))), source({}))).toThrow(ExprValidationError);
    const r = createDensityReference(only(Y), source({}));
    expect(() => r.voxel(s, X0 + 16, 0, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0 - 1, 0, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0, 0, Z0 + 16)).toThrow(RangeError);
    expect(() => r.voxel(s, X0, -65, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0, 320, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0 + 0.5, 0, Z0)).toThrow(RangeError);
    expect(() => r.corner(s, Y, 5, 0, 0)).toThrow(RangeError);
    expect(() => r.corner(s, Y, 0, 49, 0)).toThrow(RangeError);
    expect(() => r.corner(s, Y, 0, 0, -1)).toThrow(RangeError);
    expect(() => r.corner(s, interp(Y), 0, 0, 0)).toThrow(/interpolated/);
  });
});

describe('reference interpreter on real columns', () => {
  const ctx = ctxFor('42');
  const noises = fuzzNoiseSource();
  const sample = (cx: number, cz: number) => buildColumnSample(ctx, cx, cz, newColumnSample());

  test('corners on a chunk border are computed identically by both neighbours', () => {
    const exprs: DensityExpr[] = [
      only(add(add(col('offset'), { op: 'mul', a: col('jag'), b: n2('fz2a') }), { op: 'neg', x: Y })),
      only(add({ op: 'mul', a: col('sigma'), b: { op: 'slide', x: n3('fz3b'), knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] } }, col('E'))),
    ];
    const next = testRng(303);
    while (exprs.length < 12) {
      const d = randomDensityExpr(next);
      const nodes = interpolatedNodes(d);
      if (nodes.length > 0) exprs.push({ root: nodes[0]!.x, defs: d.defs });
    }
    for (const [cx, cz] of [[-1, -1], [0, 0], [5, -7]] as const) {
      const a = sample(cx, cz), east = sample(cx + 1, cz), south = sample(cx, cz + 1);
      for (const d of exprs) {
        const r = createDensityReference(d, noises);
        const e = d.root;
        for (let k = 0; k <= 48; k += 3) {
          for (let t = 0; t <= 4; t++) {
            expect(Object.is(r.corner(a, e, 4, k, t), r.corner(east, e, 0, k, t))).toBe(true);
            expect(Object.is(r.corner(a, e, t, k, 4), r.corner(south, e, t, k, 0))).toBe(true);
          }
        }
      }
    }
  });

  test('a voxel on a corner of a cell equals that corner through interpolated', () => {
    const s = sample(3, -2);
    const next = testRng(304);
    let checked = 0;
    for (let n = 0; n < 40; n++) {
      const e = randomDensityExpr(next);
      const r = createDensityReference(e, noises);
      for (const node of interpolatedNodes(e)) {
        for (const [i, k, j] of [[0, 0, 0], [3, 47, 3], [1, 20, 2]] as const) {
          const v = r.voxel(s, 16 * 3 + 4 * i, -64 + 8 * k, -32 + 4 * j, node);
          expect(v === r.corner(s, node.x, i, k, j)).toBe(true); // == : lerp(a, b, 0) may turn −0 into +0
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/densityFuzz.test.ts test/unit/densityReference.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/densityFuzz.test.ts [ test/unit/densityFuzz.test.ts ]
Error: Cannot find module '../../src/gen/density/reference' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityFuzz.test.ts
FAIL  |unit| test/unit/densityReference.test.ts [ test/unit/densityReference.test.ts ]
Error: Cannot find module '../../src/gen/density/reference' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityReference.test.ts
Test Files  2 failed (2)
Tests  no tests
```

- [ ] **Step 3: Implement**

Modify `src/gen/density/expr.ts` (apply with `git apply`):

```diff
diff --git a/src/gen/density/expr.ts b/src/gen/density/expr.ts
index 2674d49..3a9808d 100644
--- a/src/gen/density/expr.ts
+++ b/src/gen/density/expr.ts
@@ -82,6 +82,17 @@ export interface DensityNoiseInfo {
 /** The density noises an expression may use, by id (Task 6 builds it from the schema's `density.noises`). */
 export type DensityNoiseLookup = (id: string) => DensityNoiseInfo | undefined;
 
+/**
+ * A density noise the evaluators sample: its validation info plus `z2(x, z)` / `z3(x, y, z)` in unscaled world block
+ * coordinates (a schema NormalNoise, or a test noise). Values lie in [−clampSigma, clampSigma].
+ */
+export interface DensityNoise extends DensityNoiseInfo {
+  z2(x: number, z: number): number;
+  z3(x: number, y: number, z: number): number;
+}
+/** Injected noises by id; also a DensityNoiseLookup, so the same source validates and evaluates. */
+export type DensityNoiseSource = (id: string) => DensityNoise | undefined;
+
 export type ExprErrorCode =
   | 'NOT_OBJECT' | 'UNKNOWN_OP' | 'UNKNOWN_KEY' | 'NOT_FINITE' | 'BAD_FIELD' | 'UNKNOWN_NOISE' | 'NOISE_DIMS'
   | 'NOISE_REMAP' | 'BAD_NAME' | 'DUPLICATE_TAP' | 'UNKNOWN_REF' | 'REF_CYCLE' | 'NESTED_INTERPOLATED'
```

Modify `src/gen/density/nodes.ts` (apply with `git apply`):

```diff
diff --git a/src/gen/density/nodes.ts b/src/gen/density/nodes.ts
index cfd3a1c..66e562c 100644
--- a/src/gen/density/nodes.ts
+++ b/src/gen/density/nodes.ts
@@ -82,6 +82,40 @@ export function evalNode(e: Expr, env: NodeEnv): number {
   }
 }
 
+// ---- Geometry and interpolation (SP3b spec §2.2) ----
+// A column is 4 × 48 × 4 cells of 4 × 8 × 4 voxels. Corners sit at local x, z ∈ {0, 4, 8, 12, 16} (i, j = 0 … 4,
+// lattice point latticeIndex(i, j)) and y = −64 + 8k (k = 0 … 48). Every fraction below is exact.
+
+/** The cell index along x or z of a local block coordinate 0 … 15. */
+export function cellXZ(l: number): number { return l >> 2; }
+/** The voxel's fraction across its cell along x or z: (l − 4·cell) / 4. */
+export function fracXZ(l: number): number { return (l - 4 * (l >> 2)) / 4; }
+/** The cell layer of a voxel y ∈ [−64, 319]: ⌊(y + 64) / 8⌋. */
+export function cellY(y: number): number { return (y + 64) >> 3; }
+/** The voxel's fraction across its cell layer: (y + 64 − 8·cell) / 8. */
+export function fracY(y: number): number { return (y + 64 - 8 * ((y + 64) >> 3)) / 8; }
+/** The y of corner layer k: −64 + 8k. */
+export function cornerY(k: number): number { return -64 + 8 * k; }
+
+/** lerp(a, b, t) = a + t · (b − a), in that order (the one definition the compiler and the reference share). */
+export function lerp(a: number, b: number, t: number): number { return a + t * (b - a); }
+
+/**
+ * Trilinear interpolation of a cell's 8 corner values in the pinned order: lerp along x on the four x-edges, then
+ * along z, then along y. `cXYZ` is the corner at (x0 + 4X, y0 + 8Y, z0 + 4Z); the arguments come x fastest, then z,
+ * then y (c000, c100, c001, c101 on the lower layer, then the upper layer), followed by tx, ty, tz.
+ */
+export function trilerp(
+  c000: number, c100: number, c001: number, c101: number, c010: number, c110: number, c011: number, c111: number,
+  tx: number, ty: number, tz: number,
+): number {
+  const e00 = lerp(c000, c100, tx);
+  const e01 = lerp(c001, c101, tx);
+  const e10 = lerp(c010, c110, tx);
+  const e11 = lerp(c011, c111, tx);
+  return lerp(lerp(e00, e01, tz), lerp(e10, e11, tz), ty);
+}
+
 // ---- Interval rules (SP3b spec §1.2) ----
 
 /** [lo, hi] as is: `const` is [v, v], `y` the cell's [y0, y1]. */
```

Create `src/gen/density/reference.ts`:

```ts
/**
 * The reference interpreter (SP3b spec §2.3): evaluates a density expression at one voxel (or one corner) by walking
 * the tree, with the compiler's placement rules and the §2.2 interpolation, recomputing everything per call. It is the
 * oracle the compiled closures must equal bit for bit (DT2 `compiledReference`, the compile fuzz).
 *
 * Placement (§2.1, §2.2):
 * - outside `interpolated` (voxel level), `y` is the voxel's y, `col` is the ColumnSample's bilinear readout at the
 *   voxel's (x, z) (`readField`), `noise2` is z2(x, z) and `noise` z3(x, y, z) at the voxel;
 * - an `interpolated` node evaluates its child at the 8 corners of the voxel's cell and interpolates them (`trilerp`);
 * - at a corner (i, k, j), `y` is −64 + 8k, `col` is the lattice value `latticeIndex(i, j)` exactly, and the noises
 *   sample the corner's world coordinates (16cx + 4i, −64 + 8k, 16cz + 4j).
 * A COLUMN sub-tree read at voxel level depends on nothing but `const`, `col` and `noise2`, so walking it with the
 * voxel's reads is its `positionFn` value at the voxel's position; a COLUMN or CELL sub-tree inside `interpolated` is
 * walked with the corner's reads (its `columnFn` / `cornerFn` value). The walk therefore needs no class pass.
 *
 * Noises are injected (`DensityNoiseSource`), so the reference runs on schema noises and on test noises alike.
 */
import { latticeIndex, readField, type ColumnSample } from '../column/columnStage';
import { EXPR_CHILD_KEYS, ExprValidationError, validateExpr, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type InterpolatedExpr, type TapExpr } from './expr';
import { cellXZ, cellY, cornerY, evalNode, fracXZ, fracY, trilerp, type DelegatedExpr, type NodeEnv } from './nodes';

const LATTICE = latticeIndex;
const READ_FIELD = readField;
const VALIDATE = validateExpr;
const INVALID = ExprValidationError;
const CHILD_KEYS = EXPR_CHILD_KEYS;
const EVAL = evalNode;
const CELL_XZ = cellXZ;
const CELL_Y = cellY;
const FRAC_XZ = fracXZ;
const FRAC_Y = fracY;
const CORNER_Y = cornerY;
const TRILERP = trilerp;

export interface DensityReference {
  /** The validated expression. */
  readonly expr: DensityExpr;
  /**
   * `e` (default: the root) at the voxel at world (x, y, z): integers, (x, z) inside `s`'s column, y ∈ [−64, 319].
   * Throws a RangeError outside.
   */
  voxel(s: ColumnSample, x: number, y: number, z: number, e?: Expr): number;
  /**
   * `e` at corner (i, k, j) of `s`'s column (i, j ∈ 0 … 4, k ∈ 0 … 48) with the corner placement: the value
   * `cornerFn`/`columnFn` hold for a node inside `interpolated`. `e` must not contain an `interpolated`.
   */
  corner(s: ColumnSample, e: Expr, i: number, k: number, j: number): number;
  /**
   * The tap `name` at a voxel: its child at the voxel when its first occurrence (evaluation order, from the root) is
   * outside `interpolated`; otherwise its child's corner values interpolated as an `interpolated` would. Throws when no
   * tap of that name is reachable from the root.
   */
  tap(s: ColumnSample, name: string, x: number, y: number, z: number): number;
}

function checkInt(v: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} ${v} is outside [${lo}, ${hi}]`);
}

/** Validates `expr` against `noises` (throws ExprValidationError) and returns its reference evaluator. */
export function createDensityReference(expr: DensityExpr, noises: DensityNoiseSource): DensityReference {
  const issues = VALIDATE(expr, noises);
  if (issues.length > 0) throw new INVALID(issues);
  const defs = expr.defs;
  const noise = (id: string): DensityNoise => {
    const n = noises(id);
    if (n === undefined) throw new Error(`unknown density noise ${id}`);
    return n;
  };

  const corner = (s: ColumnSample, e: Expr, i: number, k: number, j: number): number => {
    checkInt(i, 0, 4, 'corner i');
    checkInt(k, 0, 48, 'corner k');
    checkInt(j, 0, 4, 'corner j');
    const cx = 16 * s.cx + 4 * i, cy = CORNER_Y(k), cz = 16 * s.cz + 4 * j, li = LATTICE(i, j);
    const env: NodeEnv = {
      y: cy,
      child: (c) => EVAL(c, env),
      read: (r: DelegatedExpr) => {
        switch (r.op) {
          case 'col': return s.f[r.field][li]!;
          case 'noise2': return noise(r.id).z2(cx, cz);
          case 'noise': return noise(r.id).z3(cx, cy, cz);
          case 'ref': return EVAL(defs[r.name]!, env);
          case 'interpolated': throw new Error('an interpolated cannot be evaluated at a corner (nested interpolated)');
        }
      },
    };
    return EVAL(e, env);
  };

  const voxel = (s: ColumnSample, x: number, y: number, z: number, e: Expr = expr.root): number => {
    const lx = x - 16 * s.cx, lz = z - 16 * s.cz;
    checkInt(lx, 0, 15, 'voxel local x');
    checkInt(lz, 0, 15, 'voxel local z');
    checkInt(y, -64, 319, 'voxel y');
    const ci = CELL_XZ(lx), ck = CELL_Y(y), cj = CELL_XZ(lz);
    const tx = FRAC_XZ(lx), ty = FRAC_Y(y), tz = FRAC_XZ(lz);
    const env: NodeEnv = {
      y,
      child: (c) => EVAL(c, env),
      read: (r: DelegatedExpr) => {
        switch (r.op) {
          case 'col': return READ_FIELD(s, r.field, x, z);
          case 'noise2': return noise(r.id).z2(x, z);
          case 'noise': return noise(r.id).z3(x, y, z);
          case 'ref': return EVAL(defs[r.name]!, env);
          case 'interpolated': {
            const c = r.x;
            return TRILERP(
              corner(s, c, ci, ck, cj), corner(s, c, ci + 1, ck, cj), corner(s, c, ci, ck, cj + 1), corner(s, c, ci + 1, ck, cj + 1),
              corner(s, c, ci, ck + 1, cj), corner(s, c, ci + 1, ck + 1, cj), corner(s, c, ci, ck + 1, cj + 1), corner(s, c, ci + 1, ck + 1, cj + 1),
              tx, ty, tz,
            );
          }
        }
      },
    };
    return EVAL(e, env);
  };

  const tap = (s: ColumnSample, name: string, x: number, y: number, z: number): number => {
    const found = findTap(expr, name);
    if (found === undefined) throw new Error(`no tap ${JSON.stringify(name)} reachable from the root`);
    return voxel(s, x, y, z, found.inside ? { op: 'interpolated', x: found.node.x } : found.node.x);
  };

  return { expr, voxel, corner, tap };
}

/**
 * Walks the nodes reachable from the root in evaluation order (slot order; through refs; both rangeChoice branches),
 * with the inside-`interpolated` flag. A def is entered once per flag. `visit` returning true stops the walk.
 */
function walkReachable(expr: DensityExpr, visit: (e: Expr, inside: boolean) => boolean): void {
  const entered = new Set<string>();
  const go = (e: Expr, inside: boolean): boolean => {
    if (visit(e, inside)) return true;
    if (e.op === 'ref') {
      const key = `${inside ? 1 : 0}|${e.name}`;
      if (entered.has(key)) return false;
      entered.add(key);
      return go(expr.defs[e.name]!, inside);
    }
    const rec = e as unknown as Record<string, Expr>;
    const childInside = inside || e.op === 'interpolated';
    for (const k of CHILD_KEYS[e.op]) if (go(rec[k]!, childInside)) return true;
    return false;
  };
  go(expr.root, false);
}

/** The first occurrence of tap `name` reachable from the root (evaluation order), and whether it is inside `interpolated`. */
export function findTap(expr: DensityExpr, name: string): { readonly node: TapExpr; readonly inside: boolean } | undefined {
  let out: { node: TapExpr; inside: boolean } | undefined;
  walkReachable(expr, (e, inside) => {
    if (e.op === 'tap' && e.name === name) { out = { node: e, inside }; return true; }
    return false;
  });
  return out;
}

/** The distinct `interpolated` nodes (by identity) reachable from the root, in evaluation order. */
export function interpolatedNodes(expr: DensityExpr): InterpolatedExpr[] {
  const out: InterpolatedExpr[] = [];
  const seen = new Set<Expr>();
  walkReachable(expr, (e) => {
    if (e.op === 'interpolated' && !seen.has(e)) { seen.add(e); out.push(e); }
    return false;
  });
  return out;
}
```

Create `test/harness/densityFuzz.ts`:

```ts
/**
 * Random valid density expressions for the compile == reference and bounds fuzz (SP3b spec §10).
 *
 * Trees use every op of §1.1 over a set of noise ids: until the schema has its `density.noises` (Task 6) they are the
 * test noises of `fuzzNoiseSource()`; pass `noises` to draw over other ids. Constants are drawn as §1.2 asks
 * (`fuzzConstant`: log-uniform magnitudes in [1e-6, 1e9] with random signs, plus 0, −0 and small integers).
 *
 * Every tree is valid by construction: defs reference only earlier defs (no cycles), no `interpolated` is generated
 * inside another (a ref inside `interpolated` targets only a def without one), clamp lo ≤ hi, rangeChoice lo < hi,
 * slide knots strictly increasing, tap names unique. Heights (a ref counts as its def's height) are at most `maxDepth`
 * (default 6), so a tree has at most 2^5 multiplicative leaves of magnitude ≤ 1e9 and every value stays finite.
 */
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import type { Seed64 } from '../../src/core/hash';
import { SAMPLE_FIELDS } from '../../src/gen/column/columnStage';
import { exprChildren, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type SlideKnot } from '../../src/gen/density/expr';
import { testFloat } from './stats';

export interface FuzzNoiseSpec { readonly id: string; readonly dims: 2 | 3; readonly def: NoiseDef }

/** The test noise map: two 2D and two 3D noises of different wavelengths, octaves, yScale and clampSigma. */
export const FUZZ_NOISE_SPECS: readonly FuzzNoiseSpec[] = [
  { id: 'fz2a', dims: 2, def: completeNoiseDef({ wavelength: 16, octaves: 2 }) },
  { id: 'fz2b', dims: 2, def: completeNoiseDef({ wavelength: 64, octaves: 1, clampSigma: 2.5 }) },
  { id: 'fz3a', dims: 3, def: completeNoiseDef({ wavelength: 8, octaves: 1 }) },
  { id: 'fz3b', dims: 3, def: completeNoiseDef({ wavelength: 32, octaves: 2, yScale: 2, clampSigma: 4 }) },
];

/** Wraps a NormalNoise as a DensityNoise (Task 6 does the same for the schema's density noises). */
export function densityNoiseOf(n: NormalNoise, dims: 2 | 3): DensityNoise {
  return { dims, remap: n.def.remap, clampSigma: n.clamp, z2: (x, z) => n.z2(x, z), z3: (x, y, z) => n.z3(x, y, z) };
}

/** The test noises as a DensityNoiseSource; seed names are `density.noises.<id>` under `seed`. */
export function fuzzNoiseSource(seed: Seed64 = [0x5eed, 0x3b]): DensityNoiseSource {
  const m = new Map<string, DensityNoise>();
  for (const { id, dims, def } of FUZZ_NOISE_SPECS) m.set(id, densityNoiseOf(new NormalNoise(seed, `density.noises.${id}`, def), dims));
  return (id) => m.get(id);
}

/** 1/8 +0, 1/8 −0, 1/8 an integer in [−10, 10], else a log-uniform magnitude in [1e-6, 1e9] with a random sign. */
export function fuzzConstant(next: () => number): number {
  const r = next() % 8;
  if (r === 0) return 0;
  if (r === 1) return -0;
  if (r === 2) return (next() % 21) - 10;
  const mag = Math.exp(Math.log(1e-6) + (Math.log(1e9) - Math.log(1e-6)) * testFloat(next));
  const m = mag < 1e-6 ? 1e-6 : mag > 1e9 ? 1e9 : mag;
  return next() % 2 === 0 ? m : -m;
}

/** A threshold for clamp / rangeChoice: half the time in [−8, 8] (so both sides occur on typical values), else fuzzConstant. */
function threshold(next: () => number): number {
  return next() % 2 === 0 ? (testFloat(next) - 0.5) * 16 : fuzzConstant(next);
}

function knots(next: () => number): SlideKnot[] {
  const n = 2 + (next() % 4);
  const out: SlideKnot[] = [];
  let y = -80 + (next() % 120);
  for (let i = 0; i < n; i++) {
    const v = next() % 3 === 0 ? (next() % 5) - 2 : (testFloat(next) - 0.5) * 4;
    out.push([y, v]);
    y += 1 + (next() % 120) + (next() % 4 === 0 ? 0.5 : 0);
  }
  return out;
}

/** The height of a node: leaves 1, a ref its def's height. */
export function exprHeight(e: Expr, defs: Readonly<Record<string, Expr>>): number {
  if (e.op === 'ref') return exprHeight(defs[e.name]!, defs);
  let h = 0;
  for (const c of exprChildren(e)) h = Math.max(h, exprHeight(c, defs));
  return h + 1;
}

function hasInterpolated(e: Expr, defs: Readonly<Record<string, Expr>>): boolean {
  if (e.op === 'interpolated') return true;
  if (e.op === 'ref') return hasInterpolated(defs[e.name]!, defs);
  return exprChildren(e).some((c) => hasInterpolated(c, defs));
}

export interface DensityFuzzOptions {
  /** Noise ids and dims to draw from (default FUZZ_NOISE_SPECS). */
  readonly noises?: readonly { readonly id: string; readonly dims: 2 | 3 }[];
  /** Maximum height (default 6: keeps every value finite). */
  readonly maxDepth?: number;
  /** Maximum number of defs (default 3). */
  readonly maxDefs?: number;
}

type Op = Expr['op'];
const INNER_OPS: readonly Op[] = ['add', 'mul', 'min', 'max', 'neg', 'abs', 'square', 'clamp', 'slide', 'interpolated', 'rangeChoice', 'tap'];
const LEAF_OPS: readonly Op[] = ['const', 'y', 'col', 'noise2', 'noise', 'ref'];

/** A random valid DensityExpr drawn from `next` (u32 stream, e.g. testRng). */
export function randomDensityExpr(next: () => number, opts: DensityFuzzOptions = {}): DensityExpr {
  const noises = opts.noises ?? FUZZ_NOISE_SPECS;
  const n2 = noises.filter((n) => n.dims === 2), n3 = noises.filter((n) => n.dims === 3);
  const maxDepth = opts.maxDepth ?? 6;
  const defs: Record<string, Expr> = {};
  const defInfo: Array<{ name: string; height: number; interp: boolean }> = [];
  let taps = 0;
  const pick = <T>(xs: readonly T[]): T => xs[next() % xs.length]!;

  const leaf = (budget: number, inside: boolean): Expr => {
    for (;;) {
      const op = pick(LEAF_OPS);
      switch (op) {
        case 'const': return { op, v: fuzzConstant(next) };
        case 'y': return { op };
        case 'col': return { op, field: pick(SAMPLE_FIELDS) };
        case 'noise2': if (n2.length > 0) return { op, id: pick(n2).id }; break;
        case 'noise': if (n3.length > 0) return { op, id: pick(n3).id }; break;
        case 'ref': {
          const ok = defInfo.filter((d) => d.height <= budget && !(inside && d.interp));
          if (ok.length > 0) return { op, name: pick(ok).name };
          break;
        }
        default: break;
      }
    }
  };

  const gen = (budget: number, inside: boolean): Expr => {
    if (budget <= 1 || next() % 4 === 0) return leaf(budget, inside);
    const sub = budget - 1;
    for (;;) {
      const op = pick(INNER_OPS);
      switch (op) {
        case 'add': case 'mul': case 'min': case 'max': return { op, a: gen(sub, inside), b: gen(sub, inside) };
        case 'neg': case 'abs': case 'square': return { op, x: gen(sub, inside) };
        case 'clamp': {
          const a = threshold(next), b = threshold(next);
          return { op, x: gen(sub, inside), lo: a <= b ? a : b, hi: a <= b ? b : a };
        }
        case 'slide': return { op, x: gen(sub, inside), knots: knots(next) };
        case 'interpolated': if (!inside) return { op, x: gen(sub, true) }; break;
        case 'rangeChoice': {
          const a = threshold(next);
          let b = threshold(next);
          if (b === a) b = a + 1;
          return { op, x: gen(sub, inside), lo: a < b ? a : b, hi: a < b ? b : a, inside: gen(sub, inside), outside: gen(sub, inside) };
        }
        case 'tap': return { op, name: `t${taps++}`, x: gen(sub, inside) };
        default: break;
      }
    }
  };

  const nDefs = next() % ((opts.maxDefs ?? 3) + 1);
  for (let i = 0; i < nDefs; i++) {
    const name = `d${i}`;
    const e = gen(1 + (next() % (maxDepth - 1)), next() % 2 === 0);
    defs[name] = e;
    defInfo.push({ name, height: exprHeight(e, defs), interp: hasInterpolated(e, defs) });
  }
  return { root: gen(maxDepth, false), defs };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/densityFuzz.test.ts test/unit/densityReference.test.ts`

Expected: PASS (exit 0)

```
Test Files  2 passed (2)
Tests  20 passed (20)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  125 passed | 2 skipped (127)
Tests  1637 passed | 3 skipped (1640)
```

- [ ] **Step 6: Commit**

```bash
git add src/gen/density/expr.ts src/gen/density/nodes.ts src/gen/density/reference.ts test/harness/densityFuzz.ts test/unit/densityFuzz.test.ts test/unit/densityReference.test.ts
git commit -F - <<'EOF'
feat(gen/density): geometry, reference interpreter and fuzz generator

SP3b spec §2.2, §2.3: nodes.ts gains the cell geometry (cellXZ, fracXZ,
cellY, fracY, cornerY), lerp and trilerp (x, then z, then y), shared by the
reference and the compiler. reference.ts evaluates an expression at a voxel
or a corner by walking the tree with the placement rules: bilinear col and
voxel-sampled noises outside interpolated, lattice col and corner-sampled
noises at corners, trilinear interpolation of the cell's corners. Noises are
injected through DensityNoiseSource (expr.ts), so the reference runs on test
noises until the schema's density noises exist. test/harness/densityFuzz.ts
draws random valid trees over every op, with log-uniform constants.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `0e3d226` on `dry/sp3a`; 6 files changed, 723 insertions(+)):

Commit Task 3 on `dry/sp3b-density` (worktree `P/dry-density`, parent Task 2; 6 files, 723 insertions). RED (the commit's test files over the parent): both files fail to import (`Cannot find module '../../src/gen/density/reference'`), "no tests", plus 21 `tsc -p tsconfig.test.json` errors (missing `DensityNoise`/`DensityNoiseSource`, `lerp`, `trilerp`, the geometry functions, `reference`, `densityFuzz`). GREEN: typecheck clean (1.2 s); the two files 20 tests in 0.5 s; `npm test` 125 files passed, 2 skipped; 1637 tests passed, 3 skipped (28.7 s wall).

- Ruling (API, noises injected, `expr.ts`): `DensityNoise extends DensityNoiseInfo { z2(x, z); z3(x, y, z) }` (unscaled world block coordinates, values in [−clampSigma, clampSigma]) and `DensityNoiseSource = (id) => DensityNoise | undefined`, which is also a `DensityNoiseLookup`, so one source both validates and evaluates. Task 6 wraps each schema `density.noises.<id>` NormalNoise the way `densityNoiseOf(n, dims)` in `test/harness/densityFuzz.ts` does (`{dims, remap: n.def.remap, clampSigma: n.clamp, z2, z3}`; move it to `context.ts`). Task 4's `compile(expr, noises: DensityNoiseSource)` should take the same source — cost if wrong: one adapter.
- Ruling (API, `nodes.ts` geometry): `cellXZ(l) = l >> 2`, `fracXZ(l) = (l − 4·cellXZ(l)) / 4`, `cellY(y) = (y + 64) >> 3`, `fracY(y) = (y + 64 − 8·cellY(y)) / 8`, `cornerY(k) = −64 + 8k`; all fractions are exact. `lerp(a, b, t) = a + t * (b − a)` and `trilerp(c000, c100, c001, c101, c010, c110, c011, c111, tx, ty, tz)` (`cXYZ` = corner at (x0 + 4X, y0 + 8Y, z0 + 4Z); arguments x fastest, then z, then y; four x-edge lerps, then two z lerps, then one y lerp). Task 4's voxelFn calls `trilerp` (or the identical inline expression) with the same argument mapping. The test shows the y-first order differs on >100 of 2000 random cells, and that `(1 − t)·a + t·b` differs from `lerp` — cost if wrong: none.
- Ruling (API, `reference.ts`): `createDensityReference(expr, noises): DensityReference` validates (throws `ExprValidationError`) and returns `{ expr, voxel(s, x, y, z, e = root), corner(s, e, i, k, j), tap(s, name, x, y, z) }`. `voxel` takes world coordinates (integers, (x, z) inside `s`'s column, y ∈ [−64, 319]; RangeError otherwise); `corner` takes i, j ∈ 0 … 4, k ∈ 0 … 48 and any sub-expression without `interpolated` (it throws on one). Everything is recomputed per call (8 corner walks per `interpolated` read). Helpers: `findTap(expr, name) → {node, inside} | undefined` and `interpolatedNodes(expr) → InterpolatedExpr[]` (distinct by identity, reachable from the root through refs, in evaluation order; unreachable defs are ignored). Task 4's fuzz compares, per tree: `voxel` against voxelFn at random voxels, and `corner(s, node.x, i, k, j)` against cornerFn for each of `interpolatedNodes(expr)` — cost if wrong: none.
- Ruling (placement in the reference): the walk takes no class pass. Outside `interpolated` it reads `col` through `readField` at the voxel (x, z), `noise2` as z2(x, z) and `noise` as z3(x, y, z); at a corner it reads the lattice value `s.f[field][latticeIndex(i, j)]` exactly and samples noises at (16cx + 4i, −64 + 8k, 16cz + 4j). A COLUMN sub-tree reads only `const`/`col`/`noise2`, so walking it with the voxel's reads gives exactly its positionFn value, and with a corner's reads its columnFn value. That is the spec's placement, and the compiler's CSE by placement cannot change a value. Tested: a lattice value the bilinear readout cannot reach at x = 16 (v00 = 1e17, v10 = 0.1) comes back exactly at the corner, `slide` reads the voxel y outside and the corner y inside (0.5 vs 0.25), and `noise2` at a voxel differs from `interpolated(noise2)` — cost if wrong: none.
- Ruling (taps): a tap's voxel value is its child at the voxel when its first occurrence reachable from the root (evaluation order: slot order, both rangeChoice branches, through refs) is outside `interpolated`. When that occurrence is inside, the value is the trilinear interpolation of its child's corner values, i.e. what an `interpolated` around it would give. A tap only in an unreachable def, or an unknown name, throws `no tap "<name>" reachable from the root`. The probe (Task 6) should follow the same rule — cost if wrong: one branch in probe and reference.
- Ruling (fuzz, `test/harness/densityFuzz.ts`): `randomDensityExpr(next, {noises?, maxDepth = 6, maxDefs = 3})` with `next` a u32 stream (`testRng`). Defs `d0…` reference only earlier defs. `interpolated` is never generated inside another, and a ref inside one targets only a def without one. Taps are `t0, t1, …`. clamp lo ≤ hi and rangeChoice lo < hi are drawn half the time uniform in [−8, 8] (both branches occur) and otherwise by `fuzzConstant`. Slide has 2 to 5 knots, y from [−80, 40) with steps of 1 to 120 (a quarter of them + 0.5), and v ∈ [−2, 2]. `col` draws any `SAMPLE_FIELDS` member. `exprHeight` counts a ref as its def's height. With height ≤ 6 a tree has at most 2^5 multiplicative leaves of magnitude ≤ 1e9, so every value is finite (< 1e300) and Task 5's soundness fuzz needs no NaN/∞ handling. `fuzzConstant` gives 1/8 +0, 1/8 −0, 1/8 an integer in [−10, 10], and 5/8 log-uniform in [1e-6, 1e9] with a random sign (§1.2). Test noises `FUZZ_NOISE_SPECS`: fz2a (λ 16, 2 oct), fz2b (λ 64, 1 oct, clampSigma 2.5), fz3a (λ 8, 1 oct), fz3b (λ 32, 2 oct, yScale 2, clampSigma 4), seed names `density.noises.<id>` under seed [0x5eed, 0x3b]. Once Task 6 lands, pass `noises: <schema ids with dims>` and the schema-built source to fuzz over the real noises — cost if wrong: none (test-only).
- Ruling (tests): corner sharing across a chunk border is tested with a real GenContext ('42') and fuzz noises: corner (4, k, j) of column (cx, cz) is `Object.is` corner (0, k, j) of (cx + 1, cz), and the same for z, at (−1, −1), (0, 0) and (5, −7), over 2 hand expressions and 10 fuzz interpolated sub-trees. A voxel on a cell corner equals that corner through `interpolated` with `==`, not `Object.is`: `lerp(−0, b, 0) = −0 + 0·(b − (−0))` is +0 when b ≥ 0. Compiled values match this because they share `lerp` — cost if wrong: none.

---

### Task 4: gen/density: the compiler

**Spec:** §2.1

**Files:**
- Create: `src/gen/density/compile.ts`
- Create: `test/unit/densityCompile.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/expr.ts` (Task 2): `EXPR_CHILD_KEYS`, `ExprValidationError`, `type DensityExpr`, `type DensityNoise`, `type DensityNoiseSource`, `type Expr`, `type ExprOp`, `type InterpolatedExpr`, `validateExpr`
  - `src/gen/density/nodes.ts` (Task 2): `cornerY`, `joinClass`, `ownClass`, `slideAt`, `trilerp`, `type DensityClass`
  - `src/gen/density/reference.ts` (Task 3): `findTap`
- Produces (exports added by this task):
  - `src/gen/density/compile.ts`:
    - `export interface DensityNode`
    - `export interface CompiledDensity`
    - `export function colValueIndex(slot: number, i: number, j: number): number { return slot * 25 + j * 5 + i; }`
    - `export function posValueIndex(slot: number, lx: number, lz: number): number { return slot * 256 + lz * 16 + lx; }`
    - `export function cornerValueIndex(slot: number, i: number, k: number, j: number): number { return slot * 1225 + (k * 5 + j) * 5 + i; }`
    - `export function compileDensity(expr: DensityExpr, noises: DensityNoiseSource): CompiledDensity`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/densityCompile.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { buildColumnSample, latticeIndex, newColumnSample, readField, SAMPLE_FIELDS, type ColumnSample } from '../../src/gen/column/columnStage';
import { colValueIndex, compileDensity, cornerValueIndex, posValueIndex, type CompiledDensity } from '../../src/gen/density/compile';
import { exprChildren, exprHash, ExprValidationError, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type InterpolatedExpr } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: (typeof SAMPLE_FIELDS)[number]): Expr => ({ op: 'col', field });
const n2 = (id: string): Expr => ({ op: 'noise2', id });
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): InterpolatedExpr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const ref = (name: string): Expr => ({ op: 'ref', name });
const SLIDE: Expr = { op: 'slide', x: C(1), knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] };
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });

/** A fake density noise whose calls are logged as [x, z] / [x, y, z]. */
function fake(dims: 2 | 3, f: (x: number, y: number, z: number) => number, log: number[][] = []): DensityNoise {
  return {
    dims, remap: 'none', clampSigma: 4,
    z2: (x, z) => { log.push([x, z]); return f(x, 0, z); },
    z3: (x, y, z) => { log.push([x, y, z]); return f(x, y, z); },
  };
}
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

/** A hand-built ColumnSample at column (2, −3): E is i + 10·j on the lattice, offset i·j, every other field 0. */
function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      s.f.E[latticeIndex(i, j)] = i + 10 * j;
      s.f.offset[latticeIndex(i, j)] = i * j + 0.5;
    }
  }
  return s;
}
const X0 = 32;   // 16 · cx
const Z0 = -48;  // 16 · cz

function begin(c: CompiledDensity, s: ColumnSample): void {
  c.columnFn(s);
  c.positionFn(s);
}

/** The node of `c` whose representative source node is `e` (by identity) and placement `inside`. */
function nodeOf(c: CompiledDensity, e: Expr, inside: boolean) {
  const n = c.nodes.find((m) => m.expr === e && m.inside === inside);
  if (n === undefined) throw new Error(`no node for ${e.op} (inside ${inside})`);
  return n;
}

describe('compileDensity: stage placement (SP3b spec §2.1)', () => {
  test('y and slide are never COLUMN: VOXEL outside interpolated, CELL inside', () => {
    const slideIn: Expr = { op: 'slide', x: col('E'), knots: [[0, 0], [8, 1]] };
    const yIn: Expr = { op: 'y' };
    const e = only(add(add(Y, SLIDE), interp(add(slideIn, yIn))));
    const c = compileDensity(e, source({}));
    expect(nodeOf(c, Y, false).cls).toBe('voxel');
    expect(nodeOf(c, SLIDE, false).cls).toBe('voxel');
    expect(nodeOf(c, slideIn, true).cls).toBe('cell');
    expect(nodeOf(c, yIn, true).cls).toBe('cell');
    expect(nodeOf(c, (slideIn as { x: Expr }).x, true)).toMatchObject({ cls: 'column', colSlot: 0, posSlot: -1 });
    // A slide of a constant still reads y: VOXEL, evaluated per voxel.
    expect(nodeOf(c, (SLIDE as { x: Expr }).x, false)).toMatchObject({ cls: 'column', posSlot: -1, colSlot: -1 });
    expect(c.nodes.filter((n) => n.cls === 'column' && n.op === 'slide')).toEqual([]);
    expect(c.nodes.filter((n) => n.cls === 'column' && n.op === 'y')).toEqual([]);
  });

  test('a COLUMN sub-tree read by a VOXEL node goes through positionFn, at the 16 × 16 positions', () => {
    const log2: number[][] = [], log3: number[][] = [];
    const a = fake(2, (x, _y, z) => x - 0.25 * z, log2);
    const b = fake(3, (x, y, z) => x + y + z, log3);
    const amp = mul(col('E'), n2('a'));
    const c = compileDensity(only(add(amp, n3('b'))), source({ a, b }));
    expect(nodeOf(c, amp, false)).toMatchObject({ cls: 'column', posSlot: 0, colSlot: -1 });
    expect(c.columnSlotCount).toBe(0);
    expect(c.positionSlotCount).toBe(1);
    const s = handSample();
    c.columnFn(s);
    expect(log2).toEqual([]);
    c.positionFn(s);
    expect(log2.length).toBe(256);
    expect(new Set(log2.map(([x, z]) => `${x},${z}`)).size).toBe(256);
    for (const [x, z] of log2) {
      expect(x - X0).toBeGreaterThanOrEqual(0);
      expect(x - X0).toBeLessThan(16);
      expect(z - Z0).toBeGreaterThanOrEqual(0);
      expect(z - Z0).toBeLessThan(16);
    }
    // The stored value: bilinear E at the position times noise2 at the position's integer (x, z).
    for (const [lx, lz] of [[0, 0], [5, 9], [15, 15]] as const) {
      const want = readField(s, 'E', X0 + lx, Z0 + lz) * a.z2(X0 + lx, Z0 + lz);
      expect(c.posValues[posValueIndex(0, lx, lz)]).toBe(want);
    }
    log2.length = 0;
    log3.length = 0;
    expect(c.voxelFn(5, 70, 9)).toBe(c.posValues[posValueIndex(0, 5, 9)]! + (X0 + 5 + 70 + Z0 + 9));
    expect(log2).toEqual([]);
    expect(log3).toEqual([[X0 + 5, 70, Z0 + 9]]);
  });

  test('a COLUMN sub-tree inside interpolated goes through columnFn, at the 5 × 5 corner columns, from the lattice', () => {
    const log2: number[][] = [];
    const a = fake(2, (x, _y, z) => x * 0.5 + z, log2);
    const inner = add(col('offset'), n2('a'));
    const c = compileDensity(only(interp(add(inner, Y))), source({ a }));
    expect(nodeOf(c, inner, true)).toMatchObject({ cls: 'column', colSlot: 0, posSlot: -1 });
    expect(c.positionSlotCount).toBe(0);
    const s = handSample();
    c.columnFn(s);
    expect(log2.length).toBe(25);
    for (let j = 0; j <= 4; j++) {
      for (let i = 0; i <= 4; i++) {
        const x = X0 + 4 * i, z = Z0 + 4 * j;
        expect(c.colValues[colValueIndex(0, i, j)]).toBe(s.f.offset[latticeIndex(i, j)]! + (x * 0.5 + z));
      }
    }
    c.positionFn(s);
    expect(log2.length).toBe(25);
    c.cornerFn(1, 20, 3);
    expect(c.cornerValues[cornerValueIndex(0, 1, 20, 3)]).toBe(c.colValues[colValueIndex(0, 1, 3)]! + (-64 + 8 * 20));
    expect(log2.length).toBe(25);
    // A lattice value the bilinear readout cannot reach at x = 16 (v00 + (v10 − v00) · 1 ≠ v10) comes back exactly.
    const t = handSample();
    t.f.E[latticeIndex(3, 0)] = 1e17;
    t.f.E[latticeIndex(4, 0)] = 0.1;
    expect(readField(t, 'E', X0 + 16, Z0)).not.toBe(0.1);
    const e = compileDensity(only(interp(col('E'))), source({}));
    e.columnFn(t);
    expect(e.colValues[colValueIndex(0, 4, 0)]).toBe(0.1);
    e.cornerFn(4, 7, 0);
    expect(e.cornerValues[cornerValueIndex(0, 4, 7, 0)]).toBe(0.1);
  });

  test('cornerFn evaluates each corner once per column; voxelFn fills its cell first; columnFn starts a new column', () => {
    const log: number[][] = [];
    const q = fake(3, (x, y, z) => x * 0.25 + y * 0.5 + z, log);
    const c = compileDensity(only(interp(n3('q'))), source({ q }));
    expect(c.interpolatedSlotCount).toBe(1);
    const s = handSample();
    begin(c, s);
    c.cornerFn(2, 10, 4);
    c.cornerFn(2, 10, 4);
    expect(log).toEqual([[X0 + 8, -64 + 80, Z0 + 16]]);
    expect(c.cornerReady[2 + 5 * 4 + 25 * 10]).toBe(1);
    log.length = 0;
    // Every voxel of the column: each of the 5 × 49 × 5 corners exactly once.
    for (let y = -64; y <= 319; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) c.voxelFn(lx, y, lz);
    expect(log.length).toBe(1225 - 1);
    // The affine noise is reproduced exactly at a voxel.
    expect(c.voxelFn(5, 70, 9)).toBe((X0 + 5) * 0.25 + 70 * 0.5 + Z0 + 9);
    log.length = 0;
    const t = handSample();
    t.cx = 3;
    begin(c, t);
    expect(c.cornerReady.every((v) => v === 0)).toBe(true);
    expect(c.voxelFn(0, -64, 0)).toBe((X0 + 16) * 0.25 - 32 + Z0);
    expect(log.length).toBe(8);
  });

  test('cellCorners fills the 8 corners of one cell; positionFn needs the column of columnFn', () => {
    const c = compileDensity(only(add(interp(Y), col('E'))), source({}));
    const s = handSample();
    c.columnFn(s);
    expect(c.hasColumn(2, -3)).toBe(true);
    expect(c.hasPositions(2, -3)).toBe(false);
    c.cellCorners(1, 47, 3);
    const ready: number[] = [];
    c.cornerReady.forEach((v, k) => { if (v === 1) ready.push(k); });
    expect(ready).toEqual([1 + 15 + 25 * 47, 2 + 15 + 25 * 47, 1 + 20 + 25 * 47, 2 + 20 + 25 * 47,
      1 + 15 + 25 * 48, 2 + 15 + 25 * 48, 1 + 20 + 25 * 48, 2 + 20 + 25 * 48]);
    expect(c.cornerValues[cornerValueIndex(0, 2, 48, 4)]).toBe(320);
    const other = handSample();
    other.cz = 7;
    expect(() => c.positionFn(other)).toThrow(/columnFn/);
    c.positionFn(s);
    expect(c.hasPositions(2, -3)).toBe(true);
    expect(c.hasColumn(2, 7)).toBe(false);
  });

  test('rangeChoice evaluates x, then only the chosen branch', () => {
    const boom = fake(3, () => { throw new Error('evaluated'); });
    const c = compileDensity(only({ op: 'rangeChoice', x: Y, lo: 0, hi: 64, inside: C(1), outside: n3('boom') }), source({ boom }));
    begin(c, handSample());
    expect(c.voxelFn(0, 0, 0)).toBe(1);
    expect(c.voxelFn(0, 63, 0)).toBe(1);
    expect(() => c.voxelFn(0, 64, 0)).toThrow('evaluated');
  });

  test('the root may be COLUMN (read from positionFn) or a bare interpolated', () => {
    const s = handSample();
    const c = compileDensity(only(col('E')), source({}));
    begin(c, s);
    expect(c.voxelFn(6, 100, 10)).toBe(readField(s, 'E', X0 + 6, Z0 + 10));
    const k = compileDensity(only(C(-0)), source({}));
    begin(k, s);
    expect(Object.is(k.voxelFn(3, 3, 3), -0)).toBe(true);
    const i = compileDensity(only(interp(col('E'))), source({}));
    begin(i, s);
    expect(i.voxelFn(6, 100, 10)).toBe(1.5 + 25);
  });

  test('invalid expressions throw ExprValidationError with real node paths', () => {
    let err: unknown;
    try { compileDensity(only(add(Y, n3('missing')), { d: interp(interp(Y)) }), source({})); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ExprValidationError);
    expect((err as ExprValidationError).issues.map((i) => i.path)).toEqual(['root.b.id']);
    expect(() => compileDensity(only(ref('d'), { d: interp(interp(Y)) }), source({}))).toThrow(/defs\.d\.x: NESTED_INTERPOLATED/);
  });
});

describe('compileDensity: placement-keyed CSE', () => {
  test('equal sub-trees are shared within one placement and evaluated once per point', () => {
    const log: number[][] = [];
    const q = fake(3, (x, y, z) => x + y - z, log);
    // Two separate (structurally equal) copies of square(noise q) outside interpolated.
    const e = only(add({ op: 'square', x: n3('q') }, { op: 'square', x: n3('q') }));
    const c = compileDensity(e, source({ q }));
    expect(c.nodes.map((n) => n.op)).toEqual(['noise', 'square', 'add']);
    expect(c.nodes[2]!.kids).toEqual([1, 1]);
    begin(c, handSample());
    log.length = 0;
    const v = c.voxelFn(1, 2, 3);
    expect(log.length).toBe(1);
    expect(v).toBe(2 * (X0 + 1 + 2 - (Z0 + 3)) ** 2);
  });

  test('the same sub-tree inside and outside interpolated gives two nodes, one per placement', () => {
    const outside = add(n2('a'), Y);
    const inside = add(n2('a'), Y);
    const c = compileDensity(only(add(outside, interp(inside))), source({ a: fake(2, (x) => x) }));
    const o = nodeOf(c, outside, false), i = nodeOf(c, inside, true);
    expect(o).not.toBe(i);
    expect(o.cls).toBe('voxel');
    expect(i.cls).toBe('cell');
    expect(c.nodes.filter((n) => n.op === 'noise2').map((n) => [n.inside, n.colSlot, n.posSlot])).toEqual([[false, -1, 0], [true, 0, -1]]);
  });

  test('refs resolve to their def; an inline copy of a def is the same node; −0 ≠ +0; tap names count', () => {
    const d = mul(col('E'), C(2));
    const c = compileDensity(only(add(add(ref('d'), ref('d')), add(mul(col('E'), C(2)), interp(ref('d')))), { d }), source({}));
    const outer = c.nodes.filter((n) => n.op === 'mul' && !n.inside);
    expect(outer.length).toBe(1);
    expect(c.nodes.filter((n) => n.op === 'mul' && n.inside).length).toBe(1);
    expect(c.nodes.some((n) => (n.op as string) === 'ref')).toBe(false);
    const z = compileDensity(only(add(C(0), C(-0))), source({}));
    expect(z.nodes.filter((n) => n.op === 'const').length).toBe(2);
    const t = compileDensity(only(add({ op: 'tap', name: 'a', x: Y }, { op: 'tap', name: 'b', x: Y })), source({}));
    expect(t.nodes.filter((n) => n.op === 'tap').length).toBe(2);
    expect(t.nodes.filter((n) => n.op === 'y').length).toBe(1);
  });

  test('structurally equal interpolated nodes share one corner slot', () => {
    const a = interp(add(Y, col('E'))), b = interp(add(Y, col('E')));
    const c = compileDensity(only(mul(a, b)), source({}));
    expect(c.interpolatedSlotCount).toBe(1);
    expect(c.interpolatedSlot(a)).toBe(0);
    expect(c.interpolatedSlot(b)).toBe(0);
    expect(c.interpolatedSlot(interp(Y))).toBe(-1);
  });

  test('on random trees the nodes are exactly the distinct (structural hash, inside) keys after ref resolution', () => {
    const next = testRng(401);
    const noises = fuzzNoiseSource();
    for (let n = 0; n < 200; n++) {
      const e = randomDensityExpr(next);
      const keys = new Set<string>();
      const memo = new WeakMap<Expr, string>();
      const resolved = new Map<Expr, Expr>();
      const resolve = (x: Expr): Expr => {
        if (x.op === 'ref') return resolve(e.defs[x.name]!);
        const hit = resolved.get(x);
        if (hit !== undefined) return hit;
        const rec: Record<string, unknown> = { ...x };
        const keysOf = Object.keys(rec).filter((k) => typeof rec[k] === 'object' && rec[k] !== null && !Array.isArray(rec[k]));
        for (const k of keysOf) rec[k] = resolve(rec[k] as Expr);
        resolved.set(x, rec as unknown as Expr);
        return rec as unknown as Expr;
      };
      const walk = (x: Expr, inside: boolean) => {
        keys.add(`${exprHash(x, memo)}|${inside ? 1 : 0}`);
        for (const k of exprChildren(x)) walk(k, inside || x.op === 'interpolated');
      };
      walk(resolve(e.root), false);
      expect(compileDensity(e, noises).nodes.length).toBe(keys.size);
    }
  });
});

describe('compileDensity: compiled == reference, bit for bit (fuzz)', () => {
  const ctx = ctxFor('42');
  const noises = fuzzNoiseSource();
  const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));

  test('voxels, corners and taps on random trees', () => {
    const next = testRng(402);
    let voxels = 0, corners = 0, taps = 0, interpTrees = 0;
    for (let n = 0; n < 300; n++) {
      const e = randomDensityExpr(next);
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      const nodes = interpolatedNodes(e);
      if (nodes.length > 0) interpTrees++;
      const tapNames = new Set<string>();
      JSON.stringify(e, (k, v: unknown) => { if (k === 'name' && typeof v === 'string' && v.startsWith('t')) tapNames.add(v); return v; });
      // Two columns, then the first again: the scratch is reused across columns.
      for (const s of [samples[n % 4]!, samples[(n + 1) % 4]!, samples[n % 4]!]) {
        begin(c, s);
        for (let m = 0; m < 24; m++) {
          const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
          const want = r.voxel(s, 16 * s.cx + lx, y, 16 * s.cz + lz);
          const got = c.voxelFn(lx, y, lz);
          if (!Object.is(got, want)) throw new Error(`tree ${n}: voxel (${lx}, ${y}, ${lz}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
          voxels++;
        }
        for (const node of nodes) {
          const slot = c.interpolatedSlot(node);
          expect(slot).toBeGreaterThanOrEqual(0);
          for (let m = 0; m < 8; m++) {
            const i = next() % 5, k = next() % 49, j = next() % 5;
            c.cornerFn(i, k, j);
            const want = r.corner(s, node.x, i, k, j);
            const got = c.cornerValues[cornerValueIndex(slot, i, k, j)]!;
            if (!Object.is(got, want)) throw new Error(`tree ${n}: corner (${i}, ${k}, ${j}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
            corners++;
          }
        }
        for (const name of tapNames) {
          let reachable = true;
          try { r.tap(s, name, 16 * s.cx, 0, 16 * s.cz); } catch { reachable = false; }
          if (!reachable) { expect(() => c.tapFn(name, 0, 0, 0)).toThrow(/no tap/); continue; }
          for (let m = 0; m < 3; m++) {
            const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
            const want = r.tap(s, name, 16 * s.cx + lx, y, 16 * s.cz + lz);
            const got = c.tapFn(name, lx, y, lz);
            if (!Object.is(got, want)) throw new Error(`tree ${n}: tap ${name} at (${lx}, ${y}, ${lz}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
            taps++;
          }
        }
      }
    }
    expect(voxels).toBe(300 * 3 * 24);
    expect(interpTrees).toBeGreaterThan(60);
    expect(corners).toBeGreaterThan(2000);
    expect(taps).toBeGreaterThan(500);
  });

  test('every voxel of one cell layer per column, in scan order, on trees with interpolated', () => {
    const next = testRng(403);
    let trees = 0;
    while (trees < 12) {
      const e = randomDensityExpr(next);
      if (interpolatedNodes(e).length === 0) continue;
      trees++;
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      const s = samples[trees % 4]!;
      begin(c, s);
      const y0 = -64 + 8 * (next() % 48);
      for (let y = y0; y < y0 + 8; y++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const want = r.voxel(s, 16 * s.cx + lx, y, 16 * s.cz + lz);
            const got = c.voxelFn(lx, y, lz);
            if (!Object.is(got, want)) throw new Error(`voxel (${lx}, ${y}, ${lz}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
          }
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/densityCompile.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/densityCompile.test.ts [ test/unit/densityCompile.test.ts ]
Error: Cannot find module '../../src/gen/density/compile' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityCompile.test.ts
Test Files  1 failed (1)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `src/gen/density/compile.ts`:

```ts
/**
 * The density compiler (SP3b spec §2.1): validation, ref resolution, placement-keyed CSE, classification and closure
 * emission over typed scratch arrays (no `new Function`, no `eval`). The compiled closures equal the reference
 * interpreter (reference.ts) bit for bit: they use the same per-op expressions (nodes.ts) in the same order, the same
 * reads per placement and the same `trilerp`.
 *
 * Nodes. After ref resolution, equal sub-trees are one node per placement: the CSE key is the node's structure (op,
 * scalar fields with −0 ≠ +0, tap names, its children's nodes) plus the inside-`interpolated` flag. Each node has a
 * class (COLUMN < CELL < VOXEL; `y`, `slide` and `noise` are CELL inside `interpolated` and VOXEL outside; an
 * `interpolated` node is VOXEL) and is evaluated by one of four closures:
 * - `columnFn(s)`: the COLUMN nodes inside `interpolated` that a non-COLUMN node reads (column slots), at the 5 × 5
 *   corner columns: `col` is the lattice value, `noise2` z2 at the corner column's (x, z);
 * - `positionFn(s)`: the COLUMN nodes outside `interpolated` that a non-COLUMN node reads (position slots), and COLUMN
 *   taps, at the 16 × 16 block positions: `col` is `readField`'s bilinear readout, `noise2` z2 at the position;
 * - `cornerFn(i, k, j)`: the children of every `interpolated` node (interpolated slots) at one corner, cached per
 *   column;
 * - `voxelFn(lx, y, lz)`: the root at one voxel (an `interpolated` node is the trilinear interpolation of its slot's
 *   corner values).
 * A `const` never takes a slot: its readers use the value. Within one point (a corner column, a position, a corner or
 * a voxel) a node read more than once is evaluated once (an epoch-stamped memo); a `rangeChoice` evaluates only its
 * chosen branch, so a VOXEL or CELL branch costs nothing when not chosen (COLUMN slots are filled eagerly).
 *
 * Scratch. One CompiledDensity owns the scratch of one column (its slot values, its corner cache and its point
 * registers); compile again for an independent one. Nothing is allocated per column, corner or voxel.
 */
import { latticeIndex, readField, type ColumnSample } from '../column/columnStage';
import {
  EXPR_CHILD_KEYS, ExprValidationError, validateExpr,
  type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type ExprOp, type InterpolatedExpr,
} from './expr';
import { cornerY, joinClass, ownClass, slideAt, trilerp, type DensityClass } from './nodes';
import { findTap } from './reference';

const LATTICE = latticeIndex;
const READ_FIELD = readField;
const CHILD_KEYS = EXPR_CHILD_KEYS;
const INVALID = ExprValidationError;
const VALIDATE = validateExpr;
const CORNER_Y = cornerY;
const JOIN = joinClass;
const OWN = ownClass;
const SLIDE_AT = slideAt;
const TRILERP = trilerp;
const FIND_TAP = findTap;

/** One node of the compiled DAG (after ref resolution and CSE). */
export interface DensityNode {
  readonly op: Exclude<ExprOp, 'ref'>;
  /** A source node with this structure (the first one met): its scalar fields (v, field, id, lo, hi, knots, name). */
  readonly expr: Expr;
  /** Inside an `interpolated` (evaluated at corners) or not (at voxels and positions). */
  readonly inside: boolean;
  readonly cls: DensityClass;
  /** Child node indices in evaluation order (EXPR_CHILD_KEYS). */
  readonly kids: readonly number[];
  /** ≥ 0: a column slot, `colValues[colValueIndex(slot, i, j)]` after columnFn; else −1. */
  readonly colSlot: number;
  /** ≥ 0: a position slot, `posValues[posValueIndex(slot, lx, lz)]` after positionFn; else −1. */
  readonly posSlot: number;
  /** ≥ 0 on an `interpolated` node: its child's corner values, `cornerValues[cornerValueIndex(slot, i, k, j)]`; else −1. */
  readonly interpSlot: number;
}

/** A compiled density expression with the scratch of one column. */
export interface CompiledDensity {
  /** The validated source expression. */
  readonly expr: DensityExpr;
  /** The DAG reachable from the root, children before parents. */
  readonly nodes: readonly DensityNode[];
  /** The root's node index. */
  readonly root: number;
  readonly columnSlotCount: number;
  readonly positionSlotCount: number;
  readonly interpolatedSlotCount: number;
  /** Column slot values, `colValueIndex(slot, i, j)` (i, j ∈ 0 … 4). */
  readonly colValues: Float64Array;
  /** Position slot values, `posValueIndex(slot, lx, lz)` (lx, lz ∈ 0 … 15). */
  readonly posValues: Float64Array;
  /** Corner values of each interpolated slot, `cornerValueIndex(slot, i, k, j)` (k ∈ 0 … 48); valid where cornerReady. */
  readonly cornerValues: Float64Array;
  /** 1 where corner `(k·5 + j)·5 + i` holds every interpolated slot's value for the current column. */
  readonly cornerReady: Uint8Array;
  /**
   * Starts column (s.cx, s.cz): clears the corner cache and fills the column slots from `s`'s lattice. Must precede
   * positionFn, cornerFn, voxelFn and tapFn for that column.
   */
  columnFn(s: ColumnSample): void;
  /** Fills the position slots from `s` (bilinear `col`). Throws unless columnFn ran last for the same (cx, cz). */
  positionFn(s: ColumnSample): void;
  /** columnFn ran for (cx, cz) and no other column since. */
  hasColumn(cx: number, cz: number): boolean;
  /** positionFn ran for (cx, cz) and no other column since. */
  hasPositions(cx: number, cz: number): boolean;
  /** Evaluates every interpolated slot at corner (i, k, j) unless the column's cache has it. Integers, unchecked. */
  cornerFn(i: number, k: number, j: number): void;
  /** cornerFn for the 8 corners of cell (ci, ck, cj) (ci, cj ∈ 0 … 3, ck ∈ 0 … 47), remembered per cell. */
  cellCorners(ci: number, ck: number, cj: number): void;
  /** The root at voxel (lx, y, lz) of the current column (lx, lz ∈ 0 … 15, y ∈ −64 … 319, integers, unchecked). */
  voxelFn(lx: number, y: number, lz: number): number;
  /**
   * The tap `name` at a voxel, as `DensityReference.tap`: its child at the voxel when its first occurrence is outside
   * `interpolated`, else its child's corner values interpolated (computed for the call, not cached). Throws when no tap
   * of that name is reachable from the root.
   */
  tapFn(name: string, lx: number, y: number, lz: number): number;
  /** The interpolated slot of a source `interpolated` node reachable from the root (by identity), else −1. */
  interpolatedSlot(e: InterpolatedExpr): number;
}

/** Index of column slot `slot` at corner column (i, j) in `colValues`. */
export function colValueIndex(slot: number, i: number, j: number): number { return slot * 25 + j * 5 + i; }
/** Index of position slot `slot` at position (lx, lz) in `posValues`. */
export function posValueIndex(slot: number, lx: number, lz: number): number { return slot * 256 + lz * 16 + lx; }
/** Index of interpolated slot `slot` at corner (i, k, j) in `cornerValues`. */
export function cornerValueIndex(slot: number, i: number, k: number, j: number): number { return slot * 1225 + (k * 5 + j) * 5 + i; }

type Thunk = () => number;

interface Building {
  op: Exclude<ExprOp, 'ref'>;
  expr: Expr;
  inside: boolean;
  cls: DensityClass;
  kids: number[];
  colSlot: number;
  posSlot: number;
  interpSlot: number;
}

/** A number's CSE key: exact (shortest round-trip form), with −0 apart from +0. */
function numKey(v: number): string {
  return Object.is(v, -0) ? '-0' : String(v);
}

function scalarKey(e: Expr): string {
  switch (e.op) {
    case 'const': return numKey(e.v);
    case 'col': return e.field;
    case 'noise2': case 'noise': return JSON.stringify(e.id);
    case 'clamp': case 'rangeChoice': return `${numKey(e.lo)},${numKey(e.hi)}`;
    case 'slide': return e.knots.map(([y, v]) => `${numKey(y)}:${numKey(v)}`).join(',');
    case 'tap': return JSON.stringify(e.name);
    default: return '';
  }
}

/**
 * Validates `expr` against `noises` (throws ExprValidationError listing every issue) and compiles it (SP3b spec §2.1).
 */
export function compileDensity(expr: DensityExpr, noises: DensityNoiseSource): CompiledDensity {
  const issues = VALIDATE(expr, noises);
  if (issues.length > 0) throw new INVALID(issues);
  const defs = expr.defs;
  const noise = (id: string): DensityNoise => {
    const n = noises(id);
    if (n === undefined) throw new Error(`unknown density noise ${id}`);
    return n;
  };

  // ---- 1. Ref resolution and placement-keyed CSE (post-order: children before parents). ----
  const nodes: Building[] = [];
  const byKey = new Map<string, number>();
  const bySource = [new Map<Expr, number>(), new Map<Expr, number>()];
  const build = (e: Expr, inside: boolean): number => {
    const seen = bySource[inside ? 1 : 0]!;
    const hit = seen.get(e);
    if (hit !== undefined) return hit;
    let id: number;
    if (e.op === 'ref') id = build(defs[e.name]!, inside);
    else {
      const rec = e as unknown as Record<string, Expr>;
      const kidInside = inside || e.op === 'interpolated';
      const kids = CHILD_KEYS[e.op].map((k) => build(rec[k]!, kidInside));
      const key = `${inside ? 1 : 0}|${e.op}|${scalarKey(e)}|${kids.join(',')}`;
      const old = byKey.get(key);
      if (old !== undefined) id = old;
      else {
        let cls = OWN(e.op, inside);
        for (const k of kids) {
          const kc = nodes[k]!.cls;
          // An interpolated node's children are inside it (CELL or COLUMN); the node itself is VOXEL.
          if (e.op !== 'interpolated') cls = JOIN(cls, kc);
        }
        id = nodes.length;
        nodes.push({ op: e.op, expr: e, inside, cls, kids, colSlot: -1, posSlot: -1, interpSlot: -1 });
        byKey.set(key, id);
      }
    }
    seen.set(e, id);
    return id;
  };
  const root = build(expr.root, false);

  // Taps: the first occurrence reachable from the root (evaluation order), as the reference reads them.
  const tapNodes = new Map<string, { node: number; inside: boolean }>();
  for (const n of nodes) {
    if (n.op !== 'tap') continue;
    const name = (n.expr as { name: string }).name;
    if (tapNodes.has(name)) continue;
    const found = FIND_TAP(expr, name);
    if (found === undefined) continue;
    tapNodes.set(name, { node: bySource[found.inside ? 1 : 0]!.get(found.node)!, inside: found.inside });
  }

  // ---- 2. Slots and call counts. ----
  let colSlots = 0, posSlots = 0, interpSlots = 0;
  const calls = new Int32Array(nodes.length);
  /** A COLUMN node read from outside its column closures takes a slot (a const never does). */
  const needSlot = (id: number): void => {
    const n = nodes[id]!;
    if (n.op === 'const') return;
    if (n.inside) { if (n.colSlot < 0) { n.colSlot = colSlots++; calls[id]++; } }
    else if (n.posSlot < 0) { n.posSlot = posSlots++; calls[id]++; }
  };
  /** How a non-COLUMN reader (or the root/tap/interpolated driver) reaches node `id`. */
  const readFromOutside = (id: number): void => {
    if (nodes[id]!.cls === 'column') needSlot(id);
    else calls[id]++;
  };
  for (const n of nodes) {
    if (n.op === 'interpolated') { n.interpSlot = interpSlots++; readFromOutside(n.kids[0]!); continue; }
    for (const k of n.kids) {
      if (n.cls !== 'column' && nodes[k]!.cls === 'column') needSlot(k);
      else calls[k]++;
    }
  }
  readFromOutside(root);
  for (const t of tapNodes.values()) {
    const n = nodes[t.node]!;
    if (n.cls === 'column') needSlot(t.node);
  }

  // ---- 3. Scratch. ----
  const colValues = new Float64Array(colSlots * 25);
  const posValues = new Float64Array(posSlots * 256);
  const cornerValues = new Float64Array(interpSlots * 1225);
  const cornerReady = new Uint8Array(1225);
  const cellReady = new Uint8Array(768);
  const memoVal = new Float64Array(nodes.length);
  const memoStamp = new Float64Array(nodes.length);
  const tmp = new Float64Array(8);
  // Point registers: world (x, y, z); lat = lattice index and cc = j·5 + i of the corner column; p = lz·16 + lx; the
  // voxel's cell base index (k·5 + j)·5 + i and fractions; the memo epoch.
  let px = 0, py = 0, pz = 0, lat = 0, cc = 0, p = 0, cIdx = 0, tx = 0, ty = 0, tz = 0, epoch = 0;
  let sample: ColumnSample | null = null;
  let x0 = 0, z0 = 0, colCx = 0, colCz = 0, colSet = false, posSet = false;

  // ---- 4. Closures, children first. ----
  const thunks: Thunk[] = [];
  const slotReader = (id: number): Thunk => {
    const n = nodes[id]!;
    if (n.op === 'const') { const v = (n.expr as { v: number }).v; return () => v; }
    if (n.inside) { const base = n.colSlot * 25; return () => colValues[base + cc]!; }
    const base = n.posSlot * 256;
    return () => posValues[base + p]!;
  };
  /** The thunk a reader of class `readerCls` calls for child `id`. */
  const reader = (readerCls: DensityClass, id: number): Thunk =>
    (readerCls !== 'column' && nodes[id]!.cls === 'column' ? slotReader(id) : thunks[id]!);

  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id]!;
    const e = n.expr;
    const kid = (slot: number): Thunk => reader(n.cls, n.kids[slot]!);
    let f: Thunk;
    switch (e.op) {
      case 'const': { const v = e.v; f = () => v; break; }
      case 'y': f = () => py; break;
      case 'col': {
        const field = e.field;
        f = n.inside ? () => sample!.f[field][lat]! : () => READ_FIELD(sample!, field, px, pz);
        break;
      }
      case 'noise2': { const nz = noise(e.id); f = () => nz.z2(px, pz); break; }
      case 'noise': { const nz = noise(e.id); f = () => nz.z3(px, py, pz); break; }
      case 'add': { const a = kid(0), b = kid(1); f = () => { const va = a(); return va + b(); }; break; }
      case 'mul': { const a = kid(0), b = kid(1); f = () => { const va = a(); return va * b(); }; break; }
      case 'min': { const a = kid(0), b = kid(1); f = () => { const va = a(), vb = b(); return vb < va ? vb : va; }; break; }
      case 'max': { const a = kid(0), b = kid(1); f = () => { const va = a(), vb = b(); return vb > va ? vb : va; }; break; }
      case 'neg': { const x = kid(0); f = () => -x(); break; }
      case 'abs': { const x = kid(0); f = () => Math.abs(x()); break; }
      case 'square': { const x = kid(0); f = () => { const v = x(); return v * v; }; break; }
      case 'clamp': {
        const x = kid(0), lo = e.lo, hi = e.hi;
        f = () => { const v = x(); return v < lo ? lo : v > hi ? hi : v; };
        break;
      }
      case 'slide': { const x = kid(0), knots = e.knots; f = () => x() * SLIDE_AT(knots, py); break; }
      case 'interpolated': {
        const base = n.interpSlot * 1225;
        f = () => {
          const b = base + cIdx;
          return TRILERP(cornerValues[b]!, cornerValues[b + 1]!, cornerValues[b + 5]!, cornerValues[b + 6]!,
            cornerValues[b + 25]!, cornerValues[b + 26]!, cornerValues[b + 30]!, cornerValues[b + 31]!, tx, ty, tz);
        };
        break;
      }
      case 'rangeChoice': {
        const x = kid(0), inside = kid(1), outside = kid(2), lo = e.lo, hi = e.hi;
        f = () => { const v = x(); return lo <= v && v < hi ? inside() : outside(); };
        break;
      }
      case 'tap': { const x = kid(0); f = () => x(); break; }
      case 'ref': throw new Error('unreachable: refs are resolved');
    }
    if (calls[id]! > 1) {
      const raw = f;
      f = () => {
        if (memoStamp[id] === epoch) return memoVal[id]!;
        const v = raw();
        memoVal[id] = v;
        memoStamp[id] = epoch;
        return v;
      };
    }
    thunks.push(f);
  }

  const colOut: Array<{ at: number; f: Thunk }> = [];
  const posOut: Array<{ at: number; f: Thunk }> = [];
  const cornerOut: Array<{ at: number; f: Thunk }> = [];
  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id]!;
    if (n.colSlot >= 0) colOut.push({ at: n.colSlot * 25, f: thunks[id]! });
    if (n.posSlot >= 0) posOut.push({ at: n.posSlot * 256, f: thunks[id]! });
    if (n.interpSlot >= 0) cornerOut.push({ at: n.interpSlot * 1225, f: reader('cell', n.kids[0]!) });
  }
  const rootFn = reader('voxel', root);
  const tapFns = new Map<string, { inside: boolean; f: Thunk }>();
  for (const [name, t] of tapNodes) tapFns.set(name, { inside: t.inside, f: reader(t.inside ? 'cell' : 'voxel', t.node) });
  const nCol = colOut.length, nPos = posOut.length, nCorner = cornerOut.length;

  const columnFn = (s: ColumnSample): void => {
    sample = s;
    colCx = s.cx;
    colCz = s.cz;
    x0 = 16 * s.cx;
    z0 = 16 * s.cz;
    colSet = true;
    posSet = false;
    cornerReady.fill(0);
    cellReady.fill(0);
    for (let j = 0; j <= 4; j++) {
      for (let i = 0; i <= 4; i++) {
        px = x0 + 4 * i;
        pz = z0 + 4 * j;
        lat = LATTICE(i, j);
        cc = j * 5 + i;
        epoch++;
        for (let o = 0; o < nCol; o++) { const out = colOut[o]!; colValues[out.at + cc] = out.f(); }
      }
    }
    sample = null;
  };

  const positionFn = (s: ColumnSample): void => {
    if (!colSet || s.cx !== colCx || s.cz !== colCz) throw new Error(`positionFn(${s.cx}, ${s.cz}) needs columnFn for that column first`);
    sample = s;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        px = x0 + lx;
        pz = z0 + lz;
        p = lz * 16 + lx;
        epoch++;
        for (let o = 0; o < nPos; o++) { const out = posOut[o]!; posValues[out.at + p] = out.f(); }
      }
    }
    sample = null;
    posSet = true;
  };

  const cornerFn = (i: number, k: number, j: number): void => {
    const idx = (k * 5 + j) * 5 + i;
    if (cornerReady[idx] === 1) return;
    cc = j * 5 + i;
    px = x0 + 4 * i;
    py = CORNER_Y(k);
    pz = z0 + 4 * j;
    epoch++;
    for (let o = 0; o < nCorner; o++) { const out = cornerOut[o]!; cornerValues[out.at + idx] = out.f(); }
    cornerReady[idx] = 1;
  };

  const cellCorners = (ci: number, ck: number, cj: number): void => {
    const cell = (ck * 4 + cj) * 4 + ci;
    if (cellReady[cell] === 1) return;
    cornerFn(ci, ck, cj); cornerFn(ci + 1, ck, cj); cornerFn(ci, ck, cj + 1); cornerFn(ci + 1, ck, cj + 1);
    cornerFn(ci, ck + 1, cj); cornerFn(ci + 1, ck + 1, cj); cornerFn(ci, ck + 1, cj + 1); cornerFn(ci + 1, ck + 1, cj + 1);
    cellReady[cell] = 1;
  };

  /** Sets the voxel registers (after any corner work, which overwrites them). Fractions as nodes.ts fracXZ/fracY. */
  const setVoxel = (lx: number, y: number, lz: number): void => {
    const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
    px = x0 + lx;
    py = y;
    pz = z0 + lz;
    p = lz * 16 + lx;
    cIdx = (ck * 5 + cj) * 5 + ci;
    tx = (lx - 4 * ci) / 4;
    ty = (y + 64 - 8 * ck) / 8;
    tz = (lz - 4 * cj) / 4;
    epoch++;
  };

  const voxelFn = (lx: number, y: number, lz: number): number => {
    if (nCorner > 0) cellCorners(lx >> 2, (y + 64) >> 3, lz >> 2);
    setVoxel(lx, y, lz);
    return rootFn();
  };

  const tapFn = (name: string, lx: number, y: number, lz: number): number => {
    const t = tapFns.get(name);
    if (t === undefined) throw new Error(`no tap ${JSON.stringify(name)} reachable from the root`);
    const f = t.f;
    if (!t.inside) {
      if (nCorner > 0) cellCorners(lx >> 2, (y + 64) >> 3, lz >> 2);
      setVoxel(lx, y, lz);
      return f();
    }
    // Inside interpolated: the tap's corner values at the voxel's cell, interpolated as an `interpolated` would.
    const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
    for (let c = 0; c < 8; c++) {
      const i = ci + (c & 1), j = cj + ((c >> 1) & 1), k = ck + (c >> 2);
      cc = j * 5 + i;
      px = x0 + 4 * i;
      py = CORNER_Y(k);
      pz = z0 + 4 * j;
      epoch++;
      tmp[c] = f();
    }
    return TRILERP(tmp[0]!, tmp[1]!, tmp[2]!, tmp[3]!, tmp[4]!, tmp[5]!, tmp[6]!, tmp[7]!,
      (lx - 4 * ci) / 4, (y + 64 - 8 * ck) / 8, (lz - 4 * cj) / 4);
  };

  const interpBySource = new Map<Expr, number>();
  for (const [src, id] of bySource[0]!) if (src.op === 'interpolated') interpBySource.set(src, nodes[id]!.interpSlot);

  return {
    expr,
    nodes,
    root,
    columnSlotCount: colSlots,
    positionSlotCount: posSlots,
    interpolatedSlotCount: interpSlots,
    colValues,
    posValues,
    cornerValues,
    cornerReady,
    columnFn,
    positionFn,
    hasColumn: (cx, cz) => colSet && cx === colCx && cz === colCz,
    hasPositions: (cx, cz) => posSet && cx === colCx && cz === colCz,
    cornerFn,
    cellCorners,
    voxelFn,
    tapFn,
    interpolatedSlot: (e) => interpBySource.get(e) ?? -1,
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/densityCompile.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  15 passed (15)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  126 passed | 2 skipped (128)
Tests  1652 passed | 3 skipped (1655)
```

- [ ] **Step 6: Commit**

```bash
git add src/gen/density/compile.ts test/unit/densityCompile.test.ts
git commit -F - <<'EOF'
feat(gen/density): the compiler (placement, CSE, closures over scratch)

SP3b spec §2.1: compileDensity validates, resolves refs, merges equal
sub-trees per placement (structure plus the inside-interpolated flag),
classifies each node (y, slide and noise never COLUMN) and emits closures
over one column's typed scratch: columnFn (COLUMN nodes read inside
interpolated, at the 5 x 5 corner columns from the lattice), positionFn
(COLUMN nodes read by VOXEL nodes, at the 16 x 16 positions, bilinear col),
cornerFn (the interpolated children per corner, cached per column) and
voxelFn (the root per voxel, trilerp in the pinned order). Shared nodes are
evaluated once per point through an epoch-stamped memo; nothing is
allocated per column, corner or voxel. tapFn reads a tap as the reference
does. The fuzz checks compiled == reference with Object.is on voxels,
corners and taps.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `0d26e47` on `dry/sp3a`; 2 files changed, 839 insertions(+)):

Commit Task 4 on `dry/sp3b-density` (worktree `P/dry-density`, parent Task 3; 2 files, 839 insertions). RED (the commit's test file over the parent): the file fails to import (`Cannot find module '../../src/gen/density/compile'`), "no tests", plus 16 `tsc -p tsconfig.test.json` errors (the missing module and the implicit-any parameters that follow from it). GREEN: typecheck clean; the file 15 tests in 0.43 s; `npm test` 126 files passed, 2 skipped; 1652 tests passed, 3 skipped (29.0 s wall). Mutation checks: a min tie flipped to b, the x/z corner arguments swapped, slide read at y + 0.5, a stale memo stamp, and lattice `col` replaced by the bilinear readout each fail the file.

- Ruling (API, `src/gen/density/compile.ts`): `compileDensity(expr: DensityExpr, noises: DensityNoiseSource): CompiledDensity`. It validates with `validateExpr` and throws `new ExprValidationError(issues)`, not `assertValidExpr`, because of TS2775. The result has:
  - `expr`, `nodes: readonly DensityNode[]` (the DAG reachable from the root, children before parents) and `root` (a node index);
  - `columnSlotCount`, `positionSlotCount` and `interpolatedSlotCount`;
  - the scratch: `colValues` (Float64Array, `colValueIndex(slot, i, j) = slot·25 + j·5 + i`), `posValues` (`posValueIndex(slot, lx, lz) = slot·256 + lz·16 + lx`), `cornerValues` (`cornerValueIndex(slot, i, k, j) = slot·1225 + (k·5 + j)·5 + i`) and `cornerReady` (Uint8Array(1225), indexed `(k·5 + j)·5 + i`);
  - the closures: `columnFn(s)`, `positionFn(s)`, `hasColumn(cx, cz)`, `hasPositions(cx, cz)`, `cornerFn(i, k, j)`, `cellCorners(ci, ck, cj)`, `voxelFn(lx, y, lz): number`, `tapFn(name, lx, y, lz): number` and `interpolatedSlot(e: InterpolatedExpr): number` (by source identity, −1 when unknown).
  
  The three index helpers are exported functions, because gen exports no numeric constants. Cost if wrong: an adapter in Task 5/6/8.
- Ruling (`DensityNode`): `{op (never 'ref'), expr (the first source node with that structure; read its scalars v/field/id/lo/hi/knots/name from it), inside, cls: DensityClass, kids: number[] (EXPR_CHILD_KEYS order), colSlot, posSlot, interpSlot}`, with −1 meaning no slot. Task 5's bounds walk `nodes` in order and compose the nodes.ts interval rules per node:
  - a node with `colSlot ≥ 0` takes the hull of its 4 corner-column values (sound and tighter than per-leaf rules);
  - a node with `posSlot ≥ 0` takes the hull of its 4 × 4 position values, widened;
  - an `interpolated` node takes its child's interval (or the hull of the cell's corner values once they exist), widened.
  
  Cost if wrong: none.
- Ruling (driver contract):
  - `columnFn(s)` starts a column: it records (s.cx, s.cz), clears the corner and cell caches and fills the column slots. It must come first.
  - `positionFn(s)` throws unless columnFn ran last for the same (cx, cz).
  - The closures keep no reference to `s` after they return, so a ColumnCache may evict it.
  - `cornerFn` evaluates every interpolated slot at one corner, once per column (`cornerReady`).
  - `cellCorners` runs the cell's 8 cornerFn calls and remembers the cell in a 768-entry flag array.
  - `voxelFn` calls `cellCorners` for its own cell first, so it is self-sufficient after columnFn and positionFn. Task 8's driver may skip corners only in early-out cells, where it never calls voxelFn.
  - Arguments are unchecked integers; this is the hot path.
  - One CompiledDensity owns one column's scratch. Task 6's DensityContext and the T stage either each compile their own copy (cheap) or share one and compare `hasColumn`/`hasPositions` before re-running.
  
  Cost if wrong: none.
- Ruling (placement):
  - Slots go to the COLUMN nodes a non-COLUMN reader reads: a CELL or VOXEL parent, an `interpolated` (whose COLUMN child is copied from its column slot into the corner cache), the root, or a tap.
  - Inside `interpolated` that is a column slot; outside, a position slot.
  - A `const` never takes a slot; its readers use the value.
  - A COLUMN root is read from its position slot.
  - COLUMN slots are filled eagerly, even when they are read only in a rangeChoice branch that is never chosen; CELL and VOXEL branches stay lazy.
  - cornerFn evaluates every interpolated slot at a corner, even one reachable only through an unchosen branch.
  
  Values cannot change; only cost does. Cost if wrong: a few wasted evaluations on unusual trees, and none for the default expression.
- Ruling (CSE key): the key is exact, not the 64-bit `exprHash`. It is `inside|op|scalars|child node ids`, with numbers by their shortest round-trip `String(v)` and −0 written '-0', and tap names and noise ids JSON-quoted. Because child ids already stand for resolved sub-trees, this is hash-consing: it groups exactly as `(exprHash(resolved), inside)` does, without the collision risk. A test checks this on 200 fuzz trees by counting the distinct `exprHash|inside` keys after ref resolution. A tap is its own node, so its name counts. Cost if wrong: none.
- Ruling (shared nodes): a node with more than one call site is wrapped in an epoch-stamped memo (Float64Array values and stamps; the epoch is a double, so it never wraps). A node's call sites are its parents' edges, a slot fill, the root and the interpolated driver. Every point (a corner column, a position, a corner, a voxel, a tap corner) bumps the epoch. A shared sub-tree is therefore evaluated once per point. This is CSE's cost saving; values equal the reference's recomputation. Cost if wrong: none.
- Ruling (taps, for Task 6's probe): `tapFn` follows the reference rule. A tap whose first occurrence is outside `interpolated` gives its child at the voxel; this uses the voxel closures and the corner cache, or a position slot when the tap is COLUMN. A tap inside `interpolated` gives its child's 8 corner values, computed per call without the corner cache, then `trilerp`; it uses a column slot when the tap is COLUMN. Every reachable COLUMN tap takes a slot, so tap reads need positionFn but never the ColumnSample. The default expression's taps (`terrain` outside, VOXEL; `islands` outside, already a position slot) add no work. The probe is `columnFn` + `positionFn` once per column, then `voxelFn` or `tapFn`. Cost if wrong: an inside tap costs 8 corner evaluations per probe; caching it is one more slot kind.
- Ruling (bit-exactness): the closures inline nodes.ts's expressions and evaluation order (a then b; `b < a ? b : a`; `x < lo ? lo : x > hi ? hi : x`; `Math.abs`; `x() * slideAt(knots, y)`; rangeChoice `lo <= x && x < hi`), call `trilerp`, `readField`, `latticeIndex` and `cornerY` (through top-level aliases), and compute the fractions as `(lx − 4·ci) / 4` and `(y + 64 − 8·ck) / 8` (= fracXZ/fracY). The fuzz covers 300 trees × 3 column visits (A, B, A) × 24 random voxels with Object.is, ≥ 8 random corners per interpolated node per visit, and ≥ 3 voxels per reachable tap. It also checks every voxel of one cell layer in scan order on 12 trees with interpolated nodes. Cost if wrong: none.

---

### Task 5: gen/density: bounds and early-outs

**Spec:** §1.2, §2.4

**Files:**
- Create: `src/gen/density/bounds.ts`
- Modify: `test/harness/densityFuzz.ts`
- Create: `test/unit/densityBounds.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/expr.ts` (Task 2): `DensityNoiseSource`, `SlideKnot`
  - `src/gen/density/nodes.ts` (Task 2): `cornerY`, `ivAbs`, `ivAdd`, `ivClamp`, `ivHull`, `ivMax`, `ivMin`, `ivMul`, `ivNeg`, `ivSet`, `ivSlide`, `ivSquare`, `ivWiden`, `rangeChoiceCase`
  - `src/gen/density/compile.ts` (Task 4): `CompiledDensity`
- Produces (exports added by this task):
  - `src/gen/density/bounds.ts`:
    - `export interface DensityBounds`
    - `export function createDensityBounds(c: CompiledDensity, noises: DensityNoiseSource): DensityBounds`
    - `export function fillDensityColumn(`
  - `test/harness/densityFuzz.ts`:
    - `export function terrainStandInExpr(): DensityExpr`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/densityBounds.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { buildColumnSample, latticeIndex, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { createDensityBounds, fillDensityColumn, type DensityBounds } from '../../src/gen/density/bounds';
import { compileDensity, posValueIndex } from '../../src/gen/density/compile';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr } from '../../src/gen/density/expr';
import { cornerY, ivWiden } from '../../src/gen/density/nodes';
import { createDensityReference } from '../../src/gen/density/reference';
import { fuzzNoiseSource, randomDensityExpr, terrainStandInExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: 'offset' | 'E'): Expr => ({ op: 'col', field });
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): Expr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });

/** A constant-valued 3D noise with clampSigma 4. */
const flat3: DensityNoise = { dims: 3, remap: 'none', clampSigma: 4, z2: () => 0, z3: () => 1 };
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

/** A hand-built ColumnSample at column (2, −3): offset i·j + 0.5 and E i + 10·j on the lattice, every other field 0. */
function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      s.f.offset[latticeIndex(i, j)] = i * j + 0.5;
      s.f.E[latticeIndex(i, j)] = i + 10 * j;
    }
  }
  return s;
}

const widened = (lo: number, hi: number): [number, number] => {
  const o = new Float64Array(2);
  ivWiden(lo, hi, o, 0);
  return [o[0]!, o[1]!];
};

function begin(b: DensityBounds, s: ColumnSample): void {
  b.compiled.columnFn(s);
  b.compiled.positionFn(s);
  b.beginColumn();
}

/** Column-wide voxel index, as the T stage's sections: ((y + 64)·16 + lz)·16 + lx. */
const vIdx = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;

describe('bounds: the root interval per cell (SP3b spec §1.2, §2.4)', () => {
  test('interpolated: its child over the cell corners (col from the 4 corner columns, y over [y0, y0 + 8]), widened', () => {
    // root = interpolated(offset − y) + 2·noise(b), noise b with clampSigma 4.
    const e = only(add(interp(add(col('offset'), neg(Y))), mul(n3('b'), C(2))));
    const b = createDensityBounds(compileDensity(e, source({ b: flat3 })), source({ b: flat3 }));
    begin(b, handSample());
    const out = new Float64Array(2);
    // Cell (1, 10, 2): corner columns i ∈ {1, 2}, j ∈ {2, 3} hold offsets 2.5, 4.5, 3.5, 6.5; corners y 16 and 24.
    b.cellInterval(1, 10, 2, out, 0);
    const [l, h] = widened(2.5 - 24, 6.5 - 16);
    expect([out[0], out[1]]).toEqual([l - 8, h + 8]);
    // After the cell's corners exist, the interpolated part is the hull of its 8 corner values, widened.
    b.compiled.cellCorners(1, 10, 2);
    b.cellIntervalCorners(1, 10, 2, out, 0);
    expect([out[0], out[1]]).toEqual([l - 8, h + 8]);
  });

  test('voxel level: y over [y0, y0 + 7]; a COLUMN value read per voxel is the hull of its 4 × 4 positions, widened', () => {
    const amp = mul(col('E'), C(0.5));
    const c = compileDensity(only(add(amp, Y)), source({}));
    const b = createDensityBounds(c, source({}));
    const s = handSample();
    begin(b, s);
    const out = new Float64Array(2);
    for (const [ci, ck, cj] of [[0, 0, 0], [3, 47, 3], [2, 20, 1]] as const) {
      let lo = Infinity, hi = -Infinity;
      for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
        for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
          const v = c.posValues[posValueIndex(0, lx, lz)]!;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      const [wl, wh] = widened(lo, hi);
      b.cellInterval(ci, ck, cj, out, 0);
      expect([out[0], out[1]]).toEqual([wl + cornerY(ck), wh + (cornerY(ck) + 7)]);
    }
  });

  test('rangeChoice takes one branch when x decides it, else the hull; nodeIntervals hold every node of the last call', () => {
    // rangeChoice(y, 0, 100, inside 1, outside −1) at voxel level.
    const e = only({ op: 'rangeChoice', x: Y, lo: 0, hi: 100, inside: C(1), outside: C(-1) });
    const b = createDensityBounds(compileDensity(e, source({})), source({}));
    begin(b, handSample());
    const out = new Float64Array(2);
    b.cellInterval(0, 10, 0, out, 0); // y 16 … 23: inside
    expect([out[0], out[1]]).toEqual([1, 1]);
    b.cellInterval(0, 7, 0, out, 0); // y −8 … −1: outside
    expect([out[0], out[1]]).toEqual([-1, -1]);
    b.cellInterval(0, 20, 0, out, 0); // y 96 … 103: both
    expect([out[0], out[1]]).toEqual([-1, 1]);
    const r = b.compiled.root;
    expect([b.nodeIntervals[2 * r], b.nodeIntervals[2 * r + 1]]).toEqual([-1, 1]);
  });
});

describe('fillDensityColumn: the early-out driver (SP3b spec §2.4, §4)', () => {
  test('solid below y 100: early-outs above and below, voxels only in the straddling layer, values where mask is set', () => {
    const e = only(interp(add(C(100), neg(Y))));
    const b = createDensityBounds(compileDensity(e, source({})), source({}));
    const solid = new Uint8Array(98304).fill(7);
    const values = new Float64Array(98304).fill(NaN);
    const mask = new Uint8Array(98304).fill(7);
    let polls = 0;
    expect(fillDensityColumn(b, handSample(), solid, values, mask, () => { polls++; return false; })).toBe(true);
    expect(polls).toBe(6);
    for (let y = -64; y < 320; y++) {
      for (const [lx, lz] of [[0, 0], [5, 9], [15, 15]] as const) {
        const i = vIdx(lx, y, lz);
        expect(solid[i]).toBe(y < 100 ? 1 : 0);
        // Only cell layer 20 (y 96 … 103) straddles 0: its corners are 4 and −4.
        expect(mask[i]).toBe(y >= 96 && y < 104 ? 1 : 0);
        if (mask[i] === 1) expect(values[i]).toBe(100 - y);
      }
    }
  });

  test('stop() is polled before every 8 cell layers; true returns false at once', () => {
    const e = only(interp(add(C(100), neg(Y))));
    const b = createDensityBounds(compileDensity(e, source({})), source({}));
    const solid = new Uint8Array(98304).fill(7);
    let polls = 0;
    expect(fillDensityColumn(b, handSample(), solid, null, null, () => ++polls === 3)).toBe(false);
    expect(polls).toBe(3);
    // Layers 0 … 15 (y −64 … 63) were filled; nothing from layer 16 on.
    expect(solid.subarray(0, 16 * 8 * 256).every((v) => v === 1)).toBe(true);
    expect(solid.subarray(16 * 8 * 256).every((v) => v === 7)).toBe(true);
  });
});

describe('bounds and early-outs: fuzz (SP3b spec §1.2, §10)', () => {
  const ctx = ctxFor('42');
  const noises = fuzzNoiseSource();
  const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));

  test('no evaluated value leaves its interval, at every node, before and after the corners', () => {
    const next = testRng(501);
    let checks = 0, big = 0, tiny = 0;
    const out = new Float64Array(2);
    for (let n = 0; n < 300; n++) {
      const e = randomDensityExpr(next);
      JSON.stringify(e, (k, v: unknown) => {
        if (k === 'v' && typeof v === 'number') { if (Math.abs(v) >= 1e6) big++; if (v !== 0 && Math.abs(v) <= 1e-3) tiny++; }
        return v;
      });
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      const b = createDensityBounds(c, noises);
      const s = samples[n % 4]!;
      begin(b, s);
      const x0 = 16 * s.cx, z0 = 16 * s.cz;
      for (let m = 0; m < 3; m++) {
        const ci = next() % 4, ck = next() % 48, cj = next() % 4;
        const y0 = cornerY(ck);
        const vox = Array.from({ length: 6 }, () => [4 * ci + (next() % 4), y0 + (next() % 8), 4 * cj + (next() % 4)] as const);
        vox.push([4 * ci, y0, 4 * cj], [4 * ci + 3, y0 + 7, 4 * cj + 3]);
        const check = (pass: string): void => {
          const iv = b.nodeIntervals;
          for (let id = 0; id < c.nodes.length; id++) {
            const node = c.nodes[id]!;
            const lo = iv[2 * id]!, hi = iv[2 * id + 1]!;
            if (Number.isNaN(lo)) {
              // Only COLUMN nodes no non-COLUMN node reads go without an interval.
              expect(node.cls === 'column' && node.colSlot < 0 && node.posSlot < 0).toBe(true);
              continue;
            }
            const inCheck = (v: number, where: string): void => {
              if (!(lo <= v && v <= hi)) {
                throw new Error(`tree ${n} ${pass}: node ${id} (${node.op}, inside ${node.inside}) at ${where} = ${v} outside [${lo}, ${hi}]\n${JSON.stringify(e)}`);
              }
              checks++;
            };
            if (node.inside) {
              for (let q = 0; q < 8; q++) {
                const i = ci + (q & 1), j = cj + ((q >> 1) & 1), k = ck + (q >> 2);
                inCheck(r.corner(s, node.expr, i, k, j), `corner (${i}, ${k}, ${j})`);
              }
            } else {
              for (const [lx, y, lz] of vox) inCheck(r.voxel(s, x0 + lx, y, z0 + lz, node.expr), `voxel (${lx}, ${y}, ${lz})`);
            }
          }
        };
        b.cellInterval(ci, ck, cj, out, 0);
        expect([out[0], out[1]]).toEqual([b.nodeIntervals[2 * c.root], b.nodeIntervals[2 * c.root + 1]]);
        check('cellInterval');
        c.cellCorners(ci, ck, cj);
        b.cellIntervalCorners(ci, ck, cj, out, 0);
        check('cellIntervalCorners');
        // The refined interval holds the compiled value of every voxel of the cell.
        for (let y = y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              const v = c.voxelFn(lx, y, lz);
              if (!(out[0]! <= v && v <= out[1]!)) throw new Error(`tree ${n}: voxel (${lx}, ${y}, ${lz}) = ${v} outside [${out[0]}, ${out[1]}]`);
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(20000);
    expect(big).toBeGreaterThan(30);
    expect(tiny).toBeGreaterThan(30);
  });

  /** Runs the driver and checks every voxel against a full evaluation on an independent compile; returns early-out cells. */
  function driverEqualsFull(e: DensityExpr, s: ColumnSample, what: string): { air: number; solid: number; voxel: number } {
    const b = createDensityBounds(compileDensity(e, noises), noises);
    const full = compileDensity(e, noises);
    full.columnFn(s);
    full.positionFn(s);
    const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
    expect(fillDensityColumn(b, s, solid, values, mask, () => false)).toBe(true);
    const cells = { air: 0, solid: 0, voxel: 0 };
    for (let ck = 0; ck < 48; ck++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          let masked = 0, solids = 0;
          for (let y = cornerY(ck); y < cornerY(ck) + 8; y++) {
            for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
              for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
                const i = vIdx(lx, y, lz);
                const v = full.voxelFn(lx, y, lz);
                if (solid[i] !== (v > 0 ? 1 : 0)) throw new Error(`${what}: voxel (${lx}, ${y}, ${lz}) solid ${solid[i]} but full value ${v}\n${JSON.stringify(e)}`);
                if (mask[i] === 1 && !Object.is(values[i], v)) throw new Error(`${what}: voxel (${lx}, ${y}, ${lz}) value ${values[i]} ≠ ${v}`);
                masked += mask[i]!;
                solids += solid[i]!;
              }
            }
          }
          // A cell is evaluated whole or not at all.
          expect(masked === 0 || masked === 128).toBe(true);
          if (masked === 128) cells.voxel++;
          else if (solids === 128) cells.solid++;
          else { expect(solids).toBe(0); cells.air++; }
        }
      }
    }
    return cells;
  }

  test('the driver\'s solidity equals full evaluation at every voxel of random trees', () => {
    const next = testRng(502);
    const total = { air: 0, solid: 0, voxel: 0 };
    let n = 0, withInterp = 0;
    while (n < 80) {
      const e = randomDensityExpr(next);
      const hasInterp = JSON.stringify(e).includes('"interpolated"');
      // Half the trees have an interpolated node (the early-out with corners).
      if (!hasInterp && n - withInterp >= 40) continue;
      if (hasInterp) withInterp++;
      const cells = driverEqualsFull(e, samples[n % 4]!, `tree ${n}`);
      total.air += cells.air;
      total.solid += cells.solid;
      total.voxel += cells.voxel;
      n++;
    }
    expect(withInterp).toBeGreaterThanOrEqual(40);
    // Both early-outs and the voxel path are exercised.
    expect(total.air).toBeGreaterThan(1000);
    expect(total.solid).toBeGreaterThan(1000);
    expect(total.voxel).toBeGreaterThan(1000);
  });

  test('a terrain-shaped stand-in: driver == full evaluation, and most cells early-out', () => {
    const e = terrainStandInExpr();
    const total = { air: 0, solid: 0, voxel: 0 };
    for (const [m, s] of samples.entries()) {
      const cells = driverEqualsFull(e, s, `stand-in column ${m}`);
      total.air += cells.air;
      total.solid += cells.solid;
      total.voxel += cells.voxel;
    }
    expect(total.air).toBeGreaterThan(0);
    expect(total.solid).toBeGreaterThan(0);
    expect(total.voxel).toBeGreaterThan(0);
    expect(total.voxel / (4 * 768)).toBeLessThan(0.2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/densityBounds.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/densityBounds.test.ts [ test/unit/densityBounds.test.ts ]
Error: Cannot find module '../../src/gen/density/bounds' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityBounds.test.ts
Test Files  1 failed (1)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `src/gen/density/bounds.ts`:

```ts
/**
 * Interval bounds per 4 × 8 × 4 cell and the early-out column driver (SP3b spec §1.2, §2.4).
 *
 * Bounds. For one cell of the current column, every node of a CompiledDensity gets an interval that holds each value
 * the node takes in that cell, by the nodes.ts rules composed per node (children before parents):
 * - a node inside `interpolated` is evaluated only at corners, so its interval covers the cell's 8 corners: `y` is
 *   [y0, y0 + 8], a COLUMN node with a column slot is the hull of its 4 corner-column values (exact);
 * - a node outside covers the cell's 128 voxels: `y` is [y0, y0 + 7], a COLUMN node with a position slot is the hull of
 *   its 4 × 4 position values, widened (spec §1.2: every voxel-level COLUMN value interval is widened);
 * - `noise` is [−clampSigma, clampSigma]; a `const` is [v, v]; `interpolated` is its child's interval, widened, or,
 *   once the cell's corners exist (`cellIntervalCorners`), the hull of its 8 corner values, widened;
 * - a COLUMN node that no non-COLUMN node reads (only COLUMN parents, which take their hull from slot values) gets no
 *   interval (NaN in `nodeIntervals`).
 *
 * Driver. `fillDensityColumn` writes one column's solidity (density > 0) for all 98,304 voxels, cell by cell, bottom
 * up: the root's interval decides hi < 0 (non-solid) and lo > 0 (solid) without corner or voxel work; otherwise the
 * cell's corners are evaluated (each at most once per column) and the interval is refined with them; only a cell that
 * still straddles 0 runs `voxelFn` per voxel. Early-outs never change a voxel's solidity.
 */
import type { ColumnSample } from '../column/columnStage';
import type { CompiledDensity } from './compile';
import type { DensityNoiseSource, SlideKnot } from './expr';
import {
  cornerY, ivAbs, ivAdd, ivClamp, ivHull, ivMax, ivMin, ivMul, ivNeg, ivSet, ivSlide, ivSquare, ivWiden, rangeChoiceCase,
} from './nodes';

const CORNER_Y = cornerY;
const IV_ABS = ivAbs;
const IV_ADD = ivAdd;
const IV_CLAMP = ivClamp;
const IV_HULL = ivHull;
const IV_MAX = ivMax;
const IV_MIN = ivMin;
const IV_MUL = ivMul;
const IV_NEG = ivNeg;
const IV_SET = ivSet;
const IV_SLIDE = ivSlide;
const IV_SQUARE = ivSquare;
const IV_WIDEN = ivWiden;
const RANGE_CASE = rangeChoiceCase;

/** Offsets of a cell's other 3 corner columns from its (ci, cj) one in a colValues slot: x +1, z +5. */
const COLUMN_OFFSETS = Int32Array.of(1, 5, 6);
/** Offsets of a cell's other 7 corners from its (ci, ck, cj) one in a cornerValues slot: x +1, z +5, y +25. */
const CORNER_OFFSETS = Int32Array.of(1, 5, 6, 25, 26, 30, 31);

// Instruction codes (module-private).
const I_COL_HULL = 0;
const I_POS_HULL = 1;
const I_Y = 2;
const I_NOISE = 3;
const I_ADD = 4;
const I_MUL = 5;
const I_MIN = 6;
const I_MAX = 7;
const I_NEG = 8;
const I_ABS = 9;
const I_SQUARE = 10;
const I_CLAMP = 11;
const I_SLIDE = 12;
const I_INTERP = 13;
const I_RANGE = 14;
const I_PASS = 15;

/** Interval bounds of one CompiledDensity (it reads that compile's slot values and corner cache). */
export interface DensityBounds {
  readonly compiled: CompiledDensity;
  /**
   * Per node `id`, `[nodeIntervals[2·id], nodeIntervals[2·id + 1]]` after the last cellInterval/cellIntervalCorners
   * call (NaN for a COLUMN node that only COLUMN parents read). Read-only for callers.
   */
  readonly nodeIntervals: Float64Array;
  /** Takes the column and position slot hulls of the compile's current column: call after columnFn and positionFn. */
  beginColumn(): void;
  /** The root's interval over cell (ci, ck, cj) into `out[k]`, `out[k + 1]`; `interpolated` from its child's interval. */
  cellInterval(ci: number, ck: number, cj: number, out: Float64Array, k: number): void;
  /**
   * The root's interval over cell (ci, ck, cj) with every `interpolated` taken from the hull of the cell's 8 corner
   * values (widened). Needs `compiled.cellCorners(ci, ck, cj)` and a cellInterval call for the same cell first.
   */
  cellIntervalCorners(ci: number, ck: number, cj: number, out: Float64Array, k: number): void;
}

/** Creates the bounds of `c`; `noises` must be the source `c` was compiled with (for each noise's clampSigma). */
export function createDensityBounds(c: CompiledDensity, noises: DensityNoiseSource): DensityBounds {
  const nodes = c.nodes;
  const n = nodes.length;
  const iv = new Float64Array(2 * n).fill(NaN);
  // Instructions: inside nodes (cell program) then outside nodes (voxel program), each in node order.
  const codes: number[] = [], dst: number[] = [], ka: number[] = [], kb: number[] = [], kc: number[] = [];
  const pa: number[] = [], pb: number[] = [];
  const knots: Array<readonly SlideKnot[] | null> = [];
  const push = (code: number, id: number, a: number, b: number, cc: number, p0: number, p1: number, kn: readonly SlideKnot[] | null): void => {
    codes.push(code); dst.push(id); ka.push(a); kb.push(b); kc.push(cc); pa.push(p0); pb.push(p1); knots.push(kn);
  };
  let cellCount = 0;
  for (const inside of [true, false]) {
    for (let id = 0; id < n; id++) {
      const node = nodes[id]!;
      if (node.inside !== inside) continue;
      const e = node.expr;
      if (e.op === 'const') { iv[2 * id] = e.v; iv[2 * id + 1] = e.v; continue; }
      if (node.cls === 'column') {
        if (node.colSlot >= 0) push(I_COL_HULL, id, node.colSlot, 0, 0, 0, 0, null);
        else if (node.posSlot >= 0) push(I_POS_HULL, id, node.posSlot, 0, 0, 0, 0, null);
        continue;
      }
      const [a = -1, b = -1, k3 = -1] = node.kids;
      switch (e.op) {
        case 'y': push(I_Y, id, 0, 0, 0, inside ? 8 : 7, 0, null); break;
        case 'noise': {
          const nz = noises(e.id);
          if (nz === undefined) throw new Error(`unknown density noise ${e.id}`);
          push(I_NOISE, id, 0, 0, 0, nz.clampSigma, 0, null);
          break;
        }
        case 'add': push(I_ADD, id, a, b, 0, 0, 0, null); break;
        case 'mul': push(I_MUL, id, a, b, 0, 0, 0, null); break;
        case 'min': push(I_MIN, id, a, b, 0, 0, 0, null); break;
        case 'max': push(I_MAX, id, a, b, 0, 0, 0, null); break;
        case 'neg': push(I_NEG, id, a, 0, 0, 0, 0, null); break;
        case 'abs': push(I_ABS, id, a, 0, 0, 0, 0, null); break;
        case 'square': push(I_SQUARE, id, a, 0, 0, 0, 0, null); break;
        case 'clamp': push(I_CLAMP, id, a, 0, 0, e.lo, e.hi, null); break;
        case 'slide': push(I_SLIDE, id, a, 0, 0, inside ? 8 : 7, 0, e.knots); break;
        case 'interpolated': push(I_INTERP, id, a, node.interpSlot, 0, 0, 0, null); break;
        case 'rangeChoice': push(I_RANGE, id, a, b, k3, e.lo, e.hi, null); break;
        case 'tap': push(I_PASS, id, a, 0, 0, 0, 0, null); break;
        default: throw new Error(`unreachable: ${e.op} is COLUMN`);
      }
    }
    if (inside) cellCount = codes.length;
  }
  const count = codes.length;
  const code = Int32Array.from(codes), out0 = Int32Array.from(dst), A = Int32Array.from(ka), B = Int32Array.from(kb);
  const K3 = Int32Array.from(kc), P0 = Float64Array.from(pa), P1 = Float64Array.from(pb);

  const colHull = new Float64Array(c.columnSlotCount * 32);
  const posHull = new Float64Array(c.positionSlotCount * 32);
  const colValues = c.colValues, posValues = c.posValues, cornerValues = c.cornerValues;
  const root = c.root;

  const beginColumn = (): void => {
    for (let slot = 0; slot < c.columnSlotCount; slot++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          const base = slot * 25 + cj * 5 + ci;
          let lo = colValues[base]!, hi = lo;
          for (let q = 0; q < 3; q++) {
            const v = colValues[base + COLUMN_OFFSETS[q]!]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const h = (slot * 16 + cj * 4 + ci) * 2;
          colHull[h] = lo;
          colHull[h + 1] = hi;
        }
      }
    }
    for (let slot = 0; slot < c.positionSlotCount; slot++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          let lo = Infinity, hi = -Infinity;
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              const v = posValues[slot * 256 + lz * 16 + lx]!;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
          IV_WIDEN(lo, hi, posHull, (slot * 16 + cj * 4 + ci) * 2);
        }
      }
    }
  };

  /** Runs instructions [from, to) for cell (ci, ck, cj); `corners`: interpolated from the corner hull. */
  const run = (from: number, to: number, ci: number, ck: number, cj: number, corners: boolean): void => {
    const y0 = CORNER_Y(ck);
    const cc4 = cj * 4 + ci;
    for (let q = from; q < to; q++) {
      const o = 2 * out0[q]!;
      const a = 2 * A[q]!;
      switch (code[q]) {
        case I_COL_HULL: { const h = (A[q]! * 16 + cc4) * 2; iv[o] = colHull[h]!; iv[o + 1] = colHull[h + 1]!; break; }
        case I_POS_HULL: { const h = (A[q]! * 16 + cc4) * 2; iv[o] = posHull[h]!; iv[o + 1] = posHull[h + 1]!; break; }
        case I_Y: IV_SET(y0, y0 + P0[q]!, iv, o); break;
        case I_NOISE: IV_SET(-P0[q]!, P0[q]!, iv, o); break;
        case I_ADD: { const b = 2 * B[q]!; IV_ADD(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_MUL: { const b = 2 * B[q]!; IV_MUL(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_MIN: { const b = 2 * B[q]!; IV_MIN(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_MAX: { const b = 2 * B[q]!; IV_MAX(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_NEG: IV_NEG(iv[a]!, iv[a + 1]!, iv, o); break;
        case I_ABS: IV_ABS(iv[a]!, iv[a + 1]!, iv, o); break;
        case I_SQUARE: IV_SQUARE(iv[a]!, iv[a + 1]!, iv, o); break;
        case I_CLAMP: IV_CLAMP(iv[a]!, iv[a + 1]!, P0[q]!, P1[q]!, iv, o); break;
        case I_SLIDE: IV_SLIDE(iv[a]!, iv[a + 1]!, knots[q]!, y0, y0 + P0[q]!, iv, o); break;
        case I_INTERP: {
          if (!corners) { IV_WIDEN(iv[a]!, iv[a + 1]!, iv, o); break; }
          const base = B[q]! * 1225 + (ck * 5 + cj) * 5 + ci;
          let lo = cornerValues[base]!, hi = lo;
          for (let q = 0; q < 7; q++) {
            const v = cornerValues[base + CORNER_OFFSETS[q]!]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          IV_WIDEN(lo, hi, iv, o);
          break;
        }
        case I_RANGE: {
          const b = 2 * B[q]!, d = 2 * K3[q]!;
          const which = RANGE_CASE(iv[a]!, iv[a + 1]!, P0[q]!, P1[q]!);
          if (which === 'inside') IV_SET(iv[b]!, iv[b + 1]!, iv, o);
          else if (which === 'outside') IV_SET(iv[d]!, iv[d + 1]!, iv, o);
          else IV_HULL(iv[b]!, iv[b + 1]!, iv[d]!, iv[d + 1]!, iv, o);
          break;
        }
        case I_PASS: IV_SET(iv[a]!, iv[a + 1]!, iv, o); break;
        default: throw new Error('unreachable: unknown interval instruction');
      }
    }
  };

  return {
    compiled: c,
    nodeIntervals: iv,
    beginColumn,
    cellInterval: (ci, ck, cj, out, k) => {
      run(0, count, ci, ck, cj, false);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
    cellIntervalCorners: (ci, ck, cj, out, k) => {
      run(cellCount, count, ci, ck, cj, true);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
  };
}

const IV = new Float64Array(2);

/**
 * Fills column (s.cx, s.cz)'s solidity with early-outs (SP3b spec §2.4, §4): runs `columnFn` and `positionFn` of
 * `b.compiled` on `s`, then the 48 cell layers bottom up, polling `stop()` before every 8 layers (6 polls); on true it
 * returns false at once (the outputs are then partial). `solid[((y + 64)·16 + lz)·16 + lx]` (98,304 entries, the T
 * stage's section order) becomes 1 where the density is > 0, else 0. A non-null `mask` is cleared, then set to 1 at
 * each voxel `voxelFn` evaluated; a non-null `values` receives those voxels' values (its other entries are left as they
 * were). Nothing is allocated.
 */
export function fillDensityColumn(
  b: DensityBounds, s: ColumnSample, solid: Uint8Array, values: Float64Array | null, mask: Uint8Array | null,
  stop: () => boolean,
): boolean {
  const c = b.compiled;
  c.columnFn(s);
  c.positionFn(s);
  b.beginColumn();
  if (mask !== null) mask.fill(0);
  const corners = c.interpolatedSlotCount > 0;
  for (let ck = 0; ck < 48; ck++) {
    if ((ck & 7) === 0 && stop()) return false;
    const y0 = CORNER_Y(ck);
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        b.cellInterval(ci, ck, cj, IV, 0);
        let fill = IV[1]! < 0 ? 0 : IV[0]! > 0 ? 1 : -1;
        if (fill < 0 && corners) {
          c.cellCorners(ci, ck, cj);
          b.cellIntervalCorners(ci, ck, cj, IV, 0);
          fill = IV[1]! < 0 ? 0 : IV[0]! > 0 ? 1 : -1;
        }
        for (let y = y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            const row = ((y + 64) * 16 + lz) * 16;
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              if (fill >= 0) { solid[row + lx] = fill; continue; }
              const v = c.voxelFn(lx, y, lz);
              solid[row + lx] = v > 0 ? 1 : 0;
              if (values !== null) values[row + lx] = v;
              if (mask !== null) mask[row + lx] = 1;
            }
          }
        }
      }
    }
  }
  return true;
}
```

Modify `test/harness/densityFuzz.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/densityFuzz.ts b/test/harness/densityFuzz.ts
index 211eda2..011dc0b 100644
--- a/test/harness/densityFuzz.ts
+++ b/test/harness/densityFuzz.ts
@@ -158,3 +158,29 @@ export function randomDensityExpr(next: () => number, opts: DensityFuzzOptions =
   }
   return { root: gen(maxDepth, false), defs };
 }
+
+/**
+ * A terrain-shaped stand-in for SP3b §3.1's default expression over the test noises (jag → fz2a, overhang → fz3b,
+ * detail → fz3a), for the bounds tests and the driver's cost until Task 6 brings the real one:
+ * `max(tap('terrain', interpolated(offset + jag·J − y + sigma·slide(N3, SLIDE) + 2·max(0, −56 − y)
+ * − 2·max(0, y − 296))) + N_detail · amp, tap('islands', −1e6))`, J = (1 − |z2 / 3|)², amp = 0.6 + 0.9·clamp((E + 1) / 2, 0, 1).
+ */
+export function terrainStandInExpr(): DensityExpr {
+  const C = (v: number): Expr => ({ op: 'const', v });
+  const Y: Expr = { op: 'y' };
+  const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
+  const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
+  const max = (a: Expr, b: Expr): Expr => ({ op: 'max', a, b });
+  const neg = (x: Expr): Expr => ({ op: 'neg', x });
+  const J: Expr = { op: 'square', x: add(C(1), neg({ op: 'abs', x: mul({ op: 'noise2', id: 'fz2a' }, C(1 / 3)) })) };
+  const slide: Expr = { op: 'slide', x: { op: 'noise', id: 'fz3b' }, knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] };
+  let inner = add({ op: 'col', field: 'offset' }, mul({ op: 'col', field: 'jag' }, J));
+  inner = add(inner, neg(Y));
+  inner = add(inner, mul({ op: 'col', field: 'sigma' }, slide));
+  inner = add(inner, mul(C(2), max(C(0), add(C(-56), neg(Y)))));
+  inner = add(inner, neg(mul(C(2), max(C(0), add(Y, C(-296))))));
+  const terrain: Expr = { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: inner } };
+  const amp = add(C(0.6), mul(C(0.9), { op: 'clamp', x: mul(add({ op: 'col', field: 'E' }, C(1)), C(0.5)), lo: 0, hi: 1 }));
+  const detail = mul({ op: 'noise', id: 'fz3a' }, amp);
+  return { root: max(add(terrain, detail), { op: 'tap', name: 'islands', x: C(-1e6) }), defs: {} };
+}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/densityBounds.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  8 passed (8)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  127 passed | 2 skipped (129)
Tests  1660 passed | 3 skipped (1663)
```

- [ ] **Step 6: Commit**

```bash
git add src/gen/density/bounds.ts test/harness/densityFuzz.ts test/unit/densityBounds.test.ts
git commit -F - <<'EOF'
feat(gen/density): bounds per cell and the early-out column driver

src/gen/density/bounds.ts: createDensityBounds composes the nodes.ts interval
rules per node of a CompiledDensity for one 4 x 8 x 4 cell (corner placement
inside interpolated, voxel placement outside; slot hulls for COLUMN values,
widened at voxel level; interpolated widened, from its child or from the
hull of the cell's corner values). fillDensityColumn fills one column's
solidity bottom up with the hi < 0 / lo > 0 early-outs, corners only for
undecided cells, voxelFn only where the refined interval straddles 0,
optional values and mask, and stop() before every 8 cell layers.

Tests: hand intervals, the driver on a hand field and its polls, and the
fuzz: no node value leaves its interval, and the driver's solidity equals
full evaluation at every voxel of random trees and a terrain stand-in.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `ff47de6` on `dry/sp3a`; 3 files changed, 607 insertions(+)):

Commit Task 5 on `dry/sp3b-density` (worktree `P/dry-density`, parent Task 4; 3 files, 607 insertions). RED (the commit's test file over the parent): the file fails to import (`Cannot find module '../../src/gen/density/bounds'`), "no tests", plus 2 `tsc -p tsconfig.test.json` errors (the missing module and the missing `terrainStandInExpr` export of `test/harness/densityFuzz.ts`). GREEN: typecheck clean (1.3 s); the file 8 tests in about 0.95 s; `npm test` 127 files passed, 2 skipped; 1660 tests passed, 3 skipped (28.8 s wall). Mutation checks: each of these fails the file: voxel-level y as [y0, y0 + 6]; corner-level y as [y0, y0 + 7]; no widening after `interpolated`; a corner hull over 4 of 8 corners; a corner-column hull over 3 of 4; swapped rangeChoice branches; `lo ≥ 0` as solid; a slide factor taken over [y0, y0 + 4]; a position hull 3 positions wide; polls after layers 7, 15, … instead of before 0, 8, ….

- Ruling (API, `src/gen/density/bounds.ts`): `createDensityBounds(c: CompiledDensity, noises: DensityNoiseSource): DensityBounds`. The bounds read `c`'s scratch, and `noises` must be the source `c` was compiled with; only `clampSigma` is read from it. `DensityBounds` has:
  - `compiled` (= c);
  - `nodeIntervals: Float64Array` (2 per node, `[2·id]` lo and `[2·id + 1]` hi, for the last call; NaN for a COLUMN node only COLUMN parents read);
  - `beginColumn()` (slot hulls of c's current column; call after columnFn + positionFn);
  - `cellInterval(ci, ck, cj, out, k)` (the root's interval with each `interpolated` from its child's interval, widened);
  - `cellIntervalCorners(ci, ck, cj, out, k)` (the same with each `interpolated` from the hull of its 8 corner values in `c.cornerValues`, widened; needs `c.cellCorners(ci, ck, cj)` and a `cellInterval` of the same cell first, and recomputes only the voxel-level nodes).

  Cost if wrong: an adapter in Task 8/9.
- Ruling (API, the driver): `fillDensityColumn(b, s, solid: Uint8Array, values: Float64Array | null, mask: Uint8Array | null, stop): boolean`.
  - It runs `columnFn(s)` and `positionFn(s)` itself, unconditionally (it does not reuse a probe's `hasPositions`), then `beginColumn`, then the 48 layers bottom up and the 16 cells of each.
  - Per cell: `cellInterval`. Then, if undecided and the compile has interpolated slots, `cellCorners` + `cellIntervalCorners`. Then either the cell is filled, or `voxelFn` runs on its 128 voxels.
  - `stop()` is called before layers 0, 8, …, 40 (6 polls); on true it returns false at once, leaving the outputs partial.
  - Indices are `((y + 64)·16 + lz)·16 + lx`, so section `sy` is `solid.subarray(4096·sy, 4096·(sy + 1))` in the SP3a stage's `(ly << 8) | (lz << 4) | lx` order.
  - `solid` is 1 where the density is > 0 (so −0 and 0 are non-solid).
  - `mask` (when non-null) is cleared and set to 1 at every voxel `voxelFn` evaluated; `values` (when non-null) gets those values and is untouched elsewhere.
  - Nothing is allocated (module-level 2-entry scratch).

  Task 8's density phase is `fillDensityColumn(b, sample, SOLID, null, null, stop)` after building the ColumnSample. `terrainDensityDebug` passes `values` and `mask`. Cost if wrong: none.
- Ruling (decision thresholds): the spec's literal `hi < 0` (non-solid) and `lo > 0` (solid). `hi ≤ 0` would also be exact, because solid ⇔ value > 0, and it would early-out a few more cells. It is not taken, so that the code reads like §2.4. Cost if wrong: a handful of extra evaluated cells where the interval touches 0 exactly.
- Ruling (placement of intervals):
  - Inside `interpolated`, a node is read only at corners, so its interval covers the cell's 8 corners: `y` is [y0, y0 + 8], and so is `slide`'s y range. A slotted COLUMN node takes the hull of its 4 corner-column values from `colValues`, which is exact and not widened.
  - Outside, a node covers the 128 voxels: `y` is [y0, y0 + 7] (Task 2's tighter option), and so is `slide`'s range. A slotted COLUMN node takes the hull of its 4 × 4 `posValues`, widened.
  - `noise` is ±clampSigma, and a `const` is [v, v] (set once).
  - An unslotted, non-const COLUMN node gets no interval: every non-COLUMN reader, `interpolated`, the root and a COLUMN root all read slotted nodes (Task 4's placement). The fuzz asserts that NaN appears only on such nodes.
  - Each interval is computed by a flat instruction list (inside nodes, then outside nodes, each in node order) with an int-code switch, recomputed per cell. The column-dependent hulls are precomputed per column for the 16 cell columns.

  Cost if wrong: none.
- Ruling (widening is kept even where it is redundant): the position hull is the hull of the very values `voxelFn` reads, so it is exact, and `lerp(a, b, t)` with t ∈ [0, 1) (every fraction here is k/4 or k/8) never leaves [min(a, b), max(a, b)]. The reason is that `t·(b − a)` only scales the rounded difference, so trilerp stays in its corners' hull. A 2-million-case random search found no counterexample. The spec's widening is applied anyway, as §1.2 states it, and the hand tests pin the widened values. No test can show the widening to be load-bearing in this geometry. Cost if wrong: none (looser by 1e-9 relative).
- Ruling (tests, `test/unit/densityBounds.test.ts`):
  - (1) hand intervals: an interpolated part plus 2·noise, a voxel-level position hull + y, and rangeChoice with inside/outside/both;
  - (2) the driver on `interpolated(100 − y)`: exact solidity; mask only on layer 20 (y 96 … 103), with `values = 100 − y` there; 6 polls; on stop at poll 3, layers 0 … 15 are filled and nothing above;
  - (3) soundness fuzz: 300 trees (`testRng(501)`) × 3 random cells. Every node with an interval is checked against the reference (`r.voxel(…, node.expr)` at 8 voxels of the cell for outside nodes, including both extreme corners; `r.corner` at the 8 corners for inside nodes), both after `cellInterval` and after `cellIntervalCorners`. The refined root interval is also checked against `voxelFn` at all 128 voxels. That is 105,456 node checks, with ≥ 30 constants of |v| ≥ 1e6 and ≥ 30 of |v| ≤ 1e-3 (fuzzConstant's log-uniform [1e-6, 1e9]);
  - (4) driver == full evaluation at all 98,304 voxels of 80 random trees (`testRng(502)`, at least 40 with `interpolated`), with solidity, values `Object.is` where mask is set, and every cell either all masked or none. On 40 trees the cell counts were air 5,177, solid 12,752, voxel 12,791;
  - (5) the same on a terrain-shaped stand-in over 4 real columns of seed '42', where 137 of 3,072 cells evaluate voxels (< 20 % asserted).

  Cost if wrong: none.
- Ruling (stand-in, `test/harness/densityFuzz.ts` `terrainStandInExpr()`): §3.1's default expression with the test noises: jag → fz2a (cs 3), overhang → fz3b (λ 32, 2 oct, yScale 2, cs 4), detail → fz3a (λ 8, 1 oct, cs 3), and amp = 0.6 + 0.9·clamp((E + 1)/2, 0, 1). Task 6 should replace its uses with the real default expression (or keep it as a schema-independent fixture). Cost if wrong: none (test-only).
- Ruling (MEASUREMENT, driver cost, stand-in): this was measured with a throwaway vitest file (not committed) on 400 random columns of seed '42' in ±1024 chunks, after warm-up, on a quiet machine (load 0.5), over three runs:
  - `fillDensityColumn` p50 0.68-0.69 ms, p90 0.88-0.89 ms, mean 0.73-0.75 ms per column, including columnFn + positionFn + hulls (p50 0.016 ms);
  - 37.0 of 768 cells per column straddle and run voxelFn (4.8 %);
  - full evaluation without early-outs costs p50 9.2-9.4 ms;
  - the ColumnSample alone costs 0.42-0.45 ms.

  The real default expression has 3 overhang octaves instead of 2 (more expensive corners) and different wavelengths, so Task 6/13 re-measure it. This number suggests `terrain.real` ≈ 0.45 + 0.7 + fill/water/sections, well inside the 4 ms gate. Cost if wrong: the 4 ms gate is tighter than it looks.

---

### Task 6: Density params, defaults, DensityContext, probe; N5 amendment

**Spec:** §3, §2.3 (DensityContext, probe), §3.3 (N5 lattice-coordinate vertical rose)

**Files:**
- Modify: `README.md`
- Modify: `src/core/params/kit.ts`
- Modify: `src/core/params/schema.ts`
- Modify: `src/core/stage/registry.ts`
- Create: `src/gen/density/context.ts`
- Create: `src/gen/density/defaults.ts`
- Create: `src/gen/density/probe.ts`
- Modify: `src/ui/paramPanel/model.ts`
- Modify: `test/harness/densityFuzz.ts`
- Modify: `test/harness/params.ts`
- Modify: `test/metrics/noise.metric.ts`
- Modify: `test/schema-shape.lock.json`
- Create: `test/unit/densityDefaults.test.ts`
- Modify: `test/unit/paramPanelModel.test.ts`
- Modify: `test/unit/schemaSp2a.test.ts`
- Create: `test/unit/schemaSp3b.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/expr.ts` (Task 2): `DensityExpr`, `DensityNoise`, `DensityNoiseSource`, `Expr`, `SlideKnot`
  - `src/gen/density/compile.ts` (Task 4): `compileDensity`, `type CompiledDensity`
  - `src/gen/density/bounds.ts` (Task 5): `createDensityBounds`, `type DensityBounds`
- Produces (exports added by this task):
  - `src/core/params/schema.ts`:
    - `export interface DensityParams extends Value<typeof ROOT.children.density> {}`
  - `src/gen/density/context.ts`:
    - `export interface DensityContext`
    - `export function densityNoiseOf(n: NormalNoise, dims: 2 | 3): DensityNoise`
    - `export function densityNoiseSource(ctx: GenContext): DensityNoiseSource`
    - `export function createDensityContext(ctx: GenContext, expr: DensityExpr = DEFAULT_EXPR(ctx.params.density)): DensityContext`
  - `src/gen/density/defaults.ts`:
    - `export function defaultDensityExpr(p: DensityParams): DensityExpr`
  - `src/gen/density/probe.ts`:
    - `export function probe(dc: DensityContext, x: number, y: number, z: number, tap?: string): number`
  - `test/harness/densityFuzz.ts`:
    - `export const SCHEMA_DENSITY_NOISES: readonly { readonly id: string; readonly dims: 2 | 3 }[] = SCHEMA.leaves`

- [ ] **Step 1: Write the failing tests**

Modify `test/metrics/noise.metric.ts` (apply with `git apply`):

```diff
diff --git a/test/metrics/noise.metric.ts b/test/metrics/noise.metric.ts
index b6be9e2..f976c49 100644
--- a/test/metrics/noise.metric.ts
+++ b/test/metrics/noise.metric.ts
@@ -23,7 +23,7 @@ export interface MetricNoise {
   readonly corners: boolean;
 }
 
-/** The 12 live schema instances (SP1 spec §7.3 "schema" set). */
+/** The live schema instances (SP1 spec §7.3 "schema" set): 12 climate, 4 shape (SP2a), 3 density (SP3b). */
 export const SCHEMA_NOISES: readonly MetricNoise[] = noiseInstances(SCHEMA, DEFAULTS).map((i) => ({ name: i.seedName, def: i.def, dims: i.dims, corners: false }));
 /** The 6 climate fields. */
 export const CLIMATE_NOISES: readonly MetricNoise[] = SCHEMA_NOISES.filter((n) => n.def.remap === 'uniform');
@@ -115,6 +115,10 @@ metricTest('N5', ['horizontal', 'vertical'], () => {
       const c = nn.clamp;
       const h = lastOctaveWavelength(nz.def) / 128;
       const f: Field = nz.dims === 2 ? (x, _y, z) => nn.z2(x, z) : (x, y, z) => nn.z3(x, y, z);
+      // The vertical rose is measured in lattice coordinates (SP3b spec §3.3, master §6.4 amended): the gradient of
+      // z3(x, y / yScale, z), so an anisotropic noise (overhang: yScale 1.25) is compared with itself on the lattice.
+      const ys = nz.def.yScale;
+      const g: Field = (x, y, z) => nn.z3(x, y / ys, z);
       const hr = new Rose();
       const vr = new Rose();
       for (let i = 0; i < n; i++) {
@@ -122,8 +126,9 @@ metricTest('N5', ['horizontal', 'vertical'], () => {
         const xp = f(x + h, y, z), xm = f(x - h, y, z), zp = f(x, y, z + h), zm = f(x, y, z - h);
         if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(zp) !== c && Math.abs(zm) !== c) hr.add(xp - xm, zp - zm);
         if (nz.dims === 3) {
-          const yp = f(x, y + h, z), ym = f(x, y - h, z);
-          if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(yp) !== c && Math.abs(ym) !== c) vr.add(xp - xm, yp - ym);
+          const gxp = ys === 1 ? xp : g(x + h, y, z), gxm = ys === 1 ? xm : g(x - h, y, z);
+          const yp = g(x, y + h, z), ym = g(x, y - h, z);
+          if (Math.abs(gxp) !== c && Math.abs(gxm) !== c && Math.abs(yp) !== c && Math.abs(ym) !== c) vr.add(gxp - gxm, yp - ym);
         }
       }
       horizontal = Math.max(horizontal, hr.ratio());
```

Create `test/unit/densityDefaults.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import { latticeIndex, type ColumnSample } from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { fillDensityColumn } from '../../src/gen/density/bounds';
import { createDensityContext, densityNoiseSource, type DensityContext } from '../../src/gen/density/context';
import { defaultDensityExpr } from '../../src/gen/density/defaults';
import { validateExpr, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { cornerY } from '../../src/gen/density/nodes';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, findTap, interpolatedNodes } from '../../src/gen/density/reference';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { randomValue } from '../harness/params';
import { testRng } from '../harness/stats';

const CTX = ctxFor('42');
/** Land (0, 0) and (5, −7); mountains (σ > 11, jag up to 37) at (−68, 100) and (−1022, −786); ocean (offset < 17) at (205, −181). */
const COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [5, -7], [-68, 100], [-1022, -786], [205, -181]];

function walk(e: Expr, visit: (e: Expr) => void): void {
  visit(e);
  for (const k of ['a', 'b', 'x', 'inside', 'outside'] as const) {
    const c = (e as unknown as Record<string, Expr | undefined>)[k];
    if (c !== undefined && typeof c === 'object') walk(c, visit);
  }
}
const ops = (e: DensityExpr): Expr[] => { const out: Expr[] = []; walk(e.root, (n) => out.push(n)); return out; };
const consts = (e: DensityExpr): number[] => ops(e).flatMap((n) => (n.op === 'const' ? [n.v] : []));

describe('the default expression (SP3b spec §3.1)', () => {
  test('it validates against the schema density noises', () => {
    const e = defaultDensityExpr(DEFAULTS.density);
    expect(validateExpr(e, densityNoiseSource(CTX))).toEqual([]);
    expect(Object.keys(e.defs)).toEqual([]);
    const noiseIds = ops(e).flatMap((n) => (n.op === 'noise2' || n.op === 'noise' ? [`${n.op}:${n.id}`] : []));
    expect(noiseIds.sort()).toEqual(['noise2:jag', 'noise:detail', 'noise:overhang']);
    const slides = ops(e).flatMap((n) => (n.op === 'slide' ? [n.knots] : []));
    expect(slides).toEqual([[[-64, 0], [-40, 1], [240, 1], [320, 0]]]);
  });

  test('taps: terrain outside interpolated (its value is the interpolated field), islands −1e6', () => {
    const e = defaultDensityExpr(DEFAULTS.density);
    expect(findTap(e, 'terrain')).toMatchObject({ inside: false, node: { x: { op: 'interpolated' } } });
    expect(findTap(e, 'islands')).toMatchObject({ inside: false, node: { x: { op: 'const', v: -1e6 } } });
    expect(interpolatedNodes(e)).toHaveLength(1);
  });

  test('placement: one interpolated slot; detail is VOXEL and reads amp from a position slot (bilinear E)', () => {
    const dc = createDensityContext(CTX);
    const c = dc.compiled;
    expect(c.interpolatedSlotCount).toBe(1);
    const detail = c.nodes.find((n) => n.op === 'noise' && (n.expr as { id: string }).id === 'detail')!;
    expect([detail.cls, detail.inside]).toEqual(['voxel', false]);
    const parent = c.nodes.find((n) => n.op === 'mul' && n.kids.includes(c.nodes.indexOf(detail)))!;
    const amp = c.nodes[parent.kids.find((k) => k !== c.nodes.indexOf(detail))!]!;
    expect([amp.op, amp.cls, amp.posSlot >= 0]).toEqual(['add', 'column', true]);
    // y and slide are never COLUMN (spec §2.1).
    for (const n of c.nodes) if (n.op === 'y' || n.op === 'slide') expect(n.cls, n.op).toBe('cell');
  });

  test('the tunables come from params.density: 1 / jag clampSigma, ampLo and ampHi − ampLo', () => {
    const base = consts(defaultDensityExpr(DEFAULTS.density));
    expect(base).toContain(1 / 3);
    expect(base).toContain(0.6);
    expect(base).toContain(1.5 - 0.6);
    const d = { ...DEFAULTS.density, noises: { ...DEFAULTS.density.noises, jag: { ...DEFAULTS.density.noises.jag, clampSigma: 2.5 } }, detailAmpLo: 0.25, detailAmpHi: 4 };
    const moved = consts(defaultDensityExpr(d));
    expect(moved).toContain(1 / 2.5);
    expect(moved).toContain(0.25);
    expect(moved).toContain(3.75);
    expect(moved).not.toContain(1 / 3);
  });
});

describe('DensityContext (spec §2.3)', () => {
  test('the noise source is the GenContext\'s density.noises.<id> NormalNoises, with the schema dims', () => {
    const src = densityNoiseSource(CTX);
    for (const [id, dims] of [['jag', 2], ['overhang', 3], ['detail', 3]] as const) {
      const n = src(id)!;
      const nn = CTX.noise.get(`density.noises.${id}`)!;
      expect([n.dims, n.remap, n.clampSigma]).toEqual([dims, 'none', nn.clamp]);
      for (const [x, y, z] of [[0, 0, 0], [123, -17, -4567], [-99999, 300, 31337]] as const) {
        expect(n.z2(x, z)).toBe(nn.z2(x, z));
        expect(n.z3(x, y, z)).toBe(nn.z3(x, y, z));
      }
    }
    expect(SCHEMA_DENSITY_NOISES).toEqual([{ id: 'jag', dims: 2 }, { id: 'overhang', dims: 3 }, { id: 'detail', dims: 3 }]);
    expect(src('climate.C')).toBeUndefined();
    expect(src('nope')).toBeUndefined();
  });

  test('column(cx, cz) reuses the current column and the ColumnCache', () => {
    const dc = createDensityContext(CTX);
    const s = dc.column(3, -4);
    expect([s.cx, s.cz, dc.compiled.hasPositions(3, -4), dc.columns.size]).toEqual([3, -4, true, 1]);
    expect(dc.column(3, -4)).toBe(s);
    dc.column(4, -4);
    expect([dc.compiled.hasPositions(3, -4), dc.compiled.hasPositions(4, -4), dc.columns.size]).toEqual([false, true, 2]);
    expect(dc.column(3, -4)).toBe(s);
  });

  test('a custom expression compiles over the same noises', () => {
    const e: DensityExpr = { root: { op: 'add', a: { op: 'noise', id: 'detail' }, b: { op: 'y' } }, defs: {} };
    const dc = createDensityContext(CTX, e);
    expect(probe(dc, 17, 5, -3)).toBe(CTX.noise.get('density.noises.detail')!.z3(17, 5, -3) + 5);
    expect(() => createDensityContext(CTX, { root: { op: 'noise', id: 'jag' }, defs: {} })).toThrow(/NOISE_DIMS/);
  });
});

/**
 * The default expression at a lattice-aligned voxel (lx, lz ∈ {0, 4, 8, 12}, y = −64 + 8k), by hand: every
 * interpolation weight is 0, so the terrain is its corner value and the bilinear E is the lattice E.
 */
function byHand(s: ColumnSample, i: number, k: number, j: number): { terrain: number; final: number } {
  const x = 16 * s.cx + 4 * i, y = cornerY(k), z = 16 * s.cz + 4 * j, l = latticeIndex(i, j);
  const n = (id: string) => CTX.noise.get(`density.noises.${id}`)!;
  const p = DEFAULTS.density;
  const q = 1 - Math.abs(n('jag').z2(x, z) * (1 / p.noises.jag.clampSigma));
  const J = q * q;
  // slide(N3) over [(−64, 0), (−40, 1), (240, 1), (320, 0)]
  const sAt = y < -40 ? 0 + (y - -64) * ((1 - 0) / (-40 - -64)) : y < 240 ? 1 + (y - -40) * ((1 - 1) / (240 - -40)) : y < 320 ? 1 + (y - 240) * ((0 - 1) / (320 - 240)) : 0;
  let t = s.f.offset[l]! + s.f.jag[l]! * J;
  t = t + -y;
  t = t + s.f.sigma[l]! * (n('overhang').z3(x, y, z) * sAt);
  t = t + 2 * Math.max(0, -56 + -y);
  t = t + -(2 * Math.max(0, y + -296));
  const amp = p.detailAmpLo + (p.detailAmpHi - p.detailAmpLo) * Math.min(1, Math.max(0, (s.f.E[l]! + 1) * 0.5));
  const v = t + n('detail').z3(x, y, z) * amp;
  return { terrain: t, final: v > -1e6 ? v : -1e6 };
}

describe('probe (spec §2.3)', () => {
  test('hand-checked values at lattice-aligned voxels: final, the terrain tap and the islands tap', () => {
    const dc = createDensityContext(CTX);
    let checked = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.columns.get(cx, cz);
      for (const [i, j] of [[0, 0], [1, 2], [3, 3], [2, 0]] as const) {
        for (const k of [0, 1, 2, 10, 15, 16, 20, 25, 30, 40, 48]) {
          if (k === 48) continue; // y 320 is above the world.
          const x = 16 * cx + 4 * i, y = cornerY(k), z = 16 * cz + 4 * j;
          const h = byHand(s, i, k, j);
          expect(probe(dc, x, y, z), `(${x}, ${y}, ${z})`).toBe(h.final);
          expect(probe(dc, x, y, z, 'terrain'), `terrain (${x}, ${y}, ${z})`).toBe(h.terrain);
          expect(probe(dc, x, y, z, 'islands')).toBe(-1e6);
          checked++;
        }
      }
    }
    expect(checked).toBe(5 * 4 * 10);
  });

  test('probe == the reference interpreter (Object.is) at random voxels, across column switches', () => {
    const dc = createDensityContext(CTX);
    const ref = createDensityReference(dc.expr, dc.noises);
    const next = testRng(601);
    for (let n = 0; n < 600; n++) {
      const [cx, cz] = COLUMNS[next() % COLUMNS.length]!;
      const x = 16 * cx + (next() % 16), z = 16 * cz + (next() % 16), y = -64 + (next() % 384);
      const s = dc.columns.get(cx, cz);
      const tap = n % 3 === 0 ? 'terrain' : undefined;
      const want = tap === undefined ? ref.voxel(s, x, y, z) : ref.tap(s, tap, x, y, z);
      const got = probe(dc, x, y, z, tap);
      if (!Object.is(got, want)) throw new Error(`probe(${x}, ${y}, ${z}${tap ? `, ${tap}` : ''}) = ${got}, reference ${want}`);
    }
  });

  test('arguments: integers, y in −64 … 319, (x, z) in the world window; unknown taps throw', () => {
    const dc = createDensityContext(CTX);
    expect(() => probe(dc, 0, -65, 0)).toThrow(RangeError);
    expect(() => probe(dc, 0, 320, 0)).toThrow(RangeError);
    expect(() => probe(dc, 0.5, 0, 0)).toThrow(RangeError);
    expect(() => probe(dc, 0, 0, 524288)).toThrow(RangeError);
    expect(() => probe(dc, 0, 0, 0, 'nope')).toThrow(/no tap "nope"/);
    expect(Number.isFinite(probe(dc, -524288, 319, 524287))).toBe(true);
  });
});

/** Column-wide voxel index, as the T stage's sections: ((y + 64)·16 + lz)·16 + lx. */
const vIdx = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;
const hull = (a: Float64Array, ls: readonly number[]): [number, number] => {
  let lo = Infinity, hi = -Infinity;
  for (const l of ls) { lo = Math.min(lo, a[l]!); hi = Math.max(hi, a[l]!); }
  return [lo, hi];
};

describe('early-outs of the default expression (spec §3.2) and the driver on it', () => {
  test('cells above offset + jag + cs·σ + cs·ampHi are air and cells the floor term keeps positive are solid, without evaluation; driver == probe', () => {
    const dc = createDensityContext(CTX);
    const cs = DEFAULTS.density.noises.overhang.clampSigma, csD = DEFAULTS.density.noises.detail.clampSigma, ampHi = DEFAULTS.density.detailAmpHi;
    const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
    let above = 0, below = 0, evaluated = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.columns.get(cx, cz);
      expect(fillDensityColumn(dc.bounds, s, solid, values, mask, () => false)).toBe(true);
      for (let ck = 0; ck < 48; ck++) {
        const y0 = cornerY(ck);
        for (let cj = 0; cj < 4; cj++) {
          for (let ci = 0; ci < 4; ci++) {
            const ls = [latticeIndex(ci, cj), latticeIndex(ci + 1, cj), latticeIndex(ci, cj + 1), latticeIndex(ci + 1, cj + 1)];
            const [offLo, offHi] = hull(s.f.offset, ls), [jagLo, jagHi] = hull(s.f.jag, ls), [sgLo, sgHi] = hull(s.f.sigma, ls);
            const sg = Math.max(Math.abs(sgLo), Math.abs(sgHi));
            const top = offHi + Math.max(0, jagHi) + cs * sg + csD * ampHi;
            const low = offLo + Math.min(0, jagLo) - (y0 + 8) - cs * sg + 2 * Math.max(0, -56 - (y0 + 8)) - 2 * Math.max(0, y0 + 8 - 296) - csD * ampHi;
            let masked = 0, solids = 0;
            for (let y = y0; y < y0 + 8; y++) {
              for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
                for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
                  const v = vIdx(lx, y, lz);
                  masked += mask[v]!;
                  solids += solid[v]!;
                }
              }
            }
            if (masked > 0) evaluated++;
            if (y0 > top + 1e-3) { above++; expect([masked, solids], `cell (${ci}, ${ck}, ${cj}) of (${cx}, ${cz})`).toEqual([0, 0]); }
            if (low > 1e-3) { below++; expect([masked, solids], `cell (${ci}, ${ck}, ${cj}) of (${cx}, ${cz})`).toEqual([0, 128]); }
          }
        }
      }
      // Driver == probe (no early-outs) at every voxel: solidity, and the value where the driver evaluated.
      for (let y = -64; y < 320; y++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const v = vIdx(lx, y, lz);
            const p = probe(dc, 16 * cx + lx, y, 16 * cz + lz);
            if (solid[v] !== (p > 0 ? 1 : 0)) throw new Error(`(${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): solid ${solid[v]}, probe ${p}`);
            if (mask[v] === 1 && !Object.is(values[v], p)) throw new Error(`(${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): driver ${values[v]}, probe ${p}`);
          }
        }
      }
    }
    // Both rules apply to most cells; few cells straddle the surface.
    expect(above + below).toBeGreaterThan(0.8 * COLUMNS.length * 768);
    expect(below).toBeGreaterThan(COLUMNS.length * 16 * 4);
    expect(evaluated / (COLUMNS.length * 768)).toBeLessThan(0.1);
  });
});

describe('compile == reference over the schema density noises (fuzz)', () => {
  test('random trees over jag / overhang / detail, Object.is at random voxels', () => {
    const noises = densityNoiseSource(CTX);
    const next = testRng(602);
    const s = createDensityContext(CTX).columns.get(-68, 100);
    for (let t = 0; t < 60; t++) {
      const e = randomDensityExpr(next, { noises: SCHEMA_DENSITY_NOISES });
      const dc = createDensityContext(CTX, e);
      const ref = createDensityReference(e, noises);
      for (let n = 0; n < 16; n++) {
        const x = 16 * s.cx + (next() % 16), z = 16 * s.cz + (next() % 16), y = -64 + (next() % 384);
        const got = probe(dc, x, y, z), want = ref.voxel(s, x, y, z);
        if (!Object.is(got, want)) throw new Error(`tree ${t} at (${x}, ${y}, ${z}): compiled ${got}, reference ${want}\n${JSON.stringify(e)}`);
      }
    }
  });
});

/** A shape spline that is `y` everywhere. */
const flatSpline = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });

/**
 * Column (cx, cz) of `c`: the driver (bounds and early-outs) against the probe (none) at all 98,304 voxels, solidity and
 * Object.is where the driver evaluated; the probe against the reference interpreter at 48 random voxels. Returns the
 * number of cells whose voxels the driver evaluated.
 */
function checkColumn(c: GenContext, cx: number, cz: number, next: () => number, what: string): number {
  const dc = createDensityContext(c);
  const dcProbe = createDensityContext(c);
  const ref = createDensityReference(dc.expr, dc.noises);
  const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
  const s = dc.columns.get(cx, cz);
  expect(fillDensityColumn(dc.bounds, s, solid, values, mask, () => false)).toBe(true);
  let masked = 0;
  for (let y = -64; y < 320; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const v = vIdx(lx, y, lz);
        const p = probe(dcProbe, 16 * cx + lx, y, 16 * cz + lz);
        if (solid[v] !== (p > 0 ? 1 : 0)) throw new Error(`${what}, (${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): solid ${solid[v]}, probe ${p}`);
        if (mask[v] === 1 && !Object.is(values[v], p)) throw new Error(`${what}, (${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): driver ${values[v]}, probe ${p}`);
        masked += mask[v]!;
      }
    }
  }
  for (let n = 0; n < 48; n++) {
    const x = 16 * cx + (next() % 16), z = 16 * cz + (next() % 16), y = -64 + (next() % 384);
    const got = probe(dcProbe, x, y, z), want = ref.voxel(s, x, y, z);
    if (!Object.is(got, want)) throw new Error(`${what} at (${x}, ${y}, ${z}): compiled ${got}, reference ${want}`);
  }
  return masked / 128;
}

describe('the density at its parameter extremes (spec §1.2, §2.4: early-outs exact and bounds sound for every valid value)', () => {
  /** Schema extremes of the density leaves and of the shape splines the expression reads; all valid. */
  const EXTREMES: ReadonlyArray<readonly [string, ParamsPatch]> = [
    ['detail amplitudes inverted (Lo 8, Hi 0)', { density: { detailAmpLo: 8, detailAmpHi: 0 } }],
    ['detail amplitudes both 8', { density: { detailAmpLo: 8, detailAmpHi: 8 } }],
    ['detail noise λ 4, 16 octaves, lacunarity 4, persistence 1, clampSigma 8', { density: { noises: { detail: { wavelength: 4, octaves: 16, lacunarity: 4, persistence: 1, clampSigma: 8 } } } }],
    ['overhang noise λ 16, 1 octave, yScale 100, clampSigma 8', { density: { noises: { overhang: { wavelength: 16, octaves: 1, yScale: 100, clampSigma: 8 } } } }],
    ['overhang noise λ 8192, 16 octaves, yScale 0.01, clampSigma 1', { density: { noises: { overhang: { wavelength: 8192, octaves: 16, yScale: 0.01, clampSigma: 1 } } } }],
    ['jag noise λ 16, 1 octave, clampSigma 1', { density: { noises: { jag: { wavelength: 16, octaves: 1, clampSigma: 1 } } } }],
    ['jag noise λ 8192, clampSigma 8', { density: { noises: { jag: { wavelength: 8192, clampSigma: 8 } } } }],
    ['σ 64 and jag 128 everywhere', { shape: { sigma: flatSpline(64), jag: flatSpline(128) } }],
    ['offset 320 (the ceiling), σ 64, jag 128', { shape: { offset: flatSpline(320), sigma: flatSpline(64), jag: flatSpline(128) } }],
    ['offset −64 (the floor), σ 64', { shape: { offset: flatSpline(-64), sigma: flatSpline(64) } }],
    ['σ and jag at their minimum −16 (clamped at 0)', { shape: { sigma: flatSpline(-16), jag: flatSpline(-16) } }],
  ];

  test.each(EXTREMES)('%s: driver == probe at every voxel, probe == reference, and the bounds still decide most cells', (what, patch) => {
    const c = ctxFor('42', patch);
    const next = testRng(605);
    let evaluated = 0;
    for (const [cx, cz] of COLUMNS) evaluated += checkColumn(c, cx, cz, next, what);
    // The T stays far from full evaluation (≈ 9 ms per column): at these extremes a quarter of the cells at most
    // evaluate their voxels (σ 64 with jag 128 the most).
    expect(evaluated / (COLUMNS.length * 768)).toBeLessThan(0.4);
  });

  test('random valid density groups (the params harness) compile, and their driver equals the probe', () => {
    const next = testRng(606);
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    for (let t = 0; t < 8; t++) {
      const noises: Record<string, unknown> = {};
      const density: Record<string, unknown> = { noises };
      for (const { path, leaf } of leaves) {
        const key = path.slice('density.'.length);
        if (key.startsWith('noises.')) noises[key.slice('noises.'.length)] = randomValue(leaf, next);
        else density[key] = randomValue(leaf, next);
      }
      const what = `group ${t}: ${JSON.stringify(density)}`;
      // A schema-valid group must compile: validateExpr rejected a 'uniform' jag (NOISE_REMAP) before the schema refused it.
      const c = ctxFor('42', { density } as ParamsPatch);
      const [cx, cz] = COLUMNS[t % COLUMNS.length]!;
      checkColumn(c, cx, cz, next, what);
    }
  });
});
```

Modify `test/unit/paramPanelModel.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/paramPanelModel.test.ts b/test/unit/paramPanelModel.test.ts
index 073ce9f..2c77673 100644
--- a/test/unit/paramPanelModel.test.ts
+++ b/test/unit/paramPanelModel.test.ts
@@ -35,7 +35,7 @@ describe('panel tree', () => {
     expect(root.path).toBe('');
     expect(root.label).toBe('Parameters');
     expect(root.controls).toEqual([]);
-    expect(root.sections.map((s) => s.path)).toEqual(['climate', 'shape', 'rivers', 'lakes', 'biomes']);
+    expect(root.sections.map((s) => s.path)).toEqual(['climate', 'shape', 'rivers', 'lakes', 'biomes', 'density']);
     const groups = SCHEMA.nodes.filter((n) => n.node.tag === 'group').map((n) => n.path);
     expect(sectionsOf(root).map((s) => s.path).sort()).toEqual([...groups].sort());
     expect(controlsOf(root).map((c) => c.path).sort()).toEqual(SCHEMA.leaves.map((l) => l.path).sort());
@@ -79,11 +79,12 @@ describe('panel tree', () => {
     expect(log.sort()).toEqual([
       'climate.C', 'climate.E', 'climate.H', 'climate.R', 'climate.T', 'climate.W', 'climate.scaleMul',
       'climate.warp.C.noise', 'climate.warp.R.noise', 'climate.warp.shift.noise',
+      'density.noises.detail', 'density.noises.jag', 'density.noises.overhang',
       'lakes.cell', 'lakes.depthMin', 'lakes.radius', 'lakes.rimNoise', 'lakes.rimWidth', 'lakes.warpNoise',
       'rivers.widthMin', 'rivers.widthNoise',
     ]);
-    // ratio 15 (ringFrac 0.1 … 1.5), min 0 (zoomJitter), negative min (coastFadeLo), splines and the table stay linear
-    for (const p of ['lakes.ringFrac', 'biomes.zoomJitter', 'rivers.coastFadeLo', 'rivers.valleyFloor', 'shape.offset', 'biomes.table']) {
+    // ratio 15 (ringFrac 0.1 … 1.5), min 0 (zoomJitter, the detail amplitudes), negative min (coastFadeLo), splines and the table stay linear
+    for (const p of ['lakes.ringFrac', 'biomes.zoomJitter', 'density.detailAmpLo', 'density.detailAmpHi', 'rivers.coastFadeLo', 'rivers.valleyFloor', 'shape.offset', 'biomes.table']) {
       expect(control(p).scale).toBe('linear');
     }
   });
@@ -253,6 +254,19 @@ describe('noise sub-block', () => {
   });
 });
 
+describe('density noises (SP3b spec §1.1)', () => {
+  test('the remap of a density noise is locked at \'none\', 2D jag included: the schema refuses \'uniform\'', () => {
+    for (const path of ['density.noises.jag', 'density.noises.overhang', 'density.noises.detail']) {
+      const c = control(path);
+      expect(c.remapNone, path).toBe(true);
+      expect(noiseFieldLock(c, noiseAt(path), 'remap'), path).toBe("a density noise keeps remap 'none'");
+    }
+    // The other noises are unchanged: the 2D jag would otherwise offer 'uniform' (double is true).
+    expect(control('lakes.rimNoise').remapNone).toBeUndefined();
+    expect(noiseFieldLock(control('density.noises.jag'), noiseAt('density.noises.jag'), 'double')).toBeNull();
+  });
+});
+
 describe('cross-field lints', () => {
   test('the defaults have no lint', () => {
     expect(paramLints(DEFAULTS)).toEqual([]);
@@ -300,7 +314,7 @@ describe('panel controls (Task 17): kinds, slider positions, typed values, issue
 
   test('on a linear stepped slider every keyboard step moves to the next value of the step grid', () => {
     const linear = [...sliders(), ...NOISE_NUMBER_FIELDS.map((f) => noiseFieldControl(control('climate.C'), f))].filter((c) => c.scale === 'linear');
-    expect(linear.length).toBe(32);
+    expect(linear.length).toBe(34);
     for (const c of linear) {
       const n = sliderPositions(c);
       expect(n).toBe(Math.round((c.max! - c.min!) / c.step!));
```

Modify `test/unit/schemaSp2a.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/schemaSp2a.test.ts b/test/unit/schemaSp2a.test.ts
index e9e132d..e0f2549 100644
--- a/test/unit/schemaSp2a.test.ts
+++ b/test/unit/schemaSp2a.test.ts
@@ -10,7 +10,7 @@ import { JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
 
 describe('SP2a schema groups', () => {
   test('leaves, scopes and stages', () => {
-    const rows = PARAM_META.filter((m) => !m.path.startsWith('climate.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`);
+    const rows = PARAM_META.filter((m) => !m.path.startsWith('climate.') && !m.path.startsWith('density.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`);
     const g = (prefix: string, stage: string, names: string) => names.split(' ').map((n) => {
       const [name, kind] = n.split(':');
       return `${prefix}.${name}:${kind ?? 'number'}:terrain:${stage}`;
@@ -43,7 +43,7 @@ describe('SP2a schema groups', () => {
   });
   test('the new noise instances have distinct seed names', () => {
     const names = noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName);
-    expect(names.filter((n) => !n.startsWith('climate.'))).toEqual(['rivers.widthNoise', 'lakes.warpNoise.x', 'lakes.warpNoise.z', 'lakes.rimNoise']);
+    expect(names.filter((n) => !n.startsWith('climate.') && !n.startsWith('density.'))).toEqual(['rivers.widthNoise', 'lakes.warpNoise.x', 'lakes.warpNoise.z', 'lakes.rimNoise']);
     expect(new Set(names).size).toBe(names.length);
   });
 });
```

Create `test/unit/schemaSp3b.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { metaOf, PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, stageHashes } from '../../src/core/stage/hash';
import { checkRegistry, STAGES } from '../../src/core/stage/registry';

describe('SP3b density group (spec §3.3)', () => {
  test('leaves, kinds, scope terrain and stage terrain', () => {
    expect(PARAM_META.filter((m) => m.path.startsWith('density.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`)).toEqual([
      'density.noises.jag:noise:terrain:terrain',
      'density.noises.overhang:noise:terrain:terrain',
      'density.noises.detail:noise:terrain:terrain',
      'density.detailAmpLo:number:terrain:terrain',
      'density.detailAmpHi:number:terrain:terrain',
    ]);
  });

  test('meta: dims and wavelength ranges of the noises, ranges of the amplitudes', () => {
    expect(metaOf('density.noises.jag')).toMatchObject({ dims: 2, min: 16, max: 8192 });
    expect(metaOf('density.noises.overhang')).toMatchObject({ dims: 3, min: 16, max: 8192 });
    expect(metaOf('density.noises.detail')).toMatchObject({ dims: 3, min: 4, max: 256 });
    for (const p of ['density.detailAmpLo', 'density.detailAmpHi']) expect(metaOf(p)).toMatchObject({ min: 0, max: 8, step: 0.05, unit: 'blocks' });
  });

  test('defaults: jag λ 28 × 2 octaves, overhang λ 80 yScale 1.25 × 3, detail λ 10 × 1; amplitudes 0.6 and 1.5', () => {
    const d = DEFAULTS.density;
    const n = (x: typeof d.noises.jag) => [x.wavelength, x.octaves, x.yScale, x.remap, x.clampSigma, x.double];
    expect(n(d.noises.jag)).toEqual([28, 2, 1, 'none', 3, true]);
    expect(n(d.noises.overhang)).toEqual([80, 3, 1.25, 'none', 3, true]);
    expect(n(d.noises.detail)).toEqual([10, 1, 1, 'none', 3, true]);
    // λy = λ / yScale = 64 (spec §3.3: overhang λy 64).
    expect(d.noises.overhang.wavelength / d.noises.overhang.yScale).toBe(64);
    expect([d.detailAmpLo, d.detailAmpHi]).toEqual([0.6, 1.5]);
  });

  test('the noise instances: seed names are the leaf paths, with their dims', () => {
    const inst = noiseInstances(SCHEMA, DEFAULTS).filter((i) => i.path.startsWith('density.'));
    expect(inst.map((i) => `${i.seedName}|${i.dims}`)).toEqual(['density.noises.jag|2', 'density.noises.overhang|3', 'density.noises.detail|3']);
  });

  test('a 2D jag noise refuses yScale ≠ 1; the 3D noises accept it', () => {
    const bad = applyPatch(SCHEMA, DEFAULTS, { density: { noises: { jag: { yScale: 2 } } } });
    expect(bad.ok ? [] : bad.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['density.noises.jag.yScale YSCALE_NOT_1']);
    expect(applyPatch(SCHEMA, DEFAULTS, { density: { noises: { detail: { yScale: 2 } } } }).ok).toBe(true);
  });

  test('a density noise refuses remap \'uniform\' (validateExpr rejects the expression, so no T column could be generated)', () => {
    // jag is 2D with double: true, so only this rule stops 'uniform' (a preset, a URL or the panel's remap select).
    const jag = applyPatch(SCHEMA, DEFAULTS, { density: { noises: { jag: { remap: 'uniform' } } } });
    expect(jag.ok ? [] : jag.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['density.noises.jag.remap REMAP_NOT_ALLOWED']);
    for (const id of ['overhang', 'detail'] as const) {
      const r = applyPatch(SCHEMA, DEFAULTS, { density: { noises: { [id]: { remap: 'uniform' } } } });
      expect(r.ok ? [] : r.issues.map((i) => `${i.path} ${i.code}`)).toEqual([`density.noises.${id}.remap REMAP_NOT_ALLOWED`]);
    }
    expect(PARAM_META.filter((m) => m.remapNone === true).map((m) => m.path)).toEqual(['density.noises.jag', 'density.noises.overhang', 'density.noises.detail']);
    // A 2D noise outside the density group keeps 'uniform'.
    expect(applyPatch(SCHEMA, DEFAULTS, { lakes: { rimNoise: { remap: 'uniform' } } }).ok).toBe(true);
  });

  test('the terrain stage hashes the density group (U4 registry invariants hold)', () => {
    expect(STAGES.find((s) => s.id === 'terrain')!.params).toEqual(['density']);
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
    const moved = applyPatch(SCHEMA, DEFAULTS, { density: { detailAmpHi: 2 } });
    if (!moved.ok) throw new Error('bad patch');
    // A density edit dirties the terrain stage and what reads it, never the 2D stages.
    expect(dirtyStages(stageHashes(DEFAULTS), stageHashes(moved.value))).toEqual(['terrain', 'decorate', 'light', 'mesh']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project metrics-fast --project unit test/metrics/noise.metric.ts test/unit/densityDefaults.test.ts test/unit/paramPanelModel.test.ts test/unit/schemaSp2a.test.ts test/unit/schemaSp3b.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× leaves, kinds, scope terrain and stage terrain 5ms
× meta: dims and wavelength ranges of the noises, ranges of the amplitudes 2ms
× defaults: jag λ 28 × 2 octaves, overhang λ 80 yScale 1.25 × 3, detail λ 10 × 1; amplitudes 0.6 and 1.5 0ms
× the noise instances: seed names are the leaf paths, with their dims 1ms
× a 2D jag noise refuses yScale ≠ 1; the 3D noises accept it 1ms
× a density noise refuses remap 'uniform' (validateExpr rejects the expression, so no T column could be generated) 1ms
× the terrain stage hashes the density group (U4 registry invariants hold) 0ms
× one section per group and one control per leaf, under its parent, in schema order 8ms
× scale: log when min > 0 and max / min ≥ 20, and for every noise wavelength; linear otherwise 1ms
× the remap of a density noise is locked at 'none', 2D jag included: the schema refuses 'uniform' 0ms
× on a linear stepped slider every keyboard step moves to the next value of the step grid 1ms
FAIL  |unit| test/unit/densityDefaults.test.ts [ test/unit/densityDefaults.test.ts ]
Error: Cannot find module '../../src/gen/density/context' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3b/replay/test/unit/densityDefaults.test.ts
FAIL  |unit| test/unit/paramPanelModel.test.ts > panel tree > one section per group and one control per leaf, under its parent, in schema order
… (20 more lines)
Test Files  3 failed | 2 passed (5)
Tests  11 failed | 44 passed (55)
```

- [ ] **Step 3: Implement**

Modify `README.md` (apply with `git apply`):

```diff
diff --git a/README.md b/README.md
index 30c1bd2..9d2156b 100644
--- a/README.md
+++ b/README.md
@@ -89,6 +89,11 @@ Generated from `src/core/params/schema.ts` by `npm run docs:params`; a test fail
 | `lakes.sigmaMul` | number | 0.3 | 0 … 1 |  | terrain | Basin sigma: Multiplier of σ inside the basin. |
 | `biomes.table` | boxTable | 26 rows | deep_ocean / ocean / warm_ocean / frozen_ocean / beach / snowy_beach / stony_shore / plains / meadow / forest / birch_forest / dark_forest / taiga / snowy_taiga / snowy_plains / desert / savanna / swamp / jungle / badlands / windswept_hills / snowy_slopes / stony_peaks / jagged_peaks / frozen_peaks / volcano |  | terrain | Biome boxes: Climate box, sign(W) filter and tie-break priority of every box-picked surface biome. |
 | `biomes.zoomJitter` | number | 1.5 | 0 … 2 | blocks | terrain | Zoom jitter: Jitter of the quart centres in the jittered-Voronoi zoom. |
+| `density.noises.jag` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":28,"yScale":1} | wavelength 16 … 8192 |  | terrain | Jag noise: Ridges of jagged peaks: J = (1 − \|z / clampSigma\|)², times the jag spline. |
+| `density.noises.overhang` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":3,"persistence":0.5,"remap":"none","wavelength":80,"yScale":1.25} | wavelength 16 … 8192 |  | terrain | Overhang noise: 3D surface displacement, times σ and the vertical slide (yScale 1.25: λy 64). |
+| `density.noises.detail` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":1,"persistence":0.5,"remap":"none","wavelength":10,"yScale":1} | wavelength 4 … 256 |  | terrain | Detail noise: Small 3D surface detail outside the interpolation, times the detail amplitude. |
+| `density.detailAmpLo` | number | 0.6 | 0 … 8 | blocks | terrain | Detail amplitude at E −1: Detail amplitude in blocks where E ≤ −1. |
+| `density.detailAmpHi` | number | 1.5 | 0 … 8 | blocks | terrain | Detail amplitude at E +1: Detail amplitude in blocks where E ≥ 1; linear in (E + 1) / 2 between the two. |
 <!-- params:end -->
 
 ## Requirements
```

Modify `src/core/params/kit.ts` (apply with `git apply`):

```diff
diff --git a/src/core/params/kit.ts b/src/core/params/kit.ts
index 2961afe..d3ff171 100644
--- a/src/core/params/kit.ts
+++ b/src/core/params/kit.ts
@@ -35,6 +35,8 @@ export interface ParamMeta {
   readonly step?: number;
   readonly options?: readonly string[];
   readonly dims?: 2 | 3;
+  /** Noise leaves whose remap must stay 'none' (SP3b density noises: the density expression rejects any other). */
+  readonly remapNone?: true;
   readonly coords?: readonly SplineCoord[];
   readonly scope: RegenScope;
   readonly stage?: StageId;
@@ -44,7 +46,7 @@ export interface ParamMeta {
 export type ParamIssueCode =
   | 'UNKNOWN_KEY' | 'MISSING_KEY' | 'NOT_OBJECT' | 'NOT_NUMBER' | 'NOT_FINITE' | 'NOT_INTEGER' | 'INT_TOO_LARGE'
   | 'OUT_OF_RANGE' | 'NOT_BOOL' | 'BAD_ENUM' | 'AMPLITUDES_LENGTH' | 'AMPLITUDES_ZERO' | 'AMPLITUDE_TINY' | 'YSCALE_NOT_1'
-  | 'REMAP_NEEDS_DOUBLE' | 'REMAP_NEEDS_2D' | 'BAD_INTERVAL' | 'DUPLICATE_PRIORITY';
+  | 'REMAP_NEEDS_DOUBLE' | 'REMAP_NEEDS_2D' | 'REMAP_NOT_ALLOWED' | 'BAD_INTERVAL' | 'DUPLICATE_PRIORITY';
 export type PresetIssueCode = 'BAD_FORMAT' | 'BAD_NAME' | 'RESERVED_NAME' | 'UNKNOWN_PROFILE' | 'BAD_SCHEMA_VERSION' | 'NEWER_SCHEMA_VERSION';
 export type IssueCode = ParamIssueCode | PresetIssueCode | 'MIGRATION_FAILED' | SplineErrorCode;
 
@@ -71,6 +73,8 @@ export interface Leaf<T, P = T> {
   readonly coords?: readonly SplineCoord[];
   readonly seedName?: string;
   readonly components?: readonly ['x', 'z'];
+  /** A noise leaf whose remap must stay 'none' (NoiseMeta.remapNone). */
+  readonly remapNone?: true;
   /** Phantom: never present at runtime. */
   readonly __patch?: P;
 }
@@ -103,6 +107,11 @@ export type NoiseMeta = MetaInput & {
   readonly dims: 2 | 3;
   readonly seedName?: string;
   readonly components?: readonly ['x', 'z'];
+  /**
+   * The noise must keep remap 'none' (validated: REMAP_NOT_ALLOWED). SP3b's density noises: `validateExpr` rejects a
+   * density noise with another remap, so a schema-valid 'uniform' would make every T column throw.
+   */
+  readonly remapNone?: true;
 };
 export type SplineMeta = MetaInput & { readonly coords: readonly SplineCoord[]; readonly min: number; readonly max: number };
 
@@ -137,6 +146,7 @@ export function noise(def: Pick<NoiseDef, 'wavelength' | 'octaves'> & NoiseDefPa
     min: meta.wavelength.min, max: meta.wavelength.max, dims: meta.dims,
     ...(meta.seedName !== undefined ? { seedName: meta.seedName } : {}),
     ...(meta.components !== undefined ? { components: meta.components } : {}),
+    ...(meta.remapNone === true ? { remapNone: true } : {}),
   };
 }
 
@@ -236,8 +246,12 @@ function checkNoise(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown,
   if (remap !== 'none' && remap !== 'uniform') out.push({ path: join(path, 'remap'), code: 'BAD_ENUM', message: `expected "none" | "uniform", got ${fmt(remap)}` });
   const clampSigma = checkNumber(v['clampSigma'], join(path, 'clampSigma'), out, R.clampSigma.min, R.clampSigma.max, false);
   if (leaf.dims === 2 && yScale !== undefined && yScale !== 1) out.push({ path: join(path, 'yScale'), code: 'YSCALE_NOT_1', message: 'a 2D noise has yScale 1' });
-  if (remap === 'uniform' && dbl === false) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_DOUBLE', message: "remap 'uniform' needs double: true" });
-  if (remap === 'uniform' && leaf.dims === 3) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_2D', message: "remap 'uniform' is for 2D noises" });
+  if (remap === 'uniform' && leaf.remapNone === true) {
+    out.push({ path: join(path, 'remap'), code: 'REMAP_NOT_ALLOWED', message: "this noise keeps remap 'none' (a density noise)" });
+  } else {
+    if (remap === 'uniform' && dbl === false) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_DOUBLE', message: "remap 'uniform' needs double: true" });
+    if (remap === 'uniform' && leaf.dims === 3) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_2D', message: "remap 'uniform' is for 2D noises" });
+  }
   if (out.length > n0) return undefined;
   return {
     wavelength: wavelength!, octaves: octaves!, persistence: persistence!, lacunarity: lacunarity!, amplitudes,
@@ -354,6 +368,7 @@ function toMeta(path: string, l: Leaf<unknown, unknown>): ParamMeta {
     ...(l.step !== undefined ? { step: l.step } : {}),
     ...(l.options !== undefined ? { options: l.options } : {}),
     ...(l.dims !== undefined ? { dims: l.dims } : {}),
+    ...(l.remapNone === true ? { remapNone: true } : {}),
     ...(l.coords !== undefined ? { coords: l.coords } : {}),
     scope: m.scope,
     ...(m.stage !== undefined ? { stage: m.stage } : {}),
```

Modify `src/core/params/schema.ts` (apply with `git apply`):

```diff
diff --git a/src/core/params/schema.ts b/src/core/params/schema.ts
index f29aed7..abbb303 100644
--- a/src/core/params/schema.ts
+++ b/src/core/params/schema.ts
@@ -7,6 +7,7 @@ export { NOISE_FIELD_RANGES } from './kit';
 const CLIMATE = { scope: 'climate', stage: 'climate' } as const;
 const SHAPE = { scope: 'terrain', stage: 'shape' } as const;
 const BIOME = { scope: 'terrain', stage: 'biome2d' } as const;
+const TERRAIN = { scope: 'terrain', stage: 'terrain' } as const;
 const SHAPE_COORDS = ['C', 'E', 'PV'] as const;
 
 const blocks = (def: number, label: string, doc: string, min: number, max: number, step = 1) =>
@@ -28,6 +29,12 @@ const warp = (label: string, doc: string, amplitude: number, wavelength: number,
     }),
   });
 
+/** A density noise (SP3b spec §3.3): sampled at unscaled world block coordinates; remap 'none' (validateExpr; the schema refuses another). */
+const densityNoise = (label: string, doc: string, def: { readonly wavelength: number; readonly octaves: number; readonly yScale?: number }, dims: 2 | 3, wavelength: { readonly min: number; readonly max: number }) =>
+  noise(def, { ...TERRAIN, label, doc, wavelength, dims, remapNone: true });
+const amp = (def: number, label: string, doc: string) =>
+  num(def, { ...TERRAIN, label, doc, unit: 'blocks', min: 0, max: 8, step: 0.05 });
+
 const field = (label: string, doc: string, wavelength: number, octaves: number) =>
   noise({ wavelength, octaves, remap: 'uniform' }, { ...CLIMATE, label, doc, wavelength: { min: 64, max: 20000 }, dims: 2 });
 
@@ -93,6 +100,15 @@ export const ROOT = group('Parameters', 'World generation parameters.', {
     table: boxTable(BIOME_TABLE_DEFAULT, { ...BIOME, label: 'Biome boxes', doc: 'Climate box, sign(W) filter and tie-break priority of every box-picked surface biome.', rows: BOX_BIOMES }),
     zoomJitter: num(1.5, { ...BIOME, label: 'Zoom jitter', doc: 'Jitter of the quart centres in the jittered-Voronoi zoom.', unit: 'blocks', min: 0, max: 2, step: 0.05 }),
   }),
+  density: group('Density', 'Tunables of the default 3D density expression (SP3b spec §3); its structure is code until SP3d.', {
+    noises: group('Density noises', 'Noises read by the density expression (noise2 / noise ops), at unscaled world block coordinates.', {
+      jag: densityNoise('Jag noise', 'Ridges of jagged peaks: J = (1 − |z / clampSigma|)², times the jag spline.', { wavelength: 28, octaves: 2 }, 2, { min: 16, max: 8192 }),
+      overhang: densityNoise('Overhang noise', '3D surface displacement, times σ and the vertical slide (yScale 1.25: λy 64).', { wavelength: 80, octaves: 3, yScale: 1.25 }, 3, { min: 16, max: 8192 }),
+      detail: densityNoise('Detail noise', 'Small 3D surface detail outside the interpolation, times the detail amplitude.', { wavelength: 10, octaves: 1 }, 3, { min: 4, max: 256 }),
+    }),
+    detailAmpLo: amp(0.6, 'Detail amplitude at E −1', 'Detail amplitude in blocks where E ≤ −1.'),
+    detailAmpHi: amp(1.5, 'Detail amplitude at E +1', 'Detail amplitude in blocks where E ≥ 1; linear in (E + 1) / 2 between the two.'),
+  }),
 });
 
 export const SCHEMA = buildSchema(ROOT);
@@ -103,3 +119,4 @@ export interface ShapeParams extends Value<typeof ROOT.children.shape> {}
 export interface RiverParams extends Value<typeof ROOT.children.rivers> {}
 export interface LakeParams extends Value<typeof ROOT.children.lakes> {}
 export interface BiomeParams extends Value<typeof ROOT.children.biomes> {}
+export interface DensityParams extends Value<typeof ROOT.children.density> {}
```

Modify `src/core/stage/registry.ts` (apply with `git apply`):

```diff
diff --git a/src/core/stage/registry.ts b/src/core/stage/registry.ts
index c597c50..33a8788 100644
--- a/src/core/stage/registry.ts
+++ b/src/core/stage/registry.ts
@@ -17,7 +17,7 @@ export const STAGES: readonly StageDef[] = [
   { id: 'shape', version: 2, reads: ['climate'], params: ['shape', 'rivers', 'lakes'], checkpoint: 'columnSample' },
   { id: 'surfaceEst', version: 2, reads: ['shape'], params: [], checkpoint: 'columnSample' },
   { id: 'biome2d', version: 2, reads: ['climate', 'shape', 'surfaceEst'], params: ['biomes'], checkpoint: 'columnSample' },
-  { id: 'terrain', version: 1, reads: ['shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'proto' },
+  { id: 'terrain', version: 1, reads: ['shape', 'surfaceEst', 'biome2d'], params: ['density'], checkpoint: 'proto' },
   { id: 'decorate', version: 1, reads: ['terrain'], params: [], checkpoint: 'final' },
   { id: 'light', version: 1, reads: ['decorate'], params: [], checkpoint: 'none' },
   { id: 'mesh', version: 1, reads: ['light'], params: [], checkpoint: 'none' },
```

Create `src/gen/density/context.ts`:

```ts
/**
 * DensityContext (SP3b spec §2.3): what evaluating the density of one GenContext needs, built once per context.
 * - `noises`: the GenContext's schema noises `density.noises.<id>` (seed name = leaf path) as a DensityNoiseSource,
 *   with each leaf's dims; ids are the keys under `density.noises`.
 * - `compiled` and `bounds`: the expression (by default `defaultDensityExpr(params.density)`) compiled once; its
 *   scratch is the per-column cache of the `columnFn` and `positionFn` values and of the corners evaluated so far.
 * - `columns`: a ColumnCache (SP2a), so that probes and surfaceEst3 do not rebuild a ColumnSample per call.
 * `column(cx, cz)` makes (cx, cz) the compiled expression's current column, running columnFn and positionFn only when
 * another column was current; a T-stage `fillDensityColumn` on `bounds` leaves its column current as well.
 */
import type { NormalNoise } from '../../core/noise/normal';
import { SCHEMA } from '../../core/params/schema';
import { createColumnCache, type ColumnCache } from '../column/columnCache';
import type { ColumnSample } from '../column/columnStage';
import { noiseFor, type GenContext } from '../context';
import { createDensityBounds, type DensityBounds } from './bounds';
import { compileDensity, type CompiledDensity } from './compile';
import { defaultDensityExpr } from './defaults';
import type { DensityExpr, DensityNoise, DensityNoiseSource } from './expr';

const SCHEMA_ = SCHEMA;
const NOISE_FOR = noiseFor;
const CACHE = createColumnCache;
const COMPILE = compileDensity;
const BOUNDS = createDensityBounds;
const DEFAULT_EXPR = defaultDensityExpr;

/** The schema path prefix of the density noises; an expression's noise id is the key after it. */
const PREFIX = 'density.noises.';

export interface DensityContext {
  readonly ctx: GenContext;
  readonly expr: DensityExpr;
  readonly noises: DensityNoiseSource;
  readonly compiled: CompiledDensity;
  readonly bounds: DensityBounds;
  readonly columns: ColumnCache;
  /** Makes column (cx, cz) current (ColumnSample from `columns`; columnFn + positionFn unless already current). */
  column(cx: number, cz: number): ColumnSample;
}

/** Wraps a NormalNoise as a DensityNoise of `dims` (values in [−clampSigma, clampSigma], unscaled coordinates). */
export function densityNoiseOf(n: NormalNoise, dims: 2 | 3): DensityNoise {
  return { dims, remap: n.def.remap, clampSigma: n.clamp, z2: (x, z) => n.z2(x, z), z3: (x, y, z) => n.z3(x, y, z) };
}

/** The GenContext's density noises: id → the prepared NormalNoise of schema leaf `density.noises.<id>`, with its dims. */
export function densityNoiseSource(ctx: GenContext): DensityNoiseSource {
  const m = new Map<string, DensityNoise>();
  for (const { path, leaf } of SCHEMA_.leaves) {
    if (leaf.kind !== 'noise' || !path.startsWith(PREFIX)) continue;
    m.set(path.slice(PREFIX.length), densityNoiseOf(NOISE_FOR(ctx, path), leaf.dims ?? 2));
  }
  return (id) => m.get(id);
}

/** A DensityContext for `ctx` over `expr` (default: the §3.1 expression from `ctx.params.density`). */
export function createDensityContext(ctx: GenContext, expr: DensityExpr = DEFAULT_EXPR(ctx.params.density)): DensityContext {
  const noises = densityNoiseSource(ctx);
  const compiled = COMPILE(expr, noises);
  const bounds = BOUNDS(compiled, noises);
  const columns = CACHE(ctx);
  return {
    ctx, expr, noises, compiled, bounds, columns,
    column(cx, cz) {
      const s = columns.get(cx, cz);
      if (!compiled.hasPositions(cx, cz)) {
        compiled.columnFn(s);
        compiled.positionFn(s);
      }
      return s;
    },
  };
}
```

Create `src/gen/density/defaults.ts`:

```ts
/**
 * The default density expression (SP3b spec §3.1), built from `params.density`:
 *
 *   J        = square(1 − abs(noise2('jag') · (1 / clampSigma)))
 *   N3       = noise('overhang')
 *   terrain  = tap('terrain', interpolated( col.offset + col.jag · J − y + col.sigma · slide(N3, SLIDE)
 *                                           + 2·max(0, −56 − y) − 2·max(0, y − 296) ))
 *   amp      = ampLo + (ampHi − ampLo) · clamp((col.E + 1) / 2, 0, 1)
 *   detail   = noise('detail') · amp
 *   final    = max( terrain + detail, islands ),   islands = tap('islands', const −1e6)
 *   SLIDE    = [(−64, 0), (−40, 1), (240, 1), (320, 0)]
 *
 * The sums are left-nested in the written order (IEEE addition is not associative, so the order is part of the
 * expression). `SLIDE`, the floor and ceiling terms and the islands constant stay code until `density.defs` (SP3d).
 * `1 / clampSigma` reads the jag noise's clampSigma, so J uses u = z / clampSigma ∈ [−1, 1] (§1.1); `(E + 1) / 2` is
 * written `(E + 1) · 0.5` (exact) and `ampHi − ampLo` is folded into one constant.
 */
import type { DensityParams } from '../../core/params/schema';
import type { DensityExpr, Expr, SlideKnot } from './expr';

const SLIDE: readonly SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const max = (a: Expr, b: Expr): Expr => ({ op: 'max', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });

/** The default density expression of SP3b spec §3.1 for `p` (= `params.density`). Ids are the `density.noises` keys. */
export function defaultDensityExpr(p: DensityParams): DensityExpr {
  const J: Expr = { op: 'square', x: add(C(1), neg({ op: 'abs', x: mul({ op: 'noise2', id: 'jag' }, C(1 / p.noises.jag.clampSigma)) })) };
  const N3: Expr = { op: 'noise', id: 'overhang' };
  let inner = add({ op: 'col', field: 'offset' }, mul({ op: 'col', field: 'jag' }, J));
  inner = add(inner, neg(Y));
  inner = add(inner, mul({ op: 'col', field: 'sigma' }, { op: 'slide', x: N3, knots: SLIDE }));
  inner = add(inner, mul(C(2), max(C(0), add(C(-56), neg(Y)))));
  inner = add(inner, neg(mul(C(2), max(C(0), add(Y, C(-296))))));
  const terrain: Expr = { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: inner } };
  const e01: Expr = { op: 'clamp', x: mul(add({ op: 'col', field: 'E' }, C(1)), C(0.5)), lo: 0, hi: 1 };
  const amp = add(C(p.detailAmpLo), mul(C(p.detailAmpHi - p.detailAmpLo), e01));
  const detail = mul({ op: 'noise', id: 'detail' }, amp);
  const islands: Expr = { op: 'tap', name: 'islands', x: C(-1e6) };
  return { root: max(add(terrain, detail), islands), defs: {} };
}
```

Create `src/gen/density/probe.ts`:

```ts
/**
 * The probe (SP3b spec §2.3, master §5.5): the density, or one tap's value, at one voxel through the compiled closures,
 * with no early-outs. The column's ColumnSample comes from the DensityContext's ColumnCache, and its columnFn and
 * positionFn values and evaluated corners are reused while the probes stay in one column.
 */
import { inWindow } from '../../core/coords';
import type { DensityContext } from './context';

const IN_WINDOW = inWindow;

function checkInt(v: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} ${v} is outside [${lo}, ${hi}]`);
}

/**
 * The final density at world voxel (x, y, z) (integers; y ∈ −64 … 319; x and z in the world window), or the value of
 * tap `tap` there (as `tapFn`: an unknown or unreachable tap name throws).
 */
export function probe(dc: DensityContext, x: number, y: number, z: number, tap?: string): number {
  if (!Number.isInteger(x) || !Number.isInteger(z) || !IN_WINDOW(x, z)) throw new RangeError(`probe (x, z) = (${x}, ${z}) is not an integer position in the world window`);
  checkInt(y, -64, 319, 'probe y');
  const cx = x >> 4, cz = z >> 4;
  dc.column(cx, cz);
  const c = dc.compiled;
  return tap === undefined ? c.voxelFn(x - 16 * cx, y, z - 16 * cz) : c.tapFn(tap, x - 16 * cx, y, z - 16 * cz);
}
```

Modify `src/ui/paramPanel/model.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/paramPanel/model.ts b/src/ui/paramPanel/model.ts
index 258308c..daf8f61 100644
--- a/src/ui/paramPanel/model.ts
+++ b/src/ui/paramPanel/model.ts
@@ -25,6 +25,8 @@ export interface ControlSpec {
   readonly stage?: StageId;
   /** Noise leaves: whether the noise is 2D or 3D (it decides which noise fields a rule fixes). */
   readonly dims?: 2 | 3;
+  /** Noise leaves whose remap stays 'none' (the density noises, SP3b). */
+  readonly remapNone?: true;
 }
 
 export interface SectionSpec {
@@ -59,6 +61,7 @@ function controlOf(meta: ParamMeta): ControlSpec {
     scope: meta.scope,
     ...(meta.stage !== undefined ? { stage: meta.stage } : {}),
     ...(meta.dims !== undefined ? { dims: meta.dims } : {}),
+    ...(meta.remapNone === true ? { remapNone: true } : {}),
   };
 }
 
@@ -173,6 +176,7 @@ export function noiseFieldLock(c: ControlSpec, def: NoiseDef, field: keyof Noise
   switch (field) {
     case 'yScale': return c.dims === 2 ? 'a 2D noise has yScale 1' : null;
     case 'remap':
+      if (c.remapNone === true) return "a density noise keeps remap 'none'";
       if (c.dims === 3) return "remap 'uniform' is for 2D noises";
       return def.double ? null : "remap 'uniform' needs double: true";
     case 'double': return def.remap === 'uniform' ? "remap 'uniform' needs double: true" : null;
```

Modify `test/harness/densityFuzz.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/densityFuzz.ts b/test/harness/densityFuzz.ts
index 011dc0b..7677cb7 100644
--- a/test/harness/densityFuzz.ts
+++ b/test/harness/densityFuzz.ts
@@ -1,9 +1,10 @@
 /**
  * Random valid density expressions for the compile == reference and bounds fuzz (SP3b spec §10).
  *
- * Trees use every op of §1.1 over a set of noise ids: until the schema has its `density.noises` (Task 6) they are the
- * test noises of `fuzzNoiseSource()`; pass `noises` to draw over other ids. Constants are drawn as §1.2 asks
- * (`fuzzConstant`: log-uniform magnitudes in [1e-6, 1e9] with random signs, plus 0, −0 and small integers).
+ * Trees use every op of §1.1 over a set of noise ids: by default the test noises of `fuzzNoiseSource()`; pass `noises`
+ * to draw over other ids (`SCHEMA_DENSITY_NOISES`, evaluated through `densityNoiseSource(ctx)`, for the schema's
+ * `density.noises`). Constants are drawn as §1.2 asks (`fuzzConstant`: log-uniform magnitudes in [1e-6, 1e9] with
+ * random signs, plus 0, −0 and small integers).
  *
  * Every tree is valid by construction: defs reference only earlier defs (no cycles), no `interpolated` is generated
  * inside another (a ref inside `interpolated` targets only a def without one), clamp lo ≤ hi, rangeChoice lo < hi,
@@ -13,7 +14,9 @@
 import { NormalNoise } from '../../src/core/noise/normal';
 import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
 import type { Seed64 } from '../../src/core/hash';
+import { SCHEMA } from '../../src/core/params/schema';
 import { SAMPLE_FIELDS } from '../../src/gen/column/columnStage';
+import { densityNoiseOf } from '../../src/gen/density/context';
 import { exprChildren, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type SlideKnot } from '../../src/gen/density/expr';
 import { testFloat } from './stats';
 
@@ -27,10 +30,10 @@ export const FUZZ_NOISE_SPECS: readonly FuzzNoiseSpec[] = [
   { id: 'fz3b', dims: 3, def: completeNoiseDef({ wavelength: 32, octaves: 2, yScale: 2, clampSigma: 4 }) },
 ];
 
-/** Wraps a NormalNoise as a DensityNoise (Task 6 does the same for the schema's density noises). */
-export function densityNoiseOf(n: NormalNoise, dims: 2 | 3): DensityNoise {
-  return { dims, remap: n.def.remap, clampSigma: n.clamp, z2: (x, z) => n.z2(x, z), z3: (x, y, z) => n.z3(x, y, z) };
-}
+/** The schema's density noise ids and dims (the keys under `density.noises`), for `randomDensityExpr`'s `noises`. */
+export const SCHEMA_DENSITY_NOISES: readonly { readonly id: string; readonly dims: 2 | 3 }[] = SCHEMA.leaves
+  .filter((l) => l.leaf.kind === 'noise' && l.path.startsWith('density.noises.'))
+  .map((l) => ({ id: l.path.slice('density.noises.'.length), dims: l.leaf.dims ?? 2 }));
 
 /** The test noises as a DensityNoiseSource; seed names are `density.noises.<id>` under `seed`. */
 export function fuzzNoiseSource(seed: Seed64 = [0x5eed, 0x3b]): DensityNoiseSource {
```

Modify `test/harness/params.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/params.ts b/test/harness/params.ts
index 112c65b..c74f302 100644
--- a/test/harness/params.ts
+++ b/test/harness/params.ts
@@ -105,7 +105,8 @@ export function randomValue(leaf: Leaf<unknown, unknown>, next: () => number): u
         wavelength: between(next, leaf.min!, leaf.max!), octaves,
         persistence: between(next, R.persistence.min, R.persistence.max), lacunarity: between(next, R.lacunarity.min, R.lacunarity.max),
         amplitudes, yScale: leaf.dims === 2 ? 1 : between(next, R.yScale.min, R.yScale.max), double,
-        remap: leaf.dims === 2 && double && (next() & 1) === 1 ? 'uniform' : 'none',
+        // A remapNone leaf (SP3b's density noises) keeps 'none'; the draw is still made, so the stream is unchanged.
+        remap: leaf.dims === 2 && double && (next() & 1) === 1 && leaf.remapNone !== true ? 'uniform' : 'none',
         clampSigma: between(next, R.clampSigma.min, R.clampSigma.max),
       };
     }
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:accept-schema`

The command writes `test/schema-shape.lock.json`; the dry run's result:

Modify `test/schema-shape.lock.json` (apply with `git apply`):

```diff
diff --git a/test/schema-shape.lock.json b/test/schema-shape.lock.json
index 45a8e6c..6507456 100644
--- a/test/schema-shape.lock.json
+++ b/test/schema-shape.lock.json
@@ -16,6 +16,11 @@
     "climate.warp.R.noise": "noise",
     "climate.warp.shift.amplitude": "number",
     "climate.warp.shift.noise": "noise",
+    "density.detailAmpHi": "number",
+    "density.detailAmpLo": "number",
+    "density.noises.detail": "noise",
+    "density.noises.jag": "noise",
+    "density.noises.overhang": "noise",
     "lakes.cell": "number",
     "lakes.depthMin": "number",
     "lakes.depthVar": "number",
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project metrics-fast --project unit test/metrics/noise.metric.ts test/unit/densityDefaults.test.ts test/unit/paramPanelModel.test.ts test/unit/schemaSp2a.test.ts test/unit/schemaSp3b.test.ts`

Expected: PASS (exit 0)

```
Test Files  5 passed (5)
Tests  79 passed (79)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  129 passed | 2 skipped (131)
Tests  1692 passed | 3 skipped (1695)
```

- [ ] **Step 7: Commit**

```bash
git add README.md src/core/params/kit.ts src/core/params/schema.ts src/core/stage/registry.ts src/gen/density/context.ts src/gen/density/defaults.ts src/gen/density/probe.ts src/ui/paramPanel/model.ts test/harness/densityFuzz.ts test/harness/params.ts test/metrics/noise.metric.ts test/schema-shape.lock.json test/unit/densityDefaults.test.ts test/unit/paramPanelModel.test.ts test/unit/schemaSp2a.test.ts test/unit/schemaSp3b.test.ts
git commit -F - <<'EOF'
feat(gen/density): density params, default expression, DensityContext and probe

SP3b spec §3, §2.3: the schema gains the `density` group (scope and stage
terrain): density.noises.jag (2D, λ 28, 2 octaves), overhang (3D, λ 80,
yScale 1.25, 3 octaves) and detail (3D, λ 10, 1 octave), detailAmpLo 0.6 and
detailAmpHi 1.5; the terrain stage hashes it (U4), schema lock and README
parameter reference regenerated. defaults.ts builds the §3.1 expression from
params.density; context.ts wraps the GenContext's density.noises.<id>
NormalNoises as the noise source and owns the compiled expression, its bounds
and a ColumnCache; probe.ts evaluates one voxel or tap with no early-outs.

N5's vertical rose is measured in lattice coordinates (gradient of
z3(x, y / yScale, z)), since the new noises join N2, N3, N5 and N6.

Tests: the default expression validates and places as §2.1 says, probe values
checked by hand at lattice-aligned voxels and against the reference, the §3.2
early-out heights on land, mountain and ocean columns with driver == probe at
every voxel, and the compile == reference fuzz over the schema noises.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `1d05c3c` on `dry/sp3a`; 16 files changed, 645 insertions(+), 21 deletions(-)):

Commit Task 6 on `dry/sp3b-density` (worktree `P/dry-density`, parent Task 5; 13 files, 511 insertions). RED (the commit's test files over the parent): `densityDefaults.test.ts` fails to import (`Cannot find module '../../src/gen/density/context'`); 9 tests fail in 2 files (schemaSp3b ×6: no `density` leaves, `DEFAULTS.density` undefined, `density UNKNOWN_KEY`, terrain params `[]`; paramPanelModel ×3: sections lack `density`, the log-scale list lacks the 3 density noises, 32 ≠ 34 linear sliders); `schemaSp2a.test.ts` (filters relaxed) and `noise.metric.ts` pass on the parent; 18 `tsc -p tsconfig.test.json` errors (the 3 missing modules, `SCHEMA_DENSITY_NOISES`, `Params.density`, and implicit anys that follow). GREEN: typecheck clean (1.2 s); `densityDefaults.test.ts` 12 tests in 0.5 s (the early-out/driver == probe test 165 ms); `npm test` 129 files passed, 2 skipped; 1678 tests passed, 3 skipped (29.4 s wall). `npm run test:accept-schema` added the 5 leaves to `test/schema-shape.lock.json` (SCHEMA_VERSION stays 1: additive); `npm run docs:params` added 5 README rows. No threshold, golden or baseline file changes, so no Threshold-log line.

- Ruling (schema, `src/core/params/schema.ts`): the `density` group is appended after `biomes` (so it is last in the schema, the panel, the README and `noiseInstances`; no existing seed name or noise order changes). Leaves exactly as §3.3, with `{scope: 'terrain', stage: 'terrain'}`: `density.noises.{jag (dims 2, λ 28, 2 oct), overhang (dims 3, λ 80, yScale 1.25, 3 oct), detail (dims 3, λ 10, 1 oct)}` (every other NoiseDef field the defaults: persistence 0.5, lacunarity 2, double, remap 'none', clampSigma 3; wavelength meta 16 … 8192, 16 … 8192, 4 … 256), `density.detailAmpLo` 0.6 and `detailAmpHi` 1.5 (min 0, max 8, step 0.05, unit blocks). Labels "Detail amplitude at E −1 / E +1" (E −1 is the mountainous end in this repo's offset spline, so neither "flat" nor "eroded" is used). `DensityParams` is exported like the other group types. Cost if wrong: wording only.
- Ruling (stage registry): the `terrain` stage gets `params: ['density']` in Task 6, not Task 8, at version 1. U4's `checkRegistry` requires every non-live leaf's home stage to hash it ("home stage terrain does not hash it" otherwise), so the leaves cannot land without it. Its version (and GENERATOR_VERSION) stay until Task 8, because the T output does not change before the real T. It changes the terrain/decorate/light/mesh stage hashes and so `genKey`, which only re-keys caches (region dumps rebuild once); no golden reads the real `STAGES` (`sp1.*` uses `FIXTURE_STAGES`). Task 8 changes only the version to 2. A test pins that a density edit dirties exactly terrain, decorate, light, mesh. Cost if wrong: none.
- Ruling (API, `src/gen/density/defaults.ts`): `defaultDensityExpr(p: DensityParams): DensityExpr` (`defs` `{}`, noise ids `jag`, `overhang`, `detail` = the keys under `density.noises`). The sums are left-nested in §3.1's written order (`((((offset + jag·J) + −y) + σ·slide(N3)) + 2·max(0, −56 + −y)) + −(2·max(0, y + −296))`; a − b is written a + (−b), which is the same double), `(E + 1) / 2` is `(E + 1) · 0.5` (exact), `ampHi − ampLo` is folded into one constant, and J's factor is `1 / params.density.noises.jag.clampSigma` (so a clampSigma edit keeps u ∈ [−1, 1]). `SLIDE`, the floor/ceiling terms and the islands −1e6 are module-private code. It equals Task 5's `terrainStandInExpr` structure (the stand-in stays as a schema-independent fixture). Task 9's `sp3b.density.default` golden pins these choices. Cost if wrong: none before Task 9.
- Ruling (API, `src/gen/density/context.ts`): `createDensityContext(ctx, expr = defaultDensityExpr(ctx.params.density)): DensityContext` with `{ctx, expr, noises, compiled, bounds, columns, column(cx, cz): ColumnSample}`. `column` gets the sample from `columns` (a `createColumnCache(ctx)`) and runs `columnFn` + `positionFn` only when `!compiled.hasPositions(cx, cz)`; the compiled scratch is the spec's "per-column cache of the columnFn and positionFn values and of the corners". `bounds` is included so Task 8's T stage can run `fillDensityColumn(dc.bounds, sample, …)` on the same compile: the driver re-runs columnFn/positionFn unconditionally and leaves its column current, so a probe after it stays correct. `densityNoiseSource(ctx)` maps id → `densityNoiseOf(noiseFor(ctx, 'density.noises.<id>'), leaf.dims)` for every noise leaf under `density.noises.` (unknown ids, including other schema noises, give undefined); `densityNoiseOf` moved here from `test/harness/densityFuzz.ts` (Task 3 ruling). The context is not memoised per GenContext: Task 8 keeps its module-level WeakMap. Cost if wrong: an adapter.
- Ruling (API, `src/gen/density/probe.ts`): `probe(dc, x, y, z, tap?)`: world coordinates; RangeError unless x, z are integers with `inWindow(x, z)` (core/coords) and y an integer in −64 … 319; then `dc.column(x >> 4, z >> 4)` and `voxelFn` or `tapFn(tap, …)` (Task 4's tap rule; an unknown tap throws `no tap "…"`). No early-outs. Cost if wrong: none.
- Ruling (tests, `test/unit/densityDefaults.test.ts`, `test/unit/schemaSp3b.test.ts`): (1) the default expression validates against `densityNoiseSource(ctx)`, uses exactly noise2:jag, noise:overhang, noise:detail and one slide with §3.1's knots, taps `terrain` (outside, over the one interpolated) and `islands` (−1e6); placement: 1 interpolated slot, detail VOXEL, amp an `add` COLUMN node in a position slot, y and slide CELL; constants follow params (1/2.5, 0.25, 3.75 after a patch); (2) the noise source returns the GenContext's NormalNoises bit for bit with schema dims; `column` reuse and cache size; a custom expression; NOISE_DIMS rejection; (3) probe hand-checked at 200 lattice-aligned voxels (lx, lz ∈ {0, 4, 8, 12}, y = −64 + 8k, where every interpolation weight is 0 and the bilinear E is the lattice E) in 5 columns (land (0, 0) and (5, −7); mountains (−68, 100) σ 11.1 jag 18 and (−1022, −786) σ 11.5 jag 37.5, found by a scan; ocean (205, −181) offset 16): final, `terrain` tap and `islands` tap with `toBe`; probe == reference with Object.is at 600 random voxels across column switches; argument checks; (4) §3.2 early-outs and driver == probe at all 98,304 voxels of the 5 columns (solidity, and Object.is where the driver evaluated); (5) the compile == reference fuzz over the schema noises (60 trees × 16 voxels, `SCHEMA_DENSITY_NOISES`, a new harness export). Cost if wrong: none.
- Ruling (§3.2 early-out heights, how they are tested): per cell, from the hulls of its 4 corner columns: `top = offsetHi + max(0, jagHi) + cs_overhang·|σ|max + cs_detail·ampHi`; a cell with y0 > top + 1e-3 must be air with no voxel evaluated. `low = offsetLo + min(0, jagLo) − (y0 + 8) − cs·|σ|max + 2·max(0, −56 − (y0 + 8)) − 2·max(0, y0 + 8 − 296) − cs_detail·ampHi`; a cell with low > 1e-3 must be solid with no voxel evaluated. Over the 5 columns: 1,968 cells above, 1,301 below, 177 of 3,840 evaluated (4.6 %); the test asserts the rules' coverage > 80 % and evaluated < 10 %. Cost if wrong: none.
- Spec defect: §3.2 "Cells below y −56 early-out to solid once the floor term exceeds the rest of the expression" → cells are 8 high from y −64, so the lowest cell's corners span −64 … −56 and the floor term's minimum over every cell is 0 (at its top corner y −56): no cell is decided by the floor term alone. Suggested wording: "Cells whose lower bound `offset − y1 − clampSigma(overhang)·σ + 2·max(0, −56 − y1) − clampSigma(detail)·ampHi` (y1 = y0 + 8) is positive early-out to solid; with the default offsets (≥ 16) that is every cell below about offset − 3σ − 13."
- Ruling (N5 amendment, `test/metrics/noise.metric.ts`): the vertical rose uses `g(x, y, z) = z3(x, y / yScale, z)` for all four samples (x ± h and y ± h at the same lattice point), so the rose is the gradient in lattice coordinates; for yScale 1 it reuses the horizontal samples, which leaves the yScale-1 noises' values bit-identical. The horizontal rose is unchanged. Counterfactual on world axes (fast tier): `N5.vertical` = 1.578 > 1.15, failing as §3.3 predicts. Cost if wrong: none.
- Spec defect: §3.3 / §15 "Measured on world axes, an anisotropic noise fails by construction (≈ 2.8 against 1.15)" → at the adopted yScale 1.25 (λy 64) the world-axis value is 1.58 (fast tier); 2.8 was the earlier λy 48 figure. Suggested: "(≈ 1.6 at λy 64 against 1.15)".
- Ruling (N2 over 3D noises): N2 keeps SP1's definition, `z2` of every SCHEMA_NOISES member on quick/full (fast: climate only), so the two 3D density noises enter N2 through their 2D stack (same seeds and octave tables as their z3). N3 and N6 use `field()`, which is z3 for dims 3. Making N2 sample z3 for 3D noises would be an amendment the spec does not ask for. Cost if wrong: N2 checks the density noises' seed independence in 2D only.
- MEASUREMENT (noise metric tiers, `noise.metric.ts` alone, this machine, quiet): fast 6.6 s → 7.4 s (N2 1.59 → 1.57, N3 1.26 → 1.46, N5 2.79 → 3.27, N6 0.33 → 0.38 s); quick 34.4 s → 40.0 s (N2 20.6 → 23.8, N3 5.0 → 5.8, N5 5.5 → 6.9, N6 1.3 → 1.5 s); full 79.8 s → 91.1 s (N2 41.6 → 48.7, N3 13.4 → 14.4, N5 10.7 → 13.2, N6 6.4 → 7.2 s); N1 unchanged. Values, parent → commit: N5.vertical fast 1.0508 → 1.0663, quick 1.0382 → 1.0482, full 1.0240 → 1.0376 (max 1.15); N5.horizontal, N1, N2, N3 and N6 are unchanged on quick and full (the maxima stay on the existing noises); on fast, N2, N3, N6 and N5.horizontal are unchanged too. Cost if wrong: none.
- MEASUREMENT (fillDensityColumn on the REAL default expression; throwaway vitest file, not committed): 400 columns of seed '42' drawn uniformly in ±1024 chunks (`testRng(777)`), 50 warm-up columns, 3 runs, twice, machine idle (top 99 % idle; load average was decaying from my own test runs, 1.4): p50 0.77-0.81 ms, p90 0.90-0.95 ms, mean 0.79-0.83 ms per column, including columnFn + positionFn + hulls (p50 0.017 ms); 33.1 of 768 cells per column run voxelFn (4.3 %); full evaluation without early-outs p50 9.4-9.5 ms; the ColumnSample alone p50 0.30 ms. On the same 400 columns Task 5's stand-in costs p50 0.90-0.94 ms (35.5 voxel cells), so the real expression is ≈ 15 % cheaper than the stand-in (detail λ 10 vs 8, fewer straddling cells); the stand-in's 0.68 ms in Task 5 was on a different column draw. Estimate for `terrain.real`: ≈ 0.3 + 0.8 + fill/water/sections, well inside the 4 ms gate. Cost if wrong: Task 13 re-measures.
- Ruling (U2): unchanged and green. `u2()` filters leaves by `COLUMN_STAGES = ['climate', 'shape', 'biome2d']`, so the 5 `density.*` leaves (stage `terrain`) are skipped: fast-tier U2 = 1 over 51 leaves, none of them `density.*` (`test/metrics/.out/U2.leaves.json`); U4 registryIssues 0, shapeLockViolations 0, readmeStale 0. Task 10 adds the `terrain` output stage and the assertion that every `density.*` leaf is decided. The liveness unit test's "every leaf gets two valid perturbations" already covers the 5 density leaves and passes. Cost if wrong: none.
- Ruling (pinned lists updated): `schemaSp2a.test.ts` filters `density.*` out of its SP2a leaf and seed-name lists (the density lists live in `schemaSp3b.test.ts`); `paramPanelModel.test.ts` gains the `density` section, the 3 density noises in the log-scale list, the amplitudes among the linear controls, and 34 linear stepped sliders (was 32). Cost if wrong: none.

---

### Task 7: Store and harness: ColumnView.auxB, aux B in hash and dump, harness minors, CI cache

**Spec:** §7 (all bullets except the review slices and uiSmoke)

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `src/world/store/api.ts`
- Modify: `src/world/store/store.ts`
- Modify: `test/arch/governance.test.ts`
- Modify: `test/arch/masterSpec.test.ts`
- Modify: `test/harness/cache.ts`
- Create: `test/harness/env.ts`
- Modify: `test/harness/governance.ts`
- Modify: `test/harness/nodeWorker.ts`
- Modify: `test/harness/region.ts`
- Modify: `test/integration/abort.test.ts`
- Modify: `test/integration/slabFuzz.test.ts`
- Modify: `test/integration/twoWorkers.test.ts`
- Modify: `test/metrics/region.metric.ts`
- Modify: `test/unit/governance.test.ts`
- Create: `test/unit/harnessHelpers.test.ts`
- Modify: `test/unit/regionCache.test.ts`
- Modify: `test/unit/regionHarness.test.ts`
- Modify: `test/unit/store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `test/harness/cache.ts`:
    - `export const REGION_CACHE_FORMAT = 2;`
  - `test/harness/env.ts`:
    - `export function integerEnv(name: string, fallback: number, env: Readonly<Record<string, string | undefined>> = process.env): number`
  - `test/harness/nodeWorker.ts`:
    - `export function ask<R = Record<string, unknown>>(w: Worker, msg: unknown): Promise<R>`
  - `test/harness/region.ts`:
    - `export function dt1WorkerDir(tier: 'fast' | 'quick' | 'full'): string`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/governance.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/governance.test.ts b/test/arch/governance.test.ts
index 0180244..7061687 100644
--- a/test/arch/governance.test.ts
+++ b/test/arch/governance.test.ts
@@ -4,6 +4,7 @@ import { join } from 'node:path';
 import { expect, test } from 'vitest';
 import type { GoldensFile } from '../harness/goldens';
 import { checkGovernance, parseGeneratorVersion } from '../harness/governance';
+import { readStateLock, STATE_LOCK_PATH, type StateIdLock } from '../harness/stateLock';
 import { ROOT } from './scan';
 
 const BASE = process.env.GOVERNANCE_BASE ?? '';
@@ -12,9 +13,10 @@ const showAtBase = (path: string): string | null => {
   try { return git('show', `${BASE}:${path}`); } catch { return null; }
 };
 
-test.skipIf(BASE === '' || /^0+$/.test(BASE))('goldens and threshold lock changes follow governance (CI, against GOVERNANCE_BASE)', () => {
+test.skipIf(BASE === '' || /^0+$/.test(BASE))('goldens, threshold lock and state-id lock changes follow governance (CI, against GOVERNANCE_BASE)', () => {
   const baseGoldensText = showAtBase('test/goldens.json');
   const baseConstants = showAtBase('src/core/constants.ts');
+  const baseStateIdsText = showAtBase('test/stateIds.lock.json');
   const headVersion = parseGeneratorVersion(readFileSync(join(ROOT, 'src/core/constants.ts'), 'utf8'));
   if (headVersion === null) throw new Error('cannot parse GENERATOR_VERSION from src/core/constants.ts');
   const errors = checkGovernance({
@@ -23,6 +25,8 @@ test.skipIf(BASE === '' || /^0+$/.test(BASE))('goldens and threshold lock change
     baseVersion: baseConstants ? parseGeneratorVersion(baseConstants) : null,
     headVersion,
     changedFiles: git('diff', '--name-only', BASE, 'HEAD').split('\n').filter((f) => f.length > 0),
+    baseStateIds: baseStateIdsText ? (JSON.parse(baseStateIdsText) as StateIdLock) : null,
+    headStateIds: readStateLock(STATE_LOCK_PATH),
   });
   expect(errors).toEqual([]);
 });
```

Modify `test/arch/masterSpec.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/masterSpec.test.ts b/test/arch/masterSpec.test.ts
index e85d76d..de2baab 100644
--- a/test/arch/masterSpec.test.ts
+++ b/test/arch/masterSpec.test.ts
@@ -4,11 +4,13 @@
  * parenthetical names every dependency `SP_DEPS` transcribes from it, and the critical path is a dependency chain.
  */
 import { readFileSync } from 'node:fs';
+import { fileURLToPath } from 'node:url';
 import { describe, expect, test } from 'vitest';
 import { SUB_PROJECTS, type SubProjectId } from '../../src/core/ids';
 import { SP_DEPS } from '../harness/sp';
 
-const MASTER = 'docs/superpowers/specs/2026-09-26-architecture-design.md';
+// Resolved from this file, not the cwd (SP3b spec §7), so the test also runs from another directory.
+const MASTER = fileURLToPath(new URL('../../docs/superpowers/specs/2026-09-26-architecture-design.md', import.meta.url));
 const text = readFileSync(MASTER, 'utf8');
 const SP_TOKEN = /\bSP(?:\d+[a-z]?)\b/g;
 
```

Modify `test/integration/abort.test.ts` (apply with `git apply`):

```diff
diff --git a/test/integration/abort.test.ts b/test/integration/abort.test.ts
index 6cfc1d9..f38eb1c 100644
--- a/test/integration/abort.test.ts
+++ b/test/integration/abort.test.ts
@@ -2,7 +2,7 @@ import { Worker } from 'node:worker_threads';
 import { afterAll, beforeAll, expect, test } from 'vitest';
 import { DEFAULTS } from '../../src/core/params/defaults';
 import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../../src/metrics/biomeShares';
-import { buildNodeTaskWorker } from '../harness/nodeWorker';
+import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
 import { ctxFor } from '../harness/gen';
 
 /**
@@ -29,8 +29,6 @@ const start = (): Worker => {
   workers.push(w);
   return w;
 };
-const ask = (w: Worker, msg: unknown): Promise<Record<string, unknown>> =>
-  new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); });
 const sameBytes = (a: unknown, b: unknown) => Buffer.from(a as ArrayBuffer).equals(Buffer.from(b as ArrayBuffer));
 const configure = (epoch: number, abort: SharedArrayBuffer | null) => ({ type: 'configure', epoch, seedText: '42', params: DEFAULTS, abort });
 /** Milliseconds on the clock the worker's `handledAt` uses (test/harness/nodeWorker.ts). */
```

Modify `test/integration/slabFuzz.test.ts` (apply with `git apply`):

```diff
diff --git a/test/integration/slabFuzz.test.ts b/test/integration/slabFuzz.test.ts
index a86eef2..972ad02 100644
--- a/test/integration/slabFuzz.test.ts
+++ b/test/integration/slabFuzz.test.ts
@@ -5,7 +5,8 @@ import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, PROTO_BLOCKS, PROTO_FLUID } fro
 import { createStore, type VoxelStore } from '../../src/world/store/store';
 import type { SlabPool } from '../../src/world/store/pool';
 import { FUZZ_LIMITS, type FuzzReply, type FuzzStats } from '../harness/fuzzWorker';
-import { buildNodeTaskWorker } from '../harness/nodeWorker';
+import { integerEnv } from '../harness/env';
+import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
 
 /**
  * Slab fuzz (SP3a spec §3.6, §9): 4 worker threads × 100k random ops on one shared store (64 MiB block pool,
@@ -18,7 +19,7 @@ const THREADS = 4;
 const OPS = 100_000;
 const PHASES = 10;
 const MiB = 1 << 20;
-const SEED = Number(process.env['SLAB_FUZZ_SEED'] ?? '1');
+const SEED = integerEnv('SLAB_FUZZ_SEED', 1);
 
 let script = '';
 const workers: Worker[] = [];
@@ -31,20 +32,9 @@ afterAll(async () => {
   await Promise.all(workers.map((w) => w.terminate()));
 });
 
-const ask = (w: Worker, msg: unknown): Promise<FuzzReply> =>
-  new Promise((resolve, reject) => {
-    const onError = (e: Error) => reject(e);
-    w.once('message', (r: FuzzReply) => {
-      w.off('error', onError);
-      resolve(r);
-    });
-    w.once('error', onError);
-    w.postMessage(msg);
-  });
-
 /** Every reply of a phase (`msg` per thread), failing with the worker's message and the seed on an error reply. */
 async function all(msg: (thread: number) => unknown): Promise<FuzzStats[]> {
-  const replies = await Promise.all(workers.map((w, t) => ask(w, msg(t))));
+  const replies = await Promise.all(workers.map((w, t) => ask<FuzzReply>(w, msg(t))));
   return replies.map((r, t) => {
     if (r.type === 'error') throw new Error(`fuzz thread ${t} (SLAB_FUZZ_SEED=${SEED}): ${r.message}`);
     return r.stats;
```

Modify `test/integration/twoWorkers.test.ts` (apply with `git apply`):

```diff
diff --git a/test/integration/twoWorkers.test.ts b/test/integration/twoWorkers.test.ts
index d7b03b9..56eb6a6 100644
--- a/test/integration/twoWorkers.test.ts
+++ b/test/integration/twoWorkers.test.ts
@@ -1,7 +1,7 @@
 import { Worker } from 'node:worker_threads';
 import { afterAll, beforeAll, expect, test } from 'vitest';
 import { DEFAULTS } from '../../src/core/params/defaults';
-import { buildNodeTaskWorker } from '../harness/nodeWorker';
+import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
 
 const workers: Worker[] = [];
 
@@ -14,9 +14,6 @@ afterAll(async () => {
   await Promise.all(workers.map((w) => w.terminate()));
 });
 
-const ask = (w: Worker, msg: unknown): Promise<Record<string, unknown>> =>
-  new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); });
-
 test('two workers produce byte-identical tiles and agree on the stage hashes', async () => {
   const ready = await Promise.all(workers.map((w) => ask(w, { type: 'configure', epoch: 1, seedText: '42', params: DEFAULTS, abort: null })));
   expect(ready[0]!['type']).toBe('ready');
```

Modify `test/metrics/region.metric.ts` (apply with `git apply`):

```diff
diff --git a/test/metrics/region.metric.ts b/test/metrics/region.metric.ts
index 7ce6830..71fd0ee 100644
--- a/test/metrics/region.metric.ts
+++ b/test/metrics/region.metric.ts
@@ -2,7 +2,8 @@ import { expect } from 'vitest';
 import { resolveProfile } from '../../src/core/params/profiles';
 import { expectGolden } from '../harness/goldens';
 import { metricTest } from '../harness/metric';
-import { genRegion, type GenRegionOptions, type RegionResult } from '../harness/region';
+import { integerEnv } from '../harness/env';
+import { dt1WorkerDir, genRegion, type GenRegionOptions, type RegionResult } from '../harness/region';
 
 /**
  * DT1 on the provisional T stage (SP3a spec §6.3), threshold exact (0 mismatches), on every tier:
@@ -23,7 +24,7 @@ const PROFILES = ['default', 'large_biomes'] as const;
 const REGION = pick({ cx0: -4, cz0: -4, w: 8, h: 8 }, { cx0: -16, cz0: -16, w: 32, h: 32 }, { cx0: -16, cz0: -16, w: 32, h: 32 });
 /** The spec allows the full tier to drop to two seeds if four are too slow (measured in the plan's dry run). */
 const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
-const SHUFFLE_SEED = Number(process.env.DT1_SHUFFLE_SEED ?? 1);
+const SHUFFLE_SEED = integerEnv('DT1_SHUFFLE_SEED', 1);
 const GOLDEN_WINDOW = [-4, -4, 8, 8] as const;
 
 interface Run {
@@ -42,7 +43,6 @@ const RUNS: readonly Run[] = [
 ];
 
 metricTest('DT1', ['mismatches'], async () => {
-  if (!Number.isInteger(SHUFFLE_SEED)) throw new Error(`DT1_SHUFFLE_SEED must be an integer, got ${process.env.DT1_SHUFFLE_SEED}`);
   const problems: string[] = [];
   let invariance = 0;
   let golden = 0;
@@ -56,7 +56,7 @@ metricTest('DT1', ['mismatches'], async () => {
       for (const [i, run] of RUNS.entries()) {
         const r: RegionResult = await genRegion({
           seed, params, ...REGION, upTo: 'T', order: run.order, threads: run.threads, cache: run.cache,
-          shuffleSeed: SHUFFLE_SEED, workerDir: 'dt1RegionWorker',
+          shuffleSeed: SHUFFLE_SEED, workerDir: dt1WorkerDir(TIER),
         });
         genMs += r.timings.totalMs;
         const hash = r.view.hash();
```

Modify `test/unit/governance.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/governance.test.ts b/test/unit/governance.test.ts
index 9f6e357..49e4c9c 100644
--- a/test/unit/governance.test.ts
+++ b/test/unit/governance.test.ts
@@ -7,6 +7,8 @@ const base: GovernanceInput = {
   baseVersion: 1,
   headVersion: 1,
   changedFiles: [],
+  baseStateIds: { air: 0, stone: 1 },
+  headStateIds: { air: 0, stone: 1 },
 };
 
 describe('checkGovernance', () => {
@@ -27,6 +29,23 @@ describe('checkGovernance', () => {
     expect(checkGovernance({ ...lockOnly, changedFiles: [...lockOnly.changedFiles, 'docs/superpowers/specs/2026-10-01-sp1-x-design.md'] })).toEqual([]);
   });
 
+  test('test/stateIds.lock.json is append-only against the base (SP3b spec §7): appended states pass', () => {
+    expect(checkGovernance({ ...base, headStateIds: { air: 0, stone: 1, water: 2 } })).toEqual([]);
+    expect(checkGovernance({ ...base, baseStateIds: null })).toEqual([]);
+    expect(checkGovernance({ ...base, baseStateIds: null, headStateIds: null })).toEqual([]);
+  });
+
+  test('a removed or renumbered locked state, an id below the locked ones, or a deleted lock fails', () => {
+    const lock = (head: Record<string, number> | null) => checkGovernance({ ...base, baseStateIds: { air: 0, stone: 1, dirt: 3 }, headStateIds: head });
+    expect(lock({ air: 0, stone: 2, dirt: 3 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: stone id 1 → 2']);
+    expect(lock({ air: 0, dirt: 3 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: stone (id 1) removed']);
+    expect(lock({ air: 0, stone: 1, dirt: 3, sand: 2 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: sand (id 2) is not after the locked ids (≤ 3)']);
+    expect(lock({ air: 0, stone: 1, dirt: 3, sand: 4 })).toEqual([]);
+    expect(lock(null)).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: the lock was deleted']);
+    // A hand edit of both the registry and the lock passes the local lock test; only this check sees it.
+    expect(lock({ air: 0, stone: 3, dirt: 1 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: stone id 1 → 3, dirt id 3 → 1']);
+  });
+
   test('no goldens at the base ref means nothing to protect yet', () => {
     expect(checkGovernance({ ...base, baseGoldens: null, baseVersion: null })).toEqual([]);
   });
```

Create `test/unit/harnessHelpers.test.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { describe, expect, test } from 'vitest';
import { integerEnv } from '../harness/env';
import { ask } from '../harness/nodeWorker';

/**
 * SP3a §10's harness minors, carried by SP3b (spec §7): one shared `ask()` for every worker-thread test (the slab
 * fuzz's copy never settled when its worker exited), and integer environment knobs that refuse what `Number()` would
 * silently turn into a seed (`SLAB_FUZZ_SEED=abc` became seed 0).
 */
describe('ask (test/harness/nodeWorker.ts)', () => {
  const worker = (body: string) => new Worker(`const { parentPort } = require('node:worker_threads');\n${body}`, { eval: true });
  const listeners = (w: Worker) => ['message', 'error', 'exit'].map((e) => w.listenerCount(e));

  test('resolves with the single reply and leaves no listener behind', async () => {
    const w = worker("parentPort.on('message', (m) => parentPort.postMessage({ echo: m }));");
    try {
      expect(await ask(w, 5)).toEqual({ echo: 5 });
      expect(await ask<{ echo: string }>(w, 'x')).toEqual({ echo: 'x' });
      expect(listeners(w)).toEqual([0, 0, 0]);
    } finally {
      await w.terminate();
    }
  });

  test('rejects when the worker exits before replying', async () => {
    const w = worker("parentPort.once('message', () => process.exit(3));");
    await expect(ask(w, 1)).rejects.toThrow(/worker exited \(3\) before replying/);
    expect(listeners(w)).toEqual([0, 0, 0]);
  });

  test('rejects with the worker\'s uncaught error', async () => {
    const w = worker("parentPort.once('message', () => { throw new Error('boom'); });");
    await expect(ask(w, 1)).rejects.toThrow(/boom/);
    await w.terminate();
  });
});

describe('integerEnv (test/harness/env.ts)', () => {
  test('unset is the fallback; an integer is read', () => {
    expect(integerEnv('SEED', 1, {})).toBe(1);
    expect(integerEnv('SEED', 1, { SEED: '42' })).toBe(42);
    expect(integerEnv('SEED', 1, { SEED: '-7' })).toBe(-7);
    expect(integerEnv('SEED', 1, { SEED: '0' })).toBe(0);
  });

  test.each(['abc', '', ' 3', '1.5', '1e3', '0x10', '+4', '9007199254740993', 'NaN'])('%j is refused, naming the variable', (v) => {
    expect(() => integerEnv('SLAB_FUZZ_SEED', 1, { SLAB_FUZZ_SEED: v })).toThrow(/SLAB_FUZZ_SEED must be an integer/);
  });
});
```

Modify `test/unit/regionCache.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/regionCache.test.ts b/test/unit/regionCache.test.ts
index 076ed43..f0adff5 100644
--- a/test/unit/regionCache.test.ts
+++ b/test/unit/regionCache.test.ts
@@ -5,9 +5,11 @@ import { afterAll, beforeEach, describe, expect, test } from 'vitest';
 import { fnv1a64, fnv1a64Bytes, hex64, type Hash64 } from '../../src/core/hash';
 import { seedFromInput } from '../../src/core/seed';
 import { genKey, stageHashes } from '../../src/core/stage/hash';
+import { REC_AUX_B } from '../../src/world/store/columnTable';
+import { createStore, type VoxelStore } from '../../src/world/store/store';
 import {
-  REGION_CACHE_DIR, REGION_CACHE_FORMAT, REGION_CACHE_PRUNE_MS, regionCacheKey, regionCachePath, SRC_KEY_SCOPE, srcKey, srcKeyOf,
-  type RegionCacheHeader,
+  encodeRegionDump, parseRegionDump, rebuildRegion, REGION_CACHE_DIR, REGION_CACHE_FORMAT, REGION_CACHE_PRUNE_MS, regionCacheKey,
+  regionCachePath, SRC_KEY_SCOPE, srcKey, srcKeyOf, type RegionCacheHeader,
 } from '../harness/cache';
 import { paramsWith } from '../harness/gen';
 import { genRegion, type GenRegionOptions } from '../harness/region';
@@ -27,8 +29,8 @@ const header = (over: Partial<RegionCacheHeader> = {}): RegionCacheHeader => ({
 });
 
 describe('the cache key (§6.1)', () => {
-  test('REGION_CACHE_FORMAT starts at 1; the dumps live in test/.cache/regions/<hex64 of the key>.bin', () => {
-    expect(REGION_CACHE_FORMAT).toBe(1);
+  test('REGION_CACHE_FORMAT is 2 (SP3b spec §7: aux B joined the dump); the dumps live in test/.cache/regions/<hex64 of the key>.bin', () => {
+    expect(REGION_CACHE_FORMAT).toBe(2);
     expect(REGION_CACHE_DIR).toBe(fileURLToPath(new URL('../.cache/regions/', import.meta.url)));
     const h = header();
     expect(regionCachePath(h)).toBe(join(REGION_CACHE_DIR, `${hex64(regionCacheKey(h))}.bin`));
@@ -187,7 +189,8 @@ describe('genRegion with the cache (§6.1)', () => {
     ['a column record of another column', (b: Buffer) => { b.writeInt32LE(b.readInt32LE(44) + 64, 44); return b; }],
     ['a dense slot overwritten with one value (same length)', (b: Buffer) => { const [o, n] = firstDenseSlot(b); b.fill(0, o, o + n); return b; }],
     ['one flipped bit in a dense slot (same length)', (b: Buffer) => { b[firstDenseSlot(b)[0] + 100]! ^= 1; return b; }],
-    ['one flipped bit in the last column\'s aux bytes (same length)', (b: Buffer) => { b[b.length - 2048]! ^= 4; return b; }],
+    ['one flipped bit in the last column\'s aux A bytes (same length)', (b: Buffer) => { b[b.length - 8 - 4096 - 2048]! ^= 4; return b; }],
+    ['one flipped bit in the last column\'s aux B bytes (same length)', (b: Buffer) => { b[b.length - 8 - 2048]! ^= 4; return b; }],
     ['a trailing byte appended', (b: Buffer) => Buffer.concat([b, Buffer.alloc(1)])],
   ] as const)('%s is a miss and the file is rewritten', async (_what, damage) => {
     const first = await genRegion(base);
@@ -216,6 +219,19 @@ describe('genRegion with the cache (§6.1)', () => {
     expect([b.readUInt32LE(b.length - 8), b.readUInt32LE(b.length - 4)]).toEqual([...fnv1a64Bytes(b.subarray(0, b.length - 8))]);
   });
 
+  test('a hit refreshes the dump\'s mtime, so the prune grace counts from its last use', async () => {
+    await genRegion(base);
+    const path = regionCachePath(keyOf(base), DIR);
+    const old = new Date(Date.now() - 2 * REGION_CACHE_PRUNE_MS);
+    utimesSync(path, old, old);
+    expect(statSync(path).mtimeMs).toBeLessThan(Date.now() - REGION_CACHE_PRUNE_MS);
+    expect((await genRegion(base)).cacheHit).toBe(true);
+    expect(statSync(path).mtimeMs).toBeGreaterThan(Date.now() - REGION_CACHE_PRUNE_MS);
+    // A dump of another srcKey written now therefore keeps it: it is no longer old.
+    await genRegion({ ...base, srcKey: [9, 9] });
+    expect(existsSync(path)).toBe(true);
+  });
+
   test('writing a dump deletes the dumps of other srcKeys untouched for REGION_CACHE_PRUNE_MS; this srcKey\'s and recent ones stay', async () => {
     expect(REGION_CACHE_PRUNE_MS).toBe(15 * 60 * 1000);
     const k1: Hash64 = [1, 1];
@@ -248,3 +264,94 @@ describe('genRegion with the cache (§6.1)', () => {
     expect(existsSync(at({}, k2))).toBe(true);
   });
 });
+
+describe('the dump with aux B (SP3b spec §7, format 2)', () => {
+  const MiB = 1 << 20;
+  const h: RegionCacheHeader = { genKey: [5, 6], srcKey: [7, 8], cx0: 0, cz0: 0, w: 3, h: 1, upTo: 'T' };
+  /** Column 0 has aux A and aux B, column 1 aux A only, column 2 neither; every section uniform (no dense slot). */
+  const source = (): VoxelStore => {
+    const s = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
+    for (let cx = 0; cx < 3; cx++) {
+      const w = s.claimColumn(cx, 0, 2);
+      for (let sy = 0; sy < 24; sy++) w.setProto(sy, new Uint16Array(4096).fill(sy < 4 ? 1 : 0), new Uint8Array(4096));
+      if (cx < 2) {
+        const a = w.aux();
+        a.worldSurfaceWG[3] = 70 + cx;
+        a.tintTH[767] = 9;
+      }
+      if (cx === 0) {
+        const b = w.auxB();
+        b.caveBiomeQ[0] = 1;
+        b.caveBiomeQ[1535] = 2;
+        b.surfaceBiomeQ[15] = 3;
+      }
+      w.commit(1);
+    }
+    return s;
+  };
+
+  test('per column: record, descriptors, dense slots, 4096 aux A bytes, then 4096 aux B bytes (zeros when absent)', () => {
+    const b = Buffer.from(encodeRegionDump(source(), h));
+    const col = 4 * (16 + 48) + 4096 + 4096;
+    expect(b.length).toBe(44 + 3 * col + 8);
+    const auxA = (k: number) => 44 + k * col + 4 * 64;
+    const auxB = (k: number) => auxA(k) + 4096;
+    expect(b.readInt16LE(auxA(0) + 6)).toBe(70);
+    expect(b.readInt16LE(auxA(1) + 6)).toBe(71);
+    expect([b[auxB(0)], b[auxB(0) + 1535], b[auxB(0) + 1536 + 15]]).toEqual([1, 2, 3]);
+    let other = 0;
+    for (let i = 0; i < 4096; i++) if (i !== 0 && i !== 1535 && i !== 1551 && b[auxB(0) + i] !== 0) other++;
+    expect(other).toBe(0);
+    for (const k of [1, 2]) expect(b.subarray(auxB(k), auxB(k) + 4096).every((x) => x === 0)).toBe(true);
+    expect(b.subarray(auxA(2), auxA(2) + 4096).every((x) => x === 0)).toBe(true);
+  });
+
+  test('a rebuild restores aux B where the column had one and allocates none where it had none', () => {
+    const src = source();
+    const cols = parseRegionDump(encodeRegionDump(src, h), h)!;
+    expect(cols).not.toBeNull();
+    const dst = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
+    rebuildRegion(dst, cols);
+    for (let cx = 0; cx < 3; cx++) {
+      const [a, b] = [src.proto(cx, 0)!, dst.proto(cx, 0)!];
+      const bytesB = (v: typeof a) => {
+        const x = v.auxB();
+        return x === null ? null : [...new Uint8Array(x.caveBiomeQ.buffer, x.caveBiomeQ.byteOffset, 4096)];
+      };
+      expect(bytesB(b), `column ${cx}`).toEqual(bytesB(a));
+      expect(b.aux() === null, `column ${cx}`).toBe(a.aux() === null);
+      expect(b.aux()?.worldSurfaceWG[3]).toBe(a.aux()?.worldSurfaceWG[3]);
+      expect(dst.table.ints[dst.table.find(cx, 0) + REC_AUX_B]! >= 0).toBe(cx === 0);
+    }
+    // Exactly the aux slots of the source: two aux A, one aux B (every section is uniform).
+    expect(dst.bytePool.slotCount() - dst.bytePool.freeCount()).toBe(3);
+    // The dump of the rebuilt region is the dump of the source.
+    expect(Buffer.from(encodeRegionDump(dst, h)).equals(Buffer.from(encodeRegionDump(src, h)))).toBe(true);
+  });
+});
+
+describe('the CI region cache step (SP3b spec §7)', () => {
+  const CI = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
+  /** The steps of the job: each `- ` item of the `steps:` list with its indented lines. */
+  const steps = CI.slice(CI.indexOf('steps:')).split(/\n\s{6}- /).slice(1);
+
+  test('one actions/cache step: the dumps only, before npm run test:metrics, with no restore-keys', () => {
+    const cache = steps.flatMap((s, i) => (/^uses: actions\/cache@/.test(s) ? [i] : []));
+    expect(cache).toHaveLength(1);
+    const step = steps[cache[0]!]!;
+    // The dumps directory and nothing else: the bundled workers (test/.cache/taskHandler*, …) are rebuilt from the code.
+    expect(step.match(/^\s*path:\s*(.+)$/m)?.[1]?.trim()).toBe('test/.cache/regions');
+    expect(fileURLToPath(new URL('../.cache/regions/', import.meta.url))).toBe(REGION_CACHE_DIR);
+    expect(step).not.toMatch(/restore-keys/);
+    const metrics = steps.findIndex((s) => /^run: npm run test:metrics\s*$/m.test(s));
+    expect(metrics).toBeGreaterThan(cache[0]!);
+  });
+
+  test('its key hashes every file a dump\'s srcKey reads (a srcKey change is always a new key) and the lock file', () => {
+    const key = steps.find((s) => /^uses: actions\/cache@/.test(s))!.match(/^\s*key:\s*(.+)$/m)?.[1] ?? '';
+    const globs = [...(key.match(/hashFiles\(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
+    expect(globs).toContain('package-lock.json');
+    const covered = (path: string): boolean => globs.some((g) => (g.endsWith('/**') ? path.startsWith(g.slice(0, -2)) : g === path));
+    for (const entry of SRC_KEY_SCOPE) expect(covered(entry), entry).toBe(true);
+  });
+});
```

Modify `test/unit/regionHarness.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/regionHarness.test.ts b/test/unit/regionHarness.test.ts
index dbe7e7c..08acc33 100644
--- a/test/unit/regionHarness.test.ts
+++ b/test/unit/regionHarness.test.ts
@@ -1,10 +1,11 @@
 import { describe, expect, test } from 'vitest';
 import { hex64 } from '../../src/core/hash';
 import { genRegionInProcess, regionHash } from '../../src/metrics/region';
-import { protoAt, REC_AUX_A } from '../../src/world/store/columnTable';
+import { allocAux } from '../../src/world/store/aux';
+import { protoAt, REC_AUX_A, REC_AUX_B } from '../../src/world/store/columnTable';
 import { createStore } from '../../src/world/store/store';
 import { ctxFor, paramsWith } from '../harness/gen';
-import { genRegion, regionColumns, regionDiff, regionView, type GenRegionOptions } from '../harness/region';
+import { dt1WorkerDir, genRegion, regionColumns, regionDiff, regionView, type GenRegionOptions } from '../harness/region';
 
 const MiB = 1 << 20;
 
@@ -128,6 +129,20 @@ describe('regionDiff (§6.1)', () => {
     expect(regionDiff(a, regionView(b.store, 0, 0, 2, 1))).toBe('the views cover other regions');
   });
 
+  test('aux B: an absent slot equals a zero one; a differing byte is named (SP3b spec §7)', () => {
+    const a = twin();
+    const b = twin();
+    expect(a.store.proto(1, 0)!.auxB()).toBeNull(); // SP3a's T writes no aux B
+    // Give b's (1, 0) a zero-filled aux B slot in its record, as a column whose stage wrote only zero quarts holds.
+    const base = b.store.table.find(1, 0);
+    b.store.table.ints[base + REC_AUX_B] = allocAux(b.store.bytePool);
+    expect(b.store.proto(1, 0)!.auxB()).not.toBeNull();
+    expect(regionDiff(a, b)).toBeNull();
+    b.store.proto(1, 0)!.auxB()!.surfaceBiomeQ[3] = 4;
+    expect(regionDiff(a, b)).toBe('column (1, 0): aux B differs');
+    expect(regionDiff(b, a)).toBe('column (1, 0): aux B differs');
+  });
+
   test('uniform sections compare by value; a uniform section never equals a dense one with the same values', () => {
     const one = (dense: boolean, state5 = 1) => {
       const s = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
@@ -149,6 +164,13 @@ describe('regionDiff (§6.1)', () => {
   });
 });
 
+test('dt1WorkerDir: one worker directory per metrics tier, none shared with the default (SP3b spec §7)', () => {
+  const dirs = (['fast', 'quick', 'full'] as const).map((t) => dt1WorkerDir(t));
+  expect(new Set([...dirs, 'regionWorker']).size).toBe(4);
+  expect(dt1WorkerDir('quick')).toBe(dt1WorkerDir('quick'));
+  for (const d of dirs) expect(d).toMatch(/^[A-Za-z0-9-]+$/);
+});
+
 describe('genRegion with 1 thread (§6.1)', () => {
   const base: GenRegionOptions = { seed: '42', params: paramsWith(), cx0: -2, cz0: -2, w: 4, h: 4, upTo: 'T', order: 'spiral', threads: 1 };
 
```

Modify `test/unit/store.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/store.test.ts b/test/unit/store.test.ts
index 4037158..7c3c738 100644
--- a/test/unit/store.test.ts
+++ b/test/unit/store.test.ts
@@ -451,6 +451,33 @@ describe.each([true, false])('shared %s', (shared) => {
     expect(av.surfaceBiome[17]).toBe(9);
   });
 
+  test('ColumnView.auxB (SP3b spec §7): null without a slot; otherwise the writer\'s slot, in the proto and final views', () => {
+    const s = newStore();
+    const w0 = s.claimColumn(0, 0, 0);
+    w0.aux();
+    w0.commit(3);
+    for (const v of [s.proto(0, 0)!, s.final(0, 0)!]) {
+      expect(v.aux()).not.toBeNull();
+      expect(v.auxB()).toBeNull(); // aux A alone allocates no aux B slot
+    }
+    const w = s.claimColumn(1, 0, 0);
+    const b = w.auxB();
+    b.surfaceBiomeQ[15] = 7;
+    b.caveBiomeQ[1535] = 3;
+    w.commit(3);
+    const slotB = s.table.ints[s.table.find(1, 0) + REC_AUX_B]!;
+    for (const v of [s.proto(1, 0)!, s.final(1, 0)!]) {
+      expect(v.aux()).toBeNull();
+      const bv = v.auxB()!;
+      for (const [k, off] of Object.entries(AUX_B_OFFSETS)) expect(bv[k as keyof typeof bv].byteOffset).toBe(slotB * 4096 + off);
+      expect([bv.caveBiomeQ.length, bv.surfaceBiomeQ.length]).toEqual([1536, 16]);
+      expect([bv.surfaceBiomeQ[15], bv.caveBiomeQ[1535], bv.caveBiomeQ[0]]).toEqual([7, 3, 0]);
+    }
+    // The view reads the record live: the writer's later bytes are visible through it.
+    b.surfaceBiomeQ[0] = 5;
+    expect(s.proto(1, 0)!.auxB()!.surfaceBiomeQ[0]).toBe(5);
+  });
+
   test('StoreFull at the maximum; the descriptor keeps its old value and freeColumn releases everything', () => {
     const s = newStore({ maxBlockBytes: MiB, maxByteBytes: MiB }); // 128 block slots, 256 byte slots
     const cols: [number, number][] = [];
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project integration --project metrics-fast --project unit test/arch/governance.test.ts test/arch/masterSpec.test.ts test/integration/abort.test.ts test/integration/slabFuzz.test.ts test/integration/twoWorkers.test.ts test/metrics/region.metric.ts test/unit/governance.test.ts test/unit/harnessHelpers.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/unit/store.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× a removed or renumbered locked state, an id below the locked ones, or a deleted lock fails 4ms
× ColumnView.auxB (SP3b spec §7): null without a slot; otherwise the writer's slot, in the proto and final views 4ms
× aux B: an absent slot equals a zero one; a differing byte is named (SP3b spec §7) 12ms
× dt1WorkerDir: one worker directory per metrics tier, none shared with the default (SP3b spec §7) 0ms
× REGION_CACHE_FORMAT is 2 (SP3b spec §7: aux B joined the dump); the dumps live in test/.cache/regions/<hex64 of the key>.bin 6ms
× a hit refreshes the dump's mtime, so the prune grace counts from its last use 6ms
× per column: record, descriptors, dense slots, 4096 aux A bytes, then 4096 aux B bytes (zeros when absent) 2ms
× a rebuild restores aux B where the column had one and allocates none where it had none 3ms
× one actions/cache step: the dumps only, before npm run test:metrics, with no restore-keys 1ms
× its key hashes every file a dump's srcKey reads (a srcKey change is always a new key) and the lock file 0ms
× two workers produce byte-identical tiles and agree on the stage hashes 2ms
× a level-4 relief tile stops within 50 ms of Atomics.store and replies ABORTED; the next tiles equal a fresh worker's 5ms (retry x2)
× a biomeShares stats slice stops within 50 ms of Atomics.store and replies ABORTED; the next slice equals the direct sums 1ms (retry x2)
FAIL  |integration| test/integration/slabFuzz.test.ts [ test/integration/slabFuzz.test.ts ]
… (29 more lines)
Test Files  9 failed | 1 passed | 1 skipped (11)
Tests  14 failed | 92 passed | 1 skipped (107)
```

- [ ] **Step 3: Implement**

Modify `.github/workflows/ci.yml` (apply with `git apply`):

```diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index c5ed52c..cbdae96 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -27,4 +27,11 @@ jobs:
       - run: npm test
         env:
           GOVERNANCE_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
+      # The region cache (SP3b spec §7): dumps only, never the bundled workers (test/.cache/taskHandler* etc.). The key
+      # covers everything a dump's srcKey hashes; no restore-keys, so a code change starts cold instead of restoring
+      # dumps that can never hit.
+      - uses: actions/cache@v6
+        with:
+          path: test/.cache/regions
+          key: regions-${{ runner.os }}-${{ hashFiles('src/**', 'test/harness/**', 'package-lock.json') }}
       - run: npm run test:metrics
```

Modify `src/world/store/api.ts` (apply with `git apply`):

```diff
diff --git a/src/world/store/api.ts b/src/world/store/api.ts
index 01c10a6..b3ffc43 100644
--- a/src/world/store/api.ts
+++ b/src/world/store/api.ts
@@ -67,6 +67,8 @@ export interface ColumnView {
   sectionFluid(sy: number): Uint8Array | number;
   /** The column's aux A, or null when it has none. */
   aux(): AuxView | null;
+  /** The column's aux B, or null when it has none (no stage of the column called the writer's `auxB()`). */
+  auxB(): AuxBView | null;
 }
 
 /** The 3 × 3 columns around (cx, cz) (SP3a spec §3.5); `dx`, `dz` ∈ {−1, 0, 1}. Consumed from SP4. */
```

Modify `src/world/store/store.ts` (apply with `git apply`):

```diff
diff --git a/src/world/store/store.ts b/src/world/store/store.ts
index a785717..3dac0eb 100644
--- a/src/world/store/store.ts
+++ b/src/world/store/store.ts
@@ -151,6 +151,10 @@ export function attachStore(h: StoreHandles): VoxelStore {
         const slot = ints[base + REC_AUX_A]!;
         return slot < 0 ? null : auxView(bytePool, slot);
       },
+      auxB() {
+        const slot = ints[base + REC_AUX_B]!;
+        return slot < 0 ? null : auxBView(bytePool, slot);
+      },
     };
   }
 
```

Modify `test/harness/cache.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/cache.ts b/test/harness/cache.ts
index da60a9c..12e33e2 100644
--- a/test/harness/cache.ts
+++ b/test/harness/cache.ts
@@ -4,29 +4,33 @@
  * + upTo`. `srcKey` is the FNV-1a 64 of the sorted paths and bytes of the code the dump depends on, read at test
  * time, so any code change is a miss without a hand-bumped constant; `REGION_CACHE_FORMAT` changes with the dump
  * layout. A hit rebuilds each column through the writer API (`claimColumn`, `setProto` per section with the
- * expanded data, the aux bytes, `commit(1)`), so uniform and dense decisions are made again by the same code.
+ * expanded data, the aux A and aux B bytes, `commit(1)`), so uniform and dense decisions are made again by the same
+ * code. A hit refreshes the dump's mtime, so the prune grace below counts from its last use.
  *
  * Dump layout (little-endian): a 44-byte header (magic `WIRC`, format u32, genKey lo/hi u32, srcKey lo/hi u32,
  * cx0, cz0 i32, w, h u32, upTo as 4 ASCII bytes padded with 0), then per column, cz outer and cx inner: record ints
  * 0-15 (i32), the 24 proto descriptors (blocks, fluid: 48 i32), the dense slots they reference in descriptor order
- * (8192 bytes per block slot, 4096 per fluid slot), and the 4096 aux A bytes (zeros when the column has none); last,
- * the FNV-1a 64 (lo, hi u32) of every byte before it. Anything that disagrees with the expected header, the layout or
+ * (8192 bytes per block slot, 4096 per fluid slot), the 4096 aux A bytes, then the 4096 aux B bytes (each zeros when
+ * the column has no such slot; the record ints say whether it has one); last, the FNV-1a 64 (lo, hi u32) of every
+ * byte before it. Format 1 had no aux B bytes (SP3a); format 2 adds them (SP3b spec §7). Anything that disagrees with the expected header, the layout or
  * the checksum is a miss (a damaged dump is never rebuilt); the caller regenerates and overwrites.
  *
  * Every code change is a new `srcKey`, so the dumps of earlier code can never hit again: writing a dump deletes the
  * `.bin` files of its directory that are not dumps of this format and `srcKey` and were not modified for
  * `REGION_CACHE_PRUNE_MS` (the grace keeps a concurrent run of other code from losing the dump it just wrote).
  */
-import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
+import {
+  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync,
+} from 'node:fs';
 import { dirname, join, sep } from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { threadId } from 'node:worker_threads';
 import { createFnv64, fnv1a64, hex64, type Hash64 } from '../../src/core/hash';
-import { protoAt, REC_AUX_A, REC_CLAIMED, REC_CX, REC_CZ, REC_STATUS, STATUS_PROTO } from '../../src/world/store/columnTable';
+import { protoAt, REC_AUX_A, REC_AUX_B, REC_CLAIMED, REC_CX, REC_CZ, REC_STATUS, STATUS_PROTO } from '../../src/world/store/columnTable';
 import type { VoxelStore } from '../../src/world/store/store';
 
 /** Bumped whenever the dump layout changes. */
-export const REGION_CACHE_FORMAT = 1;
+export const REGION_CACHE_FORMAT = 2;
 /** A dump that cannot hit for the current code is deleted once it has not been modified for this long (15 min). */
 export const REGION_CACHE_PRUNE_MS = 15 * 60 * 1000;
 
@@ -136,7 +140,7 @@ export function encodeRegionDump(store: VoxelStore, h: RegionCacheHeader): Uint8
   for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
     for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
       const base = protoBase(store, cx, cz);
-      size += COLUMN_HEAD_BYTES + AUX_BYTES;
+      size += COLUMN_HEAD_BYTES + 2 * AUX_BYTES;
       for (let sy = 0; sy < 24; sy++) {
         const p = protoAt(base, sy);
         if (ints[p]! >= 0) size += BLOCK_SLOT;
@@ -170,6 +174,12 @@ export function encodeRegionDump(store: VoxelStore, h: RegionCacheHeader): Uint8
         b.set(new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES), o);
       }
       o += AUX_BYTES;
+      if (ints[base + REC_AUX_B]! >= 0) {
+        // The aux B fields tile the slot from caveBiomeQ (offset 0) on.
+        const a = store.proto(cx, cz)!.auxB()!.caveBiomeQ;
+        b.set(new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES), o);
+      }
+      o += AUX_BYTES;
     }
   }
   const sum = checksum(b.subarray(0, o));
@@ -191,6 +201,7 @@ interface DumpColumn {
   readonly blocks: Array<Uint8Array | null>;
   readonly fluid: Array<Uint8Array | null>;
   readonly aux: Uint8Array;
+  readonly auxB: Uint8Array;
 }
 
 /** The columns of a dump whose header and layout agree with `h`, or null (a miss). Reads nothing into a store. */
@@ -231,9 +242,9 @@ export function parseRegionDump(bytes: Uint8Array, h: RegionCacheHeader): DumpCo
           o += FLUID_SLOT;
         } else fluid.push(null);
       }
-      if (o + AUX_BYTES > b.length) return null;
-      out.push({ cx, cz, record, descriptors, blocks, fluid, aux: b.subarray(o, o + AUX_BYTES) });
-      o += AUX_BYTES;
+      if (o + 2 * AUX_BYTES > b.length) return null;
+      out.push({ cx, cz, record, descriptors, blocks, fluid, aux: b.subarray(o, o + AUX_BYTES), auxB: b.subarray(o + AUX_BYTES, o + 2 * AUX_BYTES) });
+      o += 2 * AUX_BYTES;
     }
   }
   return o === b.length ? out : null;
@@ -267,6 +278,10 @@ export function rebuildRegion(store: VoxelStore, cols: readonly DumpColumn[]): F
       const a = w.aux().worldSurfaceWG;
       new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES).set(c.aux);
     }
+    if (c.record[REC_AUX_B]! >= 0) {
+      const a = w.auxB().caveBiomeQ;
+      new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES).set(c.auxB);
+    }
     w.commit(1);
     ms[k] = performance.now() - t0;
     const d0 = protoAt(store.table.find(c.cx, c.cz), 0);
@@ -282,9 +297,9 @@ export function rebuildRegion(store: VoxelStore, cols: readonly DumpColumn[]): F
 }
 
 /**
- * On a hit, rebuilds the dump at `path` into `store` and returns the milliseconds per column (row-major); null on a
- * miss (no file or one that cannot be read, another header, a malformed layout, a wrong checksum), in which case
- * `store` is untouched.
+ * On a hit, rebuilds the dump at `path` into `store`, sets the file's mtime to now (so `pruneRegionDumps`' grace
+ * counts from the last use) and returns the milliseconds per column (row-major); null on a miss (no file or one that
+ * cannot be read, another header, a malformed layout, a wrong checksum), in which case `store` is untouched.
  */
 export function readRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): Float64Array | null {
   if (!existsSync(path)) return null;
@@ -295,7 +310,15 @@ export function readRegionDump(store: VoxelStore, h: RegionCacheHeader, path: st
     return null; // deleted or replaced under us: a miss
   }
   const cols = parseRegionDump(bytes, h);
-  return cols === null ? null : rebuildRegion(store, cols);
+  if (cols === null) return null;
+  const ms = rebuildRegion(store, cols);
+  try {
+    const now = new Date();
+    utimesSync(path, now, now);
+  } catch {
+    // deleted or replaced under us: the next run regenerates it
+  }
+  return ms;
 }
 
 /** The first HEADER_BYTES of a file, or null when it is shorter or cannot be read. */
```

Create `test/harness/env.ts`:

```ts
/**
 * Integer environment knobs of the harness (`SLAB_FUZZ_SEED`, `DT1_SHUFFLE_SEED`), validated (SP3a §10's minor,
 * SP3b spec §7): `Number()` would silently turn `abc` or an empty value into a seed.
 */

/** `env[name]` as a safe integer (decimal, optional '-'), or `fallback` when unset; anything else throws. */
export function integerEnv(name: string, fallback: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const v = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(v)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return v;
}
```

Modify `test/harness/governance.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/governance.ts b/test/harness/governance.ts
index 95b35f9..056b434 100644
--- a/test/harness/governance.ts
+++ b/test/harness/governance.ts
@@ -1,4 +1,5 @@
 import type { GoldensFile } from './goldens';
+import type { StateIdLock } from './stateLock';
 
 export interface GovernanceInput {
   baseGoldens: GoldensFile | null;
@@ -6,6 +7,33 @@ export interface GovernanceInput {
   baseVersion: number | null;
   headVersion: number;
   changedFiles: readonly string[];
+  /** `test/stateIds.lock.json` at the base ref and at HEAD (null when the file does not exist there). */
+  baseStateIds: StateIdLock | null;
+  headStateIds: StateIdLock | null;
+}
+
+/**
+ * The state-id lock is append-only against the base ref (SP3a spec §2.3; SP3b spec §7): every locked entry keeps its
+ * id and new entries come after the locked ids. The local lock test compares the lock with the registry only, so a
+ * hand edit of both passes it; this compares the lock with its own history.
+ */
+function stateIdErrors(base: StateIdLock | null, head: StateIdLock | null): string[] {
+  if (base === null) return [];
+  if (head === null) return ['the lock was deleted'];
+  const headMap = new Map(Object.entries(head));
+  const out: string[] = [];
+  let maxBase = -1;
+  for (const [key, id] of Object.entries(base)) {
+    maxBase = Math.max(maxBase, id);
+    const now = headMap.get(key);
+    if (now === undefined) out.push(`${key} (id ${id}) removed`);
+    else if (now !== id) out.push(`${key} id ${id} → ${now}`);
+  }
+  const baseMap = new Map(Object.entries(base));
+  for (const [key, id] of headMap) {
+    if (!baseMap.has(key) && id <= maxBase) out.push(`${key} (id ${id}) is not after the locked ids (≤ ${maxBase})`);
+  }
+  return out;
 }
 
 export function parseGeneratorVersion(source: string): number | null {
@@ -26,5 +54,7 @@ export function checkGovernance(input: GovernanceInput): string[] {
   if (input.changedFiles.includes('test/thresholds.lock.json') && !input.changedFiles.some((f) => f.startsWith('docs/superpowers/specs/'))) {
     errors.push('test/thresholds.lock.json changed without a change under docs/superpowers/specs/');
   }
+  const ids = stateIdErrors(input.baseStateIds, input.headStateIds);
+  if (ids.length > 0) errors.push(`test/stateIds.lock.json is append-only against GOVERNANCE_BASE: ${ids.join(', ')}`);
   return errors;
 }
```

Modify `test/harness/nodeWorker.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/nodeWorker.ts b/test/harness/nodeWorker.ts
index 1d4e434..efaaa56 100644
--- a/test/harness/nodeWorker.ts
+++ b/test/harness/nodeWorker.ts
@@ -9,8 +9,28 @@
 import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
 import { basename } from 'node:path';
 import { fileURLToPath } from 'node:url';
+import type { Worker } from 'node:worker_threads';
 import { build } from 'vite';
 
+/**
+ * Posts one message to `w` and waits for its single reply (the one shared helper of every worker-thread test, SP3b
+ * spec §7). Rejects with the worker's error when it throws, or when it exits before replying; every listener it adds
+ * is removed when it settles. One outstanding `ask` per worker: concurrent asks on the same worker would race for
+ * its replies.
+ */
+export function ask<R = Record<string, unknown>>(w: Worker, msg: unknown): Promise<R> {
+  return new Promise<R>((resolve, reject) => {
+    const off = () => { w.off('error', onError); w.off('exit', onExit); w.off('message', onMessage); };
+    const onError = (e: Error) => { off(); reject(e); };
+    const onExit = (code: number) => { off(); reject(new Error(`worker exited (${code}) before replying`)); };
+    const onMessage = (r: R) => { off(); resolve(r); };
+    w.on('error', onError);
+    w.on('exit', onExit);
+    w.on('message', onMessage);
+    w.postMessage(msg);
+  });
+}
+
 /** The default entry, relative to the repository root. */
 const DEFAULT_ENTRY = 'src/workers/taskHandler.ts';
 
```

Modify `test/harness/region.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/region.ts b/test/harness/region.ts
index 58579c3..a6901da 100644
--- a/test/harness/region.ts
+++ b/test/harness/region.ts
@@ -18,7 +18,7 @@ import { fillColumnT, regionHash } from '../../src/metrics/region';
 import { protoAt } from '../../src/world/store/columnTable';
 import { createStore, type ColumnView, type VoxelStore } from '../../src/world/store/store';
 import { readRegionDump, regionCachePath, srcKey, writeRegionDump, type RegionCacheHeader, type RegionUpTo } from './cache';
-import { buildNodeTaskWorker } from './nodeWorker';
+import { ask, buildNodeTaskWorker } from './nodeWorker';
 import type { RegionAttachMsg, RegionColumnMsg, RegionWorkerReply } from './regionWorker';
 
 export type RegionOrder = 'spiral' | 'shuffled';
@@ -170,8 +170,9 @@ const sameChannel = (a: Uint16Array | Uint8Array | number, b: Uint16Array | Uint
 /**
  * The first difference between two views of the same region, or null when they hold the same proto data: per
  * column, each section's blocks and fluid (uniform against uniform by value, dense against dense by bytes; a
- * uniform section never equals a dense one, so the per-channel layout must match too) and the 4096 aux A bytes.
- * Byte comparison, much faster than hashing both regions.
+ * uniform section never equals a dense one, so the per-channel layout must match too), the 4096 aux A bytes and the
+ * 4096 aux B bytes (an absent slot compares as zeros, as in `regionHash`). Byte comparison, much faster than hashing
+ * both regions.
  */
 export function regionDiff(a: RegionView, b: RegionView): string | null {
   if (a.cx0 !== b.cx0 || a.cz0 !== b.cz0 || a.w !== b.w || a.h !== b.h) return 'the views cover other regions';
@@ -187,6 +188,10 @@ export function regionDiff(a: RegionView, b: RegionView): string | null {
       const xb = vb.aux();
       const bytes = (x: typeof xa) => (x === null ? Buffer.alloc(4096) : Buffer.from(x.worldSurfaceWG.buffer, x.worldSurfaceWG.byteOffset, 4096));
       if (!bytes(xa).equals(bytes(xb))) return `column (${cx}, ${cz}): aux A differs`;
+      const ya = va.auxB();
+      const yb = vb.auxB();
+      const bytesB = (y: typeof ya) => (y === null ? Buffer.alloc(4096) : Buffer.from(y.caveBiomeQ.buffer, y.caveBiomeQ.byteOffset, 4096));
+      if (!bytesB(ya).equals(bytesB(yb))) return `column (${cx}, ${cz}): aux B differs`;
     }
   }
   return null;
@@ -203,20 +208,16 @@ function regionWorkerScript(dir: string): Promise<string> {
   return p;
 }
 
-/** Sends one message and waits for the worker's single reply; rejects if the worker fails or exits first. */
-function ask(w: Worker, msg: RegionAttachMsg | RegionColumnMsg): Promise<RegionWorkerReply> {
-  return new Promise((resolve, reject) => {
-    const onError = (e: Error) => { off(); reject(e); };
-    const onExit = (code: number) => { off(); reject(new Error(`region worker exited (${code})`)); };
-    const onMessage = (r: RegionWorkerReply) => { off(); resolve(r); };
-    const off = () => { w.off('error', onError); w.off('exit', onExit); w.off('message', onMessage); };
-    w.on('error', onError);
-    w.on('exit', onExit);
-    w.on('message', onMessage);
-    w.postMessage(msg);
-  });
+/**
+ * DT1's worker directory for a metrics tier (SP3a §10's minor, SP3b spec §7): one per tier, so the fast, quick and
+ * full tiers running at once never share a build's `emptyOutDir`.
+ */
+export function dt1WorkerDir(tier: 'fast' | 'quick' | 'full'): string {
+  return `dt1RegionWorker-${tier}`;
 }
 
+const askRegion = (w: Worker, msg: RegionAttachMsg | RegionColumnMsg): Promise<RegionWorkerReply> => ask<RegionWorkerReply>(w, msg);
+
 /** Generates `cols` on 4 worker threads over `store` (shared); fills `ms` (row-major) and returns columns per thread. */
 async function generateThreaded(store: VoxelStore, o: GenRegionOptions, cols: ReadonlyArray<[number, number]>, ms: Float64Array): Promise<number[]> {
   const script = await regionWorkerScript(o.workerDir ?? 'regionWorker');
@@ -224,13 +225,13 @@ async function generateThreaded(store: VoxelStore, o: GenRegionOptions, cols: Re
   const written = new Uint8Array(cols.length);
   const perThread = [0, 0, 0, 0];
   try {
-    const ready = await Promise.all(workers.map((w) => ask(w, { type: 'attach', handles: store.handles(), seedText: o.seed, params: o.params })));
+    const ready = await Promise.all(workers.map((w) => askRegion(w, { type: 'attach', handles: store.handles(), seedText: o.seed, params: o.params })));
     for (const r of ready) if (r.type !== 'ready') throw new Error(`region worker: ${r.type === 'error' ? r.message : r.type}`);
     let next = 0;
     const drain = async (t: number): Promise<void> => {
       while (next < cols.length) {
         const [cx, cz] = cols[next++]!;
-        const r = await ask(workers[t]!, { type: 'column', cx, cz });
+        const r = await askRegion(workers[t]!, { type: 'column', cx, cz });
         if (r.type !== 'done') throw new Error(`region worker ${t}, column (${cx}, ${cz}): ${r.type === 'error' ? r.message : r.type}`);
         if (r.cx !== cx || r.cz !== cz) throw new Error(`region worker ${t}: asked (${cx}, ${cz}), done (${r.cx}, ${r.cz})`);
         const k = (cz - o.cz0) * o.w + (cx - o.cx0);
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project integration --project metrics-fast --project unit test/arch/governance.test.ts test/arch/masterSpec.test.ts test/integration/abort.test.ts test/integration/slabFuzz.test.ts test/integration/twoWorkers.test.ts test/metrics/region.metric.ts test/unit/governance.test.ts test/unit/harnessHelpers.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/unit/store.test.ts`

Expected: PASS (exit 0)

```
Test Files  10 passed | 1 skipped (11)
Tests  121 passed | 1 skipped (122)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  130 passed | 2 skipped (132)
Tests  1717 passed | 3 skipped (1720)
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml src/world/store/api.ts src/world/store/store.ts test/arch/governance.test.ts test/arch/masterSpec.test.ts test/harness/cache.ts test/harness/env.ts test/harness/governance.ts test/harness/nodeWorker.ts test/harness/region.ts test/integration/abort.test.ts test/integration/slabFuzz.test.ts test/integration/twoWorkers.test.ts test/metrics/region.metric.ts test/unit/governance.test.ts test/unit/harnessHelpers.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/unit/store.test.ts
git commit -F - <<'EOF'
feat(store,harness): ColumnView.auxB, aux B in the region dump, harness minors, CI region cache

SP3b spec §7 (all bullets except the review slices and uiSmoke):
- ColumnView.auxB(): the column's aux B, null without a slot.
- Region cache format 2: per column, aux A then aux B bytes (zeros when
  absent); a rebuild allocates aux B only where the column had one; a hit
  refreshes the dump's mtime. regionDiff compares aux B too.
- regionHash is unchanged here: appending aux B bytes would change
  sp3a.region.T.* at GENERATOR_VERSION 3. It lands with the real T and the
  version bump (Task 8, spec §9).
- SP3a §10's harness minors: a per-tier DT1 worker directory; the dump
  mtime refreshed on a hit; test/stateIds.lock.json append-only against
  GOVERNANCE_BASE; SLAB_FUZZ_SEED (and DT1_SHUFFLE_SEED) validated;
  masterSpec.test.ts resolved through import.meta.url; one shared ask().
- CI: actions/cache@v6 for test/.cache/regions before npm run test:metrics,
  keyed by hashFiles('src/**', 'test/harness/**', 'package-lock.json'), no
  restore-keys.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `3d96c8e` on `dry/sp3a`; 19 files changed, 381 insertions(+), 65 deletions(-)):

Commit Task 7 on `dry/sp3b-store` (worktree `P/dry-store`, from `dry/sp3b` Task 1). RED (the commit's test files over the parent): 12 failed in 9 files (store ×2 `v.auxB is not a function`, regionCache ×4 (format 1 ≠ 2, mtime not refreshed, dump 13108 ≠ 25396 bytes, `auxB`), regionHarness ×2 (`auxB`, `dt1WorkerDir`), governance ×1 (state-id lock not checked), abort ×2 and twoWorkers ×1 (`ask` not exported), slabFuzz, harnessHelpers and region.metric fail to import `ask`/`../harness/env`), plus 24 `tsc -p tsconfig.test.json` errors. masterSpec.test.ts passes on the parent from the repo root; run from `test/` (`npx vitest run --root .. --project arch arch/masterSpec.test.ts`) the parent fails with ENOENT and the commit passes. GREEN: typecheck clean; `npm test` 122 files passed, 2 skipped; 1600 tests passed, 3 skipped (29.6 s wall); `GOVERNANCE_BASE=main` governance test passes; DT1 quick alone 11.6 s, 0 mismatches, worker built in `test/.cache/dt1RegionWorker-quick/`.

- Ruling (the golden question): `regionHash` does NOT gain aux B in Task 7; the change moves to Task 8, which bumps GENERATOR_VERSION and re-records `sp3a.region.T.*`. Appending any byte, zero included, changes the FNV-1a state (h → (h ^ 0)·P), so §7's "4096 aux B bytes (zeros when absent)" changes `sp3a.region.T.*` at version 3, which `test:goldens` and governance refuse. The other option, appending only when the column has an aux B slot, contradicts §7's explicit "zeros when absent". It would also make an absent slot hash differently from an all-zero one, unlike aux A, the dump and `regionDiff`. The spec already puts the hash change at version 4: §9 says the v4 re-record of `sp3a.region.T.*` hashes "the real T and aux B", and SP3a §10 says "When the real T writes aux B, hash and dump it". §7 lists what SP3b delivers, not the order, so there is no Spec defect. Task 8's instruction: in `src/metrics/region.ts`, after the aux A bytes, append `v.auxB()`'s 4096 bytes (a view from `caveBiomeQ.byteOffset`, which tiles the slot from offset 0) or 4096 zeros when it is null; update the doc comment; add a `region.test.ts` case (one aux B byte changes the hash; an absent slot hashes like a zero-filled one); then re-record. Cost if wrong: Task 8 grows by about 10 lines and one test.
- Ruling: `ColumnView.auxB()` mirrors `aux()`: it reads `REC_AUX_B` live and returns null when the slot is below 0, in both the proto and final views. A writer's `aux()` alone allocates no aux B. Cost if wrong: none.
- Ruling: dump format 2 writes, per column, the 4096 aux A bytes and then the 4096 aux B bytes, each zero-filled when the column has no such slot. The record ints already carry `REC_AUX_B`, so a rebuild allocates aux B only where the source had one, and the rebuilt region re-encodes to the same bytes (tested). `parseRegionDump` needs both blocks. Cost if wrong: none (cache only, keyed by the format).
- Ruling: `regionDiff` (test/harness/region.ts) also compares the 4096 aux B bytes, treating an absent slot as zeros, and returns "column (cx, cz): aux B differs". This way DT1's diagnostics name an aux B difference once Task 8 hashes it. Cost if wrong: none.
- Ruling: mtime refresh: after a successful rebuild, `readRegionDump` calls `utimesSync(path, now, now)` and ignores errors, since the file may have been replaced under it. A dump read from a CI cache restore is therefore fresh after its first hit. Cost if wrong: none.
- Ruling: the state-id lock check lives in `checkGovernance` (new inputs `baseStateIds`/`headStateIds`, read via `git show BASE:test/stateIds.lock.json` and `readStateLock()`). It fails on a removed entry, a changed id, a new entry whose id is not above every locked id, or a deleted lock. A missing base lock protects nothing. All findings go in one error line, `test/stateIds.lock.json is append-only against GOVERNANCE_BASE: …`. Cost if wrong: none (CI only).
- Ruling: `integerEnv(name, fallback, env = process.env)` in a new file, `test/harness/env.ts`. Unset gives the fallback; otherwise the value must match `/^-?\d+$/` and be a safe integer, so `''`, `abc`, `1.5`, `1e3`, `0x10`, `+4` and ` 3` throw `<NAME> must be an integer, got "…"`. It is used for `SLAB_FUZZ_SEED` and also for `DT1_SHUFFLE_SEED`, whose inline check accepted `''` (as 0) and `1e3`. Cost if wrong: none.
- Ruling: one `ask<R>(w, msg)` in `test/harness/nodeWorker.ts` with error and exit handling. Its rejection reads "worker exited (N) before replying", replacing region.ts's "region worker exited (N)". It removes every listener when it settles. It replaces all four copies (region.ts, slabFuzz, and abort and twoWorkers, which had neither error nor exit handling). It is tested with `eval` workers in `test/unit/harnessHelpers.test.ts`. Cost if wrong: none.
- Ruling: `dt1WorkerDir(tier)` (test/harness/region.ts) returns `dt1RegionWorker-<tier>`. An older `test/.cache/dt1RegionWorker/` is left in place (git-ignored). The unit test asserts the three tier directories are distinct from each other and from `regionWorker`. Cost if wrong: none.
- Ruling: `masterSpec.test.ts` resolves the master through `fileURLToPath(new URL('../../docs/…', import.meta.url))`. Its RED shows only from another cwd (see above), so the plan's replay from the repo root records it as passing on the parent. Cost if wrong: plan wording only.
- Ruling (CI, could not run here): `.github/workflows/ci.yml` gains a step right before `- run: npm run test:metrics`, after `npm test`, as §7 words it: `uses: actions/cache@v6`, `path: test/.cache/regions` only (never `test/.cache/taskHandler*`, `dt1RegionWorker-*` or other bundles), `key: regions-${{ runner.os }}-${{ hashFiles('src/**', 'test/harness/**', 'package-lock.json') }}`, no `restore-keys`. The `regions-`/`runner.os` prefix is my addition; the spec names only the hashFiles. `hashFiles` covers a superset of what `srcKey` hashes (src/core, world, gen, metrics/region.ts, test/harness/cache.ts), so a restored dump always matches the current srcKey. The fast-tier dumps that `npm test` wrote before the restore have the same names and bytes. On an exact hit actions/cache does not re-save. Validated locally with `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` (PyYAML; the steps parse as intended), since node_modules has no YAML parser and no dependency may be added. Cost if wrong: one CI fix-up commit; the exit criterion "CI green, with the region cache step" is checked on GitHub by the executor.

---

### Task 8: The real T stage; GENERATOR_VERSION 4

**Spec:** §4 (all bullets except SP2a minor 5), §3.2 reduction test

**Files:**
- Modify: `src/core/constants.ts`
- Modify: `src/core/stage/registry.ts`
- Modify: `src/gen/pipeline/terrainStage.ts`
- Modify: `src/metrics/region.ts`
- Modify: `src/metrics/sp3aGoldens.ts`
- Modify: `src/ui/crossSection/section.ts`
- Modify: `src/ui/crossSection/voxels.ts`
- Modify: `test/goldens.json`
- Modify: `test/harness/region.ts`
- Modify: `test/harness/reviewSlices.ts`
- Modify: `test/integration/region.test.ts`
- Modify: `test/metrics/region.metric.ts`
- Modify: `test/unit/region.test.ts`
- Modify: `test/unit/regionCache.test.ts`
- Modify: `test/unit/regionHarness.test.ts`
- Modify: `test/unit/reviewSlices.test.ts`
- Modify: `test/unit/sliceJob.test.ts`
- Modify: `test/unit/stage.test.ts`
- Modify: `test/unit/terrainStage.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/bounds.ts` (Task 5): `fillDensityColumn`
  - `src/gen/density/context.ts` (Task 6): `createDensityContext`, `type DensityContext`
- Produces (exports added by this task):
  - `src/core/constants.ts`:
    - `export const GENERATOR_VERSION = 4;`

- [ ] **Step 1: Write the failing tests**

Modify `test/integration/region.test.ts` (apply with `git apply`):

```diff
diff --git a/test/integration/region.test.ts b/test/integration/region.test.ts
index 5a72b9d..7bebf08 100644
--- a/test/integration/region.test.ts
+++ b/test/integration/region.test.ts
@@ -28,7 +28,7 @@ function accounting(r: RegionResult) {
         if (d[2 * sy]! >= 0) blocks++;
         if (d[2 * sy + 1]! >= 0) bytes++;
       }
-      bytes++; // aux A
+      bytes += 2; // aux A and aux B
     }
   }
   return {
```

Modify `test/metrics/region.metric.ts` (apply with `git apply`):

```diff
diff --git a/test/metrics/region.metric.ts b/test/metrics/region.metric.ts
index 71fd0ee..54b0c00 100644
--- a/test/metrics/region.metric.ts
+++ b/test/metrics/region.metric.ts
@@ -6,7 +6,7 @@ import { integerEnv } from '../harness/env';
 import { dt1WorkerDir, genRegion, type GenRegionOptions, type RegionResult } from '../harness/region';
 
 /**
- * DT1 on the provisional T stage (SP3a spec §6.3), threshold exact (0 mismatches), on every tier:
+ * DT1 on the T stage (SP3a spec §6.3; the real T since SP3b), threshold exact (0 mismatches), on every tier:
  * 1. Invariance: per profile (default, large_biomes) and tier seed, five runs of the tier's region give equal region
  *    hashes: spiral / 1 thread / cold, shuffled / 4 threads / cold, a second spiral / 1 thread / cold, and two
  *    `cache: true` runs (shuffled / 4 threads, then spiral / 1 thread), the second of which must be a cache hit.
```

Modify `test/unit/region.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/region.test.ts b/test/unit/region.test.ts
index 367f698..bda8cd2 100644
--- a/test/unit/region.test.ts
+++ b/test/unit/region.test.ts
@@ -3,7 +3,7 @@ import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
 import type { GenContext } from '../../src/gen/context';
 import { fillColumnT, genRegionInProcess, regionHash } from '../../src/metrics/region';
 import { torusSlot as torusSlotOf } from '../../src/core/coords';
-import { protoAt, REC_AUX_A, REC_BLOCK_VERSION, REC_CLAIMED, REC_EPOCH, STATUS_PROTO } from '../../src/world/store/columnTable';
+import { protoAt, REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED, REC_EPOCH, STATUS_PROTO } from '../../src/world/store/columnTable';
 import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
 import { createStore, SlotBusy, StoreFull, type VoxelStore } from '../../src/world/store/store';
 import { ctxFor } from '../harness/gen';
@@ -21,7 +21,7 @@ const slots = (s: VoxelStore) => [s.blockPool.freeCount(), s.blockPool.slotCount
  * pins the order, the little-endian u16s, the uniform expansion and the aux bytes.
  */
 function referenceHash(s: VoxelStore, cx0: number, cz0: number, w: number, h: number): string {
-  const per = 24 * (8192 + 4096) + 4096;
+  const per = 24 * (8192 + 4096) + 2 * 4096;
   const out = new Uint8Array(w * h * per);
   let o = 0;
   for (let cz = cz0; cz < cz0 + h; cz++) {
@@ -40,6 +40,13 @@ function referenceHash(s: VoxelStore, cx0: number, cz0: number, w: number, h: nu
       i16(a.worldSurfaceWG); i16(a.oceanFloorWG); i16(a.worldSurface); i16(a.motionBlocking); i16(a.oceanFloor); i16(a.lightBlocking);
       for (const x of a.surfaceBiome) out[o++] = x;
       for (const x of a.tintTH) out[o++] = x;
+      // Aux B (SP3b spec §7): caveBiomeQ, surfaceBiomeQ, then zeros to 4096 bytes; all zeros without a slot.
+      const b = v.auxB();
+      if (b !== null) {
+        for (const x of b.caveBiomeQ) out[o++] = x;
+        for (const x of b.surfaceBiomeQ) out[o++] = x;
+        o += 4096 - 1536 - 16;
+      } else o += 4096;
     }
   }
   expect(o).toBe(out.length);
@@ -75,7 +82,8 @@ describe('fillColumnT (§4, §6.1)', () => {
     expect(() => fillColumnT(s, ctx, 64, 0, NEVER)).toThrow(SlotBusy);
   });
 
-  test.each([0, 3, 12, 23])('abort before section %i: false, the record is free and no slot leaks', (k) => {
+  // Polls 0 … 5 come before the density phase's cell layers 0, 8, …, 40; polls 6 … 29 before sections 0 … 23.
+  test.each([0, 3, 5, 6, 18, 29])('abort at poll %i: false, the record is free and no slot leaks', (k) => {
     const s = newStore();
     // Warm both pools with a whole column, so the snapshot covers the slots the aborted column takes.
     fillColumnT(s, ctx, 2, 2, NEVER);
@@ -141,6 +149,7 @@ describe('fillColumnT (§4, §6.1)', () => {
         if (s.table.ints[protoAt(base, sy) + PROTO_FLUID]! >= 0) bytes++;
       }
       if (s.table.ints[base + REC_AUX_A]! >= 0) bytes++;
+      if (s.table.ints[base + REC_AUX_B]! >= 0) bytes++;
     }
     expect([s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()]).toEqual([blocks, bytes]);
     // The store stays usable: once columns are freed, the failed column fills and equals a fresh fill.
@@ -186,6 +195,28 @@ describe('regionHash (§6.2)', () => {
     expect(hex64(regionHash(s, cx0, cz0, w, h))).toBe(referenceHash(s, cx0, cz0, w, h));
   });
 
+  test('aux B (SP3b spec §7): every byte of the slot counts; an absent slot hashes like a zero-filled one', () => {
+    const s = newStore();
+    genRegionInProcess(s, ctx, CX0, CZ0, 2, 1);
+    const want = regionHash(s, CX0, CZ0, 2, 1);
+    const b = s.proto(CX0 + 1, CZ0)!.auxB()!;
+    const slot = new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096);
+    for (const i of [0, 1535, 1536 + 3, 4095]) {
+      slot[i] = slot[i]! ^ 1;
+      expect(regionHash(s, CX0, CZ0, 2, 1), `byte ${i}`).not.toEqual(want);
+      slot[i] = slot[i]! ^ 1;
+    }
+    expect(regionHash(s, CX0, CZ0, 2, 1)).toEqual(want);
+    // Zero the slot, then detach it from the record (the slot leaks; the store is thrown away): same hash.
+    slot.fill(0);
+    const zeroed = regionHash(s, CX0, CZ0, 2, 1);
+    expect(zeroed).not.toEqual(want);
+    s.table.ints[s.table.find(CX0 + 1, CZ0) + REC_AUX_B] = -1;
+    expect(s.proto(CX0 + 1, CZ0)!.auxB()).toBeNull();
+    expect(regionHash(s, CX0, CZ0, 2, 1)).toEqual(zeroed);
+    expect(hex64(zeroed)).toBe(referenceHash(s, CX0, CZ0, 2, 1));
+  });
+
   test('independent of backend, generation order and slot layout', () => {
     const a = newStore(false);
     genRegionInProcess(a, ctx, CX0, CZ0, 3, 3);
```

Modify `test/unit/regionCache.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/regionCache.test.ts b/test/unit/regionCache.test.ts
index f0adff5..dde53dc 100644
--- a/test/unit/regionCache.test.ts
+++ b/test/unit/regionCache.test.ts
@@ -153,7 +153,8 @@ describe('genRegion with the cache (§6.1)', () => {
     }
     const s = b.view.store;
     expect(s.blockPool.slotCount() - s.blockPool.freeCount()).toBe(dense);
-    expect(s.bytePool.slotCount() - s.bytePool.freeCount()).toBe(denseBytes + 4);
+    // Each of the 4 columns holds an aux A and an aux B slot.
+    expect(s.bytePool.slotCount() - s.bytePool.freeCount()).toBe(denseBytes + 8);
   });
 
   test('a changed srcKey is a miss and writes its own dump', async () => {
```

Modify `test/unit/regionHarness.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/regionHarness.test.ts b/test/unit/regionHarness.test.ts
index 08acc33..1ac2ea4 100644
--- a/test/unit/regionHarness.test.ts
+++ b/test/unit/regionHarness.test.ts
@@ -132,8 +132,11 @@ describe('regionDiff (§6.1)', () => {
   test('aux B: an absent slot equals a zero one; a differing byte is named (SP3b spec §7)', () => {
     const a = twin();
     const b = twin();
-    expect(a.store.proto(1, 0)!.auxB()).toBeNull(); // SP3a's T writes no aux B
-    // Give b's (1, 0) a zero-filled aux B slot in its record, as a column whose stage wrote only zero quarts holds.
+    // The T stage writes aux B: detach a's (1, 0) slot (it leaks; the store is thrown away) and give b's (1, 0) a fresh
+    // zero-filled slot, as a column whose stage wrote only zero quarts holds.
+    a.store.table.ints[a.store.table.find(1, 0) + REC_AUX_B] = -1;
+    expect(a.store.proto(1, 0)!.auxB()).toBeNull();
+    expect(regionDiff(a, b)).toBe('column (1, 0): aux B differs');
     const base = b.store.table.find(1, 0);
     b.store.table.ints[base + REC_AUX_B] = allocAux(b.store.bytePool);
     expect(b.store.proto(1, 0)!.auxB()).not.toBeNull();
```

Modify `test/unit/reviewSlices.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/reviewSlices.test.ts b/test/unit/reviewSlices.test.ts
index 80a6ffc..dc4d6af 100644
--- a/test/unit/reviewSlices.test.ts
+++ b/test/unit/reviewSlices.test.ts
@@ -2,7 +2,7 @@ import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, test } from 'vitest';
-import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
+import { buildColumnSample, newColumnSample, readLevel } from '../../src/gen/column/columnStage';
 import { fluidType } from '../../src/world/blocks/fluid';
 import { BEDROCK } from '../../src/world/blocks/index';
 import { ctxFor, paramsWith } from '../harness/gen';
@@ -62,10 +62,16 @@ describe('vertical review slices over the generated voxels', () => {
     const s = newColumnSample();
     let cx = Number.NaN;
     let lakeAbove63 = 0;
+    // On the real T (SP3b) σ, jag and detail move each position's top away from the 2D estimate, so the 2D kind no
+    // longer predicts every position's water: a wet position needs a finite water level, and each needed kind must
+    // show up wet (land: dry) somewhere on the line. Task 14 derives the kinds from the voxels.
+    const seen = { land: 0, sea: 0, lake: 0, river: 0 };
     for (let x = 16 * site.cx0; x < 16 * (site.cx0 + site.w); x++) {
       if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), site.z >> 4, s);
       const kind = positionKind(s, x, site.z);
-      expect(wetAt(view, x, site.z), `(${x}, ${site.z}) is ${kind}`).toBe(kind !== 'land');
+      const wet = wetAt(view, x, site.z);
+      if (wet) expect(readLevel(s, 'surfaceWaterLevel', x, site.z), `(${x}, ${site.z}) is wet`).not.toBe(-Infinity);
+      if (wet === (kind !== 'land')) seen[kind]++;
       const top = view.worldSurfaceWG(x, site.z) - 1;
       const floor = view.oceanFloorWG(x, site.z) - 1;
       expect(top, `(${x}, ${site.z}) top ${top} above the crop`).toBeLessThanOrEqual(site.yMax);
@@ -73,6 +79,7 @@ describe('vertical review slices over the generated voxels', () => {
       if (kind === 'lake' && fluidType(view.fluid(x, top, site.z)) !== 0 && top > 63) lakeAbove63++;
       expect(view.block(x, -64, site.z)).toBe(BEDROCK);
     }
+    for (const k of site.needs) expect(seen[k], `${site.name}: ${k} on the voxels`).toBeGreaterThan(0);
     if (site.needs.includes('lake')) expect(lakeAbove63).toBeGreaterThan(0);
   });
 
@@ -110,8 +117,8 @@ describe('vertical review slices over the generated voxels', () => {
       expect(written!.path).toBe(join(dir, 'small.png'));
       const bytes = readFileSync(written!.path);
       expect(new Uint8Array(bytes)).toEqual(new Uint8Array(encodePng(renderSite(await generateSite('42', params, site), site))));
-      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 192]);
-      expect([written!.width, written!.height, written!.bytes]).toEqual([64, 192, bytes.length]);
+      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 224]);
+      expect([written!.width, written!.height, written!.bytes]).toEqual([64, 224, bytes.length]);
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
```

Modify `test/unit/sliceJob.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/sliceJob.test.ts b/test/unit/sliceJob.test.ts
index 998aa3a..725e016 100644
--- a/test/unit/sliceJob.test.ts
+++ b/test/unit/sliceJob.test.ts
@@ -181,14 +181,21 @@ describe('slice job: abort (SP3a spec §5.1)', () => {
     const job = createSliceJob();
     const cols = columnsOf(COAST);
     expect(cols.length).toBeGreaterThanOrEqual(3);
-    // Column 0: 1 job poll + 24 section polls; column 1: 1 + 24; column 2: its job poll, then section polls: stop at the 5th.
+    // Column 0: 1 job poll + 6 density polls + 24 section polls; column 1: 1 + 30; column 2: its job poll, then the
+    // stage's polls: stop at the 5th (in the density phase) …
     let calls = 0;
-    expect(job.run(ctx, 0, COAST, () => ++calls > 2 * 25 + 1 + 4)).toBeNull();
+    expect(job.run(ctx, 0, COAST, () => ++calls > 2 * 31 + 1 + 4)).toBeNull();
     const store = job.store!;
     expect(job.resident()).toEqual(cols.slice(0, 2));
     expect(store.table.find(cols[2]![0], cols[2]![1])).toBe(-1);
     // Live slots are those of the two resident columns: the same as a store holding just them.
     expect(live(store)).toEqual(liveOf(cols.slice(0, 2)));
+    // … or in its section phase (before its 5th section): the same.
+    const late = createSliceJob();
+    let lateCalls = 0;
+    expect(late.run(ctx, 0, COAST, () => ++lateCalls > 2 * 31 + 1 + 6 + 4)).toBeNull();
+    expect(late.resident()).toEqual(cols.slice(0, 2));
+    expect(live(late.store!)).toEqual(liveOf(cols.slice(0, 2)));
     // A stop before the first column generates nothing.
     const fresh = createSliceJob();
     expect(fresh.run(ctx, 0, COAST, () => true)).toBeNull();
```

Modify `test/unit/stage.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/stage.test.ts b/test/unit/stage.test.ts
index 867de0e..8e9eb9f 100644
--- a/test/unit/stage.test.ts
+++ b/test/unit/stage.test.ts
@@ -15,7 +15,7 @@ describe('registry', () => {
   test('the SP2a schema and stage list satisfy every invariant', () => {
     expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
     expect(ALL).toEqual(['climate', 'shape', 'surfaceEst', 'biome2d', 'terrain', 'decorate', 'light', 'mesh', 'lod', 'map']);
-    expect(STAGES.map((s) => `${s.id}@${s.version}`)).toEqual(['climate@1', 'shape@2', 'surfaceEst@2', 'biome2d@2', 'terrain@1', 'decorate@1', 'light@1', 'mesh@1', 'lod@1', 'map@2']);
+    expect(STAGES.map((s) => `${s.id}@${s.version}`)).toEqual(['climate@1', 'shape@2', 'surfaceEst@2', 'biome2d@2', 'terrain@2', 'decorate@1', 'light@1', 'mesh@1', 'lod@1', 'map@2']);
   });
   test('prefixes match on dot boundaries', () => {
     expect(prefixCovers('climate', 'climate.C')).toBe(true);
```

Modify `test/unit/terrainStage.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/terrainStage.test.ts b/test/unit/terrainStage.test.ts
index d172df9..01569e1 100644
--- a/test/unit/terrainStage.test.ts
+++ b/test/unit/terrainStage.test.ts
@@ -1,8 +1,11 @@
 import { describe, expect, test } from 'vitest';
+import type { ParamsPatch } from '../../src/core/params/schema';
 import {
   buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, readLevel, type ColumnSample,
 } from '../../src/gen/column/columnStage';
 import type { GenContext } from '../../src/gen/context';
+import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
+import { probe } from '../../src/gen/density/probe';
 import { terrainStage } from '../../src/gen/pipeline/terrainStage';
 import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
 import { AIR, BEDROCK, COLLIDE, STONE } from '../../src/world/blocks/index';
@@ -16,145 +19,229 @@ const MiB = 1 << 20;
 const NEVER = () => false;
 
 /**
- * Columns of world seed '42' (default profile) found by a scan: every position of LAND is dry, every position of
- * SEA is open ocean, LAKE lies inside one lake, RIVER crosses a wet river channel next to dry land, COAST mixes sea
- * and land. The category tests below re-derive the categories, so a world change fails loudly here.
+ * Columns of world seed '42' (default profile) on the row cz −2000, found by scans: LAND is dry land, SEA open ocean,
+ * LAKE inside one lake, RIVER crosses a wet river channel, COAST mixes sea and land (SP3a's fixtures); OVERHANG holds
+ * water under stone near the water line and WALL water walls (§4) on the real T. The tests below re-derive what they
+ * rely on, so a world change fails loudly here.
  */
 const LAND = [-1963, -2000] as const;
 const SEA = [-2000, -2000] as const;
 const LAKE = [-1001, -2000] as const;
 const RIVER = [-742, -2000] as const;
 const COAST = [-1667, -2000] as const;
+const OVERHANG = [-1238, -2000] as const;
+const WALL = [-1689, -2000] as const;
+const FIXTURES = [['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST], ['overhang', OVERHANG], ['wall', WALL]] as const;
 
-type Kind = 'land' | 'sea' | 'lake' | 'river';
+/** A shape spline that is `y` everywhere. */
+const flat = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });
 
-interface Expected { top: Int32Array; swl: Float64Array; kinds: Kind[]; biome: Uint8Array }
+const ctx = ctxFor('42');
+/** An extreme but valid shape (σ 40 everywhere): enclosed air far below the water line under the sea. */
+const ctx40 = ctxFor('42', { shape: { sigma: flat(40) } });
+/** §3.2: σ and jag splines at 0, both detail amplitudes at 0. */
+const REDUCED: ParamsPatch = { shape: { sigma: flat(0), jag: flat(0) }, density: { detailAmpLo: 0, detailAmpHi: 0 } };
+const ctxReduced = ctxFor('42', REDUCED);
+
+const DCS = new Map<GenContext, DensityContext>();
+const dcOf = (c: GenContext): DensityContext => {
+  let dc = DCS.get(c);
+  if (dc === undefined) DCS.set(c, (dc = createDensityContext(c)));
+  return dc;
+};
 
-/** The §4 inputs per position `lz·16 + lx`, read from the ColumnSample independently of the stage. */
-function expectedOf(ctx: GenContext, cx: number, cz: number): Expected {
-  const s: ColumnSample = buildColumnSample(ctx, cx, cz, newColumnSample());
-  const top = new Int32Array(256);
+/** Voxel index `((y + 64)·16 + lz)·16 + lx`. */
+const vi = (lx: number, y: number, lz: number): number => ((y + 64) * 16 + lz) * 16 + lx;
+
+interface Expected {
+  readonly s: ColumnSample;
+  readonly blocks: Uint16Array;
+  readonly fluid: Uint8Array;
+  /** Per position `lz·16 + lx`: the highest stone y (−64 when none), and surfaceWaterLevel (nearest corner). */
+  readonly top: Int32Array;
+  readonly swl: Float64Array;
+}
+
+/** §4 from the probe (no early-outs), independently of the stage: fill, `top` and the water v0 rule. */
+function expectedOf(c: GenContext, cx: number, cz: number): Expected {
+  const dc = dcOf(c);
+  const s = buildColumnSample(c, cx, cz, newColumnSample());
+  const blocks = new Uint16Array(98304);
+  const fluid = new Uint8Array(98304);
+  const top = new Int32Array(256).fill(-64);
   const swl = new Float64Array(256);
-  const biome = new Uint8Array(256);
-  const kinds: Kind[] = [];
   for (let lz = 0; lz < 16; lz++) {
     for (let lx = 0; lx < 16; lx++) {
       const x = 16 * cx + lx;
       const z = 16 * cz + lz;
-      const p = lz * 16 + lx;
-      top[p] = Math.floor(readField(s, 'surfaceEst', x, z));
-      swl[p] = readLevel(s, 'surfaceWaterLevel', x, z);
-      biome[p] = readBiome(s, ctx, x, z);
-      // The nearest quart corner, as readLevel picks it.
-      const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
-      const wet = (s.flags[k]! & 1) !== 0;
-      if (swl[p] === -Infinity) kinds.push('land');
-      else if (s.f.lakeMask[k] === 1) kinds.push('lake');
-      else if (wet) kinds.push('river');
-      else kinds.push('sea');
+      blocks[vi(lx, -64, lz)] = BEDROCK;
+      for (let y = -63; y <= 319; y++) {
+        const solid = probe(dc, x, y, z) > 0;
+        blocks[vi(lx, y, lz)] = solid ? STONE : AIR;
+        if (solid) top[lz * 16 + lx] = y;
+      }
+      swl[lz * 16 + lx] = readLevel(s, 'surfaceWaterLevel', x, z);
+    }
+  }
+  for (let p = 0; p < 256; p++) {
+    for (let y = -63; y <= 319; y++) {
+      const i = vi(p & 15, y, p >> 4);
+      if (blocks[i] === AIR && y > top[p]! - 12 && y <= swl[p]!) fluid[i] = WATER_SOURCE;
     }
   }
-  return { top, swl, kinds, biome };
+  return { s, blocks, fluid, top, swl };
 }
 
-/** §4's fill rule. */
-const blockAt = (top: number, y: number): number => (y === -64 ? BEDROCK : y <= top ? STONE : AIR);
-const fluidAt = (top: number, swl: number, y: number): number => (y !== -64 && y > top && y <= swl ? WATER_SOURCE : 0);
-
-function generate(ctx: GenContext, cx: number, cz: number, store: VoxelStore = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB })): { store: VoxelStore; view: ColumnView } {
+function generate(c: GenContext, cx: number, cz: number, store: VoxelStore = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB })): { store: VoxelStore; view: ColumnView } {
   const w = store.claimColumn(cx, cz, 0);
-  expect(terrainStage(ctx, cx, cz, w, NEVER)).toBe(true);
+  expect(terrainStage(c, cx, cz, w, NEVER)).toBe(true);
   w.commit(1);
   return { store, view: store.proto(cx, cz)! };
 }
 
-const ctx = ctxFor('42');
-
-describe('fill rule (§4)', () => {
-  test.each([
-    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST],
-  ] as const)('%s column: every voxel follows the rule', (_name, [cx, cz]) => {
-    const e = expectedOf(ctx, cx, cz);
-    const { view } = generate(ctx, cx, cz);
-    let bad = 0;
-    for (let lz = 0; lz < 16; lz++) {
-      for (let lx = 0; lx < 16; lx++) {
-        const p = lz * 16 + lx;
-        for (let y = -64; y <= 319; y++) {
-          if (view.block(lx, y, lz) !== blockAt(e.top[p]!, y) || view.fluid(lx, y, lz) !== fluidAt(e.top[p]!, e.swl[p]!, y)) bad++;
-        }
+/** Voxels where the view differs from the expected blocks or fluid. */
+function mismatches(view: ColumnView, e: Expected): number {
+  let bad = 0;
+  for (let lz = 0; lz < 16; lz++) {
+    for (let lx = 0; lx < 16; lx++) {
+      for (let y = -64; y <= 319; y++) {
+        const i = vi(lx, y, lz);
+        if (view.block(lx, y, lz) !== e.blocks[i] || view.fluid(lx, y, lz) !== e.fluid[i]) bad++;
       }
     }
-    expect(bad).toBe(0);
+  }
+  return bad;
+}
+
+const EXPECTED = new Map<string, Expected>();
+const expectedFor = (c: GenContext, [cx, cz]: readonly [number, number]): Expected => {
+  const key = `${c === ctx ? 'd' : c === ctx40 ? 's40' : 'r'}|${cx}|${cz}`;
+  let e = EXPECTED.get(key);
+  if (e === undefined) EXPECTED.set(key, (e = expectedOf(c, cx, cz)));
+  return e;
+};
+
+describe('fill and water v0 (§4)', () => {
+  test.each(FIXTURES)('%s: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule', (_name, col) => {
+    const e = expectedFor(ctx, col);
+    expect(mismatches(generate(ctx, col[0], col[1]).view, e)).toBe(0);
   });
 
-  test('land: dry everywhere, stone up to ⌊surfaceEst⌋, air above', () => {
-    const [cx, cz] = LAND;
-    const e = expectedOf(ctx, cx, cz);
-    expect(new Set(e.kinds)).toEqual(new Set(['land']));
-    const { view } = generate(ctx, cx, cz);
-    for (const p of [0, 17, 255]) {
-      const lx = p & 15, lz = p >> 4, t = e.top[p]!;
-      expect([view.block(lx, -64, lz), view.block(lx, t, lz), view.block(lx, t + 1, lz)]).toEqual([BEDROCK, STONE, AIR]);
-      expect(view.fluid(lx, t + 1, lz)).toBe(0);
+  test('σ 40 world: the sea and coast columns follow the rule too', () => {
+    for (const col of [SEA, COAST, OVERHANG]) expect(mismatches(generate(ctx40, col[0], col[1]).view, expectedFor(ctx40, col))).toBe(0);
+  });
+
+  test('the world\'s vertical ends: stone up to y 319 (offset 320, σ 64, jag 128) and a sea down to the floor (offset −64, σ 64) follow the rule, with their heightmaps', () => {
+    const ceiling = ctxFor('42', { shape: { offset: flat(320), sigma: flat(64), jag: flat(128) } });
+    const floor = ctxFor('42', { shape: { offset: flat(-64), sigma: flat(64) } });
+    let at319 = 0, deepWater = 0;
+    for (const [c, [cx, cz]] of [[ceiling, LAND], [ceiling, SEA], [floor, LAND], [floor, SEA]] as const) {
+      const e = expectedOf(c, cx, cz);
+      const { view } = generate(c, cx, cz);
+      expect(mismatches(view, e)).toBe(0);
+      const aux = view.aux()!;
+      for (let p = 0; p < 256; p++) {
+        const lx = p & 15, lz = p >> 4;
+        // WORLD_SURFACE_WG: above the highest non-air or water voxel (320 when it is stone at y 319); OCEAN_FLOOR_WG:
+        // above the highest stone (−63: the bedrock, when none).
+        let surface = -64;
+        for (let y = 319; y > -64; y--) {
+          if (e.blocks[vi(lx, y, lz)] !== AIR || e.fluid[vi(lx, y, lz)] !== 0) { surface = y; break; }
+        }
+        expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([surface + 1, e.top[p]! + 1]);
+        if (e.top[p] === 319) at319++;
+        for (let y = -63; y <= -40; y++) if (e.fluid[vi(lx, y, lz)] !== 0) deepWater++;
+      }
     }
+    // Both ends are reached: stone in the top row (no row above it to clip), and water within 24 blocks of the bedrock.
+    expect(at319).toBeGreaterThan(64);
+    expect(deepWater).toBeGreaterThan(256);
   });
 
-  test('sea: water sources from ⌊surfaceEst⌋ + 1 up to sea level 63, air above', () => {
-    const [cx, cz] = SEA;
-    const e = expectedOf(ctx, cx, cz);
-    expect(new Set(e.kinds)).toEqual(new Set(['sea']));
-    const { view } = generate(ctx, cx, cz);
+  test('air under an overhang near the water line fills', () => {
+    const e = expectedFor(ctx, OVERHANG);
+    const { view } = generate(ctx, ...OVERHANG);
+    let under = 0;
     for (let p = 0; p < 256; p++) {
-      const lx = p & 15, lz = p >> 4, t = e.top[p]!;
-      expect(e.swl[p]).toBe(63);
-      expect(t).toBeLessThan(63);
-      expect([view.block(lx, t, lz), view.fluid(lx, t, lz)]).toEqual([t === -64 ? BEDROCK : STONE, 0]);
-      expect([view.block(lx, t + 1, lz), view.fluid(lx, t + 1, lz)]).toEqual([AIR, WATER_SOURCE]);
-      expect([view.block(lx, 63, lz), view.fluid(lx, 63, lz)]).toEqual([AIR, WATER_SOURCE]);
-      expect([view.block(lx, 64, lz), view.fluid(lx, 64, lz)]).toEqual([AIR, 0]);
+      const lx = p & 15, lz = p >> 4;
+      for (let y = -63; y < e.top[p]!; y++) {
+        if (view.fluid(lx, y, lz) === 0) continue;
+        under++;
+        // Stone above it in its own position, and within 12 of the top.
+        expect(view.block(lx, y, lz)).toBe(AIR);
+        expect(y).toBeGreaterThan(e.top[p]! - 12);
+      }
     }
+    expect(under).toBeGreaterThan(0);
   });
 
-  test('lake: water up to the lake level (not sea level), dry land outside', () => {
-    const [cx, cz] = LAKE;
-    const e = expectedOf(ctx, cx, cz);
-    expect(e.kinds.every((k) => k === 'lake')).toBe(true);
-    const { view } = generate(ctx, cx, cz);
-    let wetCells = 0;
+  test('deeper enclosed air stays dry (σ 40 sea): air at y ≤ top − 12 below the water level holds no water', () => {
+    const e = expectedFor(ctx40, SEA);
+    const { view } = generate(ctx40, ...SEA);
+    let pockets = 0;
     for (let p = 0; p < 256; p++) {
-      const lx = p & 15, lz = p >> 4, t = e.top[p]!, w = Math.floor(e.swl[p]!);
-      expect(w).not.toBe(63);
-      if (w <= t) continue;
-      wetCells++;
-      expect(view.fluid(lx, w, lz)).toBe(WATER_SOURCE);
-      expect(view.fluid(lx, w + 1, lz)).toBe(0);
+      const lx = p & 15, lz = p >> 4;
+      for (let y = -63; y <= e.top[p]! - 12; y++) {
+        if (view.block(lx, y, lz) !== AIR || y > e.swl[p]!) continue;
+        pockets++;
+        expect(view.fluid(lx, y, lz)).toBe(0);
+      }
     }
-    expect(wetCells).toBeGreaterThan(0);
+    expect(pockets).toBeGreaterThan(0);
   });
 
-  test('river: wet channel positions hold water up to 63, beside dry land', () => {
-    const [cx, cz] = RIVER;
-    const e = expectedOf(ctx, cx, cz);
-    expect(e.kinds).toContain('land');
-    const { view } = generate(ctx, cx, cz);
-    let channel = 0;
+  test('water walls: water beside a dry position whose own level is −∞ and whose top is below the water', () => {
+    const e = expectedFor(ctx, WALL);
+    const { view } = generate(ctx, ...WALL);
+    let walls = 0;
     for (let p = 0; p < 256; p++) {
-      if (e.kinds[p] !== 'river' || e.top[p]! >= 63) continue;
-      channel++;
       const lx = p & 15, lz = p >> 4;
-      expect([view.fluid(lx, 63, lz), view.fluid(lx, 64, lz), view.fluid(lx, e.top[p]!, lz)]).toEqual([WATER_SOURCE, 0, 0]);
+      for (let y = -63; y <= 319; y++) {
+        if (view.fluid(lx, y, lz) === 0) continue;
+        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
+          const nx = lx + dx, nz = lz + dz;
+          if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
+          const q = nz * 16 + nx;
+          if (view.block(nx, y, nz) === AIR && view.fluid(nx, y, nz) === 0 && e.swl[q] === -Infinity && e.top[q]! < y) walls++;
+        }
+      }
     }
-    expect(channel).toBeGreaterThan(0);
+    expect(walls).toBeGreaterThan(0);
   });
 });
 
-describe('aux A (§3.4, §4)', () => {
-  test.each([
-    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST],
-  ] as const)('%s: heightmaps by the §3.4 predicates, surfaceBiome = the zoomed biome, other fields 0', (_name, [cx, cz]) => {
-    const e = expectedOf(ctx, cx, cz);
-    const { store, view } = generate(ctx, cx, cz);
+describe('reduction to SP3a (§3.2)', () => {
+  test.each([['land', LAND], ['sea', SEA], ['lake', LAKE], ['coast', COAST], ['overhang', OVERHANG]] as const)(
+    '%s: with σ, jag and detail at 0 the column is SP3a\'s y ≤ ⌊surfaceEst⌋ fill', (_name, [cx, cz]) => {
+      const s = buildColumnSample(ctxReduced, cx, cz, newColumnSample());
+      // Away from river channels (rivers hard-code σ 0.5 there): every corner column's σ and jag is 0.
+      for (let j = 0; j <= 4; j++) {
+        for (let i = 0; i <= 4; i++) expect([s.f.sigma[latticeIndex(i, j)], s.f.jag[latticeIndex(i, j)]]).toEqual([0, 0]);
+      }
+      const { view } = generate(ctxReduced, cx, cz);
+      let nearInteger = 0;
+      let bad = 0;
+      for (let lz = 0; lz < 16; lz++) {
+        for (let lx = 0; lx < 16; lx++) {
+          const est = readField(s, 'surfaceEst', 16 * cx + lx, 16 * cz + lz);
+          if (Math.abs(est - Math.round(est)) < 1e-9) { nearInteger++; continue; }
+          const top = Math.floor(est);
+          const swl = readLevel(s, 'surfaceWaterLevel', 16 * cx + lx, 16 * cz + lz);
+          for (let y = -64; y <= 319; y++) {
+            const block = y === -64 ? BEDROCK : y <= top ? STONE : AIR;
+            const fluid = y !== -64 && y > top && y <= swl ? WATER_SOURCE : 0;
+            if (view.block(lx, y, lz) !== block || view.fluid(lx, y, lz) !== fluid) bad++;
+          }
+        }
+      }
+      expect([nearInteger, bad]).toEqual([0, 0]);
+    });
+});
+
+describe('aux A (SP3a §3.4, §4)', () => {
+  test.each(FIXTURES)('%s: heightmaps by the §3.4 predicates, surfaceBiome = the zoomed biome, other fields 0', (_name, [cx, cz]) => {
+    const e = expectedFor(ctx, [cx, cz]);
+    const { view } = generate(ctx, cx, cz);
     const aux = view.aux()!;
     for (let p = 0; p < 256; p++) {
       const lx = p & 15, lz = p >> 4;
@@ -165,72 +252,76 @@ describe('aux A (§3.4, §4)', () => {
         if (of === -64 && COLLIDE[b] !== 0) of = y + 1;
       }
       expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([ws, of]);
-      // §4: land both ⌊surfaceEst⌋ + 1; under water the top water y + 1 and ⌊surfaceEst⌋ + 1.
-      const t = e.top[p]!;
-      const wet = Math.floor(e.swl[p]!) > t;
-      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([wet ? Math.floor(e.swl[p]!) + 1 : t + 1, t + 1]);
-      expect(aux.surfaceBiome[p]).toBe(e.biome[p]);
+      expect(aux.oceanFloorWG[p]).toBe(e.top[p]! + 1);
+      expect(aux.surfaceBiome[p]).toBe(readBiome(e.s, ctx, 16 * cx + lx, 16 * cz + lz));
     }
     for (const f of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking', 'tintTH'] as const) {
       expect(aux[f].every((v) => v === 0)).toBe(true);
     }
-    expect(store.table.ints[store.table.find(cx, cz) + REC_AUX_B]).toBe(-1);
+  });
+});
+
+describe('aux B (§4)', () => {
+  test('surfaceBiomeQ[qz·4 + qx] is lattice point (qx, qz)\'s 2D biome; caveBiomeQ and the rest of the slot are 0', () => {
+    let asymmetric = 0;
+    for (const [, [cx, cz]] of FIXTURES) {
+      const { store, view } = generate(ctx, cx, cz);
+      expect(store.table.ints[store.table.find(cx, cz) + REC_AUX_B]).toBeGreaterThanOrEqual(0);
+      const b = view.auxB()!;
+      const s = buildColumnSample(ctx, cx, cz, newColumnSample());
+      for (let qz = 0; qz < 4; qz++) {
+        for (let qx = 0; qx < 4; qx++) {
+          expect(b.surfaceBiomeQ[qz * 4 + qx]).toBe(s.biome[latticeIndex(qx, qz)]);
+          if (s.biome[latticeIndex(qx, qz)] !== s.biome[latticeIndex(qz, qx)]) asymmetric++;
+        }
+      }
+      const slot = new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096);
+      let nonZero = 0;
+      for (let i = 0; i < 4096; i++) if ((i < 1536 || i >= 1552) && slot[i] !== 0) nonZero++;
+      expect(nonZero).toBe(0);
+    }
+    // Some fixture's quarts are not symmetric, so the test pins qz·4 + qx against qx·4 + qz.
+    expect(asymmetric).toBeGreaterThan(0);
   });
 });
 
 describe('sections (§4: each channel uniform or dense)', () => {
-  test.each([
-    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['coast', COAST],
-  ] as const)('%s: a channel is uniform exactly when all its 4096 values are equal', (_name, [cx, cz]) => {
-    const e = expectedOf(ctx, cx, cz);
-    const { store } = generate(ctx, cx, cz);
-    const base = store.table.find(cx, cz);
+  test.each(FIXTURES)('%s: a channel is uniform exactly when all its 4096 values are equal', (_name, col) => {
+    const e = expectedFor(ctx, col);
+    const { store } = generate(ctx, col[0], col[1]);
+    const base = store.table.find(col[0], col[1]);
     const ints = store.table.ints;
-    let uniformBlocks = 0, uniformFluid = 0;
     for (let sy = 0; sy < 24; sy++) {
-      const blocks = new Set<number>();
-      const fluid = new Set<number>();
-      for (let ly = 0; ly < 16; ly++) {
-        const y = -64 + 16 * sy + ly;
-        for (let p = 0; p < 256; p++) {
-          blocks.add(blockAt(e.top[p]!, y));
-          fluid.add(fluidAt(e.top[p]!, e.swl[p]!, y));
-        }
-      }
+      const blocks = new Set(e.blocks.subarray(4096 * sy, 4096 * (sy + 1)));
+      const fluid = new Set(e.fluid.subarray(4096 * sy, 4096 * (sy + 1)));
       const b = ints[protoAt(base, sy) + PROTO_BLOCKS]!;
       const f = ints[protoAt(base, sy) + PROTO_FLUID]!;
-      if (blocks.size === 1) { uniformBlocks++; expect(b).toBe(-1 - [...blocks][0]!); } else expect(b).toBeGreaterThanOrEqual(0);
-      if (fluid.size === 1) { uniformFluid++; expect(f).toBe(-1 - [...fluid][0]!); } else expect(f).toBeGreaterThanOrEqual(0);
+      if (blocks.size === 1) expect(b).toBe(-1 - [...blocks][0]!); else expect(b).toBeGreaterThanOrEqual(0);
+      if (fluid.size === 1) expect(f).toBe(-1 - [...fluid][0]!); else expect(f).toBeGreaterThanOrEqual(0);
     }
     // Section 0 holds bedrock and stone (dense); the top section is uniform air without fluid.
     expect(ints[protoAt(base, 0) + PROTO_BLOCKS]).toBeGreaterThanOrEqual(0);
     expect([ints[protoAt(base, 23) + PROTO_BLOCKS], ints[protoAt(base, 23) + PROTO_FLUID]]).toEqual([-1, -1]);
-    expect(uniformBlocks).toBeGreaterThan(10);
-    expect(uniformFluid).toBeGreaterThan(10);
   });
 
-  test('a full stone section costs no slot (uniform stone, −1 − STONE)', () => {
-    const [cx, cz] = LAND;
-    const { store } = generate(ctx, cx, cz);
-    expect(store.table.ints[protoAt(store.table.find(cx, cz), 1) + PROTO_BLOCKS]).toBe(-1 - STONE);
-  });
-
-  test('a full water section of the deep sea costs no slot (air, uniform fluid −1 − WATER_SOURCE)', () => {
-    const [cx, cz] = SEA;
-    const { store } = generate(ctx, cx, cz);
-    const at = protoAt(store.table.find(cx, cz), 7);
-    expect([store.table.ints[at + PROTO_BLOCKS], store.table.ints[at + PROTO_FLUID]]).toEqual([-1 - AIR, -1 - WATER_SOURCE]);
+  test('a full stone section and a full water section of the deep sea cost no slot', () => {
+    const land = generate(ctx, ...LAND).store;
+    expect(land.table.ints[protoAt(land.table.find(...LAND), 1) + PROTO_BLOCKS]).toBe(-1 - STONE);
+    const sea = generate(ctx, ...SEA).store;
+    const at = protoAt(sea.table.find(...SEA), 7);
+    expect([sea.table.ints[at + PROTO_BLOCKS], sea.table.ints[at + PROTO_FLUID]]).toEqual([-1 - AIR, -1 - WATER_SOURCE]);
   });
 });
 
 /** A writer that records the calls (no store). */
-function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; commits: number } {
-  const log = { sections: [] as number[], aux: 0, commits: 0 };
+function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; auxB: number; commits: number } {
+  const log = { sections: [] as number[], aux: 0, auxB: 0, commits: 0 };
   const auxView: AuxView = {
     worldSurfaceWG: new Int16Array(256), oceanFloorWG: new Int16Array(256), worldSurface: new Int16Array(256),
     motionBlocking: new Int16Array(256), oceanFloor: new Int16Array(256), lightBlocking: new Int16Array(256),
     surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
   };
+  const auxBView: AuxBView = { caveBiomeQ: new Uint8Array(1536), surfaceBiomeQ: new Uint8Array(16) };
   const w: ColumnWriter = {
     cx: 0, cz: 0,
     setProto(sy, blocks, fluid) {
@@ -240,38 +331,56 @@ function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; commit
     setFinal() { throw new Error('the T stage writes no final set'); },
     shareFinal() { throw new Error('the T stage writes no final set'); },
     aux() { log.aux++; return auxView; },
-    auxB(): AuxBView { throw new Error('SP3a allocates no aux B'); },
+    auxB() { log.auxB++; return auxBView; },
     commit() { log.commits++; },
   };
-  return { w, get sections() { return log.sections; }, get aux() { return log.aux; }, get commits() { return log.commits; } };
+  return {
+    w, get sections() { return log.sections; }, get aux() { return log.aux; }, get auxB() { return log.auxB; },
+    get commits() { return log.commits; },
+  };
 }
 
 describe('order and abort (§4)', () => {
-  test('sections 0 … 23 in order, stop polled once before each, then aux; the stage never commits', () => {
+  test('6 density polls, then sections 0 … 23 in order with a poll before each, then aux A and aux B; never commits', () => {
     const spy = spyWriter();
-    let polls = 0;
-    expect(terrainStage(ctx, 3, -2, spy.w, () => { polls++; return false; })).toBe(true);
+    const at: number[] = [];
+    expect(terrainStage(ctx, 3, -2, spy.w, () => { at.push(spy.sections.length); return false; })).toBe(true);
     expect(spy.sections).toEqual(Array.from({ length: 24 }, (_, i) => i));
-    expect(polls).toBe(24);
-    expect([spy.aux, spy.commits]).toEqual([1, 0]);
+    // No section is written during the density phase: the first 7 polls see none.
+    expect(at).toEqual([0, 0, 0, 0, 0, 0, ...Array.from({ length: 24 }, (_, i) => i)]);
+    expect([spy.aux, spy.auxB, spy.commits]).toEqual([1, 1, 0]);
   });
 
-  test.each([0, 1, 7, 23])('stop true before section %i: returns false at once, no aux, no commit', (k) => {
+  test.each([0, 1, 5, 6, 7, 13, 29])('stop true at poll %i: returns false at once, no aux, no commit', (k) => {
     const spy = spyWriter();
     let polls = 0;
     expect(terrainStage(ctx, 3, -2, spy.w, () => ++polls > k)).toBe(false);
-    expect(spy.sections).toEqual(Array.from({ length: k }, (_, i) => i));
+    expect(spy.sections).toEqual(Array.from({ length: Math.max(0, k - 6) }, (_, i) => i));
     expect(polls).toBe(k + 1);
-    expect([spy.aux, spy.commits]).toEqual([0, 0]);
+    expect([spy.aux, spy.auxB, spy.commits]).toEqual([0, 0, 0]);
+  });
+
+  test('a stop in the density phase leaves no trace: the next column is generated as if alone', () => {
+    let polls = 0;
+    expect(terrainStage(ctx, ...OVERHANG, spyWriter().w, () => ++polls > 3)).toBe(false);
+    expect(mismatches(generate(ctx, ...COAST).view, expectedFor(ctx, COAST))).toBe(0);
   });
 
-  test('deterministic: the same column twice gives the same voxels and aux', () => {
+  test('deterministic, and one DensityContext per GenContext: interleaved contexts do not disturb each other', () => {
     const a = generate(ctx, ...COAST).view;
+    const other = generate(ctx40, ...COAST).view;
     const b = generate(ctx, ...COAST).view;
+    const fresh = generate(ctxFor('42'), ...COAST).view;
+    let differs = 0;
     for (let sy = 0; sy < 24; sy++) {
       expect(a.sectionBlocks(sy)).toEqual(b.sectionBlocks(sy));
       expect(a.sectionFluid(sy)).toEqual(b.sectionFluid(sy));
+      expect(fresh.sectionBlocks(sy)).toEqual(a.sectionBlocks(sy));
+      const x = other.sectionBlocks(sy), y = a.sectionBlocks(sy);
+      if (typeof x !== typeof y || (typeof x === 'number' ? x !== y : !(x as Uint16Array).every((v, i) => v === (y as Uint16Array)[i]))) differs++;
     }
+    expect(differs).toBeGreaterThan(0);
     expect(Array.from(a.aux()!.worldSurfaceWG)).toEqual(Array.from(b.aux()!.worldSurfaceWG));
+    expect(Array.from(a.auxB()!.surfaceBiomeQ)).toEqual(Array.from(b.auxB()!.surfaceBiomeQ));
   });
 });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project integration --project metrics-fast --project unit test/integration/region.test.ts test/metrics/region.metric.ts test/unit/region.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/unit/reviewSlices.test.ts test/unit/sliceJob.test.ts test/unit/stage.test.ts test/unit/terrainStage.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× the SP2a schema and stage list satisfy every invariant 6ms
× aux B: an absent slot equals a zero one; a differing byte is named (SP3b spec §7) 16ms
× a miss generates and writes the dump; a hit rebuilds the same region through the writer API 55ms
× abort at poll 29: false, the record is free and no slot leaks 7ms
× coast: equals FNV-1a 64 over the §6.2 byte stream 141ms
× deep sea: equals FNV-1a 64 over the §6.2 byte stream 28ms
× aux B (SP3b spec §7): every byte of the slot counts; an absent slot hashes like a zero-filled one 6ms
× land: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 83ms
× sea: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 40ms
× lake: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 35ms
× river: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 32ms
× coast: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 50ms
× overhang: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 62ms
× wall: every voxel is bedrock at −64, stone ⇔ density > 0, water by the v0 rule 69ms
… (102 more lines)
Test Files  7 failed | 2 passed (9)
Tests  41 failed | 120 passed | 1 skipped (162)
```

- [ ] **Step 3: Implement**

Modify `src/core/constants.ts` (apply with `git apply`):

```diff
diff --git a/src/core/constants.ts b/src/core/constants.ts
index e0f3b3c..ccf7fd5 100644
--- a/src/core/constants.ts
+++ b/src/core/constants.ts
@@ -1,5 +1,5 @@
 /** Bumped whenever generated output changes; goldens and saves are bound to it (§6.2). */
-export const GENERATOR_VERSION = 3;
+export const GENERATOR_VERSION = 4;
 
 /** World geometry (master §2.1): lowest block y, world height and sea level. */
 export const MIN_Y = -64;
```

Modify `src/core/stage/registry.ts` (apply with `git apply`):

```diff
diff --git a/src/core/stage/registry.ts b/src/core/stage/registry.ts
index 33a8788..4549362 100644
--- a/src/core/stage/registry.ts
+++ b/src/core/stage/registry.ts
@@ -17,7 +17,7 @@ export const STAGES: readonly StageDef[] = [
   { id: 'shape', version: 2, reads: ['climate'], params: ['shape', 'rivers', 'lakes'], checkpoint: 'columnSample' },
   { id: 'surfaceEst', version: 2, reads: ['shape'], params: [], checkpoint: 'columnSample' },
   { id: 'biome2d', version: 2, reads: ['climate', 'shape', 'surfaceEst'], params: ['biomes'], checkpoint: 'columnSample' },
-  { id: 'terrain', version: 1, reads: ['shape', 'surfaceEst', 'biome2d'], params: ['density'], checkpoint: 'proto' },
+  { id: 'terrain', version: 2, reads: ['shape', 'surfaceEst', 'biome2d'], params: ['density'], checkpoint: 'proto' },
   { id: 'decorate', version: 1, reads: ['terrain'], params: [], checkpoint: 'final' },
   { id: 'light', version: 1, reads: ['decorate'], params: [], checkpoint: 'none' },
   { id: 'mesh', version: 1, reads: ['light'], params: [], checkpoint: 'none' },
```

Modify `src/gen/pipeline/terrainStage.ts` (apply with `git apply`):

```diff
diff --git a/src/gen/pipeline/terrainStage.ts b/src/gen/pipeline/terrainStage.ts
index 68a6a37..a472a51 100644
--- a/src/gen/pipeline/terrainStage.ts
+++ b/src/gen/pipeline/terrainStage.ts
@@ -1,19 +1,28 @@
 /**
- * The provisional T stage (SP3a spec §4): fills a column's proto set from today's 2D world, through the store API.
- * Per block position, from the column's ColumnSample: `surfaceEst` (still `offset`, bilinear readout) and
- * `surfaceWaterLevel` (nearest-corner readout). From the bottom: y = −64 bedrock; y ≤ ⌊surfaceEst⌋ stone;
- * ⌊surfaceEst⌋ < y ≤ surfaceWaterLevel air with a water source; above, air. This is master §10's v0 water rule in
- * a world without overhangs. Sections 0 … 23 go to `setProto` in order (the store keeps each channel uniform or
- * dense); `stop()` is polled before each section and on true the stage returns false at once, without aux.
- * Then aux A: `worldSurfaceWG`, `oceanFloorWG` (§3.4 predicates) and `surfaceBiome` (the zoomed biome). SP3b
- * replaces this fill with the density terrain.
+ * The T stage (SP3b spec §4): fills a column's proto set with the density terrain, through the store API.
+ * - Density phase: the column's ColumnSample, then `fillDensityColumn` (columnFn, positionFn, then the 48 cell layers
+ *   bottom up with bounds and early-outs) into a column-wide solidity scratch; `stop()` is polled before every 8 cell
+ *   layers (6 polls). No section is written in this phase: water needs the whole column's `top`.
+ * - Fill: y = −64 bedrock; otherwise density > 0 stone, anything else air.
+ * - Water v0: `top` is the y of the highest stone voxel per position (−64 when there is none above bedrock); air with
+ *   `top − 12 < y ≤ surfaceWaterLevel` (nearest quart corner, as SP3a) becomes a water source. Air under an overhang
+ *   near the water line fills; deeper enclosed air stays dry (aquifers, SP6). A position whose own level is −∞ stays
+ *   dry beside a neighbour's water (the v0 "water wall").
+ * - Sections 0 … 23 go to `setProto` in order (each channel uniform or dense), `stop()` before each (24 polls). On a
+ *   true `stop()` in either phase the stage returns false at once, without aux.
+ * - Aux A: `worldSurfaceWG`, `oceanFloorWG` (SP3a §3.4 predicates) and `surfaceBiome` (the zoomed biome).
+ * - Aux B: `surfaceBiomeQ[qz·4 + qx]` is the 2D biome of lattice point (qx, qz), qx, qz ∈ 0 … 3, before the zoom;
+ *   `caveBiomeQ[(qy·4 + qz)·4 + qx]` stays 0 (none) until SP6.
+ * The stage keeps one DensityContext per GenContext (module-level WeakMap). Follows the gen determinism rules.
  */
 import { MIN_Y } from '../../core/constants';
 import { WATER_SOURCE } from '../../world/blocks/fluid';
 import { AIR, BEDROCK, STONE } from '../../world/blocks/index';
 import type { ColumnWriter as ColumnWriterT } from '../../world/store/api';
-import { buildColumnSample, newColumnSample, readBiome, readField, readLevel } from '../column/columnStage';
+import { buildColumnSample, latticeIndex, newColumnSample, readBiome, readLevel } from '../column/columnStage';
 import type { GenContext } from '../context';
+import { fillDensityColumn } from '../density/bounds';
+import { createDensityContext, type DensityContext } from '../density/context';
 
 const Y0 = MIN_Y;
 const WATER = WATER_SOURCE;
@@ -22,40 +31,63 @@ const STONE_ = STONE;
 const BEDROCK_ = BEDROCK;
 const BUILD = buildColumnSample;
 const NEW_SAMPLE = newColumnSample;
-const FIELD = readField;
+const LATTICE = latticeIndex;
 const LEVEL = readLevel;
 const BIOME = readBiome;
+const FILL = fillDensityColumn;
+const CREATE_DC = createDensityContext;
 
-/** Highest y of the world (MIN_Y + 384 − 1); tops are clamped to [Y0 − 1, TOP_Y], which changes no comparison. */
+/** Highest y of the world (MIN_Y + 384 − 1); water tops are clamped to [Y0 − 1, TOP_Y], which changes no comparison. */
 const TOP_Y = Y0 + 383;
+/** Water fills air down to `top − 12` exclusive (§4). */
+const WATER_DEPTH = 12;
 
 const SAMPLE = NEW_SAMPLE();
-/** Per column index `lz·16 + lx`: ⌊surfaceEst⌋ and ⌊surfaceWaterLevel⌋, clamped (−∞ becomes Y0 − 1). */
-const SOLID_TOP = new Int32Array(256);
+/** Solidity per voxel `((y + 64)·16 + lz)·16 + lx` (fillDensityColumn's order): section sy is 4096·sy … + 4095. */
+const SOLID = new Uint8Array(98304);
+/** Per column index `lz·16 + lx`: the highest stone y (Y0 when none) and ⌊surfaceWaterLevel⌋ (−∞ becomes Y0 − 1). */
+const TOP = new Int32Array(256);
 const WATER_TOP = new Int32Array(256);
 const BLOCKS = new Uint16Array(4096);
 const FLUID = new Uint8Array(4096);
 
+const DCS = new WeakMap<GenContext, DensityContext>();
+
+/** The stage's DensityContext for `ctx` (built on first use). */
+function densityContextOf(ctx: GenContext): DensityContext {
+  let dc = DCS.get(ctx);
+  if (dc === undefined) {
+    dc = CREATE_DC(ctx);
+    DCS.set(ctx, dc);
+  }
+  return dc;
+}
+
 const clampY = (v: number): number => Math.min(TOP_Y, Math.max(Y0 - 1, v));
 
 /**
- * Writes column (cx, cz)'s proto sections and aux A through `w`; false (nothing more written) as soon as `stop()`
- * returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
+ * Writes column (cx, cz)'s proto sections, aux A and aux B through `w`; false (nothing more written) as soon as
+ * `stop()` returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
  */
 export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriterT, stop: () => boolean): boolean {
+  const dc = densityContextOf(ctx);
   const s = BUILD(ctx, cx, cz, SAMPLE);
+  if (!FILL(dc.bounds, s, SOLID, null, null, stop)) return false;
   const x0 = 16 * cx;
   const z0 = 16 * cz;
-  for (let lz = 0; lz < 16; lz++) {
-    for (let lx = 0; lx < 16; lx++) {
-      const p = (lz << 4) | lx;
-      SOLID_TOP[p] = clampY(Math.floor(FIELD(s, 'surfaceEst', x0 + lx, z0 + lz)));
-      WATER_TOP[p] = clampY(Math.floor(LEVEL(s, 'surfaceWaterLevel', x0 + lx, z0 + lz)));
+  for (let p = 0; p < 256; p++) {
+    let top = Y0;
+    // From y 319 down to y −63 (index 256·(y + 64) + p); bedrock at Y0 is not stone.
+    for (let i = 98048 + p; i >= 256; i -= 256) {
+      if (SOLID[i] !== 0) { top = (i >> 8) + Y0; break; }
     }
+    TOP[p] = top;
+    WATER_TOP[p] = clampY(Math.floor(LEVEL(s, 'surfaceWaterLevel', x0 + (p & 15), z0 + (p >> 4))));
   }
   for (let sy = 0; sy < 24; sy++) {
     if (stop()) return false;
     const yBase = Y0 + 16 * sy;
+    const base = 4096 * sy;
     for (let ly = 0; ly < 16; ly++) {
       const y = yBase + ly;
       const row = ly << 8;
@@ -64,27 +96,30 @@ export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnW
         if (y === Y0) {
           BLOCKS[i] = BEDROCK_;
           FLUID[i] = 0;
-        } else if (y <= SOLID_TOP[p]!) {
+        } else if (SOLID[base + i] !== 0) {
           BLOCKS[i] = STONE_;
           FLUID[i] = 0;
         } else {
           BLOCKS[i] = AIR_;
-          FLUID[i] = y <= WATER_TOP[p]! ? WATER : 0;
+          FLUID[i] = y > TOP[p]! - WATER_DEPTH && y <= WATER_TOP[p]! ? WATER : 0;
         }
       }
     }
     w.setProto(sy, BLOCKS, FLUID);
   }
   const aux = w.aux();
-  for (let lz = 0; lz < 16; lz++) {
-    for (let lx = 0; lx < 16; lx++) {
-      const p = (lz << 4) | lx;
-      // Bedrock at Y0 is non-air and collides, so neither map is ever below Y0 + 1.
-      const floor = Math.max(Y0, SOLID_TOP[p]!);
-      aux.oceanFloorWG[p] = floor + 1;
-      aux.worldSurfaceWG[p] = Math.max(floor, WATER_TOP[p]!) + 1;
-      aux.surfaceBiome[p] = BIOME(s, ctx, x0 + lx, z0 + lz);
-    }
+  for (let p = 0; p < 256; p++) {
+    // OCEAN_FLOOR_WG: the highest colliding voxel is the highest stone, or the bedrock at Y0. WORLD_SURFACE_WG also
+    // counts water: when WATER_TOP > top, the air at WATER_TOP is above every stone and > top − 12, so it holds
+    // water; otherwise every water voxel lies below top. Both equal a top-down scan with the SP3a §3.4 predicates.
+    const top = TOP[p]!;
+    aux.oceanFloorWG[p] = top + 1;
+    aux.worldSurfaceWG[p] = Math.max(top, WATER_TOP[p]!) + 1;
+    aux.surfaceBiome[p] = BIOME(s, ctx, x0 + (p & 15), z0 + (p >> 4));
+  }
+  const q = w.auxB().surfaceBiomeQ;
+  for (let qz = 0; qz < 4; qz++) {
+    for (let qx = 0; qx < 4; qx++) q[qz * 4 + qx] = s.biome[LATTICE(qx, qz)]!;
   }
   return true;
 }
```

Modify `src/metrics/region.ts` (apply with `git apply`):

```diff
diff --git a/src/metrics/region.ts b/src/metrics/region.ts
index b8390b8..fbd9699 100644
--- a/src/metrics/region.ts
+++ b/src/metrics/region.ts
@@ -1,6 +1,6 @@
 /**
  * The region core (SP3a spec §6.1, §6.2), shared by the goldens, the slice job and the test harness (`src` never
- * imports `test/`): `fillColumnT` runs the provisional T stage on one claimed column, `genRegionInProcess` fills a
+ * imports `test/`): `fillColumnT` runs the T stage on one claimed column, `genRegionInProcess` fills a
  * region in process, and `regionHash` digests any generated window. Follows the core determinism rules
  * (in `DET_FILES`, arch-tested).
  */
@@ -24,7 +24,7 @@ function checkRegion(what: string, w: number, h: number): void {
 }
 
 /**
- * Claims (cx, cz) with `epoch`, runs the provisional T stage and commits it at status Proto; when `stop()` fires
+ * Claims (cx, cz) with `epoch`, runs the T stage and commits it at status Proto; when `stop()` fires
  * (or the stage throws) it frees the column instead, which releases the sections already written and leaves the
  * record free. True when the column was committed. Throws `SlotBusy` when the record is held.
  */
@@ -61,7 +61,8 @@ function hashWords(fnv: Fnv64T, a: Uint16Array): void {
 /**
  * FNV-1a 64 of the w × h window at (cx0, cz0) (SP3a spec §6.2): cz outer, cx inner; per column, for sy 0 … 23 the
  * 4096 proto block states (u16 little-endian, voxel-index order) then the 4096 proto fluid bytes (uniform sections
- * expanded, "no fluid" as 0), then the column's 4096 aux A bytes (zeros when it has none). Independent of
+ * expanded, "no fluid" as 0), then the column's 4096 aux A bytes and its 4096 aux B bytes (SP3b spec §7; each zeros
+ * when the column has no such slot, so an absent slot hashes like a zero-filled one). Independent of
  * generation order, thread count, backend and slot layout. Throws when a column of the window is not at
  * status ≥ Proto.
  */
@@ -84,6 +85,10 @@ export function regionHash(store: VoxelStore, cx0: number, cz0: number, w: numbe
       // The aux A fields tile the 4096-byte slot from worldSurfaceWG (offset 0) on; Int16 values are native LE.
       if (a === null) fnv.updateRepeatU8(0, 4096);
       else fnv.update(new Uint8Array(a.worldSurfaceWG.buffer, a.worldSurfaceWG.byteOffset, 4096));
+      const b = v.auxB();
+      // caveBiomeQ sits at offset 0 of the aux B slot, so a 4096-byte view from it is the whole slot.
+      if (b === null) fnv.updateRepeatU8(0, 4096);
+      else fnv.update(new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096));
     }
   }
   return fnv.digest();
```

Modify `src/metrics/sp3aGoldens.ts` (apply with `git apply`):

```diff
diff --git a/src/metrics/sp3aGoldens.ts b/src/metrics/sp3aGoldens.ts
index 90b0df4..4354b36 100644
--- a/src/metrics/sp3aGoldens.ts
+++ b/src/metrics/sp3aGoldens.ts
@@ -1,5 +1,6 @@
 /**
- * SP3a golden digests (SP3a spec §6.4): the block registry's first states and the provisional T region per profile.
+ * SP3a golden digests (SP3a spec §6.4): the block registry's first states and the T region per profile
+ * (the real T and aux B since GENERATOR_VERSION 4, SP3b spec §9).
  * Chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`), so the unit tests, `?selftest=1` and
  * `test/tools/goldensJsc.ts` all check them. Follows the core determinism rules (in `DET_FILES`, arch-tested).
  * Every value is hex64.
```

Modify `src/ui/crossSection/section.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/crossSection/section.ts b/src/ui/crossSection/section.ts
index 6714d85..c895d2e 100644
--- a/src/ui/crossSection/section.ts
+++ b/src/ui/crossSection/section.ts
@@ -87,7 +87,7 @@ const HINT = 'hover the plot to read a point';
 const VOXEL_HINT = 'hover the voxels to read a block';
 const MODE_LABELS: Readonly<Record<SectionMode, readonly [string, string]>> = {
   profile: ['Profile', 'The 2D shape along the line: offset, σ, water, rivers, gorges and jag'],
-  voxels: ['Voxels', 'The voxels of the vertical slice under the line (the provisional terrain stage)'],
+  voxels: ['Voxels', 'The voxels of the vertical slice under the line (the terrain stage)'],
 };
 const css = (c: Rgb): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
 
```

Modify `src/ui/crossSection/voxels.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/crossSection/voxels.ts b/src/ui/crossSection/voxels.ts
index 66b39dc..9df3363 100644
--- a/src/ui/crossSection/voxels.ts
+++ b/src/ui/crossSection/voxels.ts
@@ -55,7 +55,7 @@ const isWater = (state: number, fluid: number): boolean => state === AIR && flui
 /**
  * The slice as an RGBA image, 512 × 384, pixel (i, row) at `sliceIndex(i, y)` (row 0 is y 319). A water voxel's depth
  * counts from the top of its run of water in the sample column (the voxel under air or a block), which equals the
- * harness's `worldSurfaceWG − 1 − y` for the provisional T's columns (no overhangs).
+ * harness's `worldSurfaceWG − 1 − y` except under an overhang (SP3b's T fills air under stone near the water line).
  */
 export function sliceRgba(s: SliceResult): Uint8ClampedArray<ArrayBuffer> {
   const out = new Uint8ClampedArray(4 * SLICE_SAMPLES);
```

Modify `test/harness/region.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/region.ts b/test/harness/region.ts
index a6901da..90cb9b1 100644
--- a/test/harness/region.ts
+++ b/test/harness/region.ts
@@ -1,6 +1,6 @@
 /**
- * The region harness `genRegion` (SP3a spec §6.1): generates a w × h region of columns up to the provisional T
- * stage, in a chosen order, on 1 thread (a plain `ArrayBuffer` store, `fillColumnT` in process) or on 4
+ * The region harness `genRegion` (SP3a spec §6.1): generates a w × h region of columns up to the T stage
+ * (SP3b's density terrain), in a chosen order, on 1 thread (a plain `ArrayBuffer` store, `fillColumnT` in process) or on 4
  * `worker_threads` (a growable `SharedArrayBuffer` store; each worker runs `regionWorker.ts`, and the main thread
  * hands the next column of the list to whichever worker is idle, so every column is written by exactly one thread),
  * optionally through the region cache (`cache.ts`). The result is read through a `RegionView`, which reads the
```

Modify `test/harness/reviewSlices.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/reviewSlices.ts b/test/harness/reviewSlices.ts
index 3d27fe1..cf93cb3 100644
--- a/test/harness/reviewSlices.ts
+++ b/test/harness/reviewSlices.ts
@@ -87,7 +87,7 @@ const ROW_Z = 16 * ROW_CZ + 8;
  */
 export const REVIEW_SITES: readonly ReviewSite[] = [
   {
-    name: 'coast', file: 'slice-coast.png', kind: 'vertical', cx0: -1696, w: 64, z: ROW_Z, yMin: -64, yMax: 127, scale: 1,
+    name: 'coast', file: 'slice-coast.png', kind: 'vertical', cx0: -1696, w: 64, z: ROW_Z, yMin: -64, yMax: 159, scale: 1,
     needs: ['sea', 'land'],
   },
   {
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:goldens`

The command writes `test/goldens.json`; the dry run's result:

Modify `test/goldens.json` (apply with `git apply`):

```diff
diff --git a/test/goldens.json b/test/goldens.json
index 5584f5f..c94bf66 100644
--- a/test/goldens.json
+++ b/test/goldens.json
@@ -1,5 +1,5 @@
 {
-  "generatorVersion": 3,
+  "generatorVersion": 4,
   "entries": {
     "sp1.detMath.detCos": "feb91af46e2d5fa8",
     "sp1.detMath.detErf": "2e75e35244a19c1a",
@@ -23,7 +23,7 @@
     "sp1.noise.test.adv3d32": "a456079e4b571a2c",
     "sp1.noise.test.adv3d8": "439e4ef6ce852dd6",
     "sp1.noise.test.density3d": "127615bde2c54f3e",
-    "sp1.params": "9bed26417b2ca0fb",
+    "sp1.params": "948e09daacb25342",
     "sp1.spline.JAG": "445a1955b3113d35",
     "sp1.spline.OFFSET": "9d5ae62fbb06366d",
     "sp1.spline.SIGMA": "7163452d6496dba1",
@@ -48,8 +48,8 @@
     "sp2a.tile.rivers.256": "95bd582b209aa855",
     "sp2a.tile.rivers.4": "72f6d6c446d76cb2",
     "sp2a.tile.rivers.64": "6da7f75d7a9bfcaf",
-    "sp3a.region.T.default": "943479d09e0e89e3",
-    "sp3a.region.T.large_biomes": "e20fb4ebf0a5e9fc",
+    "sp3a.region.T.default": "9f8fcdbf6d77185d",
+    "sp3a.region.T.large_biomes": "6241e62b03b2888d",
     "sp3a.registry": "5e1febd88b449b63"
   }
 }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project integration --project metrics-fast --project unit test/integration/region.test.ts test/metrics/region.metric.ts test/unit/region.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/unit/reviewSlices.test.ts test/unit/sliceJob.test.ts test/unit/stage.test.ts test/unit/terrainStage.test.ts`

Expected: PASS (exit 0)

```
Test Files  9 passed (9)
Tests  161 passed | 1 skipped (162)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  130 passed | 2 skipped (132)
Tests  1737 passed | 3 skipped (1740)
```

- [ ] **Step 7: Commit**

```bash
git add src/core/constants.ts src/core/stage/registry.ts src/gen/pipeline/terrainStage.ts src/metrics/region.ts src/metrics/sp3aGoldens.ts src/ui/crossSection/section.ts src/ui/crossSection/voxels.ts test/goldens.json test/harness/region.ts test/harness/reviewSlices.ts test/integration/region.test.ts test/metrics/region.metric.ts test/unit/region.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/unit/reviewSlices.test.ts test/unit/sliceJob.test.ts test/unit/stage.test.ts test/unit/terrainStage.test.ts
git commit -F - <<'EOF'
feat(gen/pipeline): the real T stage from the density terrain; GENERATOR_VERSION 4

SP3b spec §4 (all but SP2a minor 5) and §3.2's reduction test:
- terrainStage: ColumnSample, then fillDensityColumn with bounds and
  early-outs (6 polls), fill (bedrock at -64, density > 0 stone, else air),
  water v0 (air with top - 12 < y <= surfaceWaterLevel), sections 0..23
  (24 polls), aux A (heightmaps, surfaceBiome) and, for the first time,
  aux B (surfaceBiomeQ[qz*4 + qx] = the quart's 2D biome; caveBiomeQ 0).
  One DensityContext per GenContext.
- regionHash appends each column's 4096 aux B bytes (zeros when absent).
- terrain stage version 2, GENERATOR_VERSION 4; goldens re-recorded:
  sp3a.region.T.default and .large_biomes, and sp1.params (its genKey
  hashes GENERATOR_VERSION).
- SP3a's provisional-fill tests replaced by the real-T tests (fill and
  water against the probe, water under an overhang, dry deep pockets,
  water walls, aux A/B, uniform sections, abort in both phases) and the
  §3.2 reduction to SP3a; slice, region, cache, harness and review-slice
  tests adapted to aux B and the 30 polls.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `7769cb2` on `dry/sp3a`; 19 files changed, 405 insertions(+), 206 deletions(-)):

Commit Task 8 on `dry/sp3b` (worktree `P/dry`, parent Task 7; 19 files, 379 insertions, 207 deletions). RED (the commit's 8 test files over the parent, in a throwaway worktree): 40 failed in 7 files (terrainStage ×30: fill/water against the probe, aux A, aux B, order/abort with 30 polls, the spy writer's aux B; region ×4: the §6.2 reference stream with aux B, the new aux-B hash case, abort at poll 29; integration region ×2: the re-recorded goldens; regionCache ×1 and regionHarness ×1: aux B slots; stage ×1: `terrain@2`; reviewSlices ×1: the coast crop's 224 rows), 0 `tsc -p tsconfig.test.json` errors. `sliceJob.test.ts` and the §3.2 reduction tests pass on the parent too (see below). GREEN: typecheck clean; `npm test` 130 files passed, 2 skipped; 1720 tests passed, 3 skipped (32.5-33.7 s wall); `GOVERNANCE_BASE=main` governance test passes; DT1 fast 1.7 s and quick 15.3 s, 0 mismatches; Bun check `50/50 match on Bun 1.4.2 (JavaScriptCore)` in 6.4 s. `npm run test:goldens` took 51 s (unit + metrics-quick, all green).

- Ruling (stage, `src/gen/pipeline/terrainStage.ts`): one `createDensityContext(ctx)` per GenContext in a module-level `WeakMap` (built on first use; the stage uses its `bounds`, not its ColumnCache). The ColumnSample is still built into the stage's module-level `SAMPLE` (not through the DensityContext's ColumnCache), and the density phase is exactly Task 5's `fillDensityColumn(dc.bounds, SAMPLE, SOLID, null, null, stop)` (6 polls, before cell layers 0, 8, …, 40), so the stage polls 30 times in all. `top` is found by scanning the solidity scratch down from y 319 to −63 per position; `WATER_TOP` = ⌊surfaceWaterLevel⌋ clamped as in SP3a. Cost if wrong: none.
- Ruling (aux A): `oceanFloorWG = top + 1` and `worldSurfaceWG = max(top, WATER_TOP) + 1` in closed form, not a per-voxel scan. They equal a top-down scan with SP3a §3.4's predicates: stone and bedrock are the only colliders; when WATER_TOP > top the air at WATER_TOP is above every stone and > top − 12, so it is water; otherwise every water voxel is below top. The test does the literal scan on 7 columns, and a mutation (`worldSurfaceWG = top + 1`) fails 6 tests. Cost if wrong: none.
- Ruling (aux B): `w.auxB()` is called after aux A, on every committed column. Only `surfaceBiomeQ[qz·4 + qx] = s.biome[latticeIndex(qx, qz)]` (qx, qz ∈ 0 … 3) is written. `caveBiomeQ` and the rest of the slot keep the store's zero fill. The test asserts that some fixture column's quarts are asymmetric, so a transposed index fails it (checked by mutation). Cost if wrong: none.
- Ruling (regionHash, Task 7's instruction carried out): after each column's aux A bytes, `regionHash` appends the 4096 bytes of the aux B slot (a view from `caveBiomeQ.byteOffset`), or 4096 zeros when `auxB()` is null. The new `region.test.ts` case flips bytes 0, 1535, 1539 and 4095 of the slot (each changes the hash). It also zero-fills the slot and then detaches it (record int −1): the hash is the same, and it equals the hand-built §6.2 stream. Cost if wrong: none.
- Ruling (tests that replace SP3a's provisional fill, `test/unit/terrainStage.test.ts`, 42 tests in about 0.9 s): the expected column is built independently of the stage. For every voxel: `probe` (no early-outs) for solidity, `top` from it, and the v0 water rule from `readLevel`. It is compared voxel by voxel on 7 seed-'42' columns: SP3a's land, sea, lake, river and coast, plus OVERHANG (−1238, −2000), which has water under stone near the water line, and WALL (−1689, −2000), which has water walls. Both were found by a scan of the row cz −2000. The test file also checks:
  - 3 columns of a σ-40 world (a flat sigma spline, valid);
  - "water under an overhang" (OVERHANG has 25 such voxels, each > top − 12);
  - "deeper enclosed air stays dry" on the σ-40 SEA column (325 air voxels at y ≤ min(swl, top − 12), all dry). On the default world, the row −2100 … −600 had no such pocket;
  - "water walls" (WALL: water beside dry air whose own level is −∞ and whose top is below the water);
  - aux A/B, uniform-or-dense sections, and the order (6 density polls with no section written, then 24);
  - abort at polls 0, 1, 5 (density phase) and 6, 7, 13, 29 (section phase), with no aux and no commit;
  - a density-phase stop leaves no trace on the next column;
  - interleaved GenContexts (default, σ 40, a fresh '42') do not disturb each other.
  
  Mutations each fail the file: water depth 13 instead of 12 (2 tests), transposed surfaceBiomeQ (1), no density-phase polls (7), worldSurfaceWG without water (6). Cost if wrong: none.
- Ruling (§3.2 reduction test): it patches `shape.sigma` and `shape.jag` to flat 0 splines and `density.detailAmpLo/Hi` to 0. It runs on LAND, SEA, LAKE, COAST and OVERHANG, after asserting that all 25 corner columns have σ = jag = 0 (WALL was dropped: one of its corners is a river channel with σ 0.5). Every voxel equals SP3a's rule `y ≤ ⌊surfaceEst⌋` (with the SP3a water rule), and the near-integer count is 0 on every column. These tests pass on the parent too, by design: they pin that the real T reduces to the provisional fill. The plan's replay will show them green in RED. Cost if wrong: plan wording only.
- Ruling (abort in `region.test.ts` and `sliceJob.test.ts`): `fillColumnT`'s leak test now aborts at polls 0, 3, 5 (density phase) and 6, 18, 29 (sections), retitled "abort at poll %i". The slice job's stop test counts 1 + 30 polls per column; it stops column 2 at its 5th stage poll (density phase) and, in a second job, before its 5th section. Both leave the two earlier columns resident with exactly their slots. On the parent the same counts still stop inside column 2, so this file passes there. Its coast expectations (bedrock row, air at 319, stone, water sources with max water y 63, byte-equal to an in-process region) hold on the real T unchanged. Cost if wrong: none.
- Ruling (slot accounting): every T column now holds an aux B slot, so the StoreFull test counts `REC_AUX_B` slots, the cache test expects `denseBytes + 8` for 4 columns, and the integration test's accounting adds 2 byte slots per column. `regionHarness`'s "absent aux B equals zero" test now detaches a's slot (record int −1, which leaks the slot in a throwaway store) instead of relying on SP3a's T writing none. Cost if wrong: none.
- Ruling (review slices, minimal; Task 14 rewrites): the vertical-slice test no longer asserts `wet ⇔ 2D kind ≠ land` per position. On the real T it fails at all three sites (for example (−27021, −31992) is "land" in 2D but wet on voxels). It now asserts that a wet position has a finite water level, and that each needed kind shows up somewhere on the line, wet (or dry for land). The coast site's crop goes from yMax 127 to 159, because a jagged peak tops at 130 (the line's tops are 19 … 144); the `writeReviewSlices` PNG pin goes from 64 × 192 to 64 × 224. `docs/superpowers/specs/assets/sp3a/` was not regenerated. Cost if wrong: none (Task 14 rewrites the kinds from the voxels).
- Ruling (doc strings): `section.ts`'s Voxels tooltip "(the provisional terrain stage)" becomes "(the terrain stage)". `voxels.ts`'s depth comment notes that the run-top depth differs from `worldSurfaceWG − 1 − y` under an overhang. The headers of region.ts, sp3aGoldens.ts, test/harness/region.ts and region.metric.ts no longer say "provisional". `test/bench/noise.bench.ts`'s `terrain.provisional` row and `benchGates.test.ts` are left to Task 13. That row now measures the real T under the old name. Cost if wrong: none.
- Spec defect: §9 "SP1 goldens do not change" and §11 "no SP1 golden change" → `sp1.params` hashes `genKey`, which includes `GENERATOR_VERSION`, so it changes at every bump (SP2a's three bumps changed it each time, `306c502`, `50c6e82`, `e75cea2`, and the SP2a spec's evidence lines say "sp1.params through genKey's version"). `npm run test:goldens` here changed exactly `generatorVersion` 3 → 4, `sp1.params` 9bed26417b2ca0fb → 948e09daacb25342, `sp3a.region.T.default` 943479d09e0e89e3 → 9f8fcdbf6d77185d and `sp3a.region.T.large_biomes` e20fb4ebf0a5e9fc → 6241e62b03b2888d. Suggested wording for §9: "SP1 goldens do not change except `sp1.params`, which hashes `genKey` and so `GENERATOR_VERSION`". The same correction applies to §11's row and to the skeleton's "only `sp3a.region.T.*` may change". The controller's instruction ("only `sp3a.region.T.default`/`large_biomes` may change") could not be met, and this is the only extra key.
- MEASUREMENT (full T column cost; throwaway vitest file, not committed): 450 columns of seed '42' drawn uniformly in ±1024 chunks (`testRng(777)`, the draw Task 6 used), the first 50 dropped as warm-up, n = 400, 3 runs. The machine was not fully quiet: load average 1.8-2.4, probably another worktree's agent.
  - `fillColumnT` (claim + ColumnSample + density + top/water + 24 `setProto` + aux A + aux B + commit + free excluded): p50 1.59 / 1.46 / 1.47 ms, p90 1.79 / 1.61 / 1.64 ms, mean 1.61 / 1.49 / 1.50 ms;
  - the same columns' parts: ColumnSample alone p50 0.30 ms, `fillDensityColumn` p50 0.84-0.85 ms (p90 0.98-1.06);
  - so top + water + sections + aux cost ≈ 0.3 ms.
  
  This is well inside `TERRAIN_P50_MAX_MS = 4`; Task 13 re-measures on a quiet machine.
- MEASUREMENT (what the real T looks like; `P/shots/task-8/`, rendered with `generateSite`/`renderSite`, seed '42', default; counts in `shots.txt`):
  - `coast.png`: x −27136 … −26113, z −31992, y −64 … 159, 1 px/block. Tops 19 … 144, with a jagged spike of about 80 blocks above the coast plain and a ridged highland to the east. No overhang on the line (0 of 1024 positions with ≥ 2 solid→air transitions above top − 30), and no water under stone. 9 water voxels beside dry air: water-wall faces.
  - `coast-zoom.png` (x −27136 … −26881, y 24 … 103, 4 px/block): a 1-block-wide, 2-block-deep dry pit in the sea surface at about x −27025, a water wall of the v0 rule.
  - `mountain.png` (x −16864 … −15841, z −12568, around Task 6's σ 11.5 / jag 37.5 site, y −64 … 319): tops 41 … 192. A steep-walled massif with jagged crests and spikes, and a sea at the east end. Again no overhang on the line. The river-valley floors hold a few water voxels (1899 water voxels in all, 5 wall faces).
  - `mountain-zoom.png` (3 px/block): the cliffs are steep but single-surface.
  - Over 512 random columns (±1024 chunks, `testRng(4242)`): 0.23 % of land positions have ≥ 2 solid→air transitions above top − 30. 39 water voxels lie under stone, and 0.04 % of water voxels have an in-column horizontal neighbour of dry air.
  
  Early warning for Task 12: T2's `overhangs` ≥ 1.5 % (and `overhangsPeaks` ≥ 10 %) looks far off with the default σ and overhang noise. Cost if wrong: none (Task 12 measures properly).

---

### Task 9: surfaceEst3, the debug hook, DT2 and the sp3b goldens

**Spec:** §5, §2.3 (`terrainDensityDebug`), §8.2 DT2 row, §9 (`src/metrics/sp3bGoldens.ts` in DET_FILES, chained, 2 keys, count 52)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md`
- Create: `src/gen/column/surfaceEstimate.ts`
- Modify: `src/gen/pipeline/terrainStage.ts`
- Modify: `src/metrics/sp2aGoldens.ts`
- Create: `src/metrics/sp3bGoldens.ts`
- Modify: `test/arch/banned.test.ts`
- Create: `test/arch/fixtures/banned/bad/src/metrics/sp3bGoldens.ts`
- Modify: `test/arch/rules/banned.ts`
- Modify: `test/goldens.json`
- Modify: `test/metrics/region.metric.ts`
- Modify: `test/thresholds.lock.json`
- Modify: `test/thresholds.ts`
- Modify: `test/tools/goldensJsc.ts`
- Modify: `test/unit/goldens.sp2a.test.ts`
- Modify: `test/unit/goldens.sp3a.test.ts`
- Create: `test/unit/goldens.sp3b.test.ts`
- Create: `test/unit/surfaceEstimate.test.ts`
- Modify: `test/unit/terrainStage.test.ts`
- Modify: `test/unit/uiSmoke.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/expr.ts` (Task 2): `DensityExpr`, `Expr`, `SlideKnot`
  - `src/gen/density/compile.ts` (Task 4): `cornerValueIndex`
  - `src/gen/density/context.ts` (Task 6): `DensityContext`, `DensityContext as DensityContextT`, `createDensityContext`
  - `src/gen/density/probe.ts` (Task 6): `probe`
- Produces (exports added by this task):
  - `src/gen/column/surfaceEstimate.ts`:
    - `export function surfaceEst3(dc: DensityContext, x: number, z: number): number`
  - `src/gen/pipeline/terrainStage.ts`:
    - `export function terrainDensityDebug(ctx: GenContext, cx: number, cz: number, out: Float64Array, mask: Uint8Array): void`
  - `src/metrics/sp3bGoldens.ts`:
    - `export function densityOpsExpr(): DensityExpr`
    - `export function densityOpsPoints(): Array<[number, number, number]>`
    - `export function densityOpsValues(): Float64Array`
    - `export function densityDefaultValues(): Float64Array`
    - `export function sp3bGoldenKeys(): string[]`
    - `export function computeSp3bGolden(key: string): string`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/banned.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/banned.test.ts b/test/arch/banned.test.ts
index 206f470..2ca2a07 100644
--- a/test/arch/banned.test.ts
+++ b/test/arch/banned.test.ts
@@ -56,6 +56,10 @@ test('bad fixture tree reports every banned use', () => {
     'src/metrics/sp3aGoldens.ts:2 math-member',
     'src/metrics/sp3aGoldens.ts:3 engine-dependent-api',
     'src/metrics/sp3aGoldens.ts:4 math-pow-operator',
+    'src/metrics/sp3bGoldens.ts:1 nondeterministic',
+    'src/metrics/sp3bGoldens.ts:2 math-member',
+    'src/metrics/sp3bGoldens.ts:3 engine-dependent-api',
+    'src/metrics/sp3bGoldens.ts:4 math-pow-operator',
     'src/metrics/splineStats.ts:1 nondeterministic',
     'src/metrics/splineStats.ts:2 math-member',
     'src/render/materials/raw.glsl:1 raw-shader-file',
```

Create `test/arch/fixtures/banned/bad/src/metrics/sp3bGoldens.ts`:

```ts
export const stamp = (): number => Date.now();
export const angle = (z: number, x: number): number => Math.atan2(z, x);
export const sort = (a: string, b: string): number => a.localeCompare(b);
export const square = (v: number): number => v ** 2;
```

Modify `test/metrics/region.metric.ts` (apply with `git apply`):

```diff
diff --git a/test/metrics/region.metric.ts b/test/metrics/region.metric.ts
index 54b0c00..454d825 100644
--- a/test/metrics/region.metric.ts
+++ b/test/metrics/region.metric.ts
@@ -1,5 +1,17 @@
 import { expect } from 'vitest';
+import { fnv1a32 } from '../../src/core/hash';
 import { resolveProfile } from '../../src/core/params/profiles';
+import { Xoshiro128 } from '../../src/core/rng';
+import { seedFromInput } from '../../src/core/seed';
+import { createGenContext } from '../../src/gen/context';
+import { cornerValueIndex } from '../../src/gen/density/compile';
+import { createDensityContext } from '../../src/gen/density/context';
+import { probe } from '../../src/gen/density/probe';
+import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
+import { terrainDensityDebug } from '../../src/gen/pipeline/terrainStage';
+import { fillColumnT } from '../../src/metrics/region';
+import { AIR, STONE } from '../../src/world/blocks/index';
+import { createStore } from '../../src/world/store/store';
 import { expectGolden } from '../harness/goldens';
 import { metricTest } from '../harness/metric';
 import { integerEnv } from '../harness/env';
@@ -88,3 +100,106 @@ metricTest('DT1', ['mismatches'], async () => {
     firstCacheHits, regions: PROFILES.length * SEEDS.length * RUNS.length, genSeconds: Math.round(genMs) / 1000,
   };
 });
+
+/**
+ * DT2 (SP3b spec §8.2), threshold exact (0 / 0), on every tier: random voxels in generated columns.
+ * - Columns: per profile (default, large_biomes) and DT1's tier seeds, drawn uniformly over ±1024 chunks (default) or
+ *   ±4096 (large_biomes, §8.1's ±16384 / ±65536 blocks) by `Xoshiro128(fnv1a32('DT2'))`; each is generated with
+ *   `fillColumnT` on a fresh column of an `ArrayBuffer` store and run through `terrainDensityDebug`.
+ * - Voxels: 16 per column, y −63 … 319, in three strata: 6 uniform over the column; 5 uniform over the voxels the bulk
+ *   evaluated (mask 1; uniform over the column when there are none); 5 near the top, at a uniform position and
+ *   `OCEAN_FLOOR_WG − 1 + d`, d uniform in −4 … 4 (where a wrong early-out would show). Fast 512, quick 8,192, full
+ *   32,768 voxels.
+ * - `probeBulk`: voxels whose probe solidity (final > 0, a DensityContext compiled apart from the stage's) differs from
+ *   the block (stone ⇔ solid; air, with or without water, ⇔ not solid; any other block counts), plus voxels with mask 1
+ *   whose probe value is not `Object.is` the bulk's.
+ * - `compiledReference`: values where the compiled closures and the reference interpreter differ (`Object.is`): the
+ *   probe at each voxel, and the 8 corner values of its cell for every `interpolated` node.
+ */
+const DT2_COLUMNS = pick(16, 256, 256);
+const DT2_VOXELS_PER_COLUMN = 16;
+const DT2_RANGE: Readonly<Record<(typeof PROFILES)[number], number>> = { default: 1024, large_biomes: 4096 };
+
+metricTest('DT2', ['probeBulk', 'compiledReference'], () => {
+  const t0 = performance.now();
+  const problems: string[] = [];
+  const r = new Xoshiro128(fnv1a32('DT2'));
+  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
+  const out = new Float64Array(98304);
+  const mask = new Uint8Array(98304);
+  const masked = new Int32Array(98304);
+  let probeBulk = 0, compiledReference = 0, voxels = 0, maskedVoxels = 0, corners = 0, columns = 0;
+  for (const profile of PROFILES) {
+    for (const seed of SEEDS) {
+      const ctx = createGenContext(seedFromInput(seed), resolveProfile(profile));
+      const dc = createDensityContext(ctx);
+      const ref = createDensityReference(dc.expr, dc.noises);
+      const c = dc.compiled;
+      const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
+      const R = DT2_RANGE[profile];
+      for (let n = 0; n < DT2_COLUMNS; n++) {
+        const cx = -R + r.nextInt(2 * R);
+        const cz = -R + r.nextInt(2 * R);
+        const at = `profile ${profile}, seed '${seed}', column (${cx}, ${cz})`;
+        expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
+        const view = store.proto(cx, cz)!;
+        terrainDensityDebug(ctx, cx, cz, out, mask);
+        let m = 0;
+        for (let i = 256; i < 98304; i++) if (mask[i] === 1) masked[m++] = i;
+        const s = dc.column(cx, cz);
+        columns++;
+        for (let v = 0; v < DT2_VOXELS_PER_COLUMN; v++) {
+          let i: number;
+          if (v >= 11) {
+            const p = r.nextInt(256);
+            const y = Math.min(319, Math.max(-63, view.aux()!.oceanFloorWG[p]! - 1 + r.nextInt(9) - 4));
+            i = ((y + 64) << 8) | p;
+          } else {
+            i = v >= 6 && m > 0 ? masked[r.nextInt(m)]! : 256 + r.nextInt(98304 - 256);
+          }
+          const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
+          const x = 16 * cx + lx, z = 16 * cz + lz;
+          const value = probe(dc, x, y, z);
+          const block = view.block(lx, y, lz);
+          voxels++;
+          if ((block !== STONE && block !== AIR) || (value > 0) !== (block === STONE)) {
+            probeBulk++;
+            problems.push(`${at}: (${x}, ${y}, ${z}) probe ${value}, block ${block}`);
+          }
+          if (mask[i] === 1) {
+            maskedVoxels++;
+            if (!Object.is(value, out[i])) {
+              probeBulk++;
+              problems.push(`${at}: (${x}, ${y}, ${z}) probe ${value} ≠ bulk ${out[i]}`);
+            }
+          }
+          const rv = ref.voxel(s, x, y, z);
+          if (!Object.is(value, rv)) {
+            compiledReference++;
+            problems.push(`${at}: (${x}, ${y}, ${z}) compiled ${value} ≠ reference ${rv}`);
+          }
+          const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
+          c.cellCorners(ci, ck, cj);
+          for (const { inner, slot } of interp) {
+            for (let d = 0; d < 8; d++) {
+              const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
+              const cv = c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!;
+              const rc = ref.corner(s, inner, ii, kk, jj);
+              corners++;
+              if (!Object.is(cv, rc)) {
+                compiledReference++;
+                problems.push(`${at}: corner (${ii}, ${kk}, ${jj}) compiled ${cv} ≠ reference ${rc}`);
+              }
+            }
+          }
+        }
+        store.freeColumn(cx, cz);
+      }
+    }
+  }
+  expect.soft(problems.slice(0, 20), `DT2 mismatches (tier ${TIER}), first 20 of ${problems.length}`).toEqual([]);
+  return {
+    probeBulk, compiledReference, voxels, maskedVoxels, cornerValues: corners, columns,
+    seconds: Math.round(performance.now() - t0) / 1000,
+  };
+});
```

Modify `test/unit/goldens.sp2a.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/goldens.sp2a.test.ts b/test/unit/goldens.sp2a.test.ts
index 50c07df..73697b5 100644
--- a/test/unit/goldens.sp2a.test.ts
+++ b/test/unit/goldens.sp2a.test.ts
@@ -7,7 +7,7 @@ test('20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn', () =>
   expect(keys.length).toBe(20);
   expect(new Set(keys).size).toBe(20);
   expect(keys.filter((k) => k.startsWith('sp2a.tile.')).length).toBe(16);
-  expect(allGoldenKeys().length).toBe(50); // 27 SP1 + 20 SP2a + 3 SP3a (SP3a spec §6.4)
+  expect(allGoldenKeys().length).toBe(52); // 27 SP1 + 20 SP2a + 3 SP3a (SP3a spec §6.4) + 2 SP3b (SP3b spec §9)
   expect(() => computeSp2aGolden('sp2a.tile.biome.32')).toThrow(/unknown golden/);
   expect(() => computeSp2aGolden('sp2a.spawn.x')).toThrow(/unknown golden/);
   expect(computeAnyGolden('sp1.params')).toMatch(/^[0-9a-f]{16}$/);
```

Modify `test/unit/goldens.sp3a.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/goldens.sp3a.test.ts b/test/unit/goldens.sp3a.test.ts
index e94e595..9d28552 100644
--- a/test/unit/goldens.sp3a.test.ts
+++ b/test/unit/goldens.sp3a.test.ts
@@ -31,7 +31,7 @@ test('3 unique SP3a keys: the registry and one 8 × 8 region per profile, chaine
   const keys = sp3aGoldenKeys();
   expect(keys).toEqual(['sp3a.registry', 'sp3a.region.T.default', 'sp3a.region.T.large_biomes']);
   expect(sp3aGoldenKeys().length).toBe(3);
-  expect(allGoldenKeys().slice(-3)).toEqual(keys);
+  expect(allGoldenKeys().slice(-5, -2)).toEqual(keys); // SP3b's 2 keys follow (SP3b spec §9)
   expect(new Set(allGoldenKeys()).size).toBe(allGoldenKeys().length);
   expect(computeAnyGolden('sp3a.registry')).toBe(computeSp3aGolden('sp3a.registry'));
   for (const bad of ['sp3a.region.T.amplified', 'sp3a.region.T', 'sp3a.region.D.default', 'sp3a.registry.x', 'sp3a.nope']) {
```

Create `test/unit/goldens.sp3b.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { hashF64, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { densityNoiseSource } from '../../src/gen/density/context';
import { defaultDensityExpr } from '../../src/gen/density/defaults';
import { EXPR_OPS, validateExpr, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { terrainDensityDebug } from '../../src/gen/pipeline/terrainStage';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import {
  computeSp3bGolden, densityDefaultValues, densityOpsExpr, densityOpsPoints, densityOpsValues, sp3bGoldenKeys,
} from '../../src/metrics/sp3bGoldens';
import { expectGolden } from '../harness/goldens';
import { testRng } from '../harness/stats';

const CTX = createGenContext(seedFromInput('42'), resolveProfile('default'));
const CORNERS = 1225;

function opsOf(e: DensityExpr): Set<string> {
  const seen = new Set<string>();
  const walk = (n: Expr): void => {
    seen.add(n.op);
    for (const k of ['a', 'b', 'x', 'inside', 'outside'] as const) {
      const c = (n as unknown as Record<string, Expr | undefined>)[k];
      if (c !== undefined && typeof c === 'object') walk(c);
    }
  };
  walk(e.root);
  for (const d of Object.values(e.defs)) walk(d);
  return seen;
}

/** Corner (i, k, j) of value index `idx` in a column's 1225 corner values: i fastest, then j, then k. */
const cornerOf = (idx: number): [number, number, number] => [idx % 5, Math.floor(idx / 25), Math.floor(idx / 5) % 5];

test('2 unique SP3b keys, chained into allGoldenKeys after SP3a\'s', () => {
  const keys = sp3bGoldenKeys();
  expect(keys).toEqual(['sp3b.density.ops', 'sp3b.density.default']);
  expect(sp3bGoldenKeys().length).toBe(2);
  expect(allGoldenKeys().slice(-2)).toEqual(keys);
  expect(allGoldenKeys().slice(-5, -2)).toEqual(['sp3a.registry', 'sp3a.region.T.default', 'sp3a.region.T.large_biomes']);
  expect(new Set(allGoldenKeys()).size).toBe(allGoldenKeys().length);
  for (const bad of ['sp3b.density', 'sp3b.density.ops.x', 'sp3b.density.large_biomes', 'sp3b.registry', 'sp3b.nope']) {
    expect(() => computeSp3bGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp3b.density.ops (§9)', () => {
  test('the fixture uses every op, with the schema noise ids, and validates', () => {
    const e = densityOpsExpr();
    expect([...opsOf(e)].sort()).toEqual([...EXPR_OPS].sort());
    expect(validateExpr(e, densityNoiseSource(CTX))).toEqual([]);
    expect(interpolatedNodes(e)).toHaveLength(1);
  });

  test('the values are the compiled corners and voxels, equal to the reference (Object.is), and the key hashes them', () => {
    const e = densityOpsExpr();
    const r = createDensityReference(e, densityNoiseSource(CTX));
    const inner = interpolatedNodes(e)[0]!.x;
    const points = densityOpsPoints();
    const values = densityOpsValues();
    const columns = [...new Set(points.map(([x, , z]) => `${x >> 4},${z >> 4}`))];
    const perColumn = points.length / columns.length;
    expect(columns.length).toBeGreaterThanOrEqual(4);
    expect(values.length).toBe(columns.length * (CORNERS + perColumn));
    const bad: string[] = [];
    columns.forEach((key, n) => {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      const s = buildColumnSample(CTX, cx, cz, newColumnSample());
      const base = n * (CORNERS + perColumn);
      for (let idx = 0; idx < CORNERS; idx++) {
        const [i, k, j] = cornerOf(idx);
        const want = r.corner(s, inner, i, k, j);
        if (!Object.is(values[base + idx], want)) bad.push(`(${cx}, ${cz}) corner (${i}, ${k}, ${j}): ${values[base + idx]} ≠ ${want}`);
      }
      points.slice(n * perColumn, (n + 1) * perColumn).forEach(([x, y, z], p) => {
        expect(`${x >> 4},${z >> 4}`).toBe(key);
        const want = r.voxel(s, x, y, z);
        if (!Object.is(values[base + CORNERS + p], want)) bad.push(`(${x}, ${y}, ${z}): ${values[base + CORNERS + p]} ≠ ${want}`);
      });
    });
    expect(bad.slice(0, 10)).toEqual([]);
    // Both branches of the rangeChoice and both signs occur among the voxels.
    const voxels = points.map((_p, i) => values[Math.floor(i / perColumn) * (CORNERS + perColumn) + CORNERS + (i % perColumn)]!);
    expect(voxels.some((v) => v > 0) && voxels.some((v) => v < 0)).toBe(true);
    expect(computeSp3bGolden('sp3b.density.ops')).toBe(hex64(hashF64(values)));
  });
});

describe('sp3b.density.default (§9)', () => {
  const values = densityDefaultValues();

  test('1225 corners then 98,304 voxels of column (0, 0), seed 42, default profile; the key hashes them', () => {
    expect(values.length).toBe(CORNERS + 98304);
    expect(computeSp3bGolden('sp3b.density.default')).toBe(hex64(hashF64(values)));
    expect(computeAnyGolden('sp3b.density.default')).toBe(computeSp3bGolden('sp3b.density.default'));
  });

  test('corners and sampled voxels equal the reference (Object.is); the bulk agrees where it evaluated', () => {
    const e = defaultDensityExpr(CTX.params.density);
    const r = createDensityReference(e, densityNoiseSource(CTX));
    const inner = interpolatedNodes(e)[0]!.x;
    const s = buildColumnSample(CTX, 0, 0, newColumnSample());
    const bad: string[] = [];
    for (let idx = 0; idx < CORNERS; idx++) {
      const [i, k, j] = cornerOf(idx);
      if (!Object.is(values[idx], r.corner(s, inner, i, k, j))) bad.push(`corner (${i}, ${k}, ${j})`);
    }
    const rng = testRng(909);
    for (let n = 0; n < 1500; n++) {
      const idx = rng() % 98304;
      const lx = idx & 15, lz = (idx >> 4) & 15, y = (idx >> 8) - 64;
      if (!Object.is(values[CORNERS + idx], r.voxel(s, lx, y, lz))) bad.push(`voxel (${lx}, ${y}, ${lz})`);
    }
    const out = new Float64Array(98304);
    const mask = new Uint8Array(98304);
    terrainDensityDebug(CTX, 0, 0, out, mask);
    let masked = 0;
    for (let idx = 0; idx < 98304; idx++) {
      if (mask[idx] === 0) continue;
      masked++;
      if (!Object.is(values[CORNERS + idx], out[idx])) bad.push(`bulk voxel ${idx}`);
    }
    expect(masked).toBeGreaterThan(0);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('SP3b goldens', () => {
  test.each(sp3bGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp3bGolden(key));
  }, 60_000);
});
```

Create `test/unit/surfaceEstimate.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { readField } from '../../src/gen/column/columnStage';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import type { GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import type { DensityExpr, Expr } from '../../src/gen/density/expr';
import { probe } from '../../src/gen/density/probe';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const CTX = ctxFor('42');
/** A shape spline that is `y` everywhere. */
const flat = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });

const c = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
/** A `terrain` tap over `x` (the only tap surfaceEst3 reads). */
const terrainOf = (x: Expr): DensityExpr => ({ defs: {}, root: { op: 'tap', name: 'terrain', x } });
/** terrain(y) = H − y: solid exactly below H, so the top is H − 1. */
const linear = (H: number): DensityExpr => terrainOf({ op: 'add', a: c(H), b: { op: 'neg', x: Y } });
/** terrain(y) = 1 inside one of the half-open bands [lo, hi), else −1. */
const bands = (list: ReadonlyArray<readonly [number, number]>): DensityExpr => terrainOf(list.reduce<Expr>(
  (acc, [lo, hi]) => ({ op: 'max', a: acc, b: { op: 'rangeChoice', x: Y, lo, hi, inside: c(1), outside: c(-1) } }), c(-1)));

const dcFor = (expr: DensityExpr, ctx: GenContext = CTX): DensityContext => createDensityContext(ctx, expr);
/** ⌊offset⌋ at (x, z), the search's start before the clamp to [−64, 319]. */
const startOf = (ctx: GenContext, x: number, z: number): number =>
  Math.floor(readField(createDensityContext(ctx).column(x >> 4, z >> 4), 'offset', x, z));

/** Land positions of seed '42' with ⌊offset⌋ well inside the world (the start y of the search). */
const POSITIONS: ReadonlyArray<readonly [number, number]> = [[3, 5], [-17, 40], [90, -122], [-1088 + 7, 1600 + 9]];

describe('surfaceEst3 on hand-built fields (SP3b spec §5)', () => {
  test('the positions start inside the world', () => {
    for (const [x, z] of POSITIONS) {
      const o = startOf(CTX, x, z);
      expect(o).toBeGreaterThan(-30);
      expect(o).toBeLessThan(280);
    }
  });

  test('a single surface H − y gives H − 1 from either side of the start, clamped to the ends', () => {
    for (const [x, z] of POSITIONS) {
      const o = startOf(CTX, x, z);
      for (let H = o - 40; H <= o + 40; H++) expect(surfaceEst3(dcFor(linear(H)), x, z), `H ${H}, start ${o}`).toBe(H - 1);
      for (const H of [-500, -65, -64, -63, -62, 318, 319, 320, 321, 1000]) {
        expect(surfaceEst3(dcFor(linear(H)), x, z), `H ${H}`).toBe(Math.min(319, Math.max(-64, H - 1)));
      }
    }
  });

  test('bisection: midpoints a + 4, then ± 2, then ± 1 inside the bracket [a, a + 8]', () => {
    const [x, z] = POSITIONS[0]!;
    const o = startOf(CTX, x, z);
    // terrain(o) > 0 ≥ terrain(o + 8): the bracket is [o, o + 8]; o + 4 is solid, o + 6 and o + 5 are not.
    expect(surfaceEst3(dcFor(bands([[-1000, o + 1], [o + 4, o + 5]])), x, z)).toBe(o + 4);
    // o + 4 is not solid, o + 2 is, o + 3 is not.
    expect(surfaceEst3(dcFor(bands([[-1000, o + 3], [o + 9, o + 12]])), x, z)).toBe(o + 2);
    // Downward: terrain(o) ≤ 0, terrain(o − 8) > 0: the bracket is [o − 8, o].
    expect(surfaceEst3(dcFor(bands([[-1000, o - 5]])), x, z)).toBe(o - 6);
    // o − 4 is solid, o − 2 and o − 3 are not.
    expect(surfaceEst3(dcFor(bands([[-1000, o - 7], [o - 4, o - 3]])), x, z)).toBe(o - 4);
  });

  test('the 8-step scan crosses gaps it steps over (§5 "Gaps")', () => {
    const [x, z] = POSITIONS[1]!;
    const o = startOf(CTX, x, z);
    // Up: o and o + 8 are solid, o + 16 is not: the overhang's top o + 11, above the air at o + 3 … o + 7.
    expect(surfaceEst3(dcFor(bands([[-1000, o + 3], [o + 8, o + 12]])), x, z)).toBe(o + 11);
    // Down: o and o − 8 are air, o − 16 is solid: the ground under the overhang o − 6 … o − 5 is returned.
    expect(surfaceEst3(dcFor(bands([[-1000, o - 12], [o - 6, o - 4]])), x, z)).toBe(o - 13);
  });

  test('ends: solid up to 319 gives 319, air down to −64 gives −64, bedrock-only gives −64', () => {
    for (const [x, z] of POSITIONS) {
      expect(surfaceEst3(dcFor(bands([[-1000, 1000]])), x, z)).toBe(319);
      expect(surfaceEst3(dcFor(terrainOf(c(-1))), x, z)).toBe(-64);
      expect(surfaceEst3(dcFor(terrainOf(c(0))), x, z)).toBe(-64);
      expect(surfaceEst3(dcFor(bands([[-64, -63]])), x, z)).toBe(-64);
      expect(surfaceEst3(dcFor(bands([[-1000, 319]])), x, z)).toBe(318);
    }
  });

  test('the start is clamped to 319 (offset 320) and a bracket cut by 319 is bisected to its top', () => {
    const high = ctxFor('42', { shape: { offset: flat(320) } });
    const [x, z] = POSITIONS[0]!;
    expect(readField(createDensityContext(high).column(x >> 4, z >> 4), 'offset', x, z)).toBeGreaterThanOrEqual(320);
    for (let H = 290; H <= 330; H++) expect(surfaceEst3(dcFor(linear(H), high), x, z), `H ${H}`).toBe(Math.min(319, H - 1));
    const near = ctxFor('42', { shape: { offset: flat(315) } });
    const o = startOf(near, x, z);
    expect(o).toBe(315);
    // Up from o: the next step is cut at 319, so the bracket is [o, 319] or o reaches 319 itself.
    for (let H = o + 1; H <= 321; H++) expect(surfaceEst3(dcFor(linear(H), near), x, z), `H ${H}, start ${o}`).toBe(Math.min(319, H - 1));
    expect(surfaceEst3(dcFor(bands([[-1000, o + 1], [o + 2, o + 3]]), near), x, z)).toBe(o + 2);
  });

  test('arguments: integer x and z in the world window; the expression must have a terrain tap', () => {
    const dc = dcFor(linear(70));
    expect(() => surfaceEst3(dc, 0.5, 0)).toThrow(RangeError);
    expect(() => surfaceEst3(dc, 0, Number.NaN)).toThrow(RangeError);
    expect(() => surfaceEst3(dc, 1 << 19, 0)).toThrow(RangeError);
    expect(() => surfaceEst3(dcFor({ defs: {}, root: { op: 'tap', name: 'other', x: c(1) } }), 0, 0)).toThrow(/no tap "terrain"/);
  });
});

describe('surfaceEst3 on the default terrain', () => {
  test('a sign change of the terrain tap, and the top of every single-surface position', () => {
    const dc = createDensityContext(CTX);
    const r = testRng(903);
    let single = 0;
    for (let n = 0; n < 160; n++) {
      const x = -4096 + (r() % 8192);
      const z = -4096 + (r() % 8192);
      const b = surfaceEst3(dc, x, z);
      const t = (y: number): number => probe(dc, x, y, z, 'terrain');
      if (b === 319) expect(t(319)).toBeGreaterThan(0);
      else if (b === -64) expect(t(-64)).toBeLessThanOrEqual(0);
      else {
        expect(t(b), `(${x}, ${z}) at ${b}`).toBeGreaterThan(0);
        expect(t(b + 1), `(${x}, ${z}) at ${b + 1}`).toBeLessThanOrEqual(0);
      }
      let changes = 0;
      let top = -64;
      for (let y = -63; y <= 319; y++) {
        const solid = t(y) > 0;
        if (solid) top = y;
        if (!solid && t(y - 1) > 0) changes++;
      }
      if (changes === 1) {
        single++;
        expect(b, `(${x}, ${z})`).toBe(top);
      }
    }
    expect(single).toBeGreaterThan(120);
  });
});

describe('surfaceEst3 at the world\'s vertical ends (the default expression)', () => {
  test.each([
    // The start is clamped from 320 to 319 and most positions are solid up to 319 (the end).
    ['the ceiling: offset 320, σ 64, jag 128', { shape: { offset: flat(320), sigma: flat(64), jag: flat(128) } }, 16],
    // The start is y −64, the floor term keeps it solid, and the search steps up; floating rocks make many positions
    // multi-surface.
    ['the floor: offset −64, σ 64', { shape: { offset: flat(-64), sigma: flat(64) } }, 0],
  ] as const)('%s: an end or a sign change of the terrain tap, and the top of every single-surface position', (_what, patch, minTopEnds) => {
    const dc = createDensityContext(ctxFor('42', patch));
    const r = testRng(904);
    let single = 0, topEnds = 0;
    for (let n = 0; n < 64; n++) {
      const x = -4096 + (r() % 8192);
      const z = -4096 + (r() % 8192);
      const b = surfaceEst3(dc, x, z);
      const t = (y: number): number => probe(dc, x, y, z, 'terrain');
      expect(Number.isInteger(b) && b >= -64 && b <= 319, `(${x}, ${z}): ${b}`).toBe(true);
      // The ends (§5 step 4): 319 when solid there; −64 when not solid there. Otherwise a sign change at b.
      if (b === 319) expect(t(319), `(${x}, ${z})`).toBeGreaterThan(0);
      else if (b !== -64 || t(-64) > 0) {
        expect(t(b), `(${x}, ${z}) at ${b}`).toBeGreaterThan(0);
        expect(t(b + 1), `(${x}, ${z}) at ${b + 1}`).toBeLessThanOrEqual(0);
      }
      if (b === 319) topEnds++;
      // Solid→air transitions from y −64 up; a position solid up to 319 has none and its top is 319.
      let changes = 0;
      let top = -64;
      for (let y = -63; y <= 319; y++) {
        const solid = t(y) > 0;
        if (solid) top = y;
        if (!solid && t(y - 1) > 0) changes++;
      }
      if (changes === 1 || (changes === 0 && top === 319)) {
        single++;
        expect(b, `(${x}, ${z})`).toBe(top);
      }
    }
    // About 60 (ceiling) and 30 (floor) of the 64 positions are single-surface; about 45 end at 319 on the ceiling.
    expect(single).toBeGreaterThan(16);
    expect(topEnds).toBeGreaterThanOrEqual(minTopEnds);
  });
});
```

Modify `test/unit/terrainStage.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/terrainStage.test.ts b/test/unit/terrainStage.test.ts
index 01569e1..dfbdf68 100644
--- a/test/unit/terrainStage.test.ts
+++ b/test/unit/terrainStage.test.ts
@@ -6,7 +6,7 @@ import {
 import type { GenContext } from '../../src/gen/context';
 import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
 import { probe } from '../../src/gen/density/probe';
-import { terrainStage } from '../../src/gen/pipeline/terrainStage';
+import { terrainDensityDebug, terrainStage } from '../../src/gen/pipeline/terrainStage';
 import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
 import { AIR, BEDROCK, COLLIDE, STONE } from '../../src/world/blocks/index';
 import type { AuxBView, AuxView, ColumnView, ColumnWriter } from '../../src/world/store/api';
@@ -384,3 +384,49 @@ describe('order and abort (§4)', () => {
     expect(Array.from(a.auxB()!.surfaceBiomeQ)).toEqual(Array.from(b.auxB()!.surfaceBiomeQ));
   });
 });
+
+describe('terrainDensityDebug (§2.3, the DT2 hook)', () => {
+  test.each(FIXTURES)('%s: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe\'s (Object.is); whole cells; the rest untouched', (_name, [cx, cz]) => {
+    const out = new Float64Array(98304).fill(12345);
+    const mask = new Uint8Array(98304).fill(7);
+    terrainDensityDebug(ctx, cx, cz, out, mask);
+    const dc = dcOf(ctx);
+    const e = expectedFor(ctx, [cx, cz]);
+    let set = 0;
+    const bad: string[] = [];
+    for (let y = -64; y <= 319; y++) {
+      for (let lz = 0; lz < 16; lz++) {
+        for (let lx = 0; lx < 16; lx++) {
+          const i = vi(lx, y, lz);
+          const at = `(${lx}, ${y}, ${lz})`;
+          if (mask[i] !== 0 && mask[i] !== 1) bad.push(`${at}: mask ${mask[i]}`);
+          // A cell is evaluated whole or not at all: each voxel's mask equals its cell's first voxel's.
+          if (mask[i] !== mask[vi(lx & ~3, y - ((y + 64) & 7), lz & ~3)]) bad.push(`${at}: mask differs inside its cell`);
+          if (mask[i] === 1) {
+            set++;
+            const v = probe(dc, 16 * cx + lx, y, 16 * cz + lz);
+            if (!Object.is(out[i], v)) bad.push(`${at}: bulk ${out[i]} ≠ probe ${v}`);
+            if (y > -64 && (v > 0 ? STONE : AIR) !== e.blocks[i]) bad.push(`${at}: block ${e.blocks[i]} vs value ${v}`);
+          } else if (out[i] !== 12345) {
+            bad.push(`${at}: out written at an early-out voxel`);
+          }
+        }
+      }
+    }
+    expect(bad.slice(0, 10)).toEqual([]);
+    // Some cells straddle 0 and most early-out (Task 5: about 4 % of the cells evaluate voxels).
+    expect(set).toBeGreaterThan(0);
+    expect(set).toBeLessThan(0.2 * 98304);
+    expect(set % 128).toBe(0);
+  });
+
+  test('it leaves the T stage unchanged: a column generated after it equals the expected column', () => {
+    terrainDensityDebug(ctx, ...OVERHANG, new Float64Array(98304), new Uint8Array(98304));
+    expect(mismatches(generate(ctx, ...COAST).view, expectedFor(ctx, COAST))).toBe(0);
+  });
+
+  test('out and mask must hold 98,304 entries', () => {
+    expect(() => terrainDensityDebug(ctx, ...LAND, new Float64Array(98303), new Uint8Array(98304))).toThrow(RangeError);
+    expect(() => terrainDensityDebug(ctx, ...LAND, new Float64Array(98304), new Uint8Array(4096))).toThrow(RangeError);
+  });
+});
```

Modify `test/unit/uiSmoke.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/uiSmoke.test.ts b/test/unit/uiSmoke.test.ts
index 5b4898a..849da38 100644
--- a/test/unit/uiSmoke.test.ts
+++ b/test/unit/uiSmoke.test.ts
@@ -76,10 +76,10 @@ describe('UI smoke test: pure parts (SP2b spec §8 Tools, §12)', () => {
   test('the selftest step counts the goldens of test/goldens.json and matches the page summary against it', () => {
     expect(goldenCount('{"generatorVersion":3,"entries":{"a":"1","b":"2"}}')).toBe(2);
     expect(() => goldenCount('{"generatorVersion":3}')).toThrow(/entries/);
-    expect(selftestAllMatch('✓ all 50 goldens match (3.2 s)', 50)).toBe(true);
-    expect(selftestAllMatch('✓ all 47 goldens match (3.2 s)', 50)).toBe(false);
-    expect(selftestAllMatch('✗ 1 of 50 goldens differ (3.2 s)', 50)).toBe(false);
-    expect(selftestAllMatch('computing 50/50…', 50)).toBe(false);
+    expect(selftestAllMatch('✓ all 52 goldens match (3.2 s)', 52)).toBe(true);
+    expect(selftestAllMatch('✓ all 50 goldens match (3.2 s)', 52)).toBe(false);
+    expect(selftestAllMatch('✗ 1 of 52 goldens differ (3.2 s)', 52)).toBe(false);
+    expect(selftestAllMatch('computing 52/52…', 52)).toBe(false);
   });
 
   test('the Voxels step reads the page\'s hover readout and summary in the formats the cut line writes (SP3a spec §5.2)', () => {
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project metrics-fast --project unit test/arch/banned.test.ts test/metrics/region.metric.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/surfaceEstimate.test.ts test/unit/terrainStage.test.ts test/unit/uiSmoke.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× bad fixture tree reports every banned use 17ms
× land: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 3ms
× sea: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 0ms
× lake: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 0ms
× river: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 0ms
× coast: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 0ms
× overhang: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 0ms
× wall: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe's (Object.is); whole cells; the rest untouched 0ms
× it leaves the T stage unchanged: a column generated after it equals the expected column 0ms
× out and mask must hold 98,304 entries 2ms
× 3 unique SP3a keys: the registry and one 8 × 8 region per profile, chained into allGoldenKeys 6ms
× DT2 12ms
× 20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn 8ms
FAIL  |unit| test/unit/goldens.sp3b.test.ts [ test/unit/goldens.sp3b.test.ts ]
… (23 more lines)
Test Files  7 failed | 1 passed (8)
Tests  13 failed | 107 passed (120)
```

- [ ] **Step 3: Implement**

Modify `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
index 0146f97..b464e7d 100644
--- a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
+++ b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
@@ -521,3 +521,4 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
 (One line per commit that changes `test/thresholds.lock.json`.)
 
 - Task 1: `STARTED_SPS` gains `SP3b` (SP3b split into SP3b and a new SP3c; the old SP3c becomes SP3d); no threshold rows change.
+- Task 9: DT2 row added (`probeBulk` max 0, `compiledReference` max 0, activeFrom `SP3b`); no other row changes.
```

Create `src/gen/column/surfaceEstimate.ts`:

```ts
/**
 * surfaceEst3 (SP3b spec §5, master §3.7): the 3D surface estimate, a search of the density's `terrain` tap
 * (interpolated, without `detail`) through the probe. Used for voxels and T5 only: the ColumnSample's `surfaceEst`
 * (map, biome picker, column stage) stays the 2D `offset`. Not cached (the quart-lattice cache comes with its first
 * consumer, SP4-SP7). Follows the gen determinism rules.
 */
import { inWindow } from '../../core/coords';
import type { DensityContext } from '../density/context';
import { probe } from '../density/probe';
import { readField } from './columnStage';

const IN_WINDOW = inWindow;
const PROBE = probe;
const READ = readField;

const TAP = 'terrain';

/**
 * The surface y at world (x, z) (integers in the world window; an integer result):
 * 1. y = ⌊offset(x, z)⌋ (the bilinear ColumnSample value), clamped to [−64, 319].
 * 2. If terrain(y) > 0, step up by 8 while the next step is > 0; otherwise step down by 8 while the next step is ≤ 0.
 *    A step is cut at 319 (up) or −64 (down). That gives a bracket [a, c] with terrain(a) > 0 ≥ terrain(c), c − a = 8
 *    unless cut.
 * 3. Bisection with midpoint a + ⌊(c − a) / 2⌋ until c − a = 1 (three steps for a bracket of 8); the result is a.
 * 4. Ends: terrain > 0 at 319 when stepping up returns 319; terrain ≤ 0 at −64 when stepping down returns −64.
 * An 8-step scan can cross a gap (and return the ground under an overhang, or an overhang's top). The DensityContext's
 * expression must have a `terrain` tap (the probe throws otherwise).
 */
export function surfaceEst3(dc: DensityContext, x: number, z: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(z) || !IN_WINDOW(x, z)) throw new RangeError(`surfaceEst3 (x, z) = (${x}, ${z}) is not an integer position in the world window`);
  const s = dc.column(x >> 4, z >> 4);
  let y = Math.floor(READ(s, 'offset', x, z));
  y = y < -64 ? -64 : y > 319 ? 319 : y;
  let a: number;
  let c: number;
  if (PROBE(dc, x, y, z, TAP) > 0) {
    a = y;
    for (;;) {
      if (a === 319) return 319;
      const n = Math.min(a + 8, 319);
      if (!(PROBE(dc, x, n, z, TAP) > 0)) { c = n; break; }
      a = n;
    }
  } else {
    c = y;
    for (;;) {
      if (c === -64) return -64;
      const n = Math.max(c - 8, -64);
      if (PROBE(dc, x, n, z, TAP) > 0) { a = n; break; }
      c = n;
    }
  }
  while (c - a > 1) {
    const m = a + ((c - a) >> 1);
    if (PROBE(dc, x, m, z, TAP) > 0) a = m;
    else c = m;
  }
  return a;
}
```

Modify `src/gen/pipeline/terrainStage.ts` (apply with `git apply`):

```diff
diff --git a/src/gen/pipeline/terrainStage.ts b/src/gen/pipeline/terrainStage.ts
index a472a51..26f3b86 100644
--- a/src/gen/pipeline/terrainStage.ts
+++ b/src/gen/pipeline/terrainStage.ts
@@ -14,6 +14,7 @@
  * - Aux B: `surfaceBiomeQ[qz·4 + qx]` is the 2D biome of lattice point (qx, qz), qx, qz ∈ 0 … 3, before the zoom;
  *   `caveBiomeQ[(qy·4 + qz)·4 + qx]` stays 0 (none) until SP6.
  * The stage keeps one DensityContext per GenContext (module-level WeakMap). Follows the gen determinism rules.
+ * `terrainDensityDebug` is a test hook (§2.3, DT2): the same density phase, recording the bulk-evaluated values.
  */
 import { MIN_Y } from '../../core/constants';
 import { WATER_SOURCE } from '../../world/blocks/fluid';
@@ -63,6 +64,8 @@ function densityContextOf(ctx: GenContext): DensityContext {
   return dc;
 }
 
+const NEVER = (): boolean => false;
+
 const clampY = (v: number): number => Math.min(TOP_Y, Math.max(Y0 - 1, v));
 
 /**
@@ -123,3 +126,18 @@ export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnW
   }
   return true;
 }
+
+/**
+ * Test hook (SP3b spec §2.3, DT2 `probeBulk`): runs column (cx, cz)'s density phase exactly as `terrainStage` does
+ * (its ColumnSample, then `fillDensityColumn` on the stage's DensityContext of `ctx`, never stopped) and writes no
+ * store. `mask` (98,304 entries, index `((y + 64)·16 + lz)·16 + lx`) is cleared, then set to 1 at every voxel the bulk
+ * evaluated with `voxelFn`, and `out` (same index) receives those voxels' values; the early-out voxels keep mask 0 and
+ * their `out` entries are left untouched. Throws a RangeError when either array is not 98,304 long.
+ */
+export function terrainDensityDebug(ctx: GenContext, cx: number, cz: number, out: Float64Array, mask: Uint8Array): void {
+  if (out.length !== SOLID.length || mask.length !== SOLID.length) {
+    throw new RangeError(`terrainDensityDebug: out has ${out.length} and mask ${mask.length} entries, expected ${SOLID.length}`);
+  }
+  const dc = densityContextOf(ctx);
+  FILL(dc.bounds, BUILD(ctx, cx, cz, SAMPLE), SOLID, out, mask, NEVER);
+}
```

Modify `src/metrics/sp2aGoldens.ts` (apply with `git apply`):

```diff
diff --git a/src/metrics/sp2aGoldens.ts b/src/metrics/sp2aGoldens.ts
index 053de5f..938c278 100644
--- a/src/metrics/sp2aGoldens.ts
+++ b/src/metrics/sp2aGoldens.ts
@@ -1,7 +1,7 @@
 /**
  * SP2a golden digests (SP2a spec §7.4), shared by test/unit/goldens.sp2a.test.ts, the ?selftest=1 worker
  * and test/tools/goldensJsc.ts, and the chain of every golden of the build (`allGoldenKeys`/`computeAnyGolden`:
- * SP1, SP2a, then SP3a, SP3a spec §6.4). Follows the core determinism rules (arch-tested). Every value is hex64.
+ * SP1, SP2a, then SP3a, SP3a spec §6.4, then SP3b, SP3b spec §9). Follows the core determinism rules (arch-tested). Every value is hex64.
  */
 import { MAP_LEVELS, type MapLevel } from '../core/constants';
 import { fnv1a32, fnv1a64Bytes, hashF64, hex64 } from '../core/hash';
@@ -16,6 +16,7 @@ import type { LayerId } from '../gen/map/layers';
 import { paintTile } from '../gen/map/tile';
 import { computeGolden as computeSp1, goldenKeys as sp1Keys } from './sp1Goldens';
 import { computeSp3aGolden, sp3aGoldenKeys } from './sp3aGoldens';
+import { computeSp3bGolden, sp3bGoldenKeys } from './sp3bGoldens';
 
 const FNV32 = fnv1a32;
 const FNV_BYTES = fnv1a64Bytes;
@@ -37,6 +38,8 @@ const SP1 = computeSp1;
 const SP1_KEYS = sp1Keys;
 const SP3A = computeSp3aGolden;
 const SP3A_KEYS = sp3aGoldenKeys;
+const SP3B = computeSp3bGolden;
+const SP3B_KEYS = sp3bGoldenKeys;
 
 const POINT_PROFILES: readonly ProfileId[] = ['default', 'large_biomes'];
 const TILE_LAYERS: readonly LayerId[] = ['biome', 'relief', 'rivers', 'C'];
@@ -120,12 +123,13 @@ export function computeSp2aGolden(key: string): string {
   throw new Error(`unknown golden ${key}`);
 }
 
-/** Every golden key of the build (SP1, SP2a, then SP3a). */
+/** Every golden key of the build (SP1, SP2a, SP3a, then SP3b). */
 export function allGoldenKeys(): string[] {
-  return [...SP1_KEYS(), ...sp2aGoldenKeys(), ...SP3A_KEYS()];
+  return [...SP1_KEYS(), ...sp2aGoldenKeys(), ...SP3A_KEYS(), ...SP3B_KEYS()];
 }
 
 export function computeAnyGolden(key: string): string {
   if (key.startsWith('sp3a.')) return SP3A(key);
+  if (key.startsWith('sp3b.')) return SP3B(key);
   return key.startsWith('sp2a.') ? computeSp2aGolden(key) : SP1(key);
 }
```

Create `src/metrics/sp3bGoldens.ts`:

```ts
/**
 * SP3b golden digests (SP3b spec §9): the density machinery at fixed points, world seed '42', default profile.
 * - `sp3b.density.ops`: a fixture expression that uses every op (its noise ids are the schema's `density.noises.*`),
 *   compiled; per column of a fixed list, its 1225 corner values and the voxel values at 32 fixed points.
 * - `sp3b.density.default`: the default expression at column (0, 0): its 1225 corner values and all 98,304 voxel
 *   values through the probe path (no early-outs).
 * Corners are written per interpolated slot in slot order, each in `cornerValueIndex` order (i fastest, then j, then k);
 * voxels of a whole column in `((y + 64)·16 + lz)·16 + lx` order. Every value is hashed as its IEEE double bits
 * (`hashF64`, so −0 ≠ +0). Chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`) after SP3a's, so the
 * unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. Follows the core determinism rules (in
 * `DET_FILES`, arch-tested). Every value is hex64.
 */
import { fnv1a32, hashF64, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import type { SampleField } from '../gen/column/columnStage';
import { createGenContext } from '../gen/context';
import type { GenContext as GenContextT } from '../gen/context';
import { cornerValueIndex } from '../gen/density/compile';
import { createDensityContext } from '../gen/density/context';
import type { DensityContext as DensityContextT } from '../gen/density/context';
import type { DensityExpr, Expr, SlideKnot } from '../gen/density/expr';
import { probe } from '../gen/density/probe';

const FNV32 = fnv1a32;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const CORNER_INDEX = cornerValueIndex;
const CREATE_DC = createDensityContext;
const PROBE = probe;

const CORNERS = 1225;
const VOXELS = 98304;
/** Land (0, 0) and (5, −7), mountains (−68, 100) and (−1022, −786), ocean (205, −181) (SP3b Task 6's columns). */
const OPS_COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [5, -7], [-68, 100], [-1022, -786], [205, -181]];
const OPS_POINTS_PER_COLUMN = 32;
const SLIDE: readonly SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

const ctx42 = (): GenContextT => CREATE_CTX(SEED('42'), RESOLVE('default'));

const k = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: SampleField): Expr => ({ op: 'col', field });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });

/**
 * The ops fixture: every op of §1.1 once at least, over the schema noises jag (2D), overhang and detail (3D):
 * defs `J` = (1 − |jag · 1/3|)² and `base` = offset − y; root = max(tap('shape', interpolated(base + jag·ref J
 * + σ·slide(overhang))), rangeChoice(detail, −1, 1, min(detail · clamp(E, −0.5, 0.5), 0.75), −40 + 0.25·y)).
 */
export function densityOpsExpr(): DensityExpr {
  const J: Expr = { op: 'square', x: add(k(1), { op: 'neg', x: { op: 'abs', x: mul({ op: 'noise2', id: 'jag' }, k(1 / 3)) } }) };
  const base: Expr = add(col('offset'), { op: 'neg', x: Y });
  const detail: Expr = { op: 'noise', id: 'detail' };
  const shape: Expr = {
    op: 'tap', name: 'shape',
    x: {
      op: 'interpolated',
      x: add(add({ op: 'ref', name: 'base' }, mul(col('jag'), { op: 'ref', name: 'J' })), mul(col('sigma'), { op: 'slide', x: { op: 'noise', id: 'overhang' }, knots: SLIDE })),
    },
  };
  const choice: Expr = {
    op: 'rangeChoice', x: detail, lo: -1, hi: 1,
    inside: { op: 'min', a: mul(detail, { op: 'clamp', x: col('E'), lo: -0.5, hi: 0.5 }), b: k(0.75) },
    outside: add(k(-40), mul(k(0.25), Y)),
  };
  return { defs: { J, base }, root: { op: 'max', a: shape, b: choice } };
}

/**
 * The ops fixture's points, world [x, y, z]: 32 per column of the list, in list order, drawn from
 * `Xoshiro128(fnv1a32('sp3b.density.ops'))` as lx, lz (`nextU32() & 15`) and y (−64 + `nextU32() % 384`).
 */
export function densityOpsPoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp3b.density.ops'));
  const out: Array<[number, number, number]> = [];
  for (const [cx, cz] of OPS_COLUMNS) {
    for (let p = 0; p < OPS_POINTS_PER_COLUMN; p++) {
      const lx = r.nextU32() & 15;
      const lz = r.nextU32() & 15;
      const y = -64 + (r.nextU32() % 384);
      out.push([16 * cx + lx, y, 16 * cz + lz]);
    }
  }
  return out;
}

/** Writes the current column's corner values (every interpolated slot, slot outer) at `values[o …]`; returns the end. */
function writeCorners(dc: DensityContextT, values: Float64Array, o: number): number {
  const c = dc.compiled;
  for (let idx = 0; idx < CORNERS; idx++) c.cornerFn(idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5);
  for (let slot = 0; slot < c.interpolatedSlotCount; slot++) {
    for (let idx = 0; idx < CORNERS; idx++) values[o++] = c.cornerValues[CORNER_INDEX(slot, idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5)]!;
  }
  return o;
}

/** Per column of the list: its corner values, then the voxel values at its 32 points (compiled, no early-outs). */
export function densityOpsValues(): Float64Array {
  const dc = CREATE_DC(ctx42(), densityOpsExpr());
  const points = densityOpsPoints();
  const values = new Float64Array(OPS_COLUMNS.length * (dc.compiled.interpolatedSlotCount * CORNERS + OPS_POINTS_PER_COLUMN));
  let o = 0;
  for (let n = 0; n < OPS_COLUMNS.length; n++) {
    const [cx, cz] = OPS_COLUMNS[n]!;
    dc.column(cx, cz);
    o = writeCorners(dc, values, o);
    for (let p = n * OPS_POINTS_PER_COLUMN; p < (n + 1) * OPS_POINTS_PER_COLUMN; p++) {
      const [x, y, z] = points[p]!;
      values[o++] = PROBE(dc, x, y, z);
    }
  }
  return values;
}

/** The default expression at column (0, 0): its corner values, then the probe at every voxel. */
export function densityDefaultValues(): Float64Array {
  const dc = CREATE_DC(ctx42());
  const values = new Float64Array(dc.compiled.interpolatedSlotCount * CORNERS + VOXELS);
  dc.column(0, 0);
  let o = writeCorners(dc, values, 0);
  for (let y = -64; y <= 319; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) values[o++] = PROBE(dc, lx, y, lz);
    }
  }
  return values;
}

export function sp3bGoldenKeys(): string[] {
  return ['sp3b.density.ops', 'sp3b.density.default'];
}

export function computeSp3bGolden(key: string): string {
  if (key === 'sp3b.density.ops') return HEX64(HASH_F64(densityOpsValues()));
  if (key === 'sp3b.density.default') return HEX64(HASH_F64(densityDefaultValues()));
  throw new Error(`unknown golden ${key}`);
}
```

Modify `test/arch/rules/banned.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/rules/banned.ts b/test/arch/rules/banned.ts
index f93304b..e574e65 100644
--- a/test/arch/rules/banned.ts
+++ b/test/arch/rules/banned.ts
@@ -12,10 +12,10 @@ const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign',
 /**
  * Files outside core/ and gen/ that follow the core determinism rules: the golden digests (SP1 spec §1.8), the
  * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4), the SP3a region core (SP3a spec §6.1) and
- * the SP3a golden digests (SP3a spec §6.4).
+ * the SP3a and SP3b golden digests (SP3a spec §6.4, SP3b spec §9).
  */
 const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts', 'metrics/biomeShares.ts', 'metrics/liveness.ts', 'metrics/splineStats.ts', 'metrics/crossSection.ts',
-  'metrics/region.ts', 'metrics/sp3aGoldens.ts']);
+  'metrics/region.ts', 'metrics/sp3aGoldens.ts', 'metrics/sp3bGoldens.ts']);
 /**
  * Directories outside core/ and gen/ that follow the core determinism rules: the block registry, whose ids and tables
  * are hashed into goldens (SP3a spec §2.5). The rest of world/ (the store) keeps the ND bans only.
```

Modify `test/thresholds.ts` (apply with `git apply`):

```diff
diff --git a/test/thresholds.ts b/test/thresholds.ts
index a2d999d..f3f905d 100644
--- a/test/thresholds.ts
+++ b/test/thresholds.ts
@@ -34,6 +34,7 @@ export const THRESHOLDS: ThresholdTable = {
   B5: { perKm2Min: { min: 0.2, activeFrom: 'SP2a' }, perKm2Max: { max: 2, activeFrom: 'SP2a' }, highShare: { min: 0.3, activeFrom: 'SP2a' } },
   U2: { value: { min: 1, activeFrom: 'SP2b' } },
   DT1: { mismatches: { max: 0, activeFrom: 'SP3a' } },
+  DT2: { probeBulk: { max: 0, activeFrom: 'SP3b' }, compiledReference: { max: 0, activeFrom: 'SP3b' } },
   M1: { states: { max: 4096, activeFrom: 'SP3a' }, roundTripFailures: { max: 0, activeFrom: 'SP3a' }, lockChanges: { max: 0, activeFrom: 'SP3a' } },
   U4: {
     registryIssues: { max: 0, activeFrom: 'SP1' },
```

Modify `test/tools/goldensJsc.ts` (apply with `git apply`):

```diff
diff --git a/test/tools/goldensJsc.ts b/test/tools/goldensJsc.ts
index f75bb99..48e1284 100644
--- a/test/tools/goldensJsc.ts
+++ b/test/tools/goldensJsc.ts
@@ -1,5 +1,5 @@
 /**
- * JavaScriptCore check of every golden, SP1, SP2a and SP3a (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
+ * JavaScriptCore check of every golden, SP1, SP2a, SP3a and SP3b (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
  * (Bun runs JavaScriptCore and resolves the repository's extensionless imports; no dependency is added).
  */
 import goldens from '../goldens.json';
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:goldens`

Run: `npm run test:accept-thresholds`

The command writes `test/goldens.json`; the dry run's result:

Modify `test/goldens.json` (apply with `git apply`):

```diff
diff --git a/test/goldens.json b/test/goldens.json
index c94bf66..f6f59e8 100644
--- a/test/goldens.json
+++ b/test/goldens.json
@@ -50,6 +50,8 @@
     "sp2a.tile.rivers.64": "6da7f75d7a9bfcaf",
     "sp3a.region.T.default": "9f8fcdbf6d77185d",
     "sp3a.region.T.large_biomes": "6241e62b03b2888d",
-    "sp3a.registry": "5e1febd88b449b63"
+    "sp3a.registry": "5e1febd88b449b63",
+    "sp3b.density.default": "19922493ff26b9fc",
+    "sp3b.density.ops": "e8dd39531eaf2f5b"
   }
 }
```

The command writes `test/thresholds.lock.json`; the dry run's result:

Modify `test/thresholds.lock.json` (apply with `git apply`):

```diff
diff --git a/test/thresholds.lock.json b/test/thresholds.lock.json
index aceca3f..006de3d 100644
--- a/test/thresholds.lock.json
+++ b/test/thresholds.lock.json
@@ -1,5 +1,5 @@
 {
-  "sha256": "b78d7a082ab396925346c6700bf7152eb24baed96d19dc82df9c405b28bb14f4",
+  "sha256": "6c0f299b4a0cbd10724f64bf9be3c4f07dfee8af547c15d24aab2b7945f9df98",
   "canonical": {
     "startedSps": [
       "SP0",
@@ -96,6 +96,16 @@
           "max": 0
         }
       },
+      "DT2": {
+        "compiledReference": {
+          "activeFrom": "SP3b",
+          "max": 0
+        },
+        "probeBulk": {
+          "activeFrom": "SP3b",
+          "max": 0
+        }
+      },
       "M1": {
         "lockChanges": {
           "activeFrom": "SP3a",
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project metrics-fast --project unit test/arch/banned.test.ts test/metrics/region.metric.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/surfaceEstimate.test.ts test/unit/terrainStage.test.ts test/unit/uiSmoke.test.ts`

Expected: PASS (exit 0)

```
Test Files  8 passed (8)
Tests  137 passed (137)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  132 passed | 2 skipped (134)
Tests  1764 passed | 3 skipped (1767)
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md src/gen/column/surfaceEstimate.ts src/gen/pipeline/terrainStage.ts src/metrics/sp2aGoldens.ts src/metrics/sp3bGoldens.ts test/arch/banned.test.ts test/arch/fixtures/banned/bad/src/metrics/sp3bGoldens.ts test/arch/rules/banned.ts test/goldens.json test/metrics/region.metric.ts test/thresholds.lock.json test/thresholds.ts test/tools/goldensJsc.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/surfaceEstimate.test.ts test/unit/terrainStage.test.ts test/unit/uiSmoke.test.ts
git commit -F - <<'EOF'
feat(gen,metrics): surfaceEst3, terrainDensityDebug, DT2 and the sp3b goldens

- src/gen/column/surfaceEstimate.ts: surfaceEst3(dc, x, z), SP3b spec §5:
  start at the clamped floor of the bilinear offset, step by 8 on the
  `terrain` tap through the probe, bisect the bracket to one block; ends
  319 / -64; a step cut at 319 or -64 gives a shorter bracket.
- terrainDensityDebug (terrainStage.ts, §2.3): the T stage's density phase
  on the stage's DensityContext, recording the bulk-evaluated values and
  mask, writing no store.
- DT2 in region.metric.ts (§8.2): probeBulk and compiledReference, 512 /
  8,192 / 32,768 voxels per tier over both profiles and DT1's seeds; row
  activeFrom SP3b, thresholds lock accepted, Threshold-log line.
- src/metrics/sp3bGoldens.ts (§9): sp3b.density.ops (a fixture using every
  op) and sp3b.density.default (column (0, 0)), in DET_FILES, chained after
  SP3a's in allGoldenKeys/computeAnyGolden; the count goes 50 -> 52.
- test/goldens.json gains exactly the two sp3b keys (GENERATOR_VERSION 4
  unchanged); Bun 52/52.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `0cfd3f1` on `dry/sp3a`; 19 files changed, 739 insertions(+), 15 deletions(-)):

Commit Task 9 on `dry/sp3b` (worktree `P/dry`, parent Task 8; 19 files, 696 insertions, 15 deletions). RED (the commit's 8 test files and the new banned fixture over the parent, in a throwaway worktree): 2 files fail to import (`surfaceEstimate.test.ts`: `Cannot find module '../../src/gen/column/surfaceEstimate'`; `goldens.sp3b.test.ts`: `…/src/metrics/sp3bGoldens'`), 13 tests fail in 6 files (terrainStage ×9: `terrainDensityDebug` is not a function; banned ×1: the sp3bGoldens fixture's 4 violations not reported, since it is not in DET_FILES; goldens.sp2a ×1: 50 ≠ 52; goldens.sp3a ×1: `slice(-5, -2)`; region.metric DT2 ×1: `terrainDensityDebug` is not a function), plus 17 `tsc -p tsconfig.test.json` errors. `uiSmoke.test.ts` passes on the parent (only its example counts change). GREEN: typecheck clean; `npm test` 132 files passed, 2 skipped; 1745 tests passed, 3 skipped (35.1 s wall); `GOVERNANCE_BASE=main` governance test passes; `npm run test:goldens` 51.7 s, all green, and `git diff test/goldens.json` adds exactly `sp3b.density.default` 19922493ff26b9fc and `sp3b.density.ops` e8dd39531eaf2f5b (generatorVersion stays 4; the merge accepts new keys at an unchanged version and refuses only changed ones); Bun `52/52 match on Bun 1.4.2 (JavaScriptCore)` in 6.1 s.

- Ruling (API, `src/gen/column/surfaceEstimate.ts`): `surfaceEst3(dc: DensityContext, x, z): number`. It throws a RangeError unless x and z are integers in the world window (the probe's check, done first because the offset read needs the column). It reads `readField(dc.column(x >> 4, z >> 4), 'offset', x, z)` (the ColumnCache sample) and probes the `terrain` tap through `probe(dc, x, y, z, 'terrain')`. An expression without a `terrain` tap throws `no tap "terrain"` from tapFn. Not cached, no allocation beyond the probe's. Cost if wrong: none.
- Ruling (bracket cut at the ends): §5 does not say what a step does when y ± 8 leaves [−64, 319]. The step is cut to 319 (up) or −64 (down), and the next value is tested there. If terrain(319) > 0 when stepping up, the result is 319; if terrain(−64) ≤ 0 when stepping down, the result is −64 (§5's ends). Otherwise the bracket [a, c] is shorter than 8, and bisection with midpoint `a + ⌊(c − a)/2⌋` runs until c − a = 1. For a full bracket of 8 that is exactly 3 steps at a + 4, then ± 2, then ± 1. Tested with offset flat 315 (start 315, brackets [315, 319]) and flat 320 (start clamped from 320 to 319; without the clamp the probe throws at y 320). Cost if wrong: none (only within 8 blocks of the world's ends).
- Ruling (surfaceEst3 tests, `test/unit/surfaceEstimate.test.ts`, 8 tests in about 0.6 s): hand-built fields through `createDensityContext(ctx, expr)` with only a `terrain` tap, at 4 land positions of seed '42', relative to the start o = ⌊offset⌋:
  - H − y for H from o − 40 to o + 40, plus H ∈ {−500, −65 … −62, 318 … 321, 1000}, gives clamp(H − 1);
  - rangeChoice bands that pin the bisection path (o + 4, o + 2, o − 6, o − 4);
  - an upward gap crossing (the overhang's top) and a downward one (the ground under an overhang, §5 "Gaps");
  - the ends (all solid gives 319; air, 0 or only y −64 gives −64; solid up to 318 gives 318);
  - the clamp and the cut brackets;
  - argument checks.

  On the default terrain, at 160 random positions: the result is a sign change of the tap (or a valid end), and it equals the tap's top at every single-surface position (> 120 asserted). Mutations: no clamp (1 test fails), an up step of 4 (1), `≥ 0` as solid (3), and an end returning 318 (3). A down step of 16 and a ceiling midpoint are equivalent mutants here: bisection of a 16 bracket passes through the 8-grid. Cost if wrong: none.
- Ruling (API, `terrainDensityDebug(ctx, cx, cz, out, mask): void`, in `terrainStage.ts`): it builds the ColumnSample into the stage's module scratch and runs `fillDensityColumn(dc.bounds, s, SOLID, out, mask, NEVER)` on the stage's own DensityContext (the same WeakMap entry `terrainStage` uses), so it runs exactly the bulk the stage runs. It writes no store. RangeError unless both arrays have 98,304 entries. `mask` is cleared and set where voxelFn ran; `out` is left untouched elsewhere (Task 5's contract). Tests: on the 7 fixtures, mask ∈ {0, 1}, whole cells, `Object.is(out, probe)` where set, the probe's solidity equals the expected block, `out` untouched elsewhere, 0 < masked < 20 % and a multiple of 128; a column generated after the hook equals the expected one; the length checks. Cost if wrong: none.
- Ruling (DT2 sampling, `test/metrics/region.metric.ts`, §8.2 leaves the draw open):
  - **Columns:** per profile (default, large_biomes) and DT1's tier seeds ('42'; full '42', '1', '2', '3'), 16 (fast) or 256 (quick, full) columns, drawn by one `Xoshiro128(fnv1a32('DT2'))` uniformly over ±1024 chunks (default) or ±4096 (large_biomes): §8.1's ±16384 / ±65536 blocks.
  - **Per column:** each is generated with `fillColumnT` on an `ArrayBuffer` store (freed after use) and run through `terrainDensityDebug`.
  - **Voxels:** 16 per column (fast 32 × 16 = 512, quick 512 × 16 = 8,192, full 2,048 × 16 = 32,768), y −63 … 319, in three strata:
    - 6 uniform over the column;
    - 5 uniform over the mask-1 voxels (uniform over the column when there are none);
    - 5 near the top: a uniform position at `OCEAN_FLOOR_WG − 1 + d`, d ∈ −4 … 4.

  Uniform voxels alone almost never sample a straddling cell or the surface band, where a wrong early-out shows. With only uniform and masked strata, a mutation that marked straddling cells with hi < 6 as air went undetected on fast; with the top stratum, fast finds 3 mismatches. A solid-side mutation (`lo > −4` as solid) gives 0 on fast and 10 on quick. Cost if wrong: a weaker fast gate (the fuzz of Task 5 is the stronger proof).
- Ruling (DT2 parts): the probe uses a DensityContext compiled apart from the stage's.
  - `probeBulk` counts, per sampled voxel, a solidity disagreement between the probe and the block (stone ⇔ solid; air with or without water ⇔ not solid; any other block counts), plus, where mask is 1, `!Object.is(probe, bulk)`. A voxel can count twice.
  - `compiledReference` counts the probe value against `reference.voxel`, and, for every `interpolated` node, the 8 corner values of the voxel's cell (`cellCorners` then `cornerValues`) against `reference.corner(s, node.x, …)`, all with `Object.is`.
  - Diagnostics (in `.out/DT2.json`, ungated): `voxels`, `maskedVoxels`, `cornerValues`, `columns`, `seconds`.
  - A mutation of the voxel y-fraction in compile.ts (`y + 63.99`) gives compiledReference 512 on fast.

  Cost if wrong: none.
- MEASUREMENT (DT2 time per tier, `metrics-<tier> region.metric.ts -t DT2` alone, load 0.3 to 2.8, two runs): fast 0.19-0.23 s in the metric (0.95 s wall with vitest start), with 323 masked of 512; quick 1.88 s (2.6 s wall), with 5,167 masked of 8,192; full 7.26-7.29 s (8.0 s wall), with 20,737 masked of 32,768. probeBulk 0 and compiledReference 0 on every tier. Cost if wrong: none.
- Ruling (goldens API, `src/metrics/sp3bGoldens.ts`): `sp3bGoldenKeys()` gives `['sp3b.density.ops', 'sp3b.density.default']` and `computeSp3bGolden(key)`. The exports `densityOpsExpr()`, `densityOpsPoints()`, `densityOpsValues()` and `densityDefaultValues()` serve the unit test. Each value is `hex64(hashF64(values))`: IEEE bits little-endian, so −0 ≠ +0. Layout:
  - per column, every interpolated slot's 1225 corner values (slot outer, `cornerValueIndex` order: i fastest, then j, then k; every corner is evaluated by `cornerFn` first), then the voxel values through `probe`;
  - `default`: column (0, 0), seed '42', default profile, the corners and then the 98,304 voxels in `((y + 64)·16 + lz)·16 + lx` order (1225 + 98,304 doubles; about 80 ms);
  - `ops`: Task 6's 5 columns ((0, 0), (5, −7), (−68, 100), (−1022, −786), (205, −181)), each with its corners and then 32 points drawn by `Xoshiro128(fnv1a32('sp3b.density.ops'))` (lx, lz = `nextU32() & 15`, y = −64 + `nextU32() % 384`).

  Cost if wrong: none before the final record.
- Ruling (the ops fixture): defs `J = square(1 + neg(abs(noise2 jag · 1/3)))` and `base = offset + neg(y)`. The root is `max(tap('shape', interpolated(base + jag·ref J + σ·slide(noise overhang, SLIDE))), rangeChoice(noise detail, −1, 1, min(detail · clamp(E, −0.5, 0.5), 0.75), −40 + 0.25·y))`. It uses all 18 ops and the 3 schema noise ids. The tap is named `shape`, not `terrain`, so the fixture cannot be mistaken for a terrain expression. The test asserts the op set equals `EXPR_OPS`, that it validates, and that both signs occur. Cost if wrong: none.
- Ruling (goldens tests, `test/unit/goldens.sp3b.test.ts`, about 0.2 s): the key list (length 2), the chain (`allGoldenKeys().slice(-2)`; SP3a's 3 keys at `slice(-5, -2)`; `goldens.sp3a.test.ts`'s `slice(-3)` becomes the same), unknown keys throw through both entry points. The `ops` values are checked against the reference, all 6,125 corners and 160 voxels with `Object.is`. The `default` values are checked against the reference (all 1225 corners and 1500 random voxels) and against `terrainDensityDebug`'s bulk wherever its mask is set. Each digest is checked as `hashF64` of its values, plus `expectGolden`. Cost if wrong: none.
- Ruling (the count 50 → 52, where it is pinned): `goldens.sp2a.test.ts` (`toBe(52)`, comment "+ 2 SP3b (SP3b spec §9)") and `uiSmoke.test.ts`'s `selftestAllMatch` examples (52; a 50-of-52 summary must fail). `goldenCount` reads `test/goldens.json`, so the uiSmoke tool's selftest step expects 52 with no code change. The header comments in `sp2aGoldens.ts`, `goldensJsc.ts` and `banned.ts` (DET_FILES) name SP3b. The banned bad fixture gains `src/metrics/sp3bGoldens.ts`, with the same 4 violations as SP3a's, so that leaving the file out of DET_FILES fails the arch test. Cost if wrong: none.
- Ruling (Threshold log): "Task 9: DT2 row added (`probeBulk` max 0, `compiledReference` max 0, activeFrom `SP3b`); no other row changes." Cost if wrong: wording only.
- Ruling (not done here, left to its task): `?selftest=1` in Chrome/Firefox with 52 keys is Task 14/15's browser run. The master §3.7/§6.4 amendments for surfaceEst3 and DT2 are Task 15's. Cost if wrong: none.

---

### Task 10: U2 covers the terrain stage; SP2a minor 5

**Spec:** §3.3 U2 bullet, §4 SP2a minor 5

**Files:**
- Modify: `src/gen/column/lakes.ts`
- Modify: `src/gen/column/steep.ts`
- Modify: `src/metrics/liveness.ts`
- Modify: `test/unit/liveness.test.ts`
- Create: `test/unit/terrainHeap.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/gen/column/lakes.ts`:
    - `export function lakeSpace(ctx: GenContext, x: number, z: number): [number, number]`
  - `src/metrics/liveness.ts`:
    - `export type OutputStage = 'climate' | 'shape' | 'biome2d' | 'terrain';`
    - `export function u2Leaves(): readonly LeafInfo[]`
    - `export function leafLiveness(base: GenContext, path: string, columns: readonly LivenessColumn[]): LivenessResult`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/liveness.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/liveness.test.ts b/test/unit/liveness.test.ts
index 8d1417b..c0dc8d3 100644
--- a/test/unit/liveness.test.ts
+++ b/test/unit/liveness.test.ts
@@ -6,9 +6,13 @@ import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
 import type { NestedSpline } from '../../src/core/spline/types';
 import { buildColumnSample, gorgeAt, newColumnSample, riverWetAt, type ColumnSample } from '../../src/gen/column/columnStage';
 import { cellEligible, lakeCell } from '../../src/gen/column/lakes';
+import { hex64 } from '../../src/core/hash';
 import {
-  cellProbe, findWitness, intendedClass, livenessColumns, perturbations, stageOutputHash, type LivenessClass, type LivenessColumn,
+  cellProbe, findWitness, intendedClass, leafLiveness, livenessColumns, perturbations, stageOutputHash, u2Leaves, type LivenessClass,
+  type LivenessColumn,
 } from '../../src/metrics/liveness';
+import { fillColumnT, regionHash } from '../../src/metrics/region';
+import { createStore } from '../../src/world/store/store';
 import { ctxFor } from '../harness/gen';
 
 const leaf = (path: string) => {
@@ -70,6 +74,26 @@ describe('perturbations', () => {
     expect(jagDown!.points[0]!.y).toBe(-16);
   });
 
+  test('density leaves (SP3b spec §3.3): every perturbation stays inside the leaf range', () => {
+    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
+    expect(density.map((l) => l.path)).toEqual([
+      'density.noises.jag', 'density.noises.overhang', 'density.noises.detail', 'density.detailAmpLo', 'density.detailAmpHi',
+    ]);
+    for (const info of density) {
+      const lo = info.leaf.min!;
+      const hi = info.leaf.max!;
+      for (const v of perturbations(info, getPath(DEFAULTS, info.path))) {
+        const x = info.leaf.kind === 'noise' ? (v as { wavelength: number }).wavelength : (v as number);
+        expect(x >= lo && x <= hi, `${info.path}: ${x} in [${lo}, ${hi}]`).toBe(true);
+      }
+    }
+    expect(perturbations(leaf('density.detailAmpLo'), 0.6)).toEqual([0.51, 0.69]);
+    expect((perturbations(leaf('density.noises.detail'), DEFAULTS.density.noises.detail) as { wavelength: number }[]).map((d) => d.wavelength))
+      .toEqual([8.5, 11.5]);
+    // At the top of the range the upward step clamps back to the value and is dropped.
+    expect(perturbations(leaf('density.detailAmpHi'), 8)).toEqual([6.8]);
+  });
+
   test('boxTable: every interval shrunk and grown by 15 % of its width about its centre, within [−1, 1]', () => {
     const [shrunk, grown] = perturbations(leaf('biomes.table'), DEFAULTS.biomes.table) as BoxTable[];
     expect(shrunk!['beach']!.C).toEqual([-0.2065, -0.0535]);
@@ -167,6 +191,28 @@ describe('stage output hashes', () => {
     expect(lattice(jitter)).toEqual(lattice(CTX));
   });
 
+  test('terrain: the region hash of the 1 × 1 window after fillColumnT on a fresh ArrayBuffer store', () => {
+    for (const c of columns().filter((x) => x.cls === 'land' || x.cls === 'coast')) {
+      const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
+      expect(fillColumnT(store, CTX, c.cx, c.cz, () => false)).toBe(true);
+      const expected = hex64(regionHash(store, c.cx, c.cz, 1, 1));
+      expect(stageOutputHash(CTX, 'terrain', c.cx, c.cz), `${c.cls} (${c.cx}, ${c.cz})`).toBe(expected);
+      expect(stageOutputHash(CTX, 'terrain', c.cx, c.cz)).toBe(expected);
+    }
+    const c = columns()[0]!;
+    const h = (['climate', 'shape', 'biome2d', 'terrain'] as const).map((st) => stageOutputHash(CTX, st, c.cx, c.cz));
+    expect(new Set(h).size).toBe(4);
+  });
+
+  test('a density leaf moves only the terrain hash', () => {
+    const c = columns().find((x) => x.cls === 'land')!;
+    const amp = moved('density.detailAmpHi', 1.725);
+    for (const st of ['climate', 'shape', 'biome2d'] as const) {
+      expect(stageOutputHash(amp, st, c.cx, c.cz), st).toBe(stageOutputHash(CTX, st, c.cx, c.cz));
+    }
+    expect(stageOutputHash(amp, 'terrain', c.cx, c.cz)).not.toBe(stageOutputHash(CTX, 'terrain', c.cx, c.cz));
+  });
+
   test('a climate leaf moves the climate hash; the three hashes are distinct and repeatable', () => {
     const c = columns()[0]!;
     const h = (['climate', 'shape', 'biome2d'] as const).map((st) => stageOutputHash(CTX, st, c.cx, c.cz));
@@ -176,6 +222,35 @@ describe('stage output hashes', () => {
   });
 });
 
+describe('the terrain stage in U2 (SP3b spec §3.3)', () => {
+  test('U2 covers the leaves of the climate, shape, biome2d and terrain stages, every density.* leaf among them', () => {
+    const stages = ['climate', 'shape', 'biome2d', 'terrain'];
+    const expected = SCHEMA.leaves.filter((l) => l.meta.stage !== undefined && stages.includes(l.meta.stage)).map((l) => l.path);
+    expect(u2Leaves().map((l) => l.path)).toEqual(expected);
+    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
+    expect(density.length).toBe(5);
+    for (const l of density) expect(l.meta.stage, l.path).toBe('terrain');
+    expect(expected).toEqual(expect.arrayContaining(density.map((l) => l.path)));
+    expect(intendedClass('density.detailAmpLo')).toBe('land');
+  });
+
+  test('every density.* leaf is decided on a land or coast column', () => {
+    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
+    for (const l of density) {
+      const r = leafLiveness(CTX, l.path, columns());
+      expect(r.live, `${l.path}: ${r.via ?? 'dead'}`).toBe(true);
+      expect(r.via, l.path).toMatch(/^(land|coast) column \(-?\d+, -?\d+\)$/);
+      expect(r.cls === 'land' || r.cls === 'coast', l.path).toBe(true);
+    }
+  });
+
+  test('a terrain leaf is tried on the land and coast columns only, with no stream witness', () => {
+    const others = columns().filter((c) => c.cls !== 'land' && c.cls !== 'coast');
+    expect(others.length).toBe(12);
+    expect(leafLiveness(CTX, 'density.noises.detail', others)).toEqual({ path: 'density.noises.detail', live: false, via: null, cls: 'land' });
+  });
+});
+
 describe('witnesses', () => {
   test('the lake-cell spiral finds a witness for lakes.minC', () => {
     expect(findWitness(CTX, 'lakes.minC')).toBe('witness cell (-12, 4) → column (-235, 87)');
```

Create `test/unit/terrainHeap.test.ts`:

```ts
/**
 * SP2a minor 5 (SP3b spec §4): the T stage's hot path retains nothing once its caches are warm. 1000 columns of seed
 * '42' go through `fillColumnT` and `freeColumn` on one `ArrayBuffer` store twice; the second pass (same columns: the
 * lake cells, the DensityContext, the store's pools and the JIT are warm) may grow the heap, measured after a full GC
 * on both sides, by less than HEAP_GROWTH_MAX bytes. Short-lived garbage (boxed doubles returned by the noise, climate
 * and density closures) is collected by scavenges and is not counted: see the column stage's notes in `lakes.ts`.
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const used = (): number => {
  gc();
  gc();
  return v8.getHeapStatistics().used_heap_size;
};

/** 16 bytes per column on average: retaining even one small object per column fails (measured: about −4 KiB). */
const HEAP_GROWTH_MAX = 16 * 1024;
const COLUMNS = 1000;

test(`the T stage's hot path: heap growth over ${COLUMNS} warm columns < ${HEAP_GROWTH_MAX} bytes`, () => {
  const ctx = ctxFor('42');
  const next = testRng(1005);
  const cols = Array.from({ length: COLUMNS }, () => [(next() % 2048) - 1024, (next() % 2048) - 1024] as const);
  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  const NEVER = (): boolean => false;
  let committed = 0;
  const pass = (): void => {
    for (const [cx, cz] of cols) {
      if (fillColumnT(store, ctx, cx, cz, NEVER)) committed++;
      store.freeColumn(cx, cz);
    }
  };
  pass();
  const before = used();
  pass();
  const growth = used() - before;
  expect(committed).toBe(2 * COLUMNS);
  expect(growth, `heap growth ${growth} bytes`).toBeLessThan(HEAP_GROWTH_MAX);
}, 60_000);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/liveness.test.ts test/unit/terrainHeap.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× terrain: the region hash of the 1 × 1 window after fillColumnT on a fresh ArrayBuffer store 22ms
× a density leaf moves only the terrain hash 5ms
× U2 covers the leaves of the climate, shape, biome2d and terrain stages, every density.* leaf among them 0ms
× every density.* leaf is decided on a land or coast column 0ms
× a terrain leaf is tried on the land and coast columns only, with no stream witness 0ms
FAIL  |unit| test/unit/liveness.test.ts > stage output hashes > terrain: the region hash of the 1 × 1 window after fillColumnT on a fresh ArrayBuffer store
AssertionError: land (-25833, 16792): expected 'bbd606349c750303' to be '2e2dc7c32a63da7c' // Object.is equality
FAIL  |unit| test/unit/liveness.test.ts > stage output hashes > a density leaf moves only the terrain hash
AssertionError: expected 'bbd606349c750303' not to be 'bbd606349c750303' // Object.is equality
FAIL  |unit| test/unit/liveness.test.ts > the terrain stage in U2 (SP3b spec §3.3) > U2 covers the leaves of the climate, shape, biome2d and terrain stages, every density.* leaf among them
TypeError: u2Leaves is not a function
FAIL  |unit| test/unit/liveness.test.ts > the terrain stage in U2 (SP3b spec §3.3) > every density.* leaf is decided on a land or coast column
TypeError: leafLiveness is not a function
FAIL  |unit| test/unit/liveness.test.ts > the terrain stage in U2 (SP3b spec §3.3) > a terrain leaf is tried on the land and coast columns only, with no stream witness
Test Files  1 failed | 1 passed (2)
Tests  5 failed | 18 passed (23)
```

- [ ] **Step 3: Implement**

Modify `src/gen/column/lakes.ts` (apply with `git apply`):

```diff
diff --git a/src/gen/column/lakes.ts b/src/gen/column/lakes.ts
index b3c1a5f..b22cb2f 100644
--- a/src/gen/column/lakes.ts
+++ b/src/gen/column/lakes.ts
@@ -2,6 +2,13 @@
  * Lakes at elevation (master §3.5, SP2a spec §2.5): warped Voronoi cells, one possible lake per cell.
  * cellEligible and lakeTerms are the pure formulas; lakeCell evaluates (and memoises) a cell centre with
  * a lake-free column evaluation; sampleLakes applies the F1 cell to a column.
+ *
+ * Allocation (SP2a minor 5, SP3b spec §4): sampleLakes, the column stage's per-point call, allocates no object; it
+ * goes through module scratch (`warpInto`, `nearestInto`) where the exported `lakeSpace` and `nearestCell` return a
+ * fresh tuple and record. A lakeCell miss allocates its memoised LakeCell (bounded by CELL_CACHE_MAX per context), so
+ * a warm cache costs nothing. What remains is V8's short-lived boxing of doubles returned by non-inlined calls (the
+ * noises, here and in climate, shape and rivers), which scavenges collect: measured on the T stage's hot path, about
+ * 1.5 MB of such garbage per column (≈ 190 scavenges per 1000 columns) and no retained growth (test/unit/terrainHeap).
  */
 import { hash2, hash4 } from '../../core/hash';
 import type { LakeParams } from '../../core/params/schema';
@@ -136,15 +143,33 @@ function noises(ctx: GenContext): LakeNoises {
   return n;
 }
 
-/** Warped lake-space position of world (x, z). */
-export function lakeSpace(ctx: GenContext, x: number, z: number): [number, number] {
+/** warpInto's output: the warped (xl, zl). */
+const WARPED = new Float64Array(2);
+/** nearestInto's output: the squared distance to the returned cell's centre. */
+const NEAREST_D2 = new Float64Array(1);
+
+/** Writes the warped lake-space position of world (x, z) into WARPED. */
+function warpInto(ctx: GenContext, x: number, z: number): void {
   const a = ctx.params.lakes.warpAmp;
   const n = noises(ctx);
-  return [x + a * n.wx.z2(x, z), z + a * n.wz.z2(x, z)];
+  WARPED[0] = x + a * n.wx.z2(x, z);
+  WARPED[1] = z + a * n.wz.z2(x, z);
+}
+
+/** Warped lake-space position of world (x, z). */
+export function lakeSpace(ctx: GenContext, x: number, z: number): [number, number] {
+  warpInto(ctx, x, z);
+  return [WARPED[0]!, WARPED[1]!];
 }
 
 /** The F1 (nearest-centre) cell of warped point (xl, zl); ties go to the lower (j, i). */
 export function nearestCell(ctx: GenContext, xl: number, zl: number): { cell: LakeCell; dist: number } {
+  const cell = nearestInto(ctx, xl, zl);
+  return { cell, dist: Math.sqrt(NEAREST_D2[0]!) };
+}
+
+/** nearestCell without the record: returns the cell and writes the squared distance into NEAREST_D2. */
+function nearestInto(ctx: GenContext, xl: number, zl: number): LakeCell {
   const cellSize = ctx.params.lakes.cell;
   const ci = Math.floor(xl / cellSize);
   const cj = Math.floor(zl / cellSize);
@@ -159,20 +184,22 @@ export function nearestCell(ctx: GenContext, xl: number, zl: number): { cell: La
       if (d2 < bestD2) { bestD2 = d2; best = cell; }
     }
   }
-  return { cell: best!, dist: Math.sqrt(bestD2) };
+  NEAREST_D2[0] = bestD2;
+  return best!;
 }
 
 /** Lakes at world (x, z) over a column already adjusted by rivers. */
 export function sampleLakes(ctx: GenContext, x: number, z: number, offset: number, sigma: number, jag: number, out: LakeOut): LakeOut {
   const p = ctx.params.lakes;
-  const [xl, zl] = lakeSpace(ctx, x, z);
-  const { cell, dist } = nearestCell(ctx, xl, zl);
+  warpInto(ctx, x, z);
+  const cell = nearestInto(ctx, WARPED[0]!, WARPED[1]!);
   if (!cell.enabled) {
     out.lakeMask = 0; out.lakeLevel = -Infinity; out.lakeFloor = -Infinity;
     out.offset = offset; out.sigma = sigma; out.jag = jag;
     return out;
   }
   const rim = noises(ctx).rim;
+  const dist = Math.sqrt(NEAREST_D2[0]!);
   const q = dist / p.radius - p.roughness * (rim.z2(x, z) / rim.clamp);
   return lakeTerms(q, cell.Lw, cell.depth, offset, sigma, jag, p, out);
 }
```

Modify `src/gen/column/steep.ts` (apply with `git apply`):

```diff
diff --git a/src/gen/column/steep.ts b/src/gen/column/steep.ts
index 5792919..e31cd4a 100644
--- a/src/gen/column/steep.ts
+++ b/src/gen/column/steep.ts
@@ -17,9 +17,12 @@ export function steepFrom(east: number, west: number, north: number, south: numb
   return Math.sqrt(gx * gx + gz * gz);
 }
 
-/** offset0 at world (x, z) (climate plus the offset spline). */
+/** offset0At's climate record, reused (SP2a minor 5): offsetFrom reads it before the next call overwrites it. */
+const CLIM = NEW_CLIMATE();
+
+/** offset0 at world (x, z) (climate plus the offset spline). Allocates no record. */
 export function offset0At(ctx: GenContext, x: number, z: number, coords: Float64Array): number {
-  return OFFSET(ctx, CLIMATE(ctx, x, z, NEW_CLIMATE()), coords);
+  return OFFSET(ctx, CLIMATE(ctx, x, z, CLIM), coords);
 }
 
 export function steepAt(ctx: GenContext, x: number, z: number, coords: Float64Array): number {
```

Modify `src/metrics/liveness.ts` (apply with `git apply`):

```diff
diff --git a/src/metrics/liveness.ts b/src/metrics/liveness.ts
index 8fc620e..37f898b 100644
--- a/src/metrics/liveness.ts
+++ b/src/metrics/liveness.ts
@@ -1,9 +1,10 @@
 /**
- * U2, parameter liveness (SP2b spec §7, master §6.4): every column-scope leaf, moved by its per-kind ±15 %
- * perturbation, must change its home stage's output hash on one of 16 class columns or on a witness
- * (seed 42, default profile). The class columns are chosen by the lattice conditions under which the leaves
- * act; lake-gate leaves (lakes.p, minC, offsetMin, offsetMax) get one threshold column each. Follows the core
- * determinism rules (DET_FILES in test/arch/rules/banned.ts).
+ * U2, parameter liveness (SP2b spec §7, master §6.4): every leaf of the climate, shape, biome2d and terrain stages,
+ * moved by its per-kind ±15 % perturbation, must change its home stage's output hash on one of 16 class columns or on
+ * a witness (seed 42, default profile). The class columns are chosen by the lattice conditions under which the leaves
+ * act; lake-gate leaves (lakes.p, minC, offsetMin, offsetMax) get one threshold column each. A `terrain` leaf (SP3b
+ * spec §3.3: the `density.*` group) is tried on the land and coast class columns only, with no witness search: its
+ * output is a whole generated column. Follows the core determinism rules (DET_FILES in test/arch/rules/banned.ts).
  */
 import { SEA_LEVEL } from '../core/constants';
 import { hash4, hashF64, hex64 } from '../core/hash';
@@ -21,7 +22,9 @@ import { buildColumnSample, newColumnSample, readBiome, type ColumnSample } from
 import { cellEligible, lakeCell, lakeSpace, nearestCell, newLake, sampleLakes, type CellProbe, type LakeCell } from '../gen/column/lakes';
 import { newRiver, sampleRivers } from '../gen/column/rivers';
 import { newShape, sampleShape } from '../gen/column/shape';
+import { createStore } from '../world/store/store';
 import { samplePoints } from './noiseStats';
+import { fillColumnT, regionHash } from './region';
 
 const SEA = SEA_LEVEL;
 const H4 = hash4;
@@ -57,6 +60,9 @@ const RIVERS = sampleRivers;
 const NEW_SHAPE = newShape;
 const SHAPE = sampleShape;
 const POINTS = samplePoints;
+const CREATE_STORE = createStore;
+const FILL_T = fillColumnT;
+const REGION_HASH = regionHash;
 
 export type LivenessClass =
   | 'land' | 'coast' | 'channel' | 'gorge' | 'basin' | 'rim'
@@ -64,8 +70,8 @@ export type LivenessClass =
 
 export interface LivenessColumn { readonly cx: number; readonly cz: number; readonly cls: LivenessClass }
 
-/** The stages whose leaves U2 covers today (column scope). */
-export type OutputStage = 'climate' | 'shape' | 'biome2d';
+/** The stages whose leaves U2 covers: the column scope, and the T stage (SP3b spec §3.3). */
+export type OutputStage = 'climate' | 'shape' | 'biome2d' | 'terrain';
 
 /**
  * One leaf's verdict. `via` names the deciding column (a class column or a witness); `cls` is that column's
@@ -87,7 +93,11 @@ const LAND_GRID = 16;
 const LATTICE_REACH = 12;
 /** Coast columns: a lattice point with |offset0 − 63| ≤ 8. */
 const COAST_BAND = 8;
-const COLUMN_STAGES: readonly string[] = ['climate', 'shape', 'biome2d'];
+const OUTPUT_STAGES: readonly string[] = ['climate', 'shape', 'biome2d', 'terrain'];
+/** The class columns a `terrain` leaf is tried on (SP3b spec §3.3). */
+const TERRAIN_CLASSES: readonly LivenessClass[] = ['land', 'coast'];
+/** One column's store: ≤ 24 dense block sections (1 MiB holds 128) and ≤ 26 byte slots (1 MiB holds 256). */
+const STORE_BYTES = 1 << 20;
 const CLASS_ORDER: readonly LivenessClass[] = [
   'land', 'coast', 'channel', 'gorge', 'basin', 'rim',
   'threshold:lakes.p', 'threshold:lakes.minC', 'threshold:lakes.offsetMin', 'threshold:lakes.offsetMax',
@@ -232,12 +242,23 @@ function hashSample(ctx: GenContext, stage: OutputStage, s: ColumnSample): strin
   return digest([s.biome, blocks]);
 }
 
+const NEVER = (): boolean => false;
+
+/** SP3b spec §3.3: `regionHash` of the 1 × 1 window after `fillColumnT` on a fresh `ArrayBuffer` store. */
+function terrainHash(ctx: GenContext, cx: number, cz: number): string {
+  const store = CREATE_STORE({ shared: false, maxBlockBytes: STORE_BYTES, maxByteBytes: STORE_BYTES });
+  if (!FILL_T(store, ctx, cx, cz, NEVER)) throw new Error(`U2: column (${cx}, ${cz}) was not generated`);
+  return HEX64(REGION_HASH(store, cx, cz, 1, 1));
+}
+
 /**
  * Hex digest of a stage's own outputs on column (cx, cz) (spec §7): climate C, E, W, T, H, R, PV at the 49
  * lattice points; shape offset0 … surfaceEst and the river flags; biome2d the lattice biome ids plus the
- * zoomed biome of each of the column's 256 blocks (where biomes.zoomJitter acts).
+ * zoomed biome of each of the column's 256 blocks (where biomes.zoomJitter acts); terrain the region hash of the
+ * generated column (blocks, fluid, aux A and aux B; SP3b spec §3.3).
  */
 export function stageOutputHash(ctx: GenContext, stage: OutputStage, cx: number, cz: number): string {
+  if (stage === 'terrain') return terrainHash(ctx, cx, cz);
   return hashSample(ctx, stage, BUILD(ctx, cx, cz, SAMPLE));
 }
 
@@ -515,10 +536,15 @@ const isGate = (path: string): boolean => GATE_KEYS.some((k) => path === `lakes.
 
 function stageOf(info: LeafInfo): OutputStage {
   const s = info.meta.stage;
-  if (s === undefined || !COLUMN_STAGES.includes(s)) throw new Error(`${info.path} is not a column-scope leaf`);
+  if (s === undefined || !OUTPUT_STAGES.includes(s)) throw new Error(`${info.path} is not a leaf of a stage U2 covers`);
   return s as OutputStage;
 }
 
+/** The leaves U2 decides, in schema order: home stage climate, shape, biome2d or terrain (SP3b spec §3.3). */
+export function u2Leaves(): readonly LeafInfo[] {
+  return SCHEMA_.leaves.filter((l) => l.meta.stage !== undefined && OUTPUT_STAGES.includes(l.meta.stage));
+}
+
 /** Cells of a square spiral from (0, 0): ring r ≥ 1 has 8r cells, from (−r, −r) along j = −r, then i = r, j = r, i = −r. */
 function someSpiralCell(max: number, visit: (i: number, j: number) => boolean): boolean {
   if (visit(0, 0)) return true;
@@ -595,28 +621,36 @@ export function findWitness(base: GenContext, path: string, skip: readonly Liven
   return witnessOf(base, info, variantContexts(base, info), skip, baseHasher(base));
 }
 
+function decide(base: GenContext, info: LeafInfo, columns: readonly LivenessColumn[], baseHash: BaseHash): LivenessResult {
+  const stage = stageOf(info);
+  const intended = intendedClass(info.path);
+  const variants = variantContexts(base, info);
+  const tried = stage === 'terrain' ? columns.filter((c) => TERRAIN_CLASSES.includes(c.cls)) : columns;
+  const order = [...tried.filter((c) => c.cls === intended), ...tried.filter((c) => c.cls !== intended)];
+  const hit = order.find((c) => variants.some((v) => stageOutputHash(v, stage, c.cx, c.cz) !== baseHash(stage, c.cx, c.cz)));
+  if (hit !== undefined) return { path: info.path, live: true, via: `${hit.cls} column (${hit.cx}, ${hit.cz})`, cls: hit.cls };
+  const w = stage === 'terrain' ? null : witnessOf(base, info, variants, columns, baseHash);
+  return w !== null ? { path: info.path, live: true, via: w, cls: null } : { path: info.path, live: false, via: null, cls: intended };
+}
+
 /**
- * U2 for every column-scope leaf: live when a perturbation changes the leaf's stage output hash on a class
- * column (its intended class first) or on its witness. value = live leaves / column-scope leaves.
+ * One leaf's U2 verdict over `columns` (the class columns of `base`): its stage output hash on the class columns (the
+ * intended class first; a `terrain` leaf only on the land and coast ones), then, except for a `terrain` leaf, the
+ * witness search.
+ */
+export function leafLiveness(base: GenContext, path: string, columns: readonly LivenessColumn[]): LivenessResult {
+  return decide(base, leafInfo(path), columns, baseHasher(base));
+}
+
+/**
+ * U2 for every leaf of `u2Leaves()`: live when a perturbation changes the leaf's stage output hash on a class
+ * column (its intended class first) or on its witness. value = live leaves / those leaves.
  */
 export function u2(seedText = '42'): { readonly value: number; readonly results: readonly LivenessResult[] } {
   const base = CREATE(SEED(seedText), RESOLVE('default'));
   const columns = livenessColumns(base);
   const baseHash = baseHasher(base);
-  const results: LivenessResult[] = [];
-  for (const info of SCHEMA_.leaves.filter((l) => l.meta.stage !== undefined && COLUMN_STAGES.includes(l.meta.stage))) {
-    const stage = stageOf(info);
-    const intended = intendedClass(info.path);
-    const variants = variantContexts(base, info);
-    const order = [...columns.filter((c) => c.cls === intended), ...columns.filter((c) => c.cls !== intended)];
-    const hit = order.find((c) => variants.some((v) => stageOutputHash(v, stage, c.cx, c.cz) !== baseHash(stage, c.cx, c.cz)));
-    if (hit !== undefined) {
-      results.push({ path: info.path, live: true, via: `${hit.cls} column (${hit.cx}, ${hit.cz})`, cls: hit.cls });
-      continue;
-    }
-    const w = witnessOf(base, info, variants, columns, baseHash);
-    results.push(w !== null ? { path: info.path, live: true, via: w, cls: null } : { path: info.path, live: false, via: null, cls: intended });
-  }
+  const results = u2Leaves().map((info) => decide(base, info, columns, baseHash));
   const live = results.filter((r) => r.live).length;
   return { value: results.length > 0 ? live / results.length : 0, results };
 }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/liveness.test.ts test/unit/terrainHeap.test.ts`

Expected: PASS (exit 0)

```
Test Files  2 passed (2)
Tests  23 passed (23)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  133 passed | 2 skipped (135)
Tests  1771 passed | 3 skipped (1774)
```

- [ ] **Step 6: Commit**

```bash
git add src/gen/column/lakes.ts src/gen/column/steep.ts src/metrics/liveness.ts test/unit/liveness.test.ts test/unit/terrainHeap.test.ts
git commit -F - <<'EOF'
feat(metrics,gen/column): U2 covers the terrain stage; T-stage heap-growth assertion

U2 gains the output stage `terrain` (SP3b spec §3.3): the hex of regionHash over
the 1 × 1 window after fillColumnT on a fresh ArrayBuffer store. A terrain leaf
is tried on the land and coast class columns only. The leaf filter becomes stage
∈ {climate, shape, biome2d, terrain}, so the five density.* leaves are decided
(all live on the first land column); U2 stays 1 (56 leaves).

SP2a minor 5 (§4): a unit test runs 1000 warm columns through fillColumnT and
freeColumn and bounds the heap growth after a full GC by 16 KiB. sampleLakes and
offset0At no longer allocate their tuple, record or climate per call (module
scratch; values unchanged); the remaining short-lived boxing is documented in
lakes.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `f31f442` on `dry/sp3a`; 5 files changed, 221 insertions(+), 35 deletions(-)):

Commit Task 10 on `dry/sp3b` (worktree `P/dry`, parent Task 9; 5 files, 221 insertions, 35 deletions). RED (the commit's 2 test files over the parent, in a throwaway worktree): 5 failed in `liveness.test.ts` (terrain hash ×1: `stageOutputHash(…, 'terrain', …)` falls through to the biome2d digest, `bbd606349c750303` ≠ the region hash `2e2dc7c32a63da7c`; density leaf moves only terrain ×1; `u2Leaves is not a function` ×1; `leafLiveness is not a function` ×2), plus 8 `tsc -p tsconfig.test.json` errors (the 2 missing exports, `'terrain'` not an `OutputStage` ×5, one implicit any). Two new tests pass on the parent by design: the density-leaf perturbation range test (perturbations are unchanged; it pins them) and `terrainHeap.test.ts` (the parent leaks nothing either; it is a guard). GREEN: typecheck clean; `npm test` 133 files passed, 2 skipped; 1752 tests passed, 3 skipped (49 s wall at load 5, another agent's metrics running); `GOVERNANCE_BASE=main` governance test passes; the new liveness tests take ≈ 180 ms, `terrainHeap.test.ts` 3.5-3.8 s. No golden, threshold, schema or baseline file changes, so no Threshold-log line.

- Ruling (API, `src/metrics/liveness.ts`): `OutputStage` gains `'terrain'`; `stageOutputHash(ctx, 'terrain', cx, cz)` = `hex64(regionHash(store, cx, cz, 1, 1))` after `fillColumnT(store, ctx, cx, cz, NEVER)` on a fresh `createStore({shared: false, maxBlockBytes: 1 MiB, maxByteBytes: 1 MiB})` per call (one column needs ≤ 24 block slots of the 128 and ≤ 26 byte slots of the 256 that 1 MiB holds; a stopped or failed generation throws). New exports: `u2Leaves()` (the schema leaves whose `meta.stage` ∈ {climate, shape, biome2d, terrain}, schema order) and `leafLiveness(base, path, columns)` (one leaf's verdict; `u2` maps the same internal `decide` over `u2Leaves()` with one shared base-hash memo). `liveness.ts` stays in DET_FILES and now value-imports `world/store/store` and `metrics/region` (metrics may). Cost if wrong: none.
- Ruling (which columns): §3.3's "U2's existing land and coast witness columns" is read as the land and coast CLASS columns of `livenessColumns` (2 + 2; U2 has no land/coast "witness" columns: witnesses are the fallback stream columns and lake-cell spiral). A `terrain` leaf is tried on those 4 only, intended class first (`intendedClass('density.*')` = 'land'), and gets NO stream-witness fallback: each witness try is three T columns (≈ 5 ms), so a dead leaf would cost ≈ 10 s for 2048 stream columns, and the spec names only these columns. A dead terrain leaf reports `{live: false, via: null, cls: 'land'}` (tested by passing only the 12 other class columns). `findWitness` still works for a terrain leaf if called directly (slow). Cost if wrong: a terrain leaf live only away from land/coast would read dead; adding the fallback is one line in `decide`.
- Spec defect: §3.3 "at U2's existing land and coast witness columns" → "at U2's land and coast class columns (no witness search for terrain leaves)".
- Ruling (perturbations): unchanged; the number and noise rules already clamp to the leaf range. Pinned for the density leaves: `detailAmpLo` 0.6 → [0.51, 0.69], `detailAmpHi` 1.5 → [1.275, 1.725] (at the maximum 8 → [6.8], the up step dropped), noise wavelengths × 0.85 / × 1.15 (detail 10 → 8.5, 11.5; jag 28 → 23.8, 32.2; overhang 80 → 68, 92), all inside their meta ranges. Cost if wrong: none.
- MEASUREMENT (U2, `params.metric.ts -t U2`, per tier; `u2()` is tier-independent, so every tier runs the same work; interleaved before/after runs, two rounds, load 2.4-3.4 from the other worktree's metrics): value 1 → 1 on fast, quick and full (51/51 leaves → 56/56); time fast 953/945 → 1042/1039 ms, quick 941/946 → 1019/1066 ms, full 1027/951 → 1034/1064 ms (≈ +0.1 s; 0.77 s before at load 0.2). The 5 density leaves are all decided on the first land column, (−25833, 16792), on every tier; the other 51 verdicts are identical to the parent's (`U2.leaves.json` diffed). Cost if wrong: none.
- Ruling (SP2a minor 5, the assertion, `test/unit/terrainHeap.test.ts`): "no-allocation … heap growth over 1000 columns below a fixed bound once the caches are warm" is implemented as RETAINED growth: 1000 columns of seed '42' (`testRng(1005)`, ±1024 chunks) go through `fillColumnT` + `freeColumn` on one `ArrayBuffer` store twice (same columns: the lake-cell memo, the stage's DensityContext, the pools and the JIT are warm after pass 1); `used_heap_size` after two forced full GCs (`v8.setFlagsFromString('--expose-gc')` + `vm.runInNewContext('gc')`, no new dependency, no vitest config change) before and after pass 2 must grow by < 16 KiB (16 bytes per column). Measured: −3.5 to −4.3 KiB over 5 runs, and passing in the full parallel suite at load 5. Mutation: one `{cx}` object retained per column in `terrainStage` gives +57.8 KiB and fails (a 64 KiB bound let it pass, hence 16 KiB). Cost if wrong: the test could flake if a V8 upgrade retains tens of KiB of code on pass 2; raise the bound, never drop the test.
- Ruling (why not "zero allocation"): the T stage's hot path cannot meet a literal zero-allocation assertion (SP1 spline test 11's "≤ 1 scavenge"): heap sampling (inspector `HeapProfiler.startSampling`, 300 warm columns) attributes ≈ 1.5 MB of short-lived garbage per column, almost all V8 boxing of doubles returned through non-inlined calls: `fillDensityColumn`'s `voxelFn` results 464 KiB, `NormalNoise.z2` 417 KiB, `lattice3` 283 KiB, compile.ts closures ≈ 290 KiB, the column stage ≈ 60 KiB (sampleClimate alone 5.7 KB per call). GCProfiler over 1000 warm columns: 179-187 scavenges, 1.46-1.52 MB per column, retained growth ≈ 0. Removing it would mean rewriting the closure compiler and the noise classes to write through typed scratch; the scavenges cost a few % of a 1.5 ms column, inside the 4 ms gate. Documented in `lakes.ts`'s header and the test's header. Cost if wrong: if the user wants literal zero allocation, it is a compiler/noise rewrite (SP4 performance work), not a minor.
- Ruling (lakes/steep, fixed): `sampleLakes` no longer allocates `lakeSpace`'s tuple and `nearestCell`'s `{cell, dist}` per call (internal `warpInto` → module `Float64Array(2)`, `nearestInto` → returns the cell, squared distance in a module `Float64Array(1)`; `dist = Math.sqrt(d2)` exactly as before); the exported `lakeSpace`/`nearestCell` keep their signatures (liveness and lakes.test use them) as wrappers. `offset0At` reuses one module `ClimateOut` instead of `newClimate()` per call (28 calls per ColumnSample for the halo ring). A lakeCell miss still allocates its memoised LakeCell (bounded by `CELL_CACHE_MAX`; nothing once warm), documented. Values are bit-identical (every golden test green, no goldens.json change). Per-call allocation measured with GCProfiler: `sampleLakes` 765 → 719 bytes, `offset0At` 5879 → 5847 bytes, `buildColumnSample` 612 → 605 KB (the rest is the boxing above). No failing-first test isolates these: the volumes are dominated by boxing and JIT-dependent; the existing lakes/shape/columnPoint tests and the goldens cover the refactor. Cost if wrong: none.

---

### Task 11: The slice split across workers

**Spec:** §6

**Files:**
- Modify: `src/engine/workerPool.ts`
- Modify: `src/ui/crossSection/model.ts`
- Modify: `src/workers/protocol.ts`
- Modify: `src/workers/sliceJob.ts`
- Modify: `src/workers/taskHandler.ts`
- Modify: `test/unit/protocol.test.ts`
- Modify: `test/unit/sliceJob.test.ts`
- Modify: `test/unit/workerPool.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/workers/protocol.ts`:
    - `export interface SliceMsg`
    - `export interface SliceResultMsg`
    - `export const slicePartIndex = (i: number, y: number, from: number, to: number): number => (319 - y) * (to - from) + (i - from);`
    - `export const sliceRangeProblem = (from: number, to: number): string | null =>`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/protocol.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/protocol.test.ts b/test/unit/protocol.test.ts
index a3b2088..840dd0b 100644
--- a/test/unit/protocol.test.ts
+++ b/test/unit/protocol.test.ts
@@ -10,7 +10,7 @@ import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
 import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode, type SplineLeaf } from '../../src/metrics/splineStats';
 import { paintTile, paintTileAbortable } from '../../src/gen/map/tile';
 import { leafOpts } from '../../src/ui/splineEditor/model';
-import { parseFromWorker, parseToWorker, pointInWindow, SLICE_SAMPLES, tileInWindow } from '../../src/workers/protocol';
+import { parseFromWorker, parseToWorker, pointInWindow, SLICE_ROWS, SLICE_SAMPLES, sliceIndex, slicePartIndex, tileInWindow } from '../../src/workers/protocol';
 import { createSliceJob } from '../../src/workers/sliceJob';
 import { createTaskHandler } from '../../src/workers/taskHandler';
 import { ctxFor } from '../harness/gen';
@@ -37,7 +37,7 @@ describe('parseToWorker', () => {
     expect(parseToWorker(stats(6, 3, 'splineStats', 0, 100, { len: 87, leaf: 'shape.offset', node: [6, 0] }))).not.toBeNull();
     expect(parseToWorker(stats(7, 3, 'biomeShares', 5, 5, { len: 31 }))).not.toBeNull();
     expect(parseToWorker(stats(8, 3, 'crossSection', 0, 512, line(5120, 3072, 6656, 3072)))).not.toBeNull();
-    expect(parseToWorker({ type: 'slice', jobId: 9, epoch: 3, ax: 5120, az: 3072, bx: 6656, bz: 3072 })).not.toBeNull();
+    expect(parseToWorker({ type: 'slice', jobId: 9, epoch: 3, ax: 5120, az: 3072, bx: 6656, bz: 3072, from: 0, to: 512 })).not.toBeNull();
   });
   test('crossSection ends are only checked to be numbers: outside the window, NaN or A = B parse, and the handler answers BAD_ARGS', () => {
     for (const args of [line(524288, 0, 0, 0), line(Number.NaN, 0, 1, 1), line(0, Infinity, 1, 1), line(7, 7, 7, 7)]) {
@@ -289,39 +289,79 @@ describe('task handler', () => {
 });
 
 describe('slice messages and the slice job (SP3a spec §5.1)', () => {
-  const slice = (jobId: number, epoch: number, ax: unknown, az: unknown, bx: unknown, bz: unknown) => ({ type: 'slice', jobId, epoch, ax, az, bx, bz });
+  const slice = (jobId: number, epoch: number, ax: unknown, az: unknown, bx: unknown, bz: unknown, from: unknown = 0, to: unknown = 512) => ({ type: 'slice', jobId, epoch, ax, az, bx, bz, from, to });
   const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
-  const coast = (jobId: number, epoch: number) => slice(jobId, epoch, COAST.ax, COAST.az, COAST.bx, COAST.bz);
+  const coast = (jobId: number, epoch: number, from = 0, to = 512) => slice(jobId, epoch, COAST.ax, COAST.az, COAST.bx, COAST.bz, from, to);
   const live = (s: { blockPool: { slotCount(): number; freeCount(): number }; bytePool: { slotCount(): number; freeCount(): number } }) =>
     [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];
 
-  test('parseToWorker: integer jobId and epoch, numeric ends (the window and A ≠ B are the handler\'s BAD_ARGS)', () => {
+  test('parseToWorker: integer jobId and epoch, numeric ends and range (the window, A ≠ B and the range are the handler\'s BAD_ARGS)', () => {
     expect(parseToWorker(coast(1, 0))).not.toBeNull();
-    for (const m of [slice(1, 0, 524288, 0, 0, 0), slice(1, 0, Number.NaN, 0, 1, 1), slice(1, 0, 7, 7, 7, 7)]) expect(parseToWorker(m)).not.toBeNull();
-    for (const m of [slice(1.5, 0, 0, 0, 1, 1), slice(1, null as unknown as number, 0, 0, 1, 1), slice(1, 0, '0', 0, 1, 1), slice(1, 0, 0, 0, 1, undefined), { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1 }]) {
+    for (const m of [slice(1, 0, 524288, 0, 0, 0), slice(1, 0, Number.NaN, 0, 1, 1), slice(1, 0, 7, 7, 7, 7), slice(1, 0, 0, 0, 1, 1, 1.5, 600), slice(1, 0, 0, 0, 1, 1, Number.NaN, -1)]) expect(parseToWorker(m)).not.toBeNull();
+    for (const m of [slice(1.5, 0, 0, 0, 1, 1), slice(1, null as unknown as number, 0, 0, 1, 1), slice(1, 0, '0', 0, 1, 1), slice(1, 0, 0, 0, 1, undefined), { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1, from: 0, to: 512 }]) {
+      expect(parseToWorker(m)).toBeNull();
+    }
+    // SP3b spec §6: the message carries from and to.
+    for (const m of [slice(1, 0, 0, 0, 1, 1, '0', 512), slice(1, 0, 0, 0, 1, 1, 0, null), { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1, bz: 1 }, { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1, bz: 1, from: 0 }]) {
       expect(parseToWorker(m)).toBeNull();
     }
   });
-  test('parseFromWorker: sliceResult carries 196 608 u16 block states and 196 608 fluid bytes in ArrayBuffers', () => {
-    const result = (blocks: unknown, fluid: unknown, jobId: unknown = 4) => ({ type: 'sliceResult', jobId, epoch: 2, blocks, fluid });
+  test('parseFromWorker: sliceResult carries its range [from, to) and (to − from)·384 u16 block states and fluid bytes in ArrayBuffers', () => {
+    const result = (blocks: unknown, fluid: unknown, jobId: unknown = 4, from: unknown = 0, to: unknown = 512) => ({ type: 'sliceResult', jobId, epoch: 2, from, to, blocks, fluid });
     expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).not.toBeNull();
     expect(parseFromWorker(result(new ArrayBuffer(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBeNull();
     expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(2 * SLICE_SAMPLES)))).toBeNull();
     expect(parseFromWorker(result(new Uint16Array(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBeNull();
     expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new Uint8Array(SLICE_SAMPLES)))).toBeNull();
     expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES), null))).toBeNull();
+    const part = (from: unknown, to: unknown, w: number) => ({ type: 'sliceResult', jobId: 4, epoch: 2, from, to, blocks: new ArrayBuffer(2 * SLICE_ROWS * w), fluid: new ArrayBuffer(SLICE_ROWS * w) });
+    for (const [from, to] of [[170, 341], [0, 1], [511, 512], [0, 512]] as const) expect(parseFromWorker(part(from, to, to - from))).not.toBeNull();
+    for (const [from, to, w] of [[170, 341, 170], [170, 341, 512], [0, 513, 513], [-1, 1, 2], [5, 5, 0], [1.5, 3, 1.5], ['0', 1, 1], [0, undefined, 512], [undefined, 512, 512]] as const) {
+      expect(parseFromWorker(part(from, to, w)), `[${from}, ${to}) with ${w} samples`).toBeNull();
+    }
   });
   test('a slice replies with the slice job\'s blocks and fluid, both transferred, at the job\'s epoch', () => {
     const h = createTaskHandler();
     h.handle(configure(3));
     const r = h.handle(coast(7, 3));
-    expect(r.msg).toMatchObject({ type: 'sliceResult', jobId: 7, epoch: 3 });
+    expect(r.msg).toMatchObject({ type: 'sliceResult', jobId: 7, epoch: 3, from: 0, to: 512 });
     if (r.msg.type !== 'sliceResult') return;
     expect(r.transfer).toEqual([r.msg.blocks, r.msg.fluid]);
     const want = createSliceJob().run(ctxFor('42'), 3, COAST, () => false)!;
     expect(sameBytes(r.msg.blocks, want.blocks)).toBe(true);
     expect(sameBytes(r.msg.fluid, want.fluid)).toBe(true);
   });
+  test('a slice of the range [from, to) replies with that part only, indexed (319 − y)·(to − from) + (i − from) (SP3b spec §6)', () => {
+    const h = createTaskHandler();
+    h.handle(configure(3));
+    const full = createSliceJob().run(ctxFor('42'), 3, COAST, () => false)!;
+    for (const [from, to] of [[0, 170], [170, 341], [341, 512], [255, 256]] as const) {
+      const r = h.handle(coast(8, 3, from, to));
+      expect(r.msg).toMatchObject({ type: 'sliceResult', jobId: 8, epoch: 3, from, to });
+      if (r.msg.type !== 'sliceResult') return;
+      expect(r.transfer).toEqual([r.msg.blocks, r.msg.fluid]);
+      const w = to - from;
+      expect([r.msg.blocks.byteLength, r.msg.fluid.byteLength]).toEqual([2 * SLICE_ROWS * w, SLICE_ROWS * w]);
+      const blocks = new Uint16Array(r.msg.blocks);
+      const fluid = new Uint8Array(r.msg.fluid);
+      for (const y of [319, 120, 63, 62, 0, -63, -64]) {
+        for (let i = from; i < to; i++) {
+          expect(blocks[slicePartIndex(i, y, from, to)]).toBe(full.blocks[sliceIndex(i, y)]);
+          expect(fluid[slicePartIndex(i, y, from, to)]).toBe(full.fluid[sliceIndex(i, y)]);
+        }
+      }
+    }
+  });
+  test('a range that is not integers with 0 ≤ from < to ≤ 512 is BAD_ARGS (SP3b spec §6)', () => {
+    const h = createTaskHandler();
+    h.handle(configure(3));
+    const bad = (from: number, to: number) => ['BAD_ARGS', 1, 3, `points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 512`];
+    for (const [from, to] of [[-1, 512], [0, 513], [5, 5], [6, 5], [1.5, 10], [0, 10.5], [Number.NaN, 10], [0, Number.POSITIVE_INFINITY], [-0.5, 0.5]] as const) {
+      const r = h.handle(coast(1, 3, from, to)).msg;
+      expect(r.type === 'error' ? [r.code, r.jobId, r.epoch, r.message] : [r.type]).toEqual(bad(from, to));
+    }
+    expect(h.handle(coast(2, 3, 511, 512)).msg.type).toBe('sliceResult');
+  });
   test('a slice before configure, of a stale epoch or whose line leaves the half-open window or has no length is refused', () => {
     const h = createTaskHandler();
     const reply = (m: unknown) => {
```

Modify `test/unit/sliceJob.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/sliceJob.test.ts b/test/unit/sliceJob.test.ts
index 725e016..ad30490 100644
--- a/test/unit/sliceJob.test.ts
+++ b/test/unit/sliceJob.test.ts
@@ -6,7 +6,7 @@ import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
 import { fluidLevel, fluidType, FLUID_WATER } from '../../src/world/blocks/fluid';
 import { REC_EPOCH } from '../../src/world/store/columnTable';
 import { createStore, type VoxelStore } from '../../src/world/store/store';
-import { SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
+import { SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, sliceIndex, slicePartIndex, sliceRangeProblem } from '../../src/workers/protocol';
 import { createSliceJob, SLICE_LRU_COLUMNS, SLICE_MAX_BLOCK_BYTES, SLICE_MAX_BYTE_BYTES, type SliceData } from '../../src/workers/sliceJob';
 import { ctxFor } from '../harness/gen';
 import { regionView } from '../harness/region';
@@ -32,9 +32,9 @@ const runOk = (job: ReturnType<typeof createSliceJob>, s: Segment, epoch = 0): S
 const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) =>
   Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
 /** The columns a segment's samples fall in, in sample order, each once. */
-const columnsOf = (s: Segment): Array<[number, number]> => {
+const columnsOf = (s: Segment, from = 0, to = SLICE_POINTS): Array<[number, number]> => {
   const out: Array<[number, number]> = [];
-  for (let i = 0; i < SLICE_POINTS; i++) {
+  for (let i = from; i < to; i++) {
     const [x, z] = segmentPointAt(s, i);
     const c: [number, number] = [Math.floor(x) >> 4, Math.floor(z) >> 4];
     const last = out[out.length - 1];
@@ -51,6 +51,17 @@ describe('slice layout (SP3a spec §5.1)', () => {
     expect([SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, CROSS_SECTION_POINTS]).toEqual([512, 384, 196608, 512]);
     expect([sliceIndex(0, 319), sliceIndex(511, 319), sliceIndex(0, 318), sliceIndex(7, -64), sliceIndex(511, -64)]).toEqual([0, 511, 512, 383 * 512 + 7, SLICE_SAMPLES - 1]);
   });
+  test('a part [from, to) holds sample (i, y) at (319 − y)·(to − from) + (i − from) (SP3b spec §6)', () => {
+    expect([slicePartIndex(0, 319, 0, 512), slicePartIndex(511, -64, 0, 512), slicePartIndex(7, -64, 0, 512)]).toEqual([0, SLICE_SAMPLES - 1, sliceIndex(7, -64)]);
+    expect([slicePartIndex(170, 319, 170, 341), slicePartIndex(340, 319, 170, 341), slicePartIndex(170, 318, 170, 341), slicePartIndex(340, -64, 170, 341)]).toEqual([0, 170, 171, 384 * 171 - 1]);
+    expect([slicePartIndex(511, 319, 511, 512), slicePartIndex(511, 0, 511, 512), slicePartIndex(511, -64, 511, 512)]).toEqual([0, 319, 383]);
+  });
+  test('a range is integers with 0 ≤ from < to ≤ 512 (SP3b spec §6)', () => {
+    for (const [from, to] of [[0, 512], [0, 1], [511, 512], [170, 341]]) expect(sliceRangeProblem(from!, to!)).toBeNull();
+    for (const [from, to] of [[-1, 10], [0, 513], [5, 5], [6, 5], [1.5, 10], [0, 10.5], [Number.NaN, 10], [0, Number.POSITIVE_INFINITY], [-0.5, 0.5]]) {
+      expect(sliceRangeProblem(from!, to!)).toBe(`points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 512`);
+    }
+  });
   test('the slice store: 32 MiB of blocks, 16 MiB of bytes, an LRU of 64 columns', () => {
     expect([SLICE_MAX_BLOCK_BYTES, SLICE_MAX_BYTE_BYTES, SLICE_LRU_COLUMNS]).toEqual([32 * MiB, 16 * MiB, 64]);
     const job = createSliceJob();
@@ -119,6 +130,47 @@ describe('slice job: samples (SP3a spec §5.1)', () => {
   });
 });
 
+describe('slice job: a range of the samples (SP3b spec §6)', () => {
+  let full: SliceData | null = null;
+  const fullCoast = () => (full ??= runOk(createSliceJob(), COAST));
+  test.each<[number, number]>([[0, 512], [0, 170], [170, 341], [341, 512], [100, 101], [511, 512], [0, 1]])('[%i, %i): the part holds the full slice\'s samples i ∈ [from, to), row by row; only the range\'s columns are generated', (from, to) => {
+    const job = createSliceJob();
+    const r = job.run(ctx, 0, COAST, NEVER, from, to);
+    if (r === null) throw new Error('slice stopped');
+    const w = to - from;
+    expect([r.blocks.length, r.fluid.length, r.blocks.buffer.byteLength, r.fluid.buffer.byteLength]).toEqual([w * SLICE_ROWS, w * SLICE_ROWS, 2 * w * SLICE_ROWS, w * SLICE_ROWS]);
+    const f = fullCoast();
+    for (let y = -64; y <= 319; y++) {
+      const at = sliceIndex(from, y);
+      expect(sameBytes(r.blocks.subarray(slicePartIndex(from, y, from, to), slicePartIndex(from, y, from, to) + w), f.blocks.subarray(at, at + w)), `blocks y ${y}`).toBe(true);
+      expect(sameBytes(r.fluid.subarray(slicePartIndex(from, y, from, to), slicePartIndex(from, y, from, to) + w), f.fluid.subarray(at, at + w)), `fluid y ${y}`).toBe(true);
+    }
+    const cols = columnsOf(COAST, from, to);
+    expect([job.misses, job.resident()]).toEqual([cols.length, cols]);
+  });
+  test('two ranges that share a column both generate it', () => {
+    const cols = columnsOf(COAST);
+    // A split point inside a column: samples k − 1 and k fall in the same column.
+    let k = 1;
+    while (k < SLICE_POINTS && String(columnsOf(COAST, k - 1, k)) !== String(columnsOf(COAST, k, k + 1))) k++;
+    expect(k).toBeLessThan(SLICE_POINTS);
+    const left = createSliceJob();
+    const right = createSliceJob();
+    expect(left.run(ctx, 0, COAST, NEVER, 0, k)).not.toBeNull();
+    expect(right.run(ctx, 0, COAST, NEVER, k, SLICE_POINTS)).not.toBeNull();
+    expect(left.resident().at(-1)).toEqual(right.resident()[0]);
+    expect([...left.resident(), ...right.resident().slice(1)]).toEqual(cols);
+    expect(left.misses + right.misses).toBe(cols.length + 1);
+  });
+  test('a bad range throws RangeError (the handler answers BAD_ARGS first)', () => {
+    const job = createSliceJob();
+    for (const [from, to] of [[-1, 10], [0, 513], [7, 7], [1.5, 10]]) {
+      expect(() => job.run(ctx, 0, COAST, NEVER, from!, to!)).toThrow(new RangeError(`slice: points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 512`));
+    }
+    expect(job.store).toBeNull();
+  });
+});
+
 describe('slice job: the LRU (SP3a spec §5.1)', () => {
   test('a second run of the same line generates nothing; the columns move to the most recent end', () => {
     const job = createSliceJob();
```

Modify `test/unit/workerPool.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/workerPool.test.ts b/test/unit/workerPool.test.ts
index 9bee1ef..3dcae01 100644
--- a/test/unit/workerPool.test.ts
+++ b/test/unit/workerPool.test.ts
@@ -438,29 +438,54 @@ describe('worker pool: probe (SP2b spec §2.8)', () => {
   });
 });
 
-describe('worker pool: slice jobs (SP3a spec §5.1)', () => {
+describe('worker pool: slice jobs (SP3a spec §5.1, split across workers: SP3b spec §6)', () => {
   const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
-  const slicesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'slice' ? [[m.jobId, m.epoch, m.ax, m.az, m.bx, m.bz]] : []));
+  /** About 170 columns: most samples in a column of their own, some columns shared by neighbouring samples. */
+  const LONG = { ax: -3000.5, az: -2100.25, bx: -1000.75, bz: -1500.5 };
+  const slicesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'slice' ? [[m.jobId, m.epoch, m.ax, m.az, m.bx, m.bz, m.from, m.to]] : []));
+  const rangesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'slice' ? [[m.from, m.to]] : []));
+  const same = (a: ArrayBufferView, b: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
+  const single = (s: typeof COAST) => createSliceJob().run(ctxFor('42'), 0, s, () => false)!;
 
-  test('a slice is one job on one worker at the stats priority (500: after preview tiles, before fine tiles); it resolves with the job\'s blocks and fluid', async () => {
+  test('a slice is split into pool.size contiguous ranges of the 512 samples, as stats splits, at the stats priority (500: after preview tiles, before fine tiles)', async () => {
     const log: ToWorker[] = [];
-    const pool = createWorkerPool(1, () => fakeWorker(log));
+    const pool = createWorkerPool(2, () => fakeWorker(log));
     const ready = pool.configure('42', DEFAULTS);
     const fine = pool.tile(tile(1), 1000);
     const got = pool.slice(COAST);
     const preview = pool.tile(tile(0), 3);
     await ready;
     const [, r] = await Promise.all([fine, got, preview]);
-    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? ['slice'] : []))).toEqual(['tile 0', 'slice', 'tile 1']);
-    expect(slicesOf(log).map((s) => s.slice(1))).toEqual([[0, COAST.ax, COAST.az, COAST.bx, COAST.bz]]);
-    const want = createSliceJob().run(ctxFor('42'), 0, COAST, () => false)!;
+    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? [`slice ${m.from}-${m.to}`] : []))).toEqual(['tile 0', 'slice 0-256', 'slice 256-512', 'tile 1']);
+    expect(slicesOf(log).map((s) => s.slice(1))).toEqual([[0, COAST.ax, COAST.az, COAST.bx, COAST.bz, 0, 256], [0, COAST.ax, COAST.az, COAST.bx, COAST.bz, 256, 512]]);
     expect(r.blocks).toBeInstanceOf(Uint16Array);
     expect(r.fluid).toBeInstanceOf(Uint8Array);
     expect([r.blocks.length, r.fluid.length]).toEqual([SLICE_SAMPLES, SLICE_SAMPLES]);
-    expect(Buffer.from(r.blocks.buffer).equals(Buffer.from(want.blocks.buffer))).toBe(true);
-    expect(Buffer.from(r.fluid.buffer).equals(Buffer.from(want.fluid.buffer))).toBe(true);
+    for (const [size, ranges] of [
+      [1, [[0, 512]]],
+      [3, [[0, 170], [170, 341], [341, 512]]],
+      [6, [[0, 85], [85, 170], [170, 256], [256, 341], [341, 426], [426, 512]]],
+    ] as const) {
+      const sized: ToWorker[] = [];
+      const p = createWorkerPool(size, () => fakeWorker(sized));
+      await p.configure('42', DEFAULTS);
+      await p.slice(COAST);
+      expect(rangesOf(sized), `size ${size}`).toEqual(ranges);
+      p.terminate();
+    }
   });
-  test('a priority can be given; probe shows the job as a slice of level null', async () => {
+  test.each([[1], [2], [3], [6]])('pool.size %i: the merged slice is byte-identical to the single-worker slice', async (size) => {
+    const pool = createWorkerPool(size, () => fakeWorker([]));
+    await pool.configure('42', DEFAULTS);
+    for (const s of [COAST, LONG, { ax: LONG.bx, az: LONG.bz, bx: LONG.ax, bz: LONG.az }]) {
+      const want = single(s);
+      const r = await pool.slice(s);
+      expect(same(r.blocks, want.blocks), `blocks ${JSON.stringify(s)}`).toBe(true);
+      expect(same(r.fluid, want.fluid), `fluid ${JSON.stringify(s)}`).toBe(true);
+    }
+    pool.terminate();
+  }, 60_000);
+  test('a priority can be given; probe shows each part as a slice of level null', async () => {
     const log: ToWorker[] = [];
     const pool = createWorkerPool(1, () => fakeWorker(log));
     const ready = pool.configure('42', DEFAULTS);
@@ -468,40 +493,99 @@ describe('worker pool: slice jobs (SP3a spec §5.1)', () => {
     await ready;
     await Promise.all(jobs);
     expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? ['slice'] : []))).toEqual(['tile 0', 'tile 1', 'slice']);
-    const idle = createWorkerPool(1, () => silentWorker());
+    const idle = createWorkerPool(2, () => silentWorker());
     void settle(idle.slice(COAST));
-    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'slice', epoch: -1, level: null }]);
+    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'slice', epoch: -1, level: null }, { worker: 1, type: 'slice', epoch: -1, level: null }]);
     idle.terminate();
   });
   test('a bad line rejects with the worker\'s BAD_ARGS', async () => {
-    const pool = createWorkerPool(1, () => fakeWorker([]));
+    const pool = createWorkerPool(2, () => fakeWorker([]));
     await pool.configure('42', DEFAULTS);
     await expect(pool.slice({ ax: 3, az: 3, bx: 3, bz: 3 })).rejects.toThrow(/^BAD_ARGS: A and B are the same point/);
     await expect(pool.slice({ ax: 0, az: 0, bx: 524288, bz: 0 })).rejects.toThrow(/^BAD_ARGS: B \(524288, 0\) is outside/);
   });
-  test('a configure rejects a queued slice with JobCancelled', async () => {
-    const pool = createWorkerPool(1, () => fakeWorker([]));
+  test('the first failing part rejects the request with its error and drops its queued siblings; nothing is retried', async () => {
+    const log: ToWorker[] = [];
+    let n = 0;
+    const gate = heldWorker(log, (m) => m.type === 'mapTile');
+    const pool = createWorkerPool(2, () => (n++ === 0 ? gate : fakeWorker(log)));
+    await pool.configure('42', DEFAULTS);
+    const held = pool.tile(tile(0), 0);
+    // Worker 1 is busy with the held tile: part 0 runs on worker 2, part 1 waits in the queue.
+    const req = settle(pool.slice({ ax: 3, az: 3, bx: 3, bz: 3 }));
+    expect(pool.queued).toBe(1);
+    const r = await req;
+    expect(r).toBeInstanceOf(Error);
+    expect((r as Error).message).toMatch(/^BAD_ARGS: A and B are the same point/);
+    expect([pool.queued, rangesOf(log)]).toEqual([0, [[0, 256]]]);
+    gate.flush();
+    expect((await held).rgba.byteLength).toBe(262144);
+    expect(rangesOf(log)).toEqual([[0, 256]]);
+    // The pool still slices.
+    expect((await pool.slice(COAST)).blocks.length).toBe(SLICE_SAMPLES);
+  });
+  test('a part reply for another range than its request rejects the request', async () => {
+    const pool = createWorkerPool(2, () => {
+      const inner = fakeWorker([]);
+      const w: WorkerLike = {
+        onmessage: null,
+        postMessage(msg) {
+          inner.onmessage = (e) => {
+            const d = e.data as { type: string; from?: number; to?: number };
+            // Swap the two halves' ranges in the replies (the lengths still fit the range they name).
+            if (d.type === 'sliceResult' && d.from === 256) { w.onmessage?.({ data: { ...d, from: 0, to: 256 } }); return; }
+            w.onmessage?.(e);
+          };
+          inner.postMessage(msg);
+        },
+        terminate() {},
+      };
+      return w;
+    });
+    await pool.configure('42', DEFAULTS);
+    await expect(pool.slice(COAST)).rejects.toThrow(/^slice part: samples \[0, 256\), expected \[256, 512\)$/);
+  });
+  test('a configure rejects every queued part with JobCancelled', async () => {
+    const log: ToWorker[] = [];
+    const pool = createWorkerPool(2, () => fakeWorker(log));
     const first = pool.configure('42', DEFAULTS);
     const req = settle(pool.slice(COAST));
+    expect(pool.queued).toBe(2);
     const second = pool.configure('7', DEFAULTS);
     expect(await settle(first)).toBeInstanceOf(JobCancelled);
     expect(await req).toBeInstanceOf(JobCancelled);
     expect((await second).epoch).toBe(1);
+    expect(rangesOf(log)).toEqual([]);
   });
-  test('an in-flight slice of a superseded epoch is aborted by the worker (ABORTED) and rejects as JobCancelled; the next slice runs', async () => {
+  test('in-flight parts of a superseded epoch are aborted by the workers (ABORTED) and reject as JobCancelled; the next slice runs', async () => {
     const cell = new Int32Array(new SharedArrayBuffer(4));
     const log: ToWorker[] = [];
     const replies: unknown[] = [];
-    const held = heldWorker(log, (m) => m.type === 'slice', replies);
-    const pool = createWorkerPool(1, () => held, { abortCell: cell });
+    const held = [heldWorker(log, (m) => m.type === 'slice', replies), heldWorker(log, (m) => m.type === 'slice', replies)];
+    let n = 0;
+    const pool = createWorkerPool(2, () => held[n++]!, { abortCell: cell });
     await pool.configure('42', DEFAULTS);
     const req = settle(pool.slice(COAST));
+    expect(pool.probe().busy).toBe(2);
     const next = pool.configure('42', DEFAULTS);
-    held.flush();
+    for (const w of held) w.flush();
+    expect(await req).toBeInstanceOf(JobCancelled);
+    expect(replies.filter((r) => (r as { code?: string }).code === 'ABORTED')).toEqual([expect.objectContaining({ type: 'error', epoch: 0 }), expect.objectContaining({ type: 'error', epoch: 0 })]);
+    expect((await next).epoch).toBe(1);
+    for (const w of held) w.holding = false;
+    const again = await pool.slice(COAST);
+    expect(same(again.blocks, single(COAST).blocks)).toBe(true);
+  });
+  test('a part answered after a configure without an abort cell (a stale epoch) rejects the request as JobCancelled', async () => {
+    const log: ToWorker[] = [];
+    const held = [heldWorker(log, (m) => m.type === 'slice'), heldWorker(log, (m) => m.type === 'slice')];
+    let n = 0;
+    const pool = createWorkerPool(2, () => held[n++]!);
+    await pool.configure('42', DEFAULTS);
+    const req = settle(pool.slice(COAST));
+    const next = pool.configure('7', DEFAULTS);
+    for (const w of held) w.flush();
     expect(await req).toBeInstanceOf(JobCancelled);
-    expect(replies).toContainEqual(expect.objectContaining({ type: 'error', epoch: 0, code: 'ABORTED' }));
     expect((await next).epoch).toBe(1);
-    held.holding = false;
-    expect((await pool.slice(COAST)).blocks.length).toBe(SLICE_SAMPLES);
   });
 });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/protocol.test.ts test/unit/sliceJob.test.ts test/unit/workerPool.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× parseToWorker: integer jobId and epoch, numeric ends and range (the window, A ≠ B and the range are the handler's BAD_ARGS) 5ms
× parseFromWorker: sliceResult carries its range [from, to) and (to − from)·384 u16 block states and fluid bytes in ArrayBuffers 1ms
× a slice replies with the slice job's blocks and fluid, both transferred, at the job's epoch 45ms
× a slice of the range [from, to) replies with that part only, indexed (319 − y)·(to − from) + (i − from) (SP3b spec §6) 49ms
× a range that is not integers with 0 ≤ from < to ≤ 512 is BAD_ARGS (SP3b spec §6) 21ms
× a slice is split into pool.size contiguous ranges of the 512 samples, as stats splits, at the stats priority (500: after preview tiles, before fine tiles) 157ms
× a priority can be given; probe shows each part as a slice of level null 135ms
× the first failing part rejects the request with its error and drops its queued siblings; nothing is retried 4ms
× a part reply for another range than its request rejects the request 242ms
× a configure rejects every queued part with JobCancelled 1ms
× in-flight parts of a superseded epoch are aborted by the workers (ABORTED) and reject as JobCancelled; the next slice runs 24ms
× a part [from, to) holds sample (i, y) at (319 − y)·(to − from) + (i − from) (SP3b spec §6) 3ms
× a range is integers with 0 ≤ from < to ≤ 512 (SP3b spec §6) 0ms
× [0, 512): the part holds the full slice's samples i ∈ [from, to), row by row; only the range's columns are generated 33ms
… (47 more lines)
Test Files  3 failed (3)
Tests  22 failed | 102 passed (124)
```

- [ ] **Step 3: Implement**

Modify `src/engine/workerPool.ts` (apply with `git apply`):

```diff
diff --git a/src/engine/workerPool.ts b/src/engine/workerPool.ts
index b9bc194..f42bc8a 100644
--- a/src/engine/workerPool.ts
+++ b/src/engine/workerPool.ts
@@ -8,14 +8,15 @@
  * with WorkerFailed. SP2b §5.4: a stats request runs as `size` slices whose raw sums are added element-wise
  * (a crossSection request as one job, §4.5).
  * SP2b §2.8: `probe()` reports what the workers run, for the latency hook.
- * SP3a §5.1: a slice request (the voxels under a line) runs as one job on one worker, as a crossSection does.
+ * SP3a §5.1, SP3b §6: a slice request (the voxels under a line) is split into `size` contiguous ranges of its 512
+ * samples, as a stats request is; the parts are merged row by row.
  */
 import type { MapLevel } from '../core/constants';
 import type { ColumnPoint } from '../gen/column/columnPoint';
 import type { Spawn } from '../gen/column/spawn';
 import type { LayerId } from '../gen/map/layers';
 import type { Segment } from '../metrics/crossSection';
-import { parseFromWorker, STATS_KINDS, type FromWorker, type ReadyMsg, type StatsArgs, type StatsKind, type StatsMsg, type ToWorker } from '../workers/protocol';
+import { parseFromWorker, SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, STATS_KINDS, type FromWorker, type ReadyMsg, type StatsArgs, type StatsKind, type StatsMsg, type ToWorker } from '../workers/protocol';
 
 export interface WorkerLike {
   postMessage(msg: ToWorker, transfer?: Transferable[]): void;
@@ -100,9 +101,13 @@ export interface WorkerPool {
    */
   stats<K extends StatsKind>(kind: K, n: number, args: StatsArgs<K>, priority?: number): Promise<Float64Array<ArrayBuffer>>;
   /**
-   * The slice under `segment` (SP3a spec §5.1): one job on one worker, never split, at `priority` (default 500, the
-   * stats priority). A configure rejects it with JobCancelled, and so does an ABORTED reply; a line with an end
-   * outside the half-open world window or of zero length rejects with the worker's BAD_ARGS.
+   * The slice under `segment` (SP3a spec §5.1), split as `stats` splits (SP3b spec §6): `size` jobs, one per
+   * contiguous range [from, to) of the 512 samples, at `priority` (default 500, the stats priority). Each part holds
+   * its range only, at `(319 − y)·(to − from) + (i − from)`, and is merged row by row into `(319 − y)·512 + i`; the
+   * result is byte-identical to a single job over the whole line. The first part that fails rejects the request with
+   * its error and drops its queued parts: a configure (or a reply of a superseded epoch, or ABORTED) rejects it with
+   * JobCancelled, and a line with an end outside the half-open world window or of zero length with the worker's
+   * BAD_ARGS.
    */
   slice(segment: Segment, priority?: number): Promise<SliceResult>;
   /** Recomputes one golden in a worker (no configure needed). */
@@ -121,7 +126,7 @@ interface Job {
   readonly priority: number;
   readonly msg: ToWorker;
   readonly tile: TileRequest | null;
-  /** The stats request the job is a slice of (0: none). */
+  /** The stats or slice request the job is a part of (0: none). */
   readonly group: number;
   readonly resolve: (v: FromWorker) => void;
   readonly reject: (e: Error) => void;
@@ -215,7 +220,7 @@ export function createWorkerPool(size: number, spawn: () => WorkerLike, opts: Po
     };
   });
 
-  /** Removes the queued slices of a stats request whose first slice failed (their promises are ignored). */
+  /** Removes the queued parts of a stats or slice request whose first part failed (their promises are ignored). */
   const dropGroup = (group: number) => {
     const dropped = queue.filter((j) => j.group === group);
     if (dropped.length === 0) return;
@@ -297,9 +302,33 @@ export function createWorkerPool(size: number, spawn: () => WorkerLike, opts: Po
     async slice(segment, priority = 500) {
       const e = epoch;
       const { ax, az, bx, bz } = segment;
-      const r = await enqueue(priority, (jobId) => ({ type: 'slice', jobId, epoch: e, ax, az, bx, bz }), null);
-      if (r.type !== 'sliceResult') throw new Error(`unexpected reply ${r.type}`);
-      return { blocks: new Uint16Array(r.blocks), fluid: new Uint8Array(r.fluid) };
+      const group = nextGroup++;
+      const ranges: Array<readonly [number, number]> = [];
+      const parts: Array<Promise<FromWorker>> = [];
+      for (let k = 0; k < size; k++) {
+        const from = Math.floor((k * SLICE_POINTS) / size);
+        const to = Math.floor(((k + 1) * SLICE_POINTS) / size);
+        if (from === to) continue;
+        ranges.push([from, to]);
+        parts.push(enqueue(priority, (jobId) => ({ type: 'slice', jobId, epoch: e, ax, az, bx, bz, from, to }), null, group));
+      }
+      const replies = await Promise.all(parts);
+      const blocks = new Uint16Array(SLICE_SAMPLES);
+      const fluid = new Uint8Array(SLICE_SAMPLES);
+      replies.forEach((r, k) => {
+        if (r.type !== 'sliceResult') throw new Error(`unexpected reply ${r.type}`);
+        const [from, to] = ranges[k]!;
+        if (r.from !== from || r.to !== to) throw new Error(`slice part: samples [${r.from}, ${r.to}), expected [${from}, ${to})`);
+        const w = to - from;
+        const b = new Uint16Array(r.blocks);
+        const f = new Uint8Array(r.fluid);
+        // Part row (319 − y) goes to the same row of the full slice, at column `from`.
+        for (let row = 0; row < SLICE_ROWS; row++) {
+          blocks.set(b.subarray(row * w, row * w + w), row * SLICE_POINTS + from);
+          fluid.set(f.subarray(row * w, row * w + w), row * SLICE_POINTS + from);
+        }
+      });
+      return { blocks, fluid };
     },
     async selftest(key) {
       const r = await enqueue(0, (jobId) => ({ type: 'selftest', jobId, key }), null);
```

Modify `src/ui/crossSection/model.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/crossSection/model.ts b/src/ui/crossSection/model.ts
index 9ce4840..4a6e8af 100644
--- a/src/ui/crossSection/model.ts
+++ b/src/ui/crossSection/model.ts
@@ -189,7 +189,7 @@ export interface SliceSource extends LineSource {
 
 export type SliceRequests = LineRequests<SliceResult>;
 
-/** The Voxels mode's requests (SP3a spec §5.2): `pool.slice(line)` (one job, abortable) per session epoch and line. */
+/** The Voxels mode's requests (SP3a spec §5.2): `pool.slice(line)` (split across the workers, abortable; SP3b spec §6) per session epoch and line. */
 export function createSliceRequests(src: SliceSource): SliceRequests {
   return createLineRequests(src, (at) => src.pool.slice(at));
 }
```

Modify `src/workers/protocol.ts` (apply with `git apply`):

```diff
diff --git a/src/workers/protocol.ts b/src/workers/protocol.ts
index 63c13d4..95e93d0 100644
--- a/src/workers/protocol.ts
+++ b/src/workers/protocol.ts
@@ -5,7 +5,8 @@
  * Configure carries the pool's abort cell (SP2b spec §2.2), errors carry the epoch of the message they
  * answer (§2.3), biome tiles carry the biome id of every pixel (§5.3), and a stats job returns the raw
  * sums of one kind over a range of the kind's fixed point stream (§5.4) or, for crossSection, of the points
- * along its line (§4.5). A slice job (SP3a spec §5.1) returns the voxels of the vertical slice under a line.
+ * along its line (§4.5). A slice job (SP3a spec §5.1) returns the voxels of the vertical slice under a line, for a
+ * range [from, to) of its 512 samples (SP3b spec §6: the pool splits a slice across its workers).
  */
 import { MAP_LEVELS, MAP_TILE_PX, type MapLevel } from '../core/constants';
 import type { StageId } from '../core/ids';
@@ -42,10 +43,15 @@ export type StatsMsg = SplineStatsMsg | BiomeSharesMsg | CrossSectionMsg;
 export type StatsKind = StatsMsg['kind'];
 export type StatsArgs<K extends StatsKind> = Extract<StatsMsg, { readonly kind: K }>['args'];
 /**
- * The vertical slice under the line A = (ax, az) → B = (bx, bz) (SP3a spec §5.1): one job, never split. The ends are
- * only checked to be numbers here; an end outside the half-open world window or A = B is the handler's BAD_ARGS.
+ * Samples [from, to) of the vertical slice under the line A = (ax, az) → B = (bx, bz) (SP3a spec §5.1; the range: SP3b
+ * spec §6). The ends and the range are only checked to be numbers here; an end outside the half-open world window,
+ * A = B, or a range that is not integers with 0 ≤ from < to ≤ 512 is the handler's BAD_ARGS.
  */
-export interface SliceMsg { readonly type: 'slice'; readonly jobId: number; readonly epoch: number; readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }
+export interface SliceMsg {
+  readonly type: 'slice'; readonly jobId: number; readonly epoch: number;
+  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
+  readonly from: number; readonly to: number;
+}
 export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SliceMsg | SelftestMsg;
 
 export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
@@ -60,10 +66,13 @@ export interface SpawnResultMsg { readonly type: 'spawnResult'; readonly jobId:
 /** `data` holds a Float64Array of the job's raw, unnormalised sums (transferred). */
 export interface StatsResultMsg { readonly type: 'statsResult'; readonly jobId: number; readonly epoch: number; readonly kind: StatsKind; readonly data: ArrayBuffer }
 /**
- * A slice's voxels (transferred): `blocks` holds SLICE_SAMPLES u16 block states and `fluid` SLICE_SAMPLES fluid
- * bytes, sample (i, y) at `sliceIndex(i, y)`.
+ * The voxels of samples [from, to) of a slice (transferred): `blocks` holds (to − from)·SLICE_ROWS u16 block states and
+ * `fluid` as many fluid bytes, sample (i, y) at `slicePartIndex(i, y, from, to)` (SP3b spec §6).
  */
-export interface SliceResultMsg { readonly type: 'sliceResult'; readonly jobId: number; readonly epoch: number; readonly blocks: ArrayBuffer; readonly fluid: ArrayBuffer }
+export interface SliceResultMsg {
+  readonly type: 'sliceResult'; readonly jobId: number; readonly epoch: number;
+  readonly from: number; readonly to: number; readonly blocks: ArrayBuffer; readonly fluid: ArrayBuffer;
+}
 /** One recomputed golden: the digest, or the error that stopped it. */
 export interface SelftestResultMsg { readonly type: 'selftestResult'; readonly jobId: number; readonly key: string; readonly actual: string | null; readonly error: string | null }
 export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SliceResultMsg | SelftestResultMsg | ErrorMsg;
@@ -76,6 +85,16 @@ export const SLICE_ROWS = 384;
 export const SLICE_SAMPLES = SLICE_POINTS * SLICE_ROWS;
 /** Index of sample (i, y) in a slice: row 0 is y 319, the order the Voxels mode draws in. */
 export const sliceIndex = (i: number, y: number): number => (319 - y) * SLICE_POINTS + i;
+/**
+ * Index of sample (i, y), i ∈ [from, to), in a part of a slice (SP3b spec §6): the part holds samples [from, to) only,
+ * row 0 at y 319. With from 0 and to 512 it is `sliceIndex`.
+ */
+export const slicePartIndex = (i: number, y: number, from: number, to: number): number => (319 - y) * (to - from) + (i - from);
+/** Why [from, to) is not a range of a slice's samples (integers with 0 ≤ from < to ≤ 512), or null when it is. */
+export const sliceRangeProblem = (from: number, to: number): string | null =>
+  Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= SLICE_POINTS
+    ? null
+    : `points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ ${SLICE_POINTS}`;
 
 const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
 const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
@@ -88,6 +107,7 @@ const isAbortCell = (v: unknown): boolean => v === null || (typeof SharedArrayBu
 export const STATS_KINDS: Readonly<Record<StatsKind, 'split' | 'single'>> = Object.freeze({ splineStats: 'split', biomeShares: 'split', crossSection: 'single' });
 const isStatsKind = (v: unknown): v is StatsKind => typeof v === 'string' && Object.hasOwn(STATS_KINDS, v);
 const SEGMENT_KEYS = ['ax', 'az', 'bx', 'bz'] as const;
+const SLICE_KEYS = [...SEGMENT_KEYS, 'from', 'to'] as const;
 /**
  * The shape of a stats job: a point range 0 ≤ from ≤ to and args with a positive integer len; splineStats
  * args also name a leaf (a string) and a node (an array of integers), crossSection args the ends of the line
@@ -140,7 +160,7 @@ export function parseToWorker(m: unknown): ToWorker | null {
     case 'stats':
       return statsOk(m) ? (m as unknown as StatsMsg) : null;
     case 'slice':
-      return isInt(m['jobId']) && isInt(m['epoch']) && SEGMENT_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SliceMsg) : null;
+      return isInt(m['jobId']) && isInt(m['epoch']) && SLICE_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SliceMsg) : null;
     case 'selftest':
       return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
     default:
@@ -169,7 +189,11 @@ export function parseFromWorker(m: unknown): FromWorker | null {
     case 'sliceResult': {
       const blocks = m['blocks'];
       const fluid = m['fluid'];
-      const ok = blocks instanceof ArrayBuffer && blocks.byteLength === 2 * SLICE_SAMPLES && fluid instanceof ArrayBuffer && fluid.byteLength === SLICE_SAMPLES;
+      const from = m['from'];
+      const to = m['to'];
+      if (typeof from !== 'number' || typeof to !== 'number' || sliceRangeProblem(from, to) !== null) return null;
+      const n = (to - from) * SLICE_ROWS;
+      const ok = blocks instanceof ArrayBuffer && blocks.byteLength === 2 * n && fluid instanceof ArrayBuffer && fluid.byteLength === n;
       return isInt(m['jobId']) && isInt(m['epoch']) && ok ? (m as unknown as SliceResultMsg) : null;
     }
     case 'error': return (m['jobId'] === null || isInt(m['jobId'])) && (m['epoch'] === null || isInt(m['epoch'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? (m as unknown as ErrorMsg) : null;
```

Modify `src/workers/sliceJob.ts` (apply with `git apply`):

```diff
diff --git a/src/workers/sliceJob.ts b/src/workers/sliceJob.ts
index d941462..5a5ccb4 100644
--- a/src/workers/sliceJob.ts
+++ b/src/workers/sliceJob.ts
@@ -1,7 +1,10 @@
 /**
  * The slice job (SP3a spec §5.1): the voxels of the vertical slice under a line, from a worker-local voxel store.
  * Sample (i, y) is the proto voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋), where (xᵢ, zᵢ) = `segmentPointAt(segment, i)`, for i 0 … 511 and
- * y −64 … 319, written at `sliceIndex(i, y)` (row 0 is y 319).
+ * y −64 … 319. A run covers a range [from, to) of the samples (SP3b spec §6: the pool gives each worker one range;
+ * the default is the whole line) and writes sample (i, y) at `slicePartIndex(i, y, from, to)` (row 0 is y 319; for
+ * the whole line that is `sliceIndex(i, y)`). Only the columns of the range's samples are generated, so a column two
+ * ranges share is generated by both workers.
  *
  * The store (an `ArrayBuffer` store of 32 MiB of blocks and 16 MiB of bytes) is created on the first run and kept;
  * an LRU keyed by colKey holds at most 64 generated columns of one epoch. The job walks the samples in order: a
@@ -17,7 +20,7 @@ import type { GenContext } from '../gen/context';
 import { segmentPointAt, segmentProblem, type Segment } from '../metrics/crossSection';
 import { fillColumnT } from '../metrics/region';
 import { createStore, type VoxelStore } from '../world/store/store';
-import { SLICE_POINTS, SLICE_SAMPLES } from './protocol';
+import { SLICE_POINTS, SLICE_ROWS, sliceRangeProblem } from './protocol';
 
 const COL_KEY = colKey;
 const TORUS = torusSlot;
@@ -26,16 +29,23 @@ const PROBLEM = segmentProblem;
 const FILL = fillColumnT;
 const CREATE_STORE = createStore;
 const N = SLICE_POINTS;
-const SAMPLES = SLICE_SAMPLES;
+const ROWS = SLICE_ROWS;
+const RANGE_PROBLEM = sliceRangeProblem;
 
 const MiB = 1 << 20;
-/** The slice store's pool maxima: 65 proto columns need at most 1,560 block and 1,625 byte slots (§5.1). */
+/**
+ * The slice store's pool maxima: 65 proto columns need at most 65 × 24 = 1,560 block slots and 65 × 26 = 1,690 byte
+ * slots (24 fluid sections, aux A and aux B; SP3a §5.1, SP3b §6), within the 4,096 slots of each.
+ */
 export const SLICE_MAX_BLOCK_BYTES = 32 * MiB;
 export const SLICE_MAX_BYTE_BYTES = 16 * MiB;
 /** Columns the slice store keeps between jobs. */
 export const SLICE_LRU_COLUMNS = 64;
 
-/** A slice's voxels: SLICE_SAMPLES block states and fluid bytes, sample (i, y) at `sliceIndex(i, y)`. */
+/**
+ * The voxels of samples [from, to) of a slice: (to − from)·SLICE_ROWS block states and fluid bytes, sample (i, y) at
+ * `slicePartIndex(i, y, from, to)` (`sliceIndex(i, y)` for the whole line).
+ */
 export interface SliceData {
   readonly blocks: Uint16Array<ArrayBuffer>;
   readonly fluid: Uint8Array<ArrayBuffer>;
@@ -43,11 +53,12 @@ export interface SliceData {
 
 export interface SliceJob {
   /**
-   * The slice under `segment`, with columns generated by `ctx` and claimed with `epoch`; null when `stop` fired. A
-   * run of another epoch than the resident columns' first frees them. Throws RangeError on a segment with a problem
-   * (`segmentProblem`: an end outside the window, or A = B).
+   * Samples [from, to) (default the whole line) of the slice under `segment`, with columns generated by `ctx` and
+   * claimed with `epoch`; null when `stop` fired. A run of another epoch than the resident columns' first frees them.
+   * Throws RangeError on a segment with a problem (`segmentProblem`: an end outside the window, or A = B) or a range
+   * that is not integers with 0 ≤ from < to ≤ 512 (`sliceRangeProblem`).
    */
-  run(ctx: GenContext, epoch: number, segment: Segment, stop: () => boolean): SliceData | null;
+  run(ctx: GenContext, epoch: number, segment: Segment, stop: () => boolean, from?: number, to?: number): SliceData | null;
   /** Frees every resident column and empties the LRU (a configure). */
   reset(): void;
   /** The slice store, null before the first run. */
@@ -124,20 +135,21 @@ export function createSliceJob(): SliceJob {
     get hits() { return hits; },
     resident: () => [...lru.values()].map((c): [number, number] => [c.cx, c.cz]),
     reset,
-    run(ctx, epoch, segment, stop) {
-      const problem = PROBLEM(segment);
+    run(ctx, epoch, segment, stop, from = 0, to = N) {
+      const problem = PROBLEM(segment) ?? RANGE_PROBLEM(from, to);
       if (problem !== null) throw new RangeError(`slice: ${problem}`);
       if (lruEpoch !== epoch) {
         reset();
         lruEpoch = epoch;
       }
       const st = store ??= CREATE_STORE({ shared: false, maxBlockBytes: SLICE_MAX_BLOCK_BYTES, maxByteBytes: SLICE_MAX_BYTE_BYTES });
-      const blocks = new Uint16Array(SAMPLES);
-      const fluid = new Uint8Array(SAMPLES);
+      const w = to - from;
+      const blocks = new Uint16Array(w * ROWS);
+      const fluid = new Uint8Array(w * ROWS);
       let curCx = 0;
       let curCz = 0;
       let loaded = false;
-      for (let i = 0; i < N; i++) {
+      for (let i = from; i < to; i++) {
         const [x, z] = POINT_AT(segment, i);
         const bx = Math.floor(x);
         const bz = Math.floor(z);
@@ -150,12 +162,12 @@ export function createSliceJob(): SliceJob {
           loaded = true;
         }
         const inSection = ((bz & 15) << 4) | (bx & 15);
-        // Row of y = 16·sy − 64 + ly is 319 − y = 383 − 16·sy − ly.
+        // Row of y = 16·sy − 64 + ly is 319 − y = 383 − 16·sy − ly; the part's rows are w samples wide.
         for (let sy = 0; sy < 24; sy++) {
           const b = secBlocks[sy]!;
           const f = secFluid[sy]!;
-          let at = (383 - 16 * sy) * N + i;
-          for (let ly = 0; ly < 16; ly++, at -= N) {
+          let at = (383 - 16 * sy) * w + (i - from);
+          for (let ly = 0; ly < 16; ly++, at -= w) {
             blocks[at] = typeof b === 'number' ? b : b[(ly << 8) | inSection]!;
             fluid[at] = typeof f === 'number' ? f : f[(ly << 8) | inSection]!;
           }
```

Modify `src/workers/taskHandler.ts` (apply with `git apply`):

```diff
diff --git a/src/workers/taskHandler.ts b/src/workers/taskHandler.ts
index 88f7702..62109ec 100644
--- a/src/workers/taskHandler.ts
+++ b/src/workers/taskHandler.ts
@@ -4,9 +4,9 @@
  * Tile, spawn, stats and slice jobs stop as soon as the pool's abort cell leaves their epoch and reply ABORTED
  * (SP2b spec §2.2); point and selftest jobs always run to the end. Stats jobs (§5.4) run the metrics
  * functions over a range of their kind's fixed point stream, or of the points along a crossSection's line
- * (§4.5), and reply with the raw sums. Slice jobs (SP3a spec §5.1) read the voxels under a line from the
- * handler's slice job (`sliceJob.ts`: a worker-local store and LRU kept for the handler's lifetime, emptied by every
- * configure) and stop like stats jobs.
+ * (§4.5), and reply with the raw sums. Slice jobs (SP3a spec §5.1) read the voxels of a range of the samples under
+ * a line (SP3b spec §6) from the handler's slice job (`sliceJob.ts`: a worker-local store and LRU kept for the
+ * handler's lifetime, emptied by every configure) and stop like stats jobs.
  */
 import { hex64 } from '../core/hash';
 import { checkParams } from '../core/params/kit';
@@ -22,7 +22,7 @@ import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength, segmentProb
 import type { Points } from '../metrics/noiseStats';
 import { computeAnyGolden } from '../metrics/sp2aGoldens';
 import { splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../metrics/splineStats';
-import { parseToWorker, type ErrorCode, type FromWorker, type StatsMsg } from './protocol';
+import { parseToWorker, sliceRangeProblem, type ErrorCode, type FromWorker, type StatsMsg } from './protocol';
 import { createSliceJob, type SliceJob } from './sliceJob';
 
 const HEX = hex64;
@@ -48,6 +48,7 @@ const SECTION_POINTS = CROSS_SECTION_POINTS;
 const SECTION_INTO = crossSectionInto;
 const SECTION_LEN = crossSectionLength;
 const SEGMENT_PROBLEM = segmentProblem;
+const RANGE_PROBLEM = sliceRangeProblem;
 const CREATE_SLICE_JOB = createSliceJob;
 
 export interface Reply {
@@ -167,11 +168,12 @@ export function createTaskHandler(slices: SliceJob = CREATE_SLICE_JOB()): TaskHa
         }
         if (m.type === 'slice') {
           const segment = { ax: m.ax, az: m.az, bx: m.bx, bz: m.bz };
-          const problem = SEGMENT_PROBLEM(segment);
+          const problem = SEGMENT_PROBLEM(segment) ?? RANGE_PROBLEM(m.from, m.to);
           if (problem !== null) return err(m.jobId, m.epoch, 'BAD_ARGS', problem);
-          const r = slices.run(ctx, m.epoch, segment, stopFor(m.epoch));
+          const r = slices.run(ctx, m.epoch, segment, stopFor(m.epoch), m.from, m.to);
           if (r === null) return aborted();
-          return { msg: { type: 'sliceResult', jobId: m.jobId, epoch, blocks: r.blocks.buffer, fluid: r.fluid.buffer }, transfer: [r.blocks.buffer, r.fluid.buffer] };
+          const msg: FromWorker = { type: 'sliceResult', jobId: m.jobId, epoch, from: m.from, to: m.to, blocks: r.blocks.buffer, fluid: r.fluid.buffer };
+          return { msg, transfer: [r.blocks.buffer, r.fluid.buffer] };
         }
         return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
       } catch (e) {
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/protocol.test.ts test/unit/sliceJob.test.ts test/unit/workerPool.test.ts`

Expected: PASS (exit 0)

```
Test Files  3 passed (3)
Tests  124 passed (124)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  133 passed | 2 skipped (135)
Tests  1791 passed | 3 skipped (1794)
```

- [ ] **Step 6: Commit**

```bash
git add src/engine/workerPool.ts src/ui/crossSection/model.ts src/workers/protocol.ts src/workers/sliceJob.ts src/workers/taskHandler.ts test/unit/protocol.test.ts test/unit/sliceJob.test.ts test/unit/workerPool.test.ts
git commit -F - <<'EOF'
feat(workers,engine): split the slice across the workers

pool.slice splits the 512 samples into one contiguous range per worker, as
pool.stats splits; the slice message and reply carry from/to (BAD_ARGS unless
integers with 0 <= from < to <= 512); each part holds its range at
(319 - y)*(to - from) + (i - from) and the pool merges the parts row by row
into (319 - y)*512 + i. The first failing part rejects and drops its queued
siblings; a stale epoch rejects as JobCancelled. The merged slice is
byte-identical to the single-worker slice (SP3b spec §6). The slice store's
bound comment becomes 65 x 26 = 1,690 byte slots.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `9c99235` on `dry/sp3a`; 8 files changed, 322 insertions(+), 79 deletions(-)):

Commit Task 11 on `dry/sp3b` (worktree `P/dry`, parent Task 10; 8 files, 322 insertions, 79 deletions). RED (the commit's 3 test files over the parent, in a throwaway worktree): 22 failed in 3 files (protocol ×5: the range in parse/reply, BAD_ARGS for a bad range, the part reply; sliceJob ×11: `slicePartIndex`/`sliceRangeProblem` not functions, parts are 196,608 samples long, a bad range does not throw, shared column not generated twice; workerPool ×6: one job instead of `size` parts, probe, first failing part, reply range check, queued parts on configure, ABORTED on both parts), plus 13 `tsc -p tsconfig.test.json` errors (the 2 missing exports, `run`'s 6 arguments, `SliceMsg.from/to`). Passing on the parent by design: "pool.size 1/2/3/6: the merged slice is byte-identical to the single-worker slice" (the parent's single job is that slice; the test pins the equivalence), "a bad line rejects with BAD_ARGS", and the no-abort-cell stale-epoch test. GREEN: typecheck clean; `npm test` 133 files passed, 2 skipped; 1772 tests passed, 3 skipped (37-51 s wall at load 1-10, another agent running metrics); the 3 files ≈ 8-9 s. No golden, threshold, schema or baseline file changes, so no Threshold-log line. uiSmoke (`node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX)`, own build, preview and headless Chrome, all stopped by the tool): `smoke: 77/77 checks pass`, exit 0; Voxels step "ground top y 21 to 252 · water on 14.5 % of the line, up to 42 deep", 38 colours.

- Ruling (API, `src/workers/protocol.ts`): `SliceMsg` gains `from, to`; `SliceResultMsg` also carries `from, to`, and `parseFromWorker` requires them to be a valid range with `blocks` 2·384·(to − from) and `fluid` 384·(to − from) bytes (the old fixed 2·SLICE_SAMPLES check cannot hold for parts). New exports `slicePartIndex(i, y, from, to) = (319 − y)·(to − from) + (i − from)` and `sliceRangeProblem(from, to)` (null, or `points [from, to) are not integers with 0 ≤ from < to ≤ 512`). The pool rejects a part whose reply names another range (`slice part: samples [a, b), expected [c, d)`). Cost if wrong: none.
- Ruling (BAD_ARGS vs BAD_MESSAGE): `parseToWorker` checks only that `from` and `to` are numbers (as it does for the line's ends), so a missing or non-numeric `from`/`to` is BAD_MESSAGE, and NaN, ±∞, fractions, negatives, `from ≥ to` and `to > 512` are the handler's BAD_ARGS (§6's wording). The segment is checked first, then the range. Cost if wrong: one guard moves.
- Ruling (split): `pool.slice` cuts [0, 512) exactly as `stats` does: `size` parts (the configured size, not the live count; parts queue onto the remaining workers), `from = ⌊k·512/size⌋`, empty parts skipped (never, since size ≤ 6), each an ordinary job at the slice's priority in one group, so the first failure rejects with its error and drops the queued siblings (the stats `dropGroup`); a configure rejects every queued part; an in-flight part of a superseded epoch (ABORTED or a stale reply) rejects as JobCancelled. The merge copies each part row into row `(319 − y)` of the full slice at column `from` (`Uint16Array.set`). Cost if wrong: none.
- Ruling (`sliceJob.run(ctx, epoch, segment, stop, from = 0, to = 512)`): the default range keeps every SP3a caller and test unchanged; a range generates only its samples' columns (a column two ranges share is generated by both workers, tested), throws RangeError on a bad range before creating the store. Each worker's LRU now holds its own range's columns; moving a line re-reads from that worker's LRU only. Cost if wrong: none.
- Ruling (store bound comment): "65 proto columns need at most 65 × 24 = 1,560 block slots and 65 × 26 = 1,690 byte slots (24 fluid sections, aux A and aux B), within the 4,096 slots of each"; not tested (arithmetic only; Task 8's slot-accounting tests already count aux B). Cost if wrong: none.
- Ruling (tests): byte-identical merged == single-worker slice for pool sizes 1, 2, 3, 6 over the coast line (≈ 6 columns, every range boundary inside a shared column), a ≈ 170-column line and its reverse; `fakeWorker`s run the real handler, each with its own slice store. The part layout is checked against the full slice per row (sliceJob) and per sample at 7 rows (handler). Cost if wrong: none.
- MEASUREMENT (a 512-sample line over 512 distinct columns, A (8.5, z) → B (8184.5, z), sample i in column (i, ⌊z⌋ >> 4); real Node worker threads running the bundled handler through `createWorkerPool`, throwaway vitest file not committed; each run on a fresh z so no LRU hit; 1 warm-up, 4 runs interleaved across pool sizes; 20 cores, load average 3.7-4.1 from the other worktree): 1 worker median 1068 ms (1001-1078), 2 workers 568 ms (565-574), 4 workers 377 ms (357-410), 6 workers (the browser pool's maximum, `poolSize`) 286 ms (261-316). The single-worker figure matches §6's "≈ 1 s"; the split is ≈ 3.7× faster at 6 workers. Cost if wrong: none (a timing, not a gate).
- Ruling (doc strings): `workerPool.ts`'s header and `slice` doc, `model.ts`'s `createSliceRequests` comment ("split across the workers"), and the headers of `protocol.ts`, `sliceJob.ts` and `taskHandler.ts` name SP3b §6. The SP3a spec §5.1 text ("one job, never split") is not amended here; Task 15 may note it. Cost if wrong: wording only.

---

### Task 12: The approved retune: lowland offset, the C 0.05 sigma node and the overhang noise

**Spec:** §8.3, §8.4, §9 (the user-approved retune)

**Files:**
- Modify: `README.md`
- Modify: `src/core/params/schema.ts`
- Modify: `src/core/params/shapeDefaults.ts`
- Modify: `test/goldens.json`
- Modify: `test/harness/reviewSlices.ts`
- Modify: `test/metrics/noise.metric.ts`
- Modify: `test/unit/columnStage.test.ts`
- Modify: `test/unit/densityDefaults.test.ts`
- Modify: `test/unit/liveness.test.ts`
- Modify: `test/unit/schemaSp2a.test.ts`
- Modify: `test/unit/schemaSp3b.test.ts`
- Create: `test/unit/terrainRetune.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces: no new exports from `src/` or the harness.

- [ ] **Step 1: Write the failing tests**

Modify `test/metrics/noise.metric.ts` (apply with `git apply`):

```diff
diff --git a/test/metrics/noise.metric.ts b/test/metrics/noise.metric.ts
index f976c49..d5a761c 100644
--- a/test/metrics/noise.metric.ts
+++ b/test/metrics/noise.metric.ts
@@ -116,7 +116,8 @@ metricTest('N5', ['horizontal', 'vertical'], () => {
       const h = lastOctaveWavelength(nz.def) / 128;
       const f: Field = nz.dims === 2 ? (x, _y, z) => nn.z2(x, z) : (x, y, z) => nn.z3(x, y, z);
       // The vertical rose is measured in lattice coordinates (SP3b spec §3.3, master §6.4 amended): the gradient of
-      // z3(x, y / yScale, z), so an anisotropic noise (overhang: yScale 1.25) is compared with itself on the lattice.
+      // z3(x, y / yScale, z), so an anisotropic noise (yScale ≠ 1; the overhang noise had 1.25 before the SP3b §8.4
+      // retune) is compared with itself on the lattice.
       const ys = nz.def.yScale;
       const g: Field = (x, y, z) => nn.z3(x, y / ys, z);
       const hr = new Rose();
```

Modify `test/unit/columnStage.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/columnStage.test.ts b/test/unit/columnStage.test.ts
index 18a1213..95d8308 100644
--- a/test/unit/columnStage.test.ts
+++ b/test/unit/columnStage.test.ts
@@ -38,7 +38,14 @@ describe('readout', () => {
     for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
       const x = 48 + 4 * i;
       const z = -80 + 4 * j;
-      for (const f of SAMPLE_FIELDS) expect(readField(s, f, x, z)).toBe(s.f[f][latticeIndex(i, j)]);
+      for (const f of SAMPLE_FIELDS) {
+        const v = s.f[f][latticeIndex(i, j)]!;
+        // The column's own block positions (lx, lz ≤ 15) see only corners i, j ≤ 3, read with weight 0: exact. The
+        // far corners (x or z = 16·c + 16, the neighbour's first block) are read as v00 + (v10 − v00)·1, which can
+        // round by an ulp (here steep at corner (4, 0), since the SP3b §8.4 retune).
+        if (i < 4 && j < 4) expect(readField(s, f, x, z)).toBe(v);
+        else expect(Math.abs(readField(s, f, x, z) - v)).toBeLessThanOrEqual(4 * Number.EPSILON * Math.max(1, Math.abs(v)));
+      }
       for (const f of LEVEL_FIELDS) expect(readLevel(s, f, x, z)).toBe(s.f[f][latticeIndex(i, j)]);
     }
   });
```

Modify `test/unit/densityDefaults.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/densityDefaults.test.ts b/test/unit/densityDefaults.test.ts
index 58ddf76..113d25e 100644
--- a/test/unit/densityDefaults.test.ts
+++ b/test/unit/densityDefaults.test.ts
@@ -232,8 +232,9 @@ describe('early-outs of the default expression (spec §3.2) and the driver on it
         }
       }
     }
-    // Both rules apply to most cells; few cells straddle the surface.
-    expect(above + below).toBeGreaterThan(0.8 * COLUMNS.length * 768);
+    // Both rules apply to most cells; few cells straddle the surface. Before the §8.4 retune: 3,269 of 3,840 cells
+    // decided by the rules, 177 evaluated; after it (larger σ, a wider open band): 3,029 and 289.
+    expect(above + below).toBeGreaterThan(0.75 * COLUMNS.length * 768);
     expect(below).toBeGreaterThan(COLUMNS.length * 16 * 4);
     expect(evaluated / (COLUMNS.length * 768)).toBeLessThan(0.1);
   });
```

Modify `test/unit/liveness.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/liveness.test.ts b/test/unit/liveness.test.ts
index c0dc8d3..1569aa2 100644
--- a/test/unit/liveness.test.ts
+++ b/test/unit/liveness.test.ts
@@ -205,12 +205,19 @@ describe('stage output hashes', () => {
   });
 
   test('a density leaf moves only the terrain hash', () => {
-    const c = columns().find((x) => x.cls === 'land')!;
+    // On the retuned defaults (SP3b §8.4) the first land column's solidity does not flip at detailAmpHi 1.725; the
+    // second does (U2 decides the leaf there too). The 2D hashes stay on both.
+    const lands = columns().filter((x) => x.cls === 'land');
+    expect(lands.length).toBe(2);
     const amp = moved('density.detailAmpHi', 1.725);
-    for (const st of ['climate', 'shape', 'biome2d'] as const) {
-      expect(stageOutputHash(amp, st, c.cx, c.cz), st).toBe(stageOutputHash(CTX, st, c.cx, c.cz));
+    let movedTerrain = 0;
+    for (const c of lands) {
+      for (const st of ['climate', 'shape', 'biome2d'] as const) {
+        expect(stageOutputHash(amp, st, c.cx, c.cz), st).toBe(stageOutputHash(CTX, st, c.cx, c.cz));
+      }
+      if (stageOutputHash(amp, 'terrain', c.cx, c.cz) !== stageOutputHash(CTX, 'terrain', c.cx, c.cz)) movedTerrain++;
     }
-    expect(stageOutputHash(amp, 'terrain', c.cx, c.cz)).not.toBe(stageOutputHash(CTX, 'terrain', c.cx, c.cz));
+    expect(movedTerrain).toBeGreaterThan(0);
   });
 
   test('a climate leaf moves the climate hash; the three hashes are distinct and repeatable', () => {
```

Modify `test/unit/schemaSp2a.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/schemaSp2a.test.ts b/test/unit/schemaSp2a.test.ts
index e0f2549..283d8ec 100644
--- a/test/unit/schemaSp2a.test.ts
+++ b/test/unit/schemaSp2a.test.ts
@@ -22,9 +22,9 @@ describe('SP2a schema groups', () => {
       ...g('biomes', 'biome2d', 'table:boxTable zoomJitter'),
     ]);
   });
-  test('shape defaults equal the frozen SP1 fixtures (until the first retune)', () => {
-    expect(canonicalJSON(DEFAULTS.shape.offset)).toBe(canonicalJSON(OFFSET));
-    expect(canonicalJSON(DEFAULTS.shape.sigma)).toBe(canonicalJSON(SIGMA));
+  test('shape defaults: jag equals the frozen SP1 fixture; offset and sigma differ from theirs (SP3b retune, terrainRetune.test.ts)', () => {
+    expect(canonicalJSON(DEFAULTS.shape.offset)).not.toBe(canonicalJSON(OFFSET));
+    expect(canonicalJSON(DEFAULTS.shape.sigma)).not.toBe(canonicalJSON(SIGMA));
     expect(canonicalJSON(DEFAULTS.shape.jag)).toBe(canonicalJSON(JAG));
   });
   test('the spline leaves are in blocks (SP2b §4.2)', () => {
```

Modify `test/unit/schemaSp3b.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/schemaSp3b.test.ts b/test/unit/schemaSp3b.test.ts
index 99b2ce1..ea5333f 100644
--- a/test/unit/schemaSp3b.test.ts
+++ b/test/unit/schemaSp3b.test.ts
@@ -25,14 +25,14 @@ describe('SP3b density group (spec §3.3)', () => {
     for (const p of ['density.detailAmpLo', 'density.detailAmpHi']) expect(metaOf(p)).toMatchObject({ min: 0, max: 8, step: 0.05, unit: 'blocks' });
   });
 
-  test('defaults: jag λ 28 × 2 octaves, overhang λ 80 yScale 1.25 × 3, detail λ 10 × 1; amplitudes 0.6 and 1.5', () => {
+  test('defaults: jag λ 28 × 2 octaves, overhang λ 32 yScale 1 × 2 (persistence 0.65, the §8.4 retune), detail λ 10 × 1; amplitudes 0.6 and 1.5', () => {
     const d = DEFAULTS.density;
-    const n = (x: typeof d.noises.jag) => [x.wavelength, x.octaves, x.yScale, x.remap, x.clampSigma, x.double];
-    expect(n(d.noises.jag)).toEqual([28, 2, 1, 'none', 3, true]);
-    expect(n(d.noises.overhang)).toEqual([80, 3, 1.25, 'none', 3, true]);
-    expect(n(d.noises.detail)).toEqual([10, 1, 1, 'none', 3, true]);
-    // λy = λ / yScale = 64 (spec §3.3: overhang λy 64).
-    expect(d.noises.overhang.wavelength / d.noises.overhang.yScale).toBe(64);
+    const n = (x: typeof d.noises.jag) => [x.wavelength, x.octaves, x.yScale, x.persistence, x.remap, x.clampSigma, x.double];
+    expect(n(d.noises.jag)).toEqual([28, 2, 1, 0.5, 'none', 3, true]);
+    expect(n(d.noises.overhang)).toEqual([32, 2, 1, 0.65, 'none', 3, true]);
+    expect(n(d.noises.detail)).toEqual([10, 1, 1, 0.5, 'none', 3, true]);
+    // λy = λ / yScale = 32 (spec §3.3 had λ 80, λy 64 before the retune).
+    expect(d.noises.overhang.wavelength / d.noises.overhang.yScale).toBe(32);
     expect([d.detailAmpLo, d.detailAmpHi]).toEqual([0.6, 1.5]);
   });
 
```

Create `test/unit/terrainRetune.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { autoTangents } from '../../src/core/spline/tangents';
import type { NestedSpline } from '../../src/core/spline/types';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { fillColumnT } from '../../src/metrics/region';
import { JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
import { AIR } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

/**
 * The SP3b retune (spec §8.4, approved by the user after the T1-T5 measurement): T1's lowland band and T2's overhangs
 * failed on the SP1 defaults, so the lowland offset knots, the C 0.05 sigma node and the overhang noise were retuned.
 * The SP1 fixtures stay frozen (they feed the SP1 goldens); the defaults now differ from them exactly at these knots.
 */

/** Every numeric knot of a nested spline, keyed by its path (`C 0.05 / E 0.2 / PV -1`). */
function knotYs(s: NestedSpline, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.points) {
    const key = `${prefix}${s.coord} ${p.x}`;
    if (typeof p.y === 'number') out[key] = p.y;
    else Object.assign(out, knotYs(p.y, `${key} / `));
  }
  return out;
}

/** The knots whose y differs from `base`'s, as [base y, y]; both splines must have the same knot paths. */
function movedKnots(s: NestedSpline, base: NestedSpline): Record<string, [number, number]> {
  const a = knotYs(base);
  const b = knotYs(s);
  expect(Object.keys(b)).toEqual(Object.keys(a));
  const out: Record<string, [number, number]> = {};
  for (const k of Object.keys(a)) if (a[k] !== b[k]) out[k] = [a[k]!, b[k]!];
  return out;
}

/** Tangents are autoTangents' (recomputed from the knots with every d zeroed). */
function zeroD(s: NestedSpline): NestedSpline {
  return { coord: s.coord, points: s.points.map((p) => ({ x: p.x, y: typeof p.y === 'number' ? p.y : zeroD(p.y), d: 0 })) };
}

describe('SP3b retune of the defaults (spec §8.4)', () => {
  test('shape.offset: only the lowland knots (C ≥ 0.05, E ≥ 0.2) move up; the coast and every E ≤ −0.4 knot stay', () => {
    expect(movedKnots(DEFAULTS.shape.offset, OFFSET)).toEqual({
      'C 0.05 / E 0.2 / PV -1': [65, 72], 'C 0.05 / E 0.2 / PV 0': [72, 84], 'C 0.05 / E 0.2 / PV 1': [80, 98],
      'C 0.05 / E 1': [66, 76],
      'C 0.3 / E 0.2 / PV -1': [66, 78], 'C 0.3 / E 0.2 / PV 0': [76, 92], 'C 0.3 / E 0.2 / PV 1': [88, 108],
      'C 0.3 / E 0.6': [70, 90], 'C 0.3 / E 1': [66, 86],
      'C 0.6 / E 0.2 / PV -1': [68, 86], 'C 0.6 / E 0.2 / PV 0': [82, 104], 'C 0.6 / E 0.2 / PV 1': [96, 124],
      'C 0.6 / E 1': [70, 102],
    });
    expect(canonicalJSON(DEFAULTS.shape.offset)).toBe(canonicalJSON(autoTangents(zeroD(DEFAULTS.shape.offset))));
  });

  test('shape.sigma: only the C 0.05 node moves (E −1 PV 12 … 26, E 0 6, E 1 3); jag stays SP1\'s fixture', () => {
    expect(movedKnots(DEFAULTS.shape.sigma, SIGMA)).toEqual({
      'C 0.05 / E -1 / PV -1': [4, 12], 'C 0.05 / E -1 / PV 1': [16, 26], 'C 0.05 / E 0': [3, 6], 'C 0.05 / E 1': [1.2, 3],
    });
    expect(canonicalJSON(DEFAULTS.shape.sigma)).toBe(canonicalJSON(autoTangents(zeroD(DEFAULTS.shape.sigma))));
    expect(canonicalJSON(DEFAULTS.shape.jag)).toBe(canonicalJSON(JAG));
  });

  test('overhang noise: λ 32, 2 octaves, persistence 0.65, yScale 1; no octave below λy 16 (2 × the 8-block corner step)', () => {
    const o = DEFAULTS.density.noises.overhang;
    expect([o.wavelength, o.octaves, o.persistence, o.yScale, o.lacunarity]).toEqual([32, 2, 0.65, 1, 2]);
    const shortestY = o.wavelength / o.yScale / o.lacunarity ** (o.octaves - 1);
    expect(shortestY).toBe(16);
  });

  /** Land tops and the land positions with ≥ 2 solid→air transitions at y ≥ top − 30 (T2's count) of one column. */
  function columnTops(cx: number, cz: number): { tops: number[]; overhangs: number } {
    const ctx = ctxFor('42');
    const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
    expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
    const v = store.proto(cx, cz)!;
    const aux = v.aux()!;
    const solid = new Uint8Array(98304);
    for (let sy = 0; sy < 24; sy++) {
      const b = v.sectionBlocks(sy);
      if (typeof b === 'number') solid.fill(b === AIR ? 0 : 1, sy << 12, (sy + 1) << 12);
      else for (let i = 0; i < 4096; i++) solid[(sy << 12) + i] = b[i] === AIR ? 0 : 1;
    }
    const tops: number[] = [];
    let overhangs = 0;
    for (let p = 0; p < 256; p++) {
      if (aux.worldSurfaceWG[p] !== aux.oceanFloorWG[p]) continue;
      const top = aux.worldSurfaceWG[p]! - 1;
      tops.push(top);
      let n = 0;
      for (let y = Math.max(-64, top - 30); y <= top; y++) if (solid[((y + 64) << 8) | p] === 1 && (y === 319 || solid[((y + 65) << 8) | p] === 0)) n++;
      if (n >= 2) overhangs++;
    }
    return { tops, overhangs };
  }

  test('a lowland plain on the raised knots tops above T1\'s old band [63, 73) (seed 42, column (−937, −1963))', () => {
    const p = columnPoint(ctxFor('42'), 16 * -937 + 8, 16 * -1963 + 8);
    expect(biomeFamily(p.biome)).toBe('lowland');
    expect(p.C).toBeGreaterThan(0.6);
    expect(p.E).toBeGreaterThan(0.2);
    const { tops } = columnTops(-937, -1963);
    expect(tops.length).toBe(256);
    // Before the retune: tops 70 … 73; after: 100 … 109.
    expect(Math.min(...tops)).toBeGreaterThan(90);
  });

  test('a high-σ highland column has overhangs (seed 42, column (−1015, −786))', () => {
    const p = columnPoint(ctxFor('42'), 16 * -1015 + 8, 16 * -786 + 8);
    expect(biomeFamily(p.biome)).toBe('highland');
    const { tops, overhangs } = columnTops(-1015, -786);
    expect(tops.length).toBe(256);
    // Before the retune: 0 of 256 (σ 10.3, overhang λ 80); after: 170 of 256 (σ 18.9, λ 32).
    expect(overhangs).toBeGreaterThanOrEqual(64);
    expect(p.sigma).toBeGreaterThan(16);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project metrics-fast --project unit test/metrics/noise.metric.ts test/unit/columnStage.test.ts test/unit/densityDefaults.test.ts test/unit/liveness.test.ts test/unit/schemaSp2a.test.ts test/unit/schemaSp3b.test.ts test/unit/terrainRetune.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× defaults: jag λ 28 × 2 octaves, overhang λ 32 yScale 1 × 2 (persistence 0.65, the §8.4 retune), detail λ 10 × 1; amplitudes 0.6 and 1.5 6ms
× shape defaults: jag equals the frozen SP1 fixture; offset and sigma differ from theirs (SP3b retune, terrainRetune.test.ts) 3ms
× shape.offset: only the lowland knots (C ≥ 0.05, E ≥ 0.2) move up; the coast and every E ≤ −0.4 knot stay 10ms
× shape.sigma: only the C 0.05 node moves (E −1 PV 12 … 26, E 0 6, E 1 3); jag stays SP1's fixture 1ms
× overhang noise: λ 32, 2 octaves, persistence 0.65, yScale 1; no octave below λy 16 (2 × the 8-block corner step) 1ms
× a lowland plain on the raised knots tops above T1's old band [63, 73) (seed 42, column (−937, −1963)) 40ms
× a high-σ highland column has overhangs (seed 42, column (−1015, −786)) 27ms
FAIL  |unit| test/unit/schemaSp2a.test.ts > SP2a schema groups > shape defaults: jag equals the frozen SP1 fixture; offset and sigma differ from theirs (SP3b retune, terrainRetune.test.ts)
AssertionError: expected '{"coord":"C","points":[{"d":0,"x":-1,…' not to be '{"coord":"C","points":[{"d":0,"x":-1,…' // Object.is equality
FAIL  |unit| test/unit/schemaSp3b.test.ts > SP3b density group (spec §3.3) > defaults: jag λ 28 × 2 octaves, overhang λ 32 yScale 1 × 2 (persistence 0.65, the §8.4 retune), detail λ 10 × 1; amplitudes 0.6 and 1.5
AssertionError: expected [ 80, 3, 1.25, 0.5, 'none', 3, true ] to deeply equal [ 32, 2, 1, 0.65, 'none', 3, true ]
FAIL  |unit| test/unit/terrainRetune.test.ts > SP3b retune of the defaults (spec §8.4) > shape.offset: only the lowland knots (C ≥ 0.05, E ≥ 0.2) move up; the coast and every E ≤ −0.4 knot stay
AssertionError: expected {} to deeply equal { …(13) }
FAIL  |unit| test/unit/terrainRetune.test.ts > SP3b retune of the defaults (spec §8.4) > shape.sigma: only the C 0.05 node moves (E −1 PV 12 … 26, E 0 6, E 1 3); jag stays SP1's fixture
… (7 more lines)
Test Files  3 failed | 4 passed (7)
Tests  7 failed | 72 passed (79)
```

- [ ] **Step 3: Implement**

Modify `README.md` (apply with `git apply`):

```diff
diff --git a/README.md b/README.md
index 9d2156b..7ce4472 100644
--- a/README.md
+++ b/README.md
@@ -51,8 +51,8 @@ Generated from `src/core/params/schema.ts` by `npm run docs:params`; a test fail
 | `climate.T` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":5000,"yScale":1} | wavelength 64 … 20000 |  | climate | Temperature: Cold ↔ hot; zones about twice the size of humidity zones. |
 | `climate.H` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":2400,"yScale":1} | wavelength 64 … 20000 |  | climate | Humidity: Dry ↔ wet. |
 | `climate.R` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":4,"persistence":0.5,"remap":"uniform","wavelength":1000,"yScale":1} | wavelength 64 … 20000 |  | climate | Rivers: Its zero set gives the river lines. |
-| `shape.offset` | spline | {"coord":"C","points":[{"d":0,"x":-1,"y":16},{"d":38.8888888888889,"x":-0.6,"y":26},{"d":72.5063938618926,"x":-0.4,"y":40},{"d":87.0967741935484,"x":-0.24,"y":52},{"d":0,"x":-0.16,"y":60},{"d":0,"x":-0.1,"y":{"coord":"E","points":[{"d":-8.5,"x":-1,"y":70},{"d":-1.71428571428571,"x":0,"y":64},{"d":0,"x":1,"y":63}]}},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":19,"x":-1,"y":72},{"d":28.1379310344828,"x":0,"y":96},{"d":39,"x":1,"y":130}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":12,"x":-1,"y":68},{"d":15.75,"x":0,"y":82},{"d":20,"x":1,"y":100}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":6.5,"x":-1,"y":65},{"d":7.46666666666667,"x":0,"y":72},{"d":8.5,"x":1,"y":80}]}},{"d":0,"x":1,"y":66}]}},{"d":0,"x":0.3,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":42.5,"x":-1,"y":80},{"d":47.3684210526316,"x":0,"y":125},{"d":52.5,"x":1,"y":175}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":16,"x":-1,"y":72},{"d":23.3333333333333,"x":0,"y":92},{"d":32,"x":1,"y":120}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":9,"x":-1,"y":66},{"d":10.9090909090909,"x":0,"y":76},{"d":13,"x":1,"y":88}]}},{"d":0,"x":0.6,"y":70},{"d":-10,"x":1,"y":66}]}},{"d":0,"x":0.6,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":60,"x":-1,"y":90},{"d":60,"x":0,"y":150},{"d":60,"x":1,"y":210}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":24,"x":-1,"y":76},{"d":31.5,"x":0,"y":104},{"d":40,"x":1,"y":140}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":14,"x":-1,"y":68},{"d":14,"x":0,"y":82},{"d":14,"x":1,"y":96}]}},{"d":0,"x":1,"y":70}]}}]} | -64 … 320 | blocks | terrain | Offset: Target surface y in blocks from C → E → PV. |
-| `shape.sigma` | spline | {"coord":"C","points":[{"d":0,"x":-1,"y":3},{"d":0,"x":-0.16,"y":3},{"d":0,"x":-0.1,"y":1.5},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":6,"x":-1,"y":4},{"d":6,"x":1,"y":16}]}},{"d":0,"x":0,"y":3},{"d":-1.8,"x":1,"y":1.2}]}}]} | -16 … 64 | blocks | terrain | Sigma: Sd of the 3D surface displacement in blocks (clamped at 0). |
+| `shape.offset` | spline | {"coord":"C","points":[{"d":0,"x":-1,"y":16},{"d":38.8888888888889,"x":-0.6,"y":26},{"d":72.5063938618926,"x":-0.4,"y":40},{"d":87.0967741935484,"x":-0.24,"y":52},{"d":0,"x":-0.16,"y":60},{"d":0,"x":-0.1,"y":{"coord":"E","points":[{"d":-8.5,"x":-1,"y":70},{"d":-1.71428571428571,"x":0,"y":64},{"d":0,"x":1,"y":63}]}},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":19,"x":-1,"y":72},{"d":28.1379310344828,"x":0,"y":96},{"d":39,"x":1,"y":130}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":12,"x":-1,"y":68},{"d":15.75,"x":0,"y":82},{"d":20,"x":1,"y":100}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":11,"x":-1,"y":72},{"d":12.9230769230769,"x":0,"y":84},{"d":15,"x":1,"y":98}]}},{"d":0,"x":1,"y":76}]}},{"d":0,"x":0.3,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":42.5,"x":-1,"y":80},{"d":47.3684210526316,"x":0,"y":125},{"d":52.5,"x":1,"y":175}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":16,"x":-1,"y":72},{"d":23.3333333333333,"x":0,"y":92},{"d":32,"x":1,"y":120}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":13,"x":-1,"y":78},{"d":14.9333333333333,"x":0,"y":92},{"d":17,"x":1,"y":108}]}},{"d":0,"x":0.6,"y":90},{"d":-10,"x":1,"y":86}]}},{"d":0,"x":0.6,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":60,"x":-1,"y":90},{"d":60,"x":0,"y":150},{"d":60,"x":1,"y":210}]}},{"d":0,"x":-0.4,"y":{"coord":"PV","points":[{"d":24,"x":-1,"y":76},{"d":31.5,"x":0,"y":104},{"d":40,"x":1,"y":140}]}},{"d":0,"x":0.2,"y":{"coord":"PV","points":[{"d":17,"x":-1,"y":86},{"d":18.9473684210526,"x":0,"y":104},{"d":21,"x":1,"y":124}]}},{"d":0,"x":1,"y":102}]}}]} | -64 … 320 | blocks | terrain | Offset: Target surface y in blocks from C → E → PV. |
+| `shape.sigma` | spline | {"coord":"C","points":[{"d":0,"x":-1,"y":3},{"d":0,"x":-0.16,"y":3},{"d":0,"x":-0.1,"y":1.5},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":7,"x":-1,"y":12},{"d":7,"x":1,"y":26}]}},{"d":0,"x":0,"y":6},{"d":-3,"x":1,"y":3}]}}]} | -16 … 64 | blocks | terrain | Sigma: Sd of the 3D surface displacement in blocks (clamped at 0). |
 | `shape.jag` | spline | {"coord":"C","points":[{"d":0,"x":-0.1,"y":0},{"d":0,"x":0.05,"y":{"coord":"E","points":[{"d":0,"x":-1,"y":{"coord":"PV","points":[{"d":0,"x":0.3,"y":0},{"d":79.1457286432161,"x":0.7,"y":30},{"d":86.9047619047619,"x":1,"y":55}]}},{"d":0,"x":-0.5,"y":{"coord":"PV","points":[{"d":0,"x":0.3,"y":0},{"d":79.1457286432161,"x":0.7,"y":30},{"d":86.9047619047619,"x":1,"y":55}]}},{"d":0,"x":-0.4,"y":0}]}}]} | -16 … 128 | blocks | terrain | Jaggedness: Amplitude of ridged peaks in blocks (clamped at 0). |
 | `rivers.widthMin` | number | 8 | 1 … 64 | blocks | terrain | Minimum width: Channel width where the width noise is lowest. |
 | `rivers.widthVar` | number | 12 | 0 … 64 | blocks | terrain | Width variation: Extra channel width where the width noise is highest. |
@@ -90,7 +90,7 @@ Generated from `src/core/params/schema.ts` by `npm run docs:params`; a test fail
 | `biomes.table` | boxTable | 26 rows | deep_ocean / ocean / warm_ocean / frozen_ocean / beach / snowy_beach / stony_shore / plains / meadow / forest / birch_forest / dark_forest / taiga / snowy_taiga / snowy_plains / desert / savanna / swamp / jungle / badlands / windswept_hills / snowy_slopes / stony_peaks / jagged_peaks / frozen_peaks / volcano |  | terrain | Biome boxes: Climate box, sign(W) filter and tie-break priority of every box-picked surface biome. |
 | `biomes.zoomJitter` | number | 1.5 | 0 … 2 | blocks | terrain | Zoom jitter: Jitter of the quart centres in the jittered-Voronoi zoom. |
 | `density.noises.jag` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.5,"remap":"none","wavelength":28,"yScale":1} | wavelength 16 … 8192 |  | terrain | Jag noise: Ridges of jagged peaks: J = (1 − \|z / clampSigma\|)², times the jag spline. |
-| `density.noises.overhang` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":3,"persistence":0.5,"remap":"none","wavelength":80,"yScale":1.25} | wavelength 16 … 8192 |  | terrain | Overhang noise: 3D surface displacement, times σ and the vertical slide (yScale 1.25: λy 64). |
+| `density.noises.overhang` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":2,"persistence":0.65,"remap":"none","wavelength":32,"yScale":1} | wavelength 16 … 8192 |  | terrain | Overhang noise: 3D surface displacement, times σ and the vertical slide (yScale 1: octaves at λy 32 and 16). |
 | `density.noises.detail` | noise | {"amplitudes":null,"clampSigma":3,"double":true,"lacunarity":2,"octaves":1,"persistence":0.5,"remap":"none","wavelength":10,"yScale":1} | wavelength 4 … 256 |  | terrain | Detail noise: Small 3D surface detail outside the interpolation, times the detail amplitude. |
 | `density.detailAmpLo` | number | 0.6 | 0 … 8 | blocks | terrain | Detail amplitude at E −1: Detail amplitude in blocks where E ≤ −1. |
 | `density.detailAmpHi` | number | 1.5 | 0 … 8 | blocks | terrain | Detail amplitude at E +1: Detail amplitude in blocks where E ≥ 1; linear in (E + 1) / 2 between the two. |
```

Modify `src/core/params/schema.ts` (apply with `git apply`):

```diff
diff --git a/src/core/params/schema.ts b/src/core/params/schema.ts
index abbb303..650aab6 100644
--- a/src/core/params/schema.ts
+++ b/src/core/params/schema.ts
@@ -30,7 +30,7 @@ const warp = (label: string, doc: string, amplitude: number, wavelength: number,
   });
 
 /** A density noise (SP3b spec §3.3): sampled at unscaled world block coordinates; remap 'none' (validateExpr; the schema refuses another). */
-const densityNoise = (label: string, doc: string, def: { readonly wavelength: number; readonly octaves: number; readonly yScale?: number }, dims: 2 | 3, wavelength: { readonly min: number; readonly max: number }) =>
+const densityNoise = (label: string, doc: string, def: { readonly wavelength: number; readonly octaves: number; readonly yScale?: number; readonly persistence?: number }, dims: 2 | 3, wavelength: { readonly min: number; readonly max: number }) =>
   noise(def, { ...TERRAIN, label, doc, wavelength, dims, remapNone: true });
 const amp = (def: number, label: string, doc: string) =>
   num(def, { ...TERRAIN, label, doc, unit: 'blocks', min: 0, max: 8, step: 0.05 });
@@ -103,7 +103,7 @@ export const ROOT = group('Parameters', 'World generation parameters.', {
   density: group('Density', 'Tunables of the default 3D density expression (SP3b spec §3); its structure is code until SP3d.', {
     noises: group('Density noises', 'Noises read by the density expression (noise2 / noise ops), at unscaled world block coordinates.', {
       jag: densityNoise('Jag noise', 'Ridges of jagged peaks: J = (1 − |z / clampSigma|)², times the jag spline.', { wavelength: 28, octaves: 2 }, 2, { min: 16, max: 8192 }),
-      overhang: densityNoise('Overhang noise', '3D surface displacement, times σ and the vertical slide (yScale 1.25: λy 64).', { wavelength: 80, octaves: 3, yScale: 1.25 }, 3, { min: 16, max: 8192 }),
+      overhang: densityNoise('Overhang noise', '3D surface displacement, times σ and the vertical slide (yScale 1: octaves at λy 32 and 16).', { wavelength: 32, octaves: 2, yScale: 1, persistence: 0.65 }, 3, { min: 16, max: 8192 }),
       detail: densityNoise('Detail noise', 'Small 3D surface detail outside the interpolation, times the detail amplitude.', { wavelength: 10, octaves: 1 }, 3, { min: 4, max: 256 }),
     }),
     detailAmpLo: amp(0.6, 'Detail amplitude at E −1', 'Detail amplitude in blocks where E ≤ −1.'),
```

Modify `src/core/params/shapeDefaults.ts` (apply with `git apply`):

```diff
diff --git a/src/core/params/shapeDefaults.ts b/src/core/params/shapeDefaults.ts
index 70a9a19..a96ef6e 100644
--- a/src/core/params/shapeDefaults.ts
+++ b/src/core/params/shapeDefaults.ts
@@ -1,6 +1,8 @@
 /**
- * Defaults of the shape splines (master §3.3, SP2a spec §2.2), authored with autoTangents. They start
- * equal to SP1's frozen OFFSET / SIGMA / JAG fixtures; a unit test pins that until the first retune.
+ * Defaults of the shape splines (master §3.3, SP2a spec §2.2), authored with autoTangents. They started
+ * equal to SP1's frozen OFFSET / SIGMA / JAG fixtures. SP3b's retune (SP3b spec §8.4) raised the lowland
+ * offset knots (C ≥ 0.05, E ≥ 0.2) and the C 0.05 sigma node; jag is unchanged. A unit test
+ * (terrainRetune.test.ts) pins exactly which knots differ from the fixtures.
  */
 import { autoTangents } from '../spline/tangents';
 import type { NestedSpline, SplineCoord } from '../spline/types';
@@ -13,14 +15,14 @@ const PVJ = (): NestedSpline => S('PV', [[0.3, 0], [0.7, 30], [1.0, 55]]);
 export const OFFSET_DEFAULT: NestedSpline = autoTangents(S('C', [
   [-1, 16], [-0.6, 26], [-0.4, 40], [-0.24, 52], [-0.16, 60],
   [-0.1, S('E', [[-1, 70], [0, 64], [1, 63]])],
-  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(65, 72, 80)], [1, 66]])],
-  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(66, 76, 88)], [0.6, 70], [1, 66]])],
-  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(68, 82, 96)], [1, 70]])],
+  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(72, 84, 98)], [1, 76]])],
+  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(78, 92, 108)], [0.6, 90], [1, 86]])],
+  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(86, 104, 124)], [1, 102]])],
 ]));
 
 export const SIGMA_DEFAULT: NestedSpline = autoTangents(S('C', [
   [-1, 3], [-0.16, 3], [-0.1, 1.5],
-  [0.05, S('E', [[-1, S('PV', [[-1, 4], [1, 16]])], [0, 3], [1, 1.2]])],
+  [0.05, S('E', [[-1, S('PV', [[-1, 12], [1, 26]])], [0, 6], [1, 3]])],
 ]));
 
 export const JAG_DEFAULT: NestedSpline = autoTangents(S('C', [
```

Modify `test/harness/reviewSlices.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/reviewSlices.ts b/test/harness/reviewSlices.ts
index cf93cb3..56b5aa0 100644
--- a/test/harness/reviewSlices.ts
+++ b/test/harness/reviewSlices.ts
@@ -95,7 +95,7 @@ export const REVIEW_SITES: readonly ReviewSite[] = [
     needs: ['lake', 'land'],
   },
   {
-    name: 'river', file: 'slice-river.png', kind: 'vertical', cx0: -972, w: 32, z: ROW_Z, yMin: 32, yMax: 95, scale: 2,
+    name: 'river', file: 'slice-river.png', kind: 'vertical', cx0: -972, w: 32, z: ROW_Z, yMin: 32, yMax: 127, scale: 2,
     needs: ['river', 'land'],
   },
   {
```

- [ ] **Step 4: Regenerate the governed files**

Before recording, restore the goldens from `main`, because `npm run test:goldens` refuses a changed key at an unchanged `GENERATOR_VERSION` and Tasks 8-9 already recorded version 4: `git show main:test/goldens.json > test/goldens.json`. Then record once.

Run: `npm run test:goldens`

The command writes `test/goldens.json`; the dry run's result:

Modify `test/goldens.json` (apply with `git apply`):

```diff
diff --git a/test/goldens.json b/test/goldens.json
index f6f59e8..b2a7c26 100644
--- a/test/goldens.json
+++ b/test/goldens.json
@@ -28,30 +28,30 @@
     "sp1.spline.OFFSET": "9d5ae62fbb06366d",
     "sp1.spline.SIGMA": "7163452d6496dba1",
     "sp1.spline.TANGENT_FIXTURE": "48c1ad609fc51ac9",
-    "sp2a.column.point.default": "901d82b3975139c2",
-    "sp2a.column.point.large_biomes": "fbfc7fcf202b9c71",
-    "sp2a.column.sample": "026e17f71d463678",
-    "sp2a.spawn": "4edb3e81ef087062",
+    "sp2a.column.point.default": "f6eea0b28a0d0b5d",
+    "sp2a.column.point.large_biomes": "e817c6995df09a87",
+    "sp2a.column.sample": "2d0575772b66c48b",
+    "sp2a.spawn": "ebf9cfffc8f8b0c7",
     "sp2a.tile.C.16": "3cbad99308c9a597",
     "sp2a.tile.C.256": "df02f1596684e5cd",
     "sp2a.tile.C.4": "154b3bda8afb6efd",
     "sp2a.tile.C.64": "d0d22bdc15560fc4",
-    "sp2a.tile.biome.16": "6e2b610d2ccf640a",
+    "sp2a.tile.biome.16": "e31830aa8db805be",
     "sp2a.tile.biome.256": "6d4706bd9dbe40c5",
     "sp2a.tile.biome.4": "85c6cc65316619ce",
-    "sp2a.tile.biome.64": "bf04282ca30077fa",
-    "sp2a.tile.relief.16": "83c7e575c763492b",
-    "sp2a.tile.relief.256": "ccd05d65032e5dd5",
-    "sp2a.tile.relief.4": "eb049779fda8b395",
-    "sp2a.tile.relief.64": "078b84f97d3afc63",
-    "sp2a.tile.rivers.16": "8fc6e210afdfed8c",
-    "sp2a.tile.rivers.256": "95bd582b209aa855",
-    "sp2a.tile.rivers.4": "72f6d6c446d76cb2",
-    "sp2a.tile.rivers.64": "6da7f75d7a9bfcaf",
-    "sp3a.region.T.default": "9f8fcdbf6d77185d",
-    "sp3a.region.T.large_biomes": "6241e62b03b2888d",
+    "sp2a.tile.biome.64": "a83c59568366276e",
+    "sp2a.tile.relief.16": "80b633886df6d2fa",
+    "sp2a.tile.relief.256": "5379c0cff8523945",
+    "sp2a.tile.relief.4": "d9fecde4976f44bb",
+    "sp2a.tile.relief.64": "524e0a9ee3fd9925",
+    "sp2a.tile.rivers.16": "7b1a03e31269d80b",
+    "sp2a.tile.rivers.256": "d075bd749fbcc025",
+    "sp2a.tile.rivers.4": "de3776fe6877fcd5",
+    "sp2a.tile.rivers.64": "9dc9184c9d07926c",
+    "sp3a.region.T.default": "e9992ef6d99595d4",
+    "sp3a.region.T.large_biomes": "6dcf464ccfb0f81d",
     "sp3a.registry": "5e1febd88b449b63",
-    "sp3b.density.default": "19922493ff26b9fc",
-    "sp3b.density.ops": "e8dd39531eaf2f5b"
+    "sp3b.density.default": "020212de61dc83da",
+    "sp3b.density.ops": "adad71e21efc60cb"
   }
 }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project metrics-fast --project unit test/metrics/noise.metric.ts test/unit/columnStage.test.ts test/unit/densityDefaults.test.ts test/unit/liveness.test.ts test/unit/schemaSp2a.test.ts test/unit/schemaSp3b.test.ts test/unit/terrainRetune.test.ts`

Expected: PASS (exit 0)

```
Test Files  7 passed (7)
Tests  79 passed (79)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  134 passed | 2 skipped (136)
Tests  1796 passed | 3 skipped (1799)
```

- [ ] **Step 7: Commit**

```bash
git add README.md src/core/params/schema.ts src/core/params/shapeDefaults.ts test/goldens.json test/harness/reviewSlices.ts test/metrics/noise.metric.ts test/unit/columnStage.test.ts test/unit/densityDefaults.test.ts test/unit/liveness.test.ts test/unit/schemaSp2a.test.ts test/unit/schemaSp3b.test.ts test/unit/terrainRetune.test.ts
git commit -F - <<'EOF'
feat(params): retune the lowland offset, the C 0.05 sigma node and the overhang noise

SP3b spec §8.4, approved by the user after the T1-T5 measurement: T1's
lowland band and T2's overhangs failed on the SP1 shape defaults. The
lowland offset knots (C >= 0.05, E >= 0.2) move up, the C 0.05 sigma node
rises (E -1 PV 12 ... 26, E 0 6, E 1 3), and density.noises.overhang goes
to lambda 32, 2 octaves, persistence 0.65, yScale 1. The SP1 fixtures stay
frozen; a test pins exactly which knots differ from them, and two seed-42
columns pin the voxel effect (a lowland plain above y 90, a high-sigma
column with overhangs). Goldens re-recorded once at GENERATOR_VERSION 4
from main's file; every 2D and noise metric, DT1 and DT2 pass on quick
and full.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `6b91b87` on `dry/sp3a`; 12 files changed, 186 insertions(+), 48 deletions(-)):

From "Task 12 — the approved retune (commit)":

Commit Task 12 on `dry/sp3b` (worktree `P/dry`, parent Task 11; 12 files, 186 insertions, 48 deletions). The src change is exactly `P/plan/task-12-candidate-retune.patch` plus the overhang doc string ("(yScale 1: octaves at λy 32 and 16)", was "(yScale 1.25: λy 64)") and the `shapeDefaults.ts` header. RED (the commit's 7 test files over the parent, in a `git archive` copy of Task 11): 7 failed in 3 files (terrainRetune ×5: no knot differs from the SP1 fixtures (offset, sigma), overhang `[80, 3, 0.5, 1.25, 2]` ≠ `[32, 2, 0.65, 1, 2]`, plain column min top 70 not > 90, high-σ column 0 overhang positions not ≥ 64; schemaSp2a ×1: offset still equals the fixture; schemaSp3b ×1: the overhang defaults), 0 `tsc -p tsconfig.test.json` errors; columnStage, densityDefaults, liveness and noise.metric pass on the parent by design (relaxed or comment-only, see below). GREEN: typecheck clean; `npm test` 134 files passed, 2 skipped; 1777 tests passed, 3 skipped (34-36 s wall, load 1-2); `GOVERNANCE_BASE=main` governance test passes; `npm run test:goldens` 51 s, all green; Bun `52/52 match on Bun 1.4.2 (JavaScriptCore)` in 6.4 s. `npm run test:metrics` 43 s and `npm run test:metrics:full` 108 s, all 19 metric tests green on both. No threshold, baseline or schema-lock change, so no Threshold-log line; no assets committed (Task 15 regenerates `assets/sp3b`).

- Ruling (the RED test, `test/unit/terrainRetune.test.ts`, 5 tests ≈ 0.1 s): (1) `shape.offset` differs from SP1's frozen `OFFSET` at exactly the 13 retuned knots (a path-keyed map `'C 0.05 / E 0.2 / PV -1': [65, 72]`, …; same knot paths otherwise), and its tangents are `autoTangents` of its knots; (2) the same for `shape.sigma` (4 knots) and `jag` still equals `JAG`; (3) overhang λ 32, 2 octaves, persistence 0.65, yScale 1, lacunarity 2, and its shortest octave's λy = 16 (2 × the 8-block corner step, §3.3's aliasing rule); (4) seed '42' column (−937, −1963), a plains column at C 0.93, E 0.77 (the C 0.6 / E 0.2 … 1 knots): all 256 positions are land with tops > 90 (before 70 … 73, after 100 … 109); (5) column (−1015, −786), badlands at σ 18.9 (was 10.3): ≥ 64 of 256 land positions with ≥ 2 solid→air transitions in [top − 30, top] (before 0, after 170). Both columns were found by a before/after scan of the Task 12 plain and mountain lines. Cost if wrong: none.
- Ruling (SP1 fixtures vs defaults): `src/metrics/sp1Fixtures.ts` is untouched (the `sp1.spline.*` goldens did not change). `schemaSp2a.test.ts`'s "shape defaults equal the frozen SP1 fixtures (until the first retune)" becomes "jag equals the fixture; offset and sigma differ from theirs (SP3b retune, terrainRetune.test.ts)": the exact pin of the new defaults lives in terrainRetune.test.ts. `schemaSp3b.test.ts`'s defaults test now pins persistence too and λy 32. Cost if wrong: none.
- Ruling (schema lock and docs): `test/schema-shape.lock.json` tracks leaf kinds only (no defaults), so `npm run test:accept-schema` was not run and the schema-shape test passes unchanged. `npm run docs:params` rewrote the README rows of `shape.offset`, `shape.sigma` and `density.noises.overhang` (3 lines). Cost if wrong: none.
- Ruling (tests the retune broke, fixed minimally):
  - `columnStage.test.ts` "exact at quart corners": `readField` at the far corners (i or j = 4, i.e. x or z = 16·c + 16, the neighbour's first block) computes v00 + (v10 − v00)·1, which is not exact in general; the retuned world exposed it (steep at corner (4, 0) of column (3, −5): 0.007975930042370278 vs …280, 1 ulp). The column's own positions (lx, lz ≤ 15) only read corners i, j ≤ 3 with weight 0, which stay `Object.is`-exact; the far corners are now checked within 4 ulp. `readField` is unchanged (no positionFn or stage read reaches u = 4). Cost if wrong: none.
  - `densityDefaults.test.ts` early-out coverage: cells decided by the §3.2 hand rules fell from 3,269 to 3,029 of 3,840 (78.9 %, the larger σ widens the open band) and evaluated cells rose from 177 to 289 (7.5 %); the 80 % floor becomes 75 % (the "< 10 % evaluated" bound and driver == probe at every voxel are unchanged). Cost if wrong: none.
  - `liveness.test.ts` "a density leaf moves only the terrain hash": `detailAmpHi` 1.725 no longer flips a voxel of the first land class column (−25833, 16792); U2 itself decides the leaf on the second land column (−15542, −30245). The test now runs both land class columns, requires the 2D hashes unchanged on both and the terrain hash moved on at least one. Cost if wrong: none.
  - `test/harness/reviewSlices.ts` river site crop y 32 … 95 → 32 … 127: the raised lowland puts tops up to 111 on the river line (columns −972 … −941, cz −2000). The lake (max 92) and coast crops still hold. Task 15 rewrites the sites anyway. Cost if wrong: none.
  - `noise.metric.ts`: the N5 comment no longer names the overhang as the anisotropic case. With yScale 1 no schema noise is anisotropic any more; the lattice-coordinate rose still covers any user edit of yScale. Cost if wrong: none.
- Ruling (goldens): `test/goldens.json` restored from `main`, then `npm run test:goldens` once. `git diff main -- test/goldens.json` changes exactly: `generatorVersion` 3 → 4; `sp1.params` 9bed26417b2ca0fb → 948e09daacb25342 (the same value Task 8 recorded: it hashes genKey, i.e. the version); `sp2a.column.point.default` → f6eea0b28a0d0b5d, `sp2a.column.point.large_biomes` → e817c6995df09a87, `sp2a.column.sample` → 2d0575772b66c48b, `sp2a.spawn` → ebf9cfffc8f8b0c7, `sp2a.tile.biome.16` → e31830aa8db805be, `sp2a.tile.biome.64` → a83c59568366276e, `sp2a.tile.relief.{4,16,64,256}` → d9fecde4976f44bb / 80b633886df6d2fa / 524e0a9ee3fd9925 / 5379c0cff8523945, `sp2a.tile.rivers.{4,16,64,256}` → de3776fe6877fcd5 / 7b1a03e31269d80b / 9dc9184c9d07926c / d075bd749fbcc025; `sp3a.region.T.default` → e9992ef6d99595d4, `sp3a.region.T.large_biomes` → 6dcf464ccfb0f81d; added `sp3b.density.default` 020212de61dc83da and `sp3b.density.ops` adad71e21efc60cb. Unchanged: every other `sp1.*` (incl. `sp1.spline.*`), `sp2a.tile.C.*`, `sp2a.tile.biome.4` and `.256` (the 4- and 256-block biome tiles do not cross a moved height threshold), `sp3a.registry`. Against Task 9's file the diff is the 18 sp2a/sp3a/sp3b values above. Cost if wrong: none.
- MEASUREMENT (2D and noise metrics, DT1, DT2; before = Task 11, after = Task 12; `npm run test:metrics` / `test:metrics:full`, all pass; `=` unchanged):

  | metric | quick before → after | full before → after |
  |---|---|---|
  | B1 | minShare 0.003743 → 0.003718; minRareShare 0.006518 =; largestLand 0.06830 → 0.06832; oceanFamily 0.4407 =; ties 0 =; outside 0.001735 = | minShare 0.003689 → 0.003663; minRareShare 0.006585 =; largestLand 0.06817 → 0.06820; oceanFamily 0.4408 =; ties 0 =; outside 0.001737 = |
  | B2 | medianLength 403.1 =; landShare 0.03180 → 0.03164; mouths 0.667 → 0.700; gorgesPer100km2 8133 → 7611; dryRiverBiome 0 = | medianLength 497.7 → 463.7; landShare 0.03521 → 0.03485; mouths 0.617 → 0.605; gorgesPer100km2 7573 → 6897; dryRiverBiome 0 = |
  | B4 | hotColdSpruceWindswept 0 =; coastBandBeach 0.9927 → 0.9916 | 0 =; 0.9903 → 0.9892 |
  | B5 | perKm2 1.364 → 1.435; highShare 0.474 → 0.650 | perKm2 1.170 → 1.199; highShare 0.462 → 0.750 |
  | T1lowland | 0.334 → 0.0761 | 0.335 → 0.0762 |
  | T6 | minGain/maxGain 10 (± 1e-13) = | 10 = |
  | T7 | 0.9866 → 0.9886; borderMismatch 0 = | 1.0015 → 0.9986; 0 = |
  | T8 | E 21.19 → 14.08 (min 10); PV 10.06 → 10.90 | E 21.28 → 14.14; PV 10.33 → 11.16 |
  | N4 | originSdRatio 0.901, spawnTopShare 0.125, spawnDistinct 17, spawnOnLand 1, all = | 0.903, 0.125, 17, 1, all = |
  | U2 | 1 = (56/56 leaves) | 1 = |
  | N1 | ksD 0.00937, sdErr 0.00865 = | 0.00620, 0.00525 = |
  | N2 | 0.01331 = | 0.01331 = |
  | N3 | 0.9785 = | 0.9862 = |
  | N5 | horizontal 1.0559, vertical 1.0482 = | 1.0414, 1.0376 = |
  | N6 | 0.000515 = | 0.000536 = |
  | DT1 | mismatches 0 = (10 regions, 9.8 s) | 0 = (40 regions, 48.3 s) |
  | DT2 | probeBulk 0, compiledReference 0 = (masked 5,167 → 5,217 of 8,192) | 0, 0 = (masked 20,737 → 20,866 of 32,768) |
  | M1, U4 | all 0 / 3 states = | = |

  N2-N6 are maxima over every schema and test noise; the new overhang noise (λ 32, 2 octaves, yScale 1) does not hold any of them on either tier, so they are bit-identical. T8.E (min 10) drops from 11.2 to 4.1 points of margin; the quick figures match Task 12's candidate run exactly. Cost if wrong: none.
- MEASUREMENT (the review shot): the Task 12 shots tool (`P/plan/task-12-zshots.metric.ts.draft`) reduced to the mountain site (z −12568, x −16864 … −15841, y −64 … 319, 1 px/block) on the committed defaults (no patch), run once as a throwaway metric file (deleted): `P/shots/task-12-retune/retuned-defaults-mountain.png` is byte-identical to `P/shots/task-12/after-mountain.png`, and its line stats match (tops 35 … 238, 74 of 1,024 overhang positions, 2,316 water voxels, 7 water-beside-dry-air faces). Cost if wrong: none.
- MEASUREMENT (fillColumnT cost after the retune; throwaway vitest file, not committed): 450 seed-'42' columns drawn by `testRng(777)` as `(u32 % 2048) − 1024` per axis (not Task 8's exact draw), first 50 per pass dropped, n = 400, the pre-retune params (SP1 offset/sigma/jag fixtures, overhang λ 80 3 oct yScale 1.25) and the retuned defaults interleaved, 3 runs, load 1.3: pre-retune p50 1.38 / 1.44 / 1.44 ms (p90 1.56-1.60, mean 1.39-1.47); retuned p50 1.55 / 1.49 / 1.50 ms (p90 1.78-1.87, mean 1.56-1.61), i.e. ≈ +4-12 % at p50 and ≈ +15 % at p90 (more straddling cells). Well inside `TERRAIN_P50_MAX_MS = 4`; the bench task re-measures on a quiet machine. Cost if wrong: none.
- Spec note (for the docs task): §3.3's table and departures paragraph ("λ 80, `yScale` 1.25 (λy 64), 3 octaves"; "overhang has λy 64"), §14's "overhang λy 64" and §15's "overhang λy 64 against aliasing" describe the pre-retune default; after §8.4 the default is λ 32, 2 octaves, persistence 0.65, yScale 1 (octaves at λy 32 and 16, still ≥ 2 × the corner step). The N5 lattice amendment stays (it matters for any yScale edit) but no default noise exercises it now. Cost if wrong: wording only.

From "Task 12":

NO COMMIT (parts fail). Branch `dry/sp3b-metrics` (worktree `P/dry-metrics`, from `dry/sp3b` Task 9, kept): `test/metrics/terrain.metric.ts` and the T1-T5 rows in `test/thresholds.ts` are left uncommitted there; copies: `P/plan/terrain.metric.ts.draft`, `P/plan/task-12-threshold-rows.patch`. The candidate retune: `P/plan/task-12-candidate-retune.patch` (src, not applied). Throwaway tools: `P/plan/task-12-{zcandidates.ts,zexplore.metric.ts,zshots.metric.ts}.draft`. Shots: `P/shots/task-12/` (+ `shots.txt`).

- MEASUREMENT (T1-T5 on the real T, `dry/sp3b` Task 9 defaults; each part = worse profile; seeds pooled per profile; the row thresholds were in `thresholds.ts` locally):

  | part (threshold) | fast default / large_biomes | quick default / large_biomes | full default / large_biomes | verdict |
  |---|---|---|---|---|
  | T1.band (≤ 0.25) | 0.415 / 0.371 | 0.426 / 0.339 | 0.420 / 0.339 | FAIL all tiers |
  | T1.span (≥ 60) | 109 / 113 | 103 / 99 | 98 / 99 | pass |
  | T1.above120 (≥ 0.06) | 0.140 / 0.180 | 0.151 / 0.156 | 0.134 / 0.148 | pass |
  | T1.above200 (≥ 0.005) | 0.0277 / 0.0271 | 0.0168 / 0.0145 | 0.0151 / 0.0146 | pass |
  | T2.overhangs (≥ 0.015) | 0.0016 / 0.0025 | 0.0023 / 0.0026 | 0.0020 / 0.0024 | FAIL all tiers (~7× short) |
  | T2.overhangsPeaks (≥ 0.10) | 0.0039 / 0.0061 | 0.0078 / 0.0075 | 0.0065 / 0.0075 | FAIL all tiers (~14× short) |
  | T3.value (≤ 1.5) | 3.80 / 2.15, pairs 366 / 565 (INSUFFICIENT < 2,000) | 2.51 / 1.30 (pairs 13,298 / 3,524) | 1.83 / 1.20 (pairs 146,576 / 50,659) | FAIL default all tiers; fast also insufficient sample |
  | T4.floorSd (≥ 3) | 9.03 / 3.08 | 7.76 / 3.23 | 5.75 / 3.26 | pass (large_biomes thin) |
  | T4.exposedBedrock (0) | 0 / 0 | 0 / 0 | 0 / 0 | pass (min floor 7 / 4) |
  | T4.deepFloor (0) | 0 / 0 | 0 / 0 | 0 / 0 | pass |
  | T5.median (≤ 1) | 1 / 1 | 1 / 1 | 1 / 1 | pass |
  | T5.p90 (≤ 2) | 2 / 2 | 2 / 2 | 2 / 2 | pass |
  | T5.p99 (≤ 6) | 3 / 3 | 3 / 3 | 3 / 3 | pass (max 19 / 30 on full) |

  Populations (default / large_biomes): fast 512 columns, land positions 71,888 / 67,390, peak columns 75 / 70 (positions 17,885 / 17,589), T5 single-surface 4,483 / 4,194; quick 2,048 columns, land 288,728 / 283,722, peak columns 303 / 270, T5 17,999 / 17,686; full 16,384 columns (4 seeds), land 2,252,446 / 2,272,062, peak columns 2,271 / 2,133, T5 140,551 / 141,597. T4 regions 1/4/16 per (profile, seed), site draws 3 / 28 / 456. Water-wall share (diagnostic, T3 + T4 regions): fast 1.05e-4, quick 1.32e-4, full 1.54e-4 (full: 178,612 wall voxels of 875 M water voxels in the T3 regions; 6,945 of 332 M in the T4 ocean regions). T3 within-family breakdown (quick, candidate run below, typical): highland borders 1.70, lowland 1.20 (default).
  Wall time (`npx vitest run --project metrics-<tier> test/metrics/terrain.metric.ts`, cold region cache, machine otherwise quiet, load < 1.5): fast 9.5 s (scattered 1.0 + 1.0 s, T3 6.2 s, T4 0.6 s), quick 34.1 s (scattered 3.7 + 3.8 s, T3 23.5 s, T4 2.4 s), full 340.9 s (scattered 30.3 + 29.9 s, T3 239.9 s, T4 39.9 s). Region cache after quick 1.2 GB, after full 9.3 GB (T3's 32 × 32 dumps are 27 MB each; full writes 256 of them).

- Ruling (sampling): T1, T2 and T5 read ONE scattered pass (`Xoshiro128(fnv1a32('T1-T5'))`, one stream over profiles then seeds), not one draw per metric: a column costs ≈ 1.5 ms and the three metrics are independent questions on the same columns; §8.1's "a fixed seed per metric" is read as "per metric family". T3 `fnv1a32('T3')`, T4 `fnv1a32('T4')` (T4 sites rejection-drawn until the 2D `columnPoint(...).offset` at the region centre is < 40). Cost if wrong: two more scattered passes (+60 s full).
- Ruling (profiles and seeds): seeds are pooled within a profile; every part's gated value is the worse of the two profiles; `<part>.<profile>` and the populations are recorded beside it in `.out/T*.json` (ungated keys). Cost if wrong: none.
- Ruling (definitions): solid = block ≠ air; land ⇔ `WORLD_SURFACE_WG === OCEAN_FLOOR_WG` (no water above the highest stone; exact given Task 8's closed-form aux A); a solid→air transition at y is solid(y) ∧ ¬solid(y + 1) (y + 1 = 320 is air); T2 counts y ∈ [top − 30, top], T5's single surface counts y ∈ [−56, top]; T1 "above120/200" = top > 120 / > 200 (master §6.4 "share y > 120"); quantiles nearest-rank; T3 pairs are the x and z neighbours inside each region (also across column borders), biome = aux A `surfaceBiome`, a pair whose biome has no inside pair is dropped and counted (0 dropped on every tier). Cost if wrong: none.
- Ruling (insufficient sample): `expect.soft(n).toBeGreaterThanOrEqual(min)` with the message "insufficient sample", per profile: T2 peak columns ≥ 20, T5 single-surface positions ≥ 1,000, T3 used border pairs ≥ 2,000. A soft failure fails the test while the values are still recorded. Cost if wrong: none.
- Ruling (water-wall diagnostic): computed on the T3 and T4 regions from aux A alone: a water voxel above its position's top at y is a wall voxel when an in-region x/z neighbour has `WORLD_SURFACE_WG ≤ y` (dry air beside water at the same y; above a neighbour's top, air is water iff y ≤ its WS − 1). Water and dry air UNDER stone (overhang pockets, Task 8: 39 voxels per 512 columns) are not counted. A per-voxel exact scan would cost ~100 M neighbour reads per 32 × 32 region. Cost if wrong: the share is a slight undercount.
- Spec defect: §8.1 "T3 uses 32 × 32-column regions: fast 4" with the 2,000-pair minimum → the fast tier always fails T3 with "insufficient sample" (366 default / 565 large_biomes pairs from 4 regions; quick 16 gives 13,298 / 3,524). Options: fast 16 regions like quick (T3 ≈ 23 s cold in `npm test`, ≈ 1 s on a cache hit), or a fast-tier minimum of 300 pairs, or T3 recorded but ungated on fast. The controller/user decides.
- Spec defect (cost): §8.1's region cache for the full tier writes 9.3 GB of dumps (256 T3 regions × 27 MB), and quick ≈ 1.2 GB, which is what the §7 CI `actions/cache` step would store for `test:metrics`. Suggest: T3/T4 regions `cache: false` (each region is read once per run) or a smaller T3 region (16 × 16, 4× more of them), or caching only the T3 aux A planes. Cost if wrong: CI cache size and local disk.
- Spec note (T3, no knob, §8.3 "a failure is reported and the user decides"): default fails on every tier (fast 3.80, quick 2.51, full 1.83); large_biomes passes (1.20-2.15, fast insufficient). The excess is in the highland family (quick, after the candidate: highland 1.70 vs lowland 1.20): windswept_hills / snowy_slopes / stony_peaks / jagged_peaks / frozen_peaks are separated by the picker's height and PV thresholds, so their borders run along slopes. The value falls with sample size (fast → full), so the fast/quick figures are also small-sample noisy.

- Knobs (§8.3) behind the failures:
  - T1.band: the lowland offset knots. 44 % of the 2D land offsets lie in [63, 73) (2D spike 8.4 % at 64; the C 0.05 … 0.6 flat ends at 66 … 70, E 0.2 PV3 65 … 96); the voxel band is the same window. σ only smears it (sigma alone: 0.43 → 0.41).
  - T2: σ and the overhang noise. Measured vertical derivative of the default overhang noise (λ 80, λy 64, 3 octaves): sd 0.062 per block, p99 0.14, max 0.24 (detail: 0.26). An overhang needs σ·∂N3/∂y > 1, so σ ≈ 16 at most gives ~3 % even at the column level; with σ alone even σ 12-40 in mountains reached only 1.2 % / 2.8 % (seed 42, 1,024 columns). The noise's wavelength (and persistence / yScale) must change too: "overhang noise amplitude/σ" in the controller's words.
  - T5 passes with the default detail amplitudes (no retune); T4 passes (no retune; the large_biomes floorSd 3.1-3.3 has little margin and is not touched by the candidate).

- Candidate retune (best found; `P/plan/task-12-candidate-retune.patch`; seed 42 exploration on 1,024-2,048 columns, then the quick tier with the patch applied to the defaults, not committed):
  - `shape.offset` lowland band: C 0.05: E 0.2 PV3(65, 72, 80) → (72, 84, 98), E 1 66 → 76; C 0.3: E 0.2 (66, 76, 88) → (78, 92, 108), E 0.6 70 → 90, E 1 66 → 86; C 0.6: E 0.2 (68, 82, 96) → (86, 104, 124), E 1 70 → 102. The coast knots (C ≤ −0.1) and every E ≤ −0.4 knot are unchanged.
  - `shape.sigma` C 0.05 node: E −1 PV(−1 → 4, 1 → 16) → (12, 26), E 0 3 → 6, E 1 1.2 → 3 (coast 1.5 and ocean 3 unchanged).
  - `density.noises.overhang`: λ 80 → 32, octaves 3 → 2, persistence 0.5 → 0.65, yScale 1.25 → 1 (λy 32 and 16: no octave below 2 × the 8-block corner spacing, the §3.3 aliasing rule; λ 32 with yScale 1.25 would put the 2nd octave at λy 12.8). Its doc string "(yScale 1.25: λy 64)" would change. `detailAmpLo/Hi` unchanged.
  - Quick tier with the candidate (default / large_biomes): T1.band 0.238 / 0.171 (pass, thin margin on default), span 105 / 110, above120 0.181 / 0.192, above200 0.0232 / 0.0209; T2.overhangs 0.0397 / 0.0444, overhangsPeaks 0.114 / 0.120 (pass); T3 1.64 / 1.35 (still fails default; no knob); T4 floorSd 7.46 / 3.16, 0 / 0 (pass); T5 median 1, p90 2, p99 4 / 4 (pass; multi-surface positions 53 → 1,158 of 18,056, so T5's population drops ~6 %, still ≫ 1,000). Water-wall share 1.30e-4 (unchanged).
  - 2D effects on the quick tier (before → candidate; all still pass): B1 minShare 0.003743 → 0.003717, minRareShare 0.006517 =, largestLand 0.0683 =, oceanFamily 0.4407 =, ties 0, outside 0.00174 =; B4 hotColdSpruceWindswept 0 =, coastBandBeach 0.9927 → 0.9916; T1lowland 0.334 → 0.076; B2 medianLength 403 =, landShare 0.0318 → 0.0316, mouths 0.667 → 0.700, gorgesPer100km2 8133 → 7611, dryRiverBiome 0; B5 perKm2 1.364 → 1.435, highShare 0.474 → 0.650; T6 10 / 10 =; T7 0.9866 → 0.9886, borderMismatch 0; T8 E 21.19 → 14.08 (min 10), PV 10.06 → 10.90; N4 unchanged (0.901, 0.125, 17, 1). The SP2a goldens built from the default profile would change (§8.4.3), and the shapeDefaults "equal to SP1's fixtures" unit pin would need its retune update.
  - Cost: the scattered pass got slower with the candidate (quick, includes surfaceEst3): default 3.73 → 4.31 s, large_biomes 3.77 → 5.90 s; T3 regions 23.5 → 52.7 s cold. The shorter overhang noise and larger σ widen the straddling band, so more cells run voxelFn: Task 13 must re-measure `terrain.real` against the 4 ms gate with whatever retune lands.
  - Weaker alternatives measured (seed 42, 1,024-2,048 columns, T1.band / T2 / T2peaks): σ only (12/40/10/5): 0.407 / 0.012 / 0.028; offset only (LOW_B): 0.282 / 0.0024 / 0.008; λ 40 2 oct p 0.65 with σ (10/36/8/4): 0.246 / 0.045 / 0.120 but with large floating blobs (σ 36); λ 32 y1 with milder σ (8/18/5/3): 0.240 / 0.025 / 0.072; (8/28/6/3): 0.239 / 0.038 / 0.108. The peaks part (≥ 10 %) is what forces σ ≈ 26 at PV 1.

- Review slices (`P/shots/task-12/`, seed '42', default, 1 px/block unless noted; numbers in `shots.txt`): the plain was found by a scan (64 consecutive columns of lowland biome with E > 0.4, C > 0.15, dry): z −31400, x −15408 … −14385; the coast is SP3a's (z −31992, x −27136 … −26113); the mountain is Task 6/8's σ > 8 site (z −12568, x −16864 … −15841), plus zooms (mountain 3 px, coast 4 px).
  - plain: before a flat strip at 62 … 85 with 1-2-block detail; after it sits at 63 … 116, a gently rolling plateau 20-30 blocks higher inland with a step down to the coast at its west end; still no overhang (0 of 1,024).
  - coast: before tops 19 … 144 with one 80-block jag spike; after 18 … 129, the same coastline and sea, the spike thinner with a 1-block needle on top; 2 overhang positions; water beside dry air along x 9 → 5.
  - mountain: before a steep single-surface massif 41 … 192 (0 overhangs); after 35 … 238, crests broken into arches, hooks and undercut ledges (74 of 1,024 land positions have ≥ 2 transitions), a few 3-6-block floating rocks above the peaks (a v0 artefact the user should judge), lowland on the west side rougher. The zoom shows a 20-block arch with a hole and a floating blob.

From "Controller — user decisions after the Task 12 measurement (2026-10-07)":

- User decision: ACCEPT the candidate retune of `task-12-candidate-retune.patch` as is — shape.offset lowland knots (C 0.05: E 0.2 PV3 (65,72,80)→(72,84,98), E 1 66→76; C 0.3: E 0.2 (66,76,88)→(78,92,108), E 0.6 70→90, E 1 66→86; C 0.6: E 0.2 (68,82,96)→(86,104,124), E 1 70→102), shape.sigma C 0.05 node (E −1 PV (4,16)→(12,26); E 0 3→6; E 1 1.2→3), density.noises.overhang λ 80→32, octaves 3→2, persistence 0.5→0.65, yScale 1.25→1. Small floating rocks above peaks are accepted for now; their amount is recorded as an ungated diagnostic (count of solid voxels with no solid voxel in their 6-neighbourhood path to the column's main body — or a simpler proxy the metric task defines: solid runs above the top-most air gap of ≥ 3 blocks whose height ≤ 6), and a "remove detached islets" cleanup is handed to SP3d/SP6.
- User decision: T3 gates ONLY borders between two different biomes of the `lowland` family (measured 1.20 on quick, passes); borders within `highland` (and other families) are recorded as an ungated diagnostic, since steep highland borders follow slopes by design.
- Ruling (controller): T3 is computed on neighbour pairs INSIDE the scattered columns already generated for T1/T2/T5 (x and z neighbours within each 16 × 16 column), not on harness regions — the full tier wrote 9.3 GB of region dumps and took 240 s for T3, and the fast tier could not reach its sample minimum; intra-column pairs cross biome borders just as well (the biome changes per block through the zoom). Its minimum sample stays 2,000 lowland border pairs. T4 keeps its 16 × 16 regions with `cache: false` (it is generated once per run; only DT1 uses the cache) — cost if wrong: none (pairs are the same statistic).
- Plan order from here: Task 12 = the retune (shape/density defaults, docs:params, every 2D metric re-run, goldens restored from main and re-recorded once at v4: sp1.params, sp2a.*, sp3a.region.T.*, sp3b.density.* may change), Task 13 = terrain metrics T1-T5 with rows, Task 14 = bench, Task 15 = review slices (assets regenerated on the retuned world), Task 16 = docs and exit evidence.

---

### Task 13: Terrain metrics T1-T5 on voxels with their rows; tier-gated threshold parts

**Spec:** §8.1, §8.2

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-architecture-design.md`
- Modify: `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md`
- Modify: `test/harness/lock.ts`
- Modify: `test/harness/metric.ts`
- Create: `test/metrics/terrain.metric.ts`
- Modify: `test/thresholds.lock.json`
- Modify: `test/thresholds.ts`
- Modify: `test/unit/lock.test.ts`
- Modify: `test/unit/metric.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `test/harness/metric.ts`:
    - `export function currentTier(): MetricsTier`
  - `test/thresholds.ts`:
    - `export type MetricsTier = 'fast' | 'quick' | 'full';`

- [ ] **Step 1: Write the failing tests**

Create `test/metrics/terrain.metric.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { expect } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { biomeFamily, biomeId, type BiomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import type { Params } from '../../src/core/params/schema';
import { AIR } from '../../src/world/blocks/index';
import type { AuxView, ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { metricTest } from '../harness/metric';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import { genRegion } from '../harness/region';
import type { RegionAttachMsg, RegionColumnMsg, RegionWorkerReply } from '../harness/regionWorker';

/**
 * T1-T5 on voxels (SP3b spec §8.1, §8.2): the real T stage's land heights (T1), overhangs (T2), lowland border steps
 * (T3), ocean floors (T4) and the 3D surface estimate (T5).
 *
 * Sampling (§8.1), per profile (default, large_biomes) and tier seed ('42'; full '42', '1', '2', '3'):
 * - Scattered columns (T1, T2, T3, T5): `COLUMNS` per (profile, seed), drawn by one `Xoshiro128(fnv1a32('T1-T5'))`
 *   uniformly over ±1024 chunks (default) or ±4096 (large_biomes), i.e. ±16384 / ±65536 blocks, generated on 4 region
 *   workers (`regionWorker.ts`, `forEachColumnThreaded` below) and read on this thread (every accumulator is order-independent). The four
 *   metrics read the same columns (one pass, memoised).
 * - T4 regions through the harness (`genRegion`, 4 threads, `cache: false`: each region is generated once per run):
 *   16 × 16 columns at sites whose 2D `offset` at the region's centre is < 40 (fast 4, quick 4, full 16 per
 *   (profile, seed); `Xoshiro128(fnv1a32('T4'))`, rejection-drawn over the same squares).
 *
 * Definitions (§8.2): solid = any block but air (stone; bedrock at y −64); a position is land when no water voxel lies
 * above its highest stone (`WORLD_SURFACE_WG === OCEAN_FLOOR_WG`), and its true top is `WORLD_SURFACE_WG − 1`; under
 * water the floor is `OCEAN_FLOOR_WG − 1`. A solid→air transition at y is solid(y) and not solid(y + 1) (y + 1 = 320 is air).
 * - T1 over all 256 positions of each column: `band` the largest share of land tops in [b, b + 10), `span` p95 − p5,
 *   `above120` / `above200` the shares of land tops > 120 / > 200 (master §6.4 "share y > 120").
 * - T2: `overhangs` the share of land positions with ≥ 2 transitions at y ≥ top − 30; `overhangsPeaks` the same over land
 *   positions whose aux A `surfaceBiome` is windswept_hills, snowy_slopes, stony_peaks, jagged_peaks or frozen_peaks.
 * - T3 over the land neighbour pairs (x and z) inside each scattered column (15 × 16 per axis; the biome is aux A's
 *   per-block `surfaceBiome`, so borders cross columns at every position): same biome → biome b's inside pairs; steep =
 *   |Δtop| ≥ 4; p_b = biome b's inside steep share over the same columns. `value` = Σ steep / Σ (p_a + p_b) / 2 over the
 *   pairs of two different biomes of the `lowland` family (the user's ruling: highland borders follow slopes by design).
 *   The same ratio for every other family, and over all same-family pairs (§8.2's wording), is an ungated diagnostic.
 *   `value` gates on the full tier only (its row's `tiers: ['full']`, the user's decision: a few dozen steep pairs make
 *   the fast and quick estimates noisy); fast and quick record it, and its 2,000-pair minimum holds on every tier.
 *   A pair whose biome has no inside pair is dropped and counted (`droppedPairs`).
 * - T4: `floorSd` the mean over regions of the sd of the floor under water; `exposedBedrock` floors at y −64 under
 *   water; `deepFloor` floors ≤ −50 under water.
 * - T5 at the 16 positions lx, lz ∈ {2, 6, 10, 14} of each column: land positions with exactly one transition at
 *   y ≥ −56; |surfaceEst3 − true top|, `median`, `p90`, `p99` (nearest rank).
 *
 * Each part's value is the worse of the two profiles (seeds pooled within a profile); the per-profile values and the
 * populations are recorded beside it (`<part>.<profile>`). A part below its minimum population (§8.1: peak positions
 * from 20 columns, 1,000 T5 positions, 2,000 lowland border pairs) fails with "insufficient sample".
 * Diagnostics (ungated, in `.out`):
 * - populations and seconds;
 * - the water-wall share (§4) over the scattered columns (in-column neighbours) and the T4 regions: water voxels above
 *   a position's top with a horizontally adjacent position whose surface (WORLD_SURFACE_WG) is at or below that y, i.e.
 *   dry air beside the water at the same y (water and dry air under stone are not counted);
 * - floating rocks (T2.json): a land position has one when, at or above y −56, a solid run of height ≤ 6 rests on an
 *   air gap of ≥ 3 blocks (a per-column proxy: it also counts thin ledges and arch roofs). `floatingRockShare` is the
 *   share of land positions with one, `floatingRockVoxels` the voxels in such runs per land position.
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const PROFILES = ['default', 'large_biomes'] as const;
type Profile = (typeof PROFILES)[number];
const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const RANGE: Readonly<Record<Profile, number>> = { default: 1024, large_biomes: 4096 };
/**
 * Columns per (profile, seed), sized by T3's 2,000 lowland border pairs (§8.1's 512 / 2048 / 4096 give ≈ 0.64 such
 * pairs per default column and ≈ 0.17 per large_biomes one, whose biomes are 4 times larger): fast 4096 / 16384 measure
 * 2,613 / 2,843 pairs on seed '42'.
 */
const COLUMNS: Readonly<Record<Profile, number>> = pick(
  { default: 4096, large_biomes: 16384 },
  { default: 8192, large_biomes: 32768 },
  { default: 4096, large_biomes: 16384 },
);
const T4_REGIONS = pick(4, 4, 16);
const WORKER_DIR = `terrainRegionWorker-${TIER}`;
const SCATTER_WORKER_DIR = `terrainScatterWorker-${TIER}`;

const MIN_PEAK_COLUMNS = 20;
const MIN_T5_POSITIONS = 1000;
const MIN_T3_PAIRS = 2000;

const PEAKS = new Set(['windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks'].map((n) => biomeId(n as Parameters<typeof biomeId>[0])));
const T5_LOCAL = [2, 6, 10, 14];
const T3_FAMILY: BiomeFamily = 'lowland';
const FLOAT_MAX_HEIGHT = 6;
const FLOAT_MIN_GAP = 3;

/** Fails the running metric test (soft) when a population is below its minimum. */
function requireSample(what: string, n: number, min: number): void {
  expect.soft(n, `${what}: insufficient sample (${n} < ${min})`).toBeGreaterThanOrEqual(min);
}

/** Column solidity, index ((y + 64) << 8) | (lz << 4) | lx, from the proto sections. */
function solidity(view: ColumnView, out: Uint8Array): Uint8Array {
  for (let sy = 0; sy < 24; sy++) {
    const b = view.sectionBlocks(sy);
    const base = sy << 12;
    if (typeof b === 'number') out.fill(b === AIR ? 0 : 1, base, base + 4096);
    else for (let i = 0; i < 4096; i++) out[base + i] = b[i] === AIR ? 0 : 1;
  }
  return out;
}

/** Solid→air transitions at y ∈ [y0, y1] (y0 ≥ −64) of position p. */
function transitions(solid: Uint8Array, p: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = Math.max(-64, y0); y <= y1; y++) {
    if (solid[((y + 64) << 8) | p] === 1 && (y === 319 || solid[((y + 65) << 8) | p] === 0)) n++;
  }
  return n;
}

/** Voxels of position p in solid runs of height ≤ 6 resting on an air gap of ≥ 3 blocks, at y ∈ [−56, top]. */
function floatingVoxels(solid: Uint8Array, p: number, top: number): number {
  let voxels = 0;
  let gap = 0;
  let run = 0;
  let runGap = 0;
  for (let y = -56; y <= top + 1; y++) {
    const s = y <= 319 && solid[((y + 64) << 8) | p] === 1;
    if (s) {
      if (run === 0) runGap = gap;
      run++;
      gap = 0;
    } else {
      if (run > 0 && run <= FLOAT_MAX_HEIGHT && runGap >= FLOAT_MIN_GAP) voxels += run;
      run = 0;
      gap++;
    }
  }
  return voxels;
}

const nearestRank = (sorted: ArrayLike<number>, q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

/** Per-position land flag, floor/top, surface and biome of a 16w × 16h block grid, row-major. */
interface Grid { n: number; m: number; top: Int16Array; ws: Int16Array; land: Uint8Array; biome: Uint8Array }

const newGrid = (n: number, m: number): Grid =>
  ({ n, m, top: new Int16Array(n * m), ws: new Int16Array(n * m), land: new Uint8Array(n * m), biome: new Uint8Array(n * m) });

/** Copies one column's aux A into the grid at block offset (ox, oz). */
function putColumn(g: Grid, a: AuxView, ox: number, oz: number): void {
  for (let p = 0; p < 256; p++) {
    const k = (oz + (p >> 4)) * g.n + ox + (p & 15);
    const ws = a.worldSurfaceWG[p]!;
    const of = a.oceanFloorWG[p]!;
    g.ws[k] = ws;
    g.top[k] = of - 1;
    g.land[k] = ws === of ? 1 : 0;
    g.biome[k] = a.surfaceBiome[p]!;
  }
}

/** Water-wall diagnostic over a grid: [wall voxels, water voxels above tops]. */
function waterWalls(g: Grid): [number, number] {
  let walls = 0;
  let water = 0;
  for (let j = 0; j < g.m; j++) {
    for (let i = 0; i < g.n; i++) {
      const k = j * g.n + i;
      const ws = g.ws[k]!;
      const top = g.top[k]!;
      if (ws - 1 <= top) continue;
      water += ws - 1 - top;
      let minWs = Infinity;
      if (i > 0) minWs = Math.min(minWs, g.ws[k - 1]!);
      if (i < g.n - 1) minWs = Math.min(minWs, g.ws[k + 1]!);
      if (j > 0) minWs = Math.min(minWs, g.ws[k - g.n]!);
      if (j < g.m - 1) minWs = Math.min(minWs, g.ws[k + g.n]!);
      walls += Math.max(0, ws - Math.max(minWs, top + 1));
    }
  }
  return [walls, water];
}

interface Scattered {
  hist: Float64Array; // land tops, index top + 64
  land: number;
  over: number;
  peakLand: number;
  peakOver: number;
  peakColumns: number;
  floatPositions: number;
  floatVoxels: number;
  peakFloatPositions: number;
  t5: number[];
  t5Land: number;
  t5Multi: number;
  /** T3: per biome, inside pairs and their steep count; per same-family biome pair `(min << 8) | max`, the same. */
  inside: Float64Array;
  insideSteep: Float64Array;
  borderPairs: Float64Array;
  borderSteep: Float64Array;
  landPairs: number;
  crossFamilyPairs: number;
  walls: number;
  water: number;
  columns: number;
  waterPositions: number;
  seconds: number;
}

let scatterScript: Promise<string> | null = null;
const askRegion = (w: Worker, msg: RegionAttachMsg | RegionColumnMsg): Promise<RegionWorkerReply> => ask<RegionWorkerReply>(w, msg);

/**
 * Generates scattered (possibly repeated) columns up to the T stage on 4 region workers (`regionWorker.ts`) and calls
 * `visit` on this thread with each column's proto view as soon as it is done, then frees it. Each worker writes into
 * its own small shared store and gets its next column only after `visit` has freed its previous one, so two columns
 * never meet on a store's 64 × 64 torus. `visit` sees the columns in completion order, not the list's: what it
 * accumulates must not depend on the order.
 */
async function forEachColumnThreaded(
  seed: string,
  params: Params,
  cols: ReadonlyArray<readonly [number, number]>,
  visit: (view: ColumnView, cx: number, cz: number) => void,
): Promise<void> {
  scatterScript ??= buildNodeTaskWorker(SCATTER_WORKER_DIR, { entry: 'test/harness/regionWorker.ts' });
  const script = await scatterScript;
  const stores = Array.from({ length: 4 }, () => createStore({ shared: true, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 }));
  const workers = stores.map(() => new Worker(script));
  try {
    const ready = await Promise.all(workers.map((w, t) => askRegion(w, { type: 'attach', handles: stores[t]!.handles(), seedText: seed, params })));
    for (const r of ready) if (r.type !== 'ready') throw new Error(`region worker: ${r.type === 'error' ? r.message : r.type}`);
    let next = 0;
    const drain = async (t: number): Promise<void> => {
      const store = stores[t]!;
      while (next < cols.length) {
        const [cx, cz] = cols[next++]!;
        const r = await askRegion(workers[t]!, { type: 'column', cx, cz });
        if (r.type !== 'done') throw new Error(`region worker ${t}, column (${cx}, ${cz}): ${r.type === 'error' ? r.message : r.type}`);
        const view = store.proto(cx, cz);
        if (view === null) throw new Error(`region worker ${t}: column (${cx}, ${cz}) has no proto set`);
        visit(view, cx, cz);
        store.freeColumn(cx, cz);
      }
    };
    await Promise.all(workers.map((_, t) => drain(t)));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

let scatteredMemo: Promise<Record<Profile, Scattered>> | null = null;

/** The one pass over the scattered columns (T1, T2, T3, T5), memoised. */
function scattered(): Promise<Record<Profile, Scattered>> {
  scatteredMemo ??= scatter();
  return scatteredMemo;
}

async function scatter(): Promise<Record<Profile, Scattered>> {
  const r = new Xoshiro128(fnv1a32('T1-T5'));
  const solid = new Uint8Array(98304);
  const g = newGrid(16, 16);
  const out = {} as Record<Profile, Scattered>;
  for (const profile of PROFILES) {
    const t0 = performance.now();
    const s: Scattered = {
      hist: new Float64Array(384), land: 0, over: 0, peakLand: 0, peakOver: 0, peakColumns: 0,
      floatPositions: 0, floatVoxels: 0, peakFloatPositions: 0, t5: [], t5Land: 0, t5Multi: 0,
      inside: new Float64Array(256), insideSteep: new Float64Array(256),
      borderPairs: new Float64Array(65536), borderSteep: new Float64Array(65536), landPairs: 0, crossFamilyPairs: 0,
      walls: 0, water: 0, columns: 0, waterPositions: 0, seconds: 0,
    };
    const R = RANGE[profile];
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const dc = createDensityContext(createGenContext(seedFromInput(seed), params));
      const cols: Array<[number, number]> = [];
      for (let n = 0; n < COLUMNS[profile]; n++) cols.push([-R + r.nextInt(2 * R), -R + r.nextInt(2 * R)]);
      await forEachColumnThreaded(seed, params, cols, (view, cx, cz) => {
        const aux = view.aux()!;
        solidity(view, solid);
        s.columns++;
        let peakHere = false;
        for (let p = 0; p < 256; p++) {
          const ws = aux.worldSurfaceWG[p]!;
          if (ws !== aux.oceanFloorWG[p]!) { s.waterPositions++; continue; }
          const top = ws - 1;
          s.land++;
          s.hist[top + 64]!++;
          const over = transitions(solid, p, top - 30, top) >= 2;
          if (over) s.over++;
          const fv = floatingVoxels(solid, p, top);
          if (fv > 0) { s.floatPositions++; s.floatVoxels += fv; }
          if (PEAKS.has(aux.surfaceBiome[p]!)) {
            s.peakLand++;
            peakHere = true;
            if (over) s.peakOver++;
            if (fv > 0) s.peakFloatPositions++;
          }
        }
        if (peakHere) s.peakColumns++;
        for (const lz of T5_LOCAL) {
          for (const lx of T5_LOCAL) {
            const p = (lz << 4) | lx;
            const ws = aux.worldSurfaceWG[p]!;
            if (ws !== aux.oceanFloorWG[p]!) continue;
            s.t5Land++;
            const top = ws - 1;
            if (transitions(solid, p, -56, top) !== 1) { s.t5Multi++; continue; }
            s.t5.push(Math.abs(surfaceEst3(dc, 16 * cx + lx, 16 * cz + lz) - top));
          }
        }
        putColumn(g, aux, 0, 0);
        const [wl, wt] = waterWalls(g);
        s.walls += wl;
        s.water += wt;
        const pair = (k: number, q: number): void => {
          if (g.land[k] !== 1 || g.land[q] !== 1) return;
          s.landPairs++;
          const steep = Math.abs(g.top[k]! - g.top[q]!) >= 4 ? 1 : 0;
          const a = g.biome[k]!;
          const b = g.biome[q]!;
          if (a === b) {
            s.inside[a]!++;
            s.insideSteep[a]! += steep;
          } else if (biomeFamily(a) === biomeFamily(b)) {
            const e = a < b ? (a << 8) | b : (b << 8) | a;
            s.borderPairs[e]!++;
            s.borderSteep[e]! += steep;
          } else s.crossFamilyPairs++;
        };
        for (let k = 0; k < 256; k++) {
          if ((k & 15) < 15) pair(k, k + 1);
          if (k < 240) pair(k, k + 16);
        }
      });
    }
    s.seconds = Math.round(performance.now() - t0) / 1000;
    out[profile] = s;
  }
  return out;
}

/** Writes `<key>.<profile>` for every profile and returns the worst (max or min) under `key`. */
function perProfile(rec: Record<string, number>, key: string, values: Record<Profile, number>, worst: 'max' | 'min'): void {
  for (const p of PROFILES) rec[`${key}.${p}`] = values[p];
  const v = PROFILES.map((p) => values[p]);
  rec[key] = worst === 'max' ? Math.max(...v) : Math.min(...v);
}

const byProfile = (f: (p: Profile) => number): Record<Profile, number> =>
  Object.fromEntries(PROFILES.map((p) => [p, f(p)])) as Record<Profile, number>;

metricTest('T1', ['band', 'span', 'above120', 'above200'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  const band = byProfile((p) => {
    const h = sc[p].hist;
    let best = 0;
    for (let b = 0; b + 10 <= 384; b++) {
      let s = 0;
      for (let k = b; k < b + 10; k++) s += h[k]!;
      if (s > best) best = s;
    }
    return best / sc[p].land;
  });
  const quantile = (p: Profile, q: number): number => {
    const h = sc[p].hist;
    const target = Math.ceil(q * sc[p].land);
    let acc = 0;
    for (let k = 0; k < 384; k++) { acc += h[k]!; if (acc >= target) return k - 64; }
    return 319;
  };
  const above = (p: Profile, y: number): number => {
    let s = 0;
    for (let k = y + 1 + 64; k < 384; k++) s += sc[p].hist[k]!;
    return s / sc[p].land;
  };
  perProfile(rec, 'band', band, 'max');
  perProfile(rec, 'span', byProfile((p) => quantile(p, 0.95) - quantile(p, 0.05)), 'min');
  perProfile(rec, 'above120', byProfile((p) => above(p, 120)), 'min');
  perProfile(rec, 'above200', byProfile((p) => above(p, 200)), 'min');
  for (const p of PROFILES) {
    rec[`p5.${p}`] = quantile(p, 0.05);
    rec[`p50.${p}`] = quantile(p, 0.5);
    rec[`p95.${p}`] = quantile(p, 0.95);
    rec[`landPositions.${p}`] = sc[p].land;
    rec[`landShare.${p}`] = sc[p].land / (256 * sc[p].columns);
    rec[`columns.${p}`] = sc[p].columns;
    rec[`seconds.${p}`] = sc[p].seconds;
    rec[`waterWallVoxels.${p}`] = sc[p].walls;
    rec[`waterVoxels.${p}`] = sc[p].water;
    rec[`waterWallShare.${p}`] = sc[p].water === 0 ? 0 : sc[p].walls / sc[p].water;
  }
  return rec;
});

metricTest('T2', ['overhangs', 'overhangsPeaks'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'overhangs', byProfile((p) => sc[p].over / sc[p].land), 'min');
  perProfile(rec, 'overhangsPeaks', byProfile((p) => (sc[p].peakLand === 0 ? 0 : sc[p].peakOver / sc[p].peakLand)), 'min');
  for (const p of PROFILES) {
    rec[`peakPositions.${p}`] = sc[p].peakLand;
    rec[`peakColumns.${p}`] = sc[p].peakColumns;
    rec[`overhangPositions.${p}`] = sc[p].over;
    rec[`floatingRockShare.${p}`] = sc[p].floatPositions / sc[p].land;
    rec[`floatingRockVoxels.${p}`] = sc[p].floatVoxels / sc[p].land;
    rec[`floatingRockPeaksShare.${p}`] = sc[p].peakLand === 0 ? 0 : sc[p].peakFloatPositions / sc[p].peakLand;
    rec[`floatingRockPositions.${p}`] = sc[p].floatPositions;
    requireSample(`T2.overhangsPeaks (${p}) peak columns`, sc[p].peakColumns, MIN_PEAK_COLUMNS);
  }
  return rec;
});

metricTest('T3', ['value'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  const values = byProfile(() => 0);
  for (const profile of PROFILES) {
    const s = sc[profile];
    const fam = new Map<BiomeFamily, [number, number, number]>(); // pairs, steep, expected
    let dropped = 0;
    for (let e = 0; e < 65536; e++) {
      const n = s.borderPairs[e]!;
      if (n === 0) continue;
      const a = e >> 8;
      const b = e & 255;
      if (s.inside[a] === 0 || s.inside[b] === 0) { dropped += n; continue; }
      const d = (s.insideSteep[a]! / s.inside[a]! + s.insideSteep[b]! / s.inside[b]!) / 2;
      const f = fam.get(biomeFamily(a)) ?? [0, 0, 0];
      f[0] += n;
      f[1] += s.borderSteep[e]!;
      f[2] += n * d;
      fam.set(biomeFamily(a), f);
    }
    let all: [number, number, number] = [0, 0, 0];
    for (const [f, [n, st, d]] of fam) {
      rec[`familyPairs.${f}.${profile}`] = n;
      rec[`familyValue.${f}.${profile}`] = d === 0 ? Infinity : st / d;
      all = [all[0] + n, all[1] + st, all[2] + d];
    }
    const [n, st, d] = fam.get(T3_FAMILY) ?? [0, 0, 0];
    values[profile] = d === 0 ? Infinity : st / d;
    rec[`borderPairs.${profile}`] = n;
    rec[`borderSteepShare.${profile}`] = n === 0 ? 0 : st / n;
    rec[`expectedSteepShare.${profile}`] = n === 0 ? 0 : d / n;
    rec[`allFamiliesValue.${profile}`] = all[2] === 0 ? Infinity : all[1] / all[2];
    rec[`allFamiliesPairs.${profile}`] = all[0];
    rec[`droppedPairs.${profile}`] = dropped;
    rec[`landPairs.${profile}`] = s.landPairs;
    rec[`crossFamilyPairs.${profile}`] = s.crossFamilyPairs;
    rec[`columns.${profile}`] = s.columns;
    requireSample(`T3 (${profile}) lowland border pairs`, n, MIN_T3_PAIRS);
  }
  perProfile(rec, 'value', values, 'max');
  return rec;
});

metricTest('T5', ['median', 'p90', 'p99'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  const arrays = {} as Record<Profile, Float64Array>;
  for (const p of PROFILES) {
    arrays[p] = Float64Array.from(sc[p].t5).sort();
    requireSample(`T5 (${p}) single-surface positions`, arrays[p].length, MIN_T5_POSITIONS);
  }
  perProfile(rec, 'median', byProfile((p) => nearestRank(arrays[p], 0.5)), 'max');
  perProfile(rec, 'p90', byProfile((p) => nearestRank(arrays[p], 0.9)), 'max');
  perProfile(rec, 'p99', byProfile((p) => nearestRank(arrays[p], 0.99)), 'max');
  for (const p of PROFILES) {
    rec[`max.${p}`] = arrays[p][arrays[p].length - 1] ?? 0;
    rec[`mean.${p}`] = arrays[p].reduce((a, b) => a + b, 0) / Math.max(1, arrays[p].length);
    rec[`singleSurface.${p}`] = arrays[p].length;
    rec[`landPositions.${p}`] = sc[p].t5Land;
    rec[`multiSurface.${p}`] = sc[p].t5Multi;
  }
  return rec;
});

metricTest('T4', ['floorSd', 'exposedBedrock', 'deepFloor'], async () => {
  const t0 = performance.now();
  const r = new Xoshiro128(fnv1a32('T4'));
  const rec: Record<string, number> = {};
  const sd = byProfile(() => 0);
  const bedrock = byProfile(() => 0);
  const deep = byProfile(() => 0);
  let walls = 0;
  let water = 0;
  let draws = 0;
  for (const profile of PROFILES) {
    const params = resolveProfile(profile);
    const R = RANGE[profile];
    let sdSum = 0;
    let regions = 0;
    let wet = 0;
    let minFloor = Infinity;
    for (const seed of SEEDS) {
      const ctx = createGenContext(seedFromInput(seed), params);
      for (let n = 0; n < T4_REGIONS; n++) {
        let cx0: number;
        let cz0: number;
        do {
          cx0 = -R + r.nextInt(2 * R - 16);
          cz0 = -R + r.nextInt(2 * R - 16);
          draws++;
        } while (columnPoint(ctx, 16 * (cx0 + 8), 16 * (cz0 + 8)).offset >= 40);
        const res = await genRegion({
          seed, params, cx0, cz0, w: 16, h: 16, upTo: 'T', order: 'spiral', threads: 4, cache: false, workerDir: WORKER_DIR,
        });
        const g = newGrid(256, 256);
        for (let cz = cz0; cz < cz0 + 16; cz++) {
          for (let cx = cx0; cx < cx0 + 16; cx++) putColumn(g, res.view.store.proto(cx, cz)!.aux()!, 16 * (cx - cx0), 16 * (cz - cz0));
        }
        const [wl, wt] = waterWalls(g);
        walls += wl;
        water += wt;
        let n0 = 0;
        let s1 = 0;
        let s2 = 0;
        for (let k = 0; k < g.n * g.m; k++) {
          if (g.land[k] === 1) continue;
          const f = g.top[k]!;
          n0++;
          s1 += f;
          s2 += f * f;
          if (f === -64) bedrock[profile]++;
          if (f <= -50) deep[profile]++;
          if (f < minFloor) minFloor = f;
        }
        wet += n0;
        regions++;
        sdSum += n0 < 2 ? 0 : Math.sqrt(Math.max(0, (s2 - (s1 * s1) / n0) / (n0 - 1)));
      }
    }
    sd[profile] = sdSum / regions;
    rec[`wetPositions.${profile}`] = wet;
    rec[`minFloor.${profile}`] = minFloor;
    rec[`regions.${profile}`] = regions;
  }
  perProfile(rec, 'floorSd', sd, 'min');
  for (const p of PROFILES) { rec[`exposedBedrock.${p}`] = bedrock[p]; rec[`deepFloor.${p}`] = deep[p]; }
  rec.exposedBedrock = bedrock.default + bedrock.large_biomes;
  rec.deepFloor = deep.default + deep.large_biomes;
  rec.siteDraws = draws;
  rec.waterWallVoxels = walls;
  rec.waterVoxels = water;
  rec.waterWallShare = water === 0 ? 0 : walls / water;
  rec.seconds = Math.round(performance.now() - t0) / 1000;
  return rec;
});
```

Modify `test/unit/lock.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/lock.test.ts b/test/unit/lock.test.ts
index 94517f7..05884f6 100644
--- a/test/unit/lock.test.ts
+++ b/test/unit/lock.test.ts
@@ -45,6 +45,20 @@ describe('diffGovernance', () => {
     );
   });
 
+  test('restricting a part to fewer tiers loosens; widening its tiers tightens; the lock records them', () => {
+    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.tiers = ['full']; }))).toEqual([
+      { path: 'T1.band', detail: 'tiers all→[full]', kind: 'LOOSEN' },
+    ]);
+    const fullOnly = edit((s) => { s.thresholds.T1!.band!.tiers = ['full']; });
+    expect(diffGovernance(fullOnly, edit((s) => { s.thresholds.T1!.band!.tiers = ['quick', 'full']; }))).toEqual([
+      { path: 'T1.band', detail: 'tiers [full]→[quick, full]', kind: 'TIGHTEN' },
+    ]);
+    expect(diffGovernance(fullOnly, base)).toEqual([{ path: 'T1.band', detail: 'tiers [full]→all', kind: 'TIGHTEN' }]);
+    expect(diffGovernance(fullOnly, edit((s) => { s.thresholds.T1!.band!.tiers = ['quick']; }))[0]!.kind).toBe('LOOSEN');
+    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.tiers = ['fast', 'quick', 'full']; }))).toEqual([]);
+    expect(makeLock(fullOnly).sha256).not.toBe(makeLock(base).sha256);
+  });
+
   test('removing an active part loosens; adding a part tightens', () => {
     expect(diffGovernance(base, edit((s) => { delete s.thresholds.T1!.span; }))[0]).toEqual(
       { path: 'T1.span', detail: 'removed', kind: 'LOOSEN' },
```

Modify `test/unit/metric.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/metric.test.ts b/test/unit/metric.test.ts
index 43e00aa..99d1dc2 100644
--- a/test/unit/metric.test.ts
+++ b/test/unit/metric.test.ts
@@ -9,7 +9,7 @@ const table: ThresholdTable = {
 describe('evaluateMetric', () => {
   test('active parts are asserted, inactive parts only recorded', () => {
     const r = evaluateMetric('C1', ['default', 'cave_heavy'], { default: 0.09, cave_heavy: 0.5 }, table, ['SP6']);
-    expect(r).toEqual({ asserted: ['default'], inactive: ['cave_heavy'], errors: [] });
+    expect(r).toEqual({ asserted: ['default'], inactive: ['cave_heavy'], otherTier: [], errors: [] });
   });
 
   test('an active part outside its range fails', () => {
@@ -17,6 +17,30 @@ describe('evaluateMetric', () => {
     expect(r.errors).toEqual(['C1.default = 0.2 > max 0.15']);
   });
 
+  test('a part with tiers is gated only on its listed tiers and recorded elsewhere (SP3b: T3 on full only)', () => {
+    const tiered: ThresholdTable = { T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: ['full'] } } };
+    for (const tier of ['fast', 'quick'] as const) {
+      expect(evaluateMetric('T3', ['value'], { value: 9 }, tiered, ['SP3b'], tier)).toEqual(
+        { asserted: [], inactive: [], otherTier: ['value'], errors: [] },
+      );
+    }
+    expect(evaluateMetric('T3', ['value'], { value: 9 }, tiered, ['SP3b'], 'full')).toEqual(
+      { asserted: ['value'], inactive: [], otherTier: [], errors: ['T3.value = 9 > max 1.5'] },
+    );
+    expect(evaluateMetric('T3', ['value'], { value: 1.2 }, tiered, ['SP3b'], 'full').errors).toEqual([]);
+    // Off-tier parts still need their value, and an inactive part stays inactive whatever its tiers.
+    expect(evaluateMetric('T3', ['value'], {}, tiered, ['SP3b'], 'fast').errors).toEqual(['T3.value: no value returned']);
+    expect(evaluateMetric('T3', ['value'], { value: 9 }, tiered, ['SP3a'], 'full')).toEqual(
+      { asserted: [], inactive: ['value'], otherTier: [], errors: [] },
+    );
+  });
+
+  test('a part without tiers is gated on every tier', () => {
+    for (const tier of ['fast', 'quick', 'full'] as const) {
+      expect(evaluateMetric('C1', ['default'], { default: 0.2 }, table, ['SP6'], tier).errors).toEqual(['C1.default = 0.2 > max 0.15']);
+    }
+  });
+
   test('missing values and unknown parts are errors', () => {
     expect(evaluateMetric('C1', ['default'], {}, table, ['SP6']).errors).toEqual(['C1.default: no value returned']);
     expect(evaluateMetric('C1', ['nope'], { nope: 1 }, table, ['SP6']).errors).toEqual(['C1.nope: not in THRESHOLDS']);
@@ -31,6 +55,16 @@ describe('coverageErrors', () => {
     expect(coverageErrors([call, call], table, ['SP6'])).toEqual(['C1.default is covered by 2 metricTest calls']);
   });
 
+  test('a tier-restricted part still needs exactly one call; its tiers must be a non-empty subset of the tiers', () => {
+    const call = { file: 'a.metric.ts', id: 'T3', parts: ['value'] };
+    const row = (tiers: readonly string[]): ThresholdTable => ({ T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: tiers as never } } });
+    expect(coverageErrors([], row(['full']), ['SP3b'])).toEqual(['T3.value is active but no metricTest covers it']);
+    expect(coverageErrors([call], row(['full']), ['SP3b'])).toEqual([]);
+    expect(coverageErrors([call], row([]), ['SP3b'])).toEqual(['T3.value: tiers [] (a non-empty subset of fast, quick, full)']);
+    expect(coverageErrors([call], row(['full', 'nightly']), ['SP3b'])).toEqual(['T3.value: tiers [full, nightly] (a non-empty subset of fast, quick, full)']);
+    expect(coverageErrors([call], row(['full', 'full']), ['SP3b'])).toEqual(['T3.value: tiers [full, full] (a non-empty subset of fast, quick, full)']);
+  });
+
   test('calls naming unknown ids or parts are errors', () => {
     expect(coverageErrors([{ file: 'a.metric.ts', id: 'C9', parts: ['x'] }], table, [])).toEqual([
       'a.metric.ts: C9 is not in THRESHOLDS',
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project metrics-fast --project unit test/metrics/terrain.metric.ts test/unit/lock.test.ts test/unit/metric.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× restricting a part to fewer tiers loosens; widening its tiers tightens; the lock records them 5ms
× active parts are asserted, inactive parts only recorded 6ms
× a part with tiers is gated only on its listed tiers and recorded elsewhere (SP3b: T3 on full only) 1ms
× a tier-restricted part still needs exactly one call; its tiers must be a non-empty subset of the tiers 1ms
× T1 16930ms
× T2 1ms
× T3 2ms
× T5 9ms
× T4 2365ms
FAIL  |unit| test/unit/lock.test.ts > diffGovernance > restricting a part to fewer tiers loosens; widening its tiers tightens; the lock records them
AssertionError: expected [] to deeply equal [ { path: 'T1.band', …(2) } ]
FAIL  |unit| test/unit/metric.test.ts > evaluateMetric > active parts are asserted, inactive parts only recorded
AssertionError: expected { asserted: [ 'default' ], …(2) } to deeply equal { asserted: [ 'default' ], …(3) }
FAIL  |unit| test/unit/metric.test.ts > evaluateMetric > a part with tiers is gated only on its listed tiers and recorded elsewhere (SP3b: T3 on full only)
… (13 more lines)
Test Files  3 failed (3)
Tests  9 failed | 13 passed (22)
```

- [ ] **Step 3: Implement**

Modify `docs/superpowers/specs/2026-09-26-architecture-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-09-26-architecture-design.md b/docs/superpowers/specs/2026-09-26-architecture-design.md
index dde3c9a..d8957ee 100644
--- a/docs/superpowers/specs/2026-09-26-architecture-design.md
+++ b/docs/superpowers/specs/2026-09-26-architecture-design.md
@@ -1353,7 +1353,7 @@ Metric values are written to `test/metrics/.out/*.json` for trends. The harness
 | T1 | land heights: largest 10-block band / p5..p95 span / share y > 120 / share y > 200 | ≤ 25% / ≥ 60 blocks / ≥ 6% / ≥ 0.5% |
 | T1lowland | share of land columns with offset0 in [66, 76) on the pure offset (SP2a) | ≤ 40% |
 | T2 | land columns with ≥ 2 solid→air transitions above surface − 30 (pre-cave) | ≥ 1.5%, ≥ 10% in peaks/windswept (amplified: Z1) |
-| T3 | P(\|Δh\| ≥ 4 across a biome border) / P(within biome) | ≤ 1.5 |
+| T3 | P(\|Δh\| ≥ 4 across a border between two lowland biomes) / P(within those biomes), stratified by the pair's biomes (SP3b spec §8.2); gates on the full metrics tier only, fast and quick record it | ≤ 1.5 |
 | T4 | ocean floor sd per 256² / exposed bedrock under water / floor ≤ −50 | ≥ 3 / 0 / 0 |
 | T5 | surfaceEst vs true top (single-surface, no canopy) | median ≤ 1, p90 ≤ 2, p99 ≤ 6 |
 | T6 | spline gain: raising a knot by 10 blocks, `gain = ΣΔoffset_col / Σw_col` over columns with w_col > 0 (w_col = product of Hermite value-basis weights along the knot path, tangents fixed), one knot per depth | 10 ± 1.5 |
@@ -1693,7 +1693,7 @@ SP3b was split on 2026-10-07 into SP3b (density and terrain shape) and a new SP3
 - The real T stage (air, stone, bedrock and water) with the general v0 water fill so oceans, rivers and lakes are visible early (air with top − 12 < y ≤ surfaceWaterLevel, `top` being the position's highest stone, becomes water sources; everything else stays dry; SP3a's provisional T is its no-overhang case); it writes aux B and bumps the `terrain` stage and `GENERATOR_VERSION`.
 - The slice job split across workers; the CI `actions/cache` step for `test/.cache/regions` before `npm run test:metrics` (moved from SP3a, whose provisional T regenerates a 32 × 32 region in about a second).
 - **Deliverable:** 3D voxel terrain from the density DAG with water, in the harness slices and the Voxels mode.
-- **Exit:** as the SP3b spec §11: DT1 on the real T, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 (stratified over same-family borders), T4 and T5 on voxel terrain (true top from WORLD_SURFACE_WG); every 2D metric still passes; P1 bench: T without caves ≤ 4 ms p50.
+- **Exit:** as the SP3b spec §11: DT1 on the real T, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 (stratified over lowland borders, gated on the full tier), T4 and T5 on voxel terrain (true top from WORLD_SURFACE_WG); every 2D metric still passes; P1 bench: T without caves ≤ 4 ms p50.
 - Received from SP3a (its spec §10): T3's redefinition before it gates and T1's lowland band; the cost of the biome height filter on the real `surfaceEst` (settled by keeping the 2D estimate there); the Expr ops' exact semantics and interval rules; SP2a minor 5 (handed to SP3 by SP2b; minor 6 moves to SP3c); the ocean-floor σ/jag stripe.
 - **Cut line:** the worker-split slice (→ SP3d).
 
```

Modify `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
index b464e7d..5232566 100644
--- a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
+++ b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
@@ -522,3 +522,4 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
 
 - Task 1: `STARTED_SPS` gains `SP3b` (SP3b split into SP3b and a new SP3c; the old SP3c becomes SP3d); no threshold rows change.
 - Task 9: DT2 row added (`probeBulk` max 0, `compiledReference` max 0, activeFrom `SP3b`); no other row changes.
+- Task 13: T1 (`band`, `span`, `above120`, `above200`), T2 (`overhangs`, `overhangsPeaks`), T3 (`value`, `tiers: ['full']`), T4 (`floorSd`, `exposedBedrock`, `deepFloor`) and T5 (`median`, `p90`, `p99`) rows added with §8.2's thresholds, activeFrom `SP3b`; `ThresholdPart` gains the optional `tiers` field (absent = every tier); no existing row changes.
```

Modify `test/harness/lock.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/lock.ts b/test/harness/lock.ts
index 3ff9144..3dac557 100644
--- a/test/harness/lock.ts
+++ b/test/harness/lock.ts
@@ -61,6 +61,14 @@ function partChanges(path: string, prev: ThresholdPart, next: ThresholdPart): Lo
     const loosen = next.max === undefined || (prev.max !== undefined && next.max > prev.max);
     out.push({ path, detail: `max ${prev.max ?? '—'}→${next.max ?? '—'}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
   }
+  const tiers = (p: ThresholdPart): readonly string[] => p.tiers ?? ['fast', 'quick', 'full'];
+  const before = tiers(prev);
+  const after = tiers(next);
+  if (before.length !== after.length || before.some((t) => !after.includes(t))) {
+    const loosen = before.some((t) => !after.includes(t));
+    const show = (p: ThresholdPart): string => (p.tiers === undefined ? 'all' : `[${p.tiers.join(', ')}]`);
+    out.push({ path, detail: `tiers ${show(prev)}→${show(next)}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
+  }
   if (prev.activeFrom !== next.activeFrom) {
     const loosen = spIndex(next.activeFrom) > spIndex(prev.activeFrom);
     out.push({ path, detail: `activeFrom ${prev.activeFrom}→${next.activeFrom}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
```

Modify `test/harness/metric.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/metric.ts b/test/harness/metric.ts
index 9db9c7a..67841f2 100644
--- a/test/harness/metric.ts
+++ b/test/harness/metric.ts
@@ -3,7 +3,7 @@ import { join, relative } from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { expect, test } from 'vitest';
 import type { MetricId, SubProjectId } from '../../src/core/ids';
-import { THRESHOLDS, type ThresholdTable } from '../thresholds';
+import { THRESHOLDS, type MetricsTier, type ThresholdTable } from '../thresholds';
 import { STARTED_SPS } from './sp';
 
 const OUT_DIR = fileURLToPath(new URL('../metrics/.out/', import.meta.url));
@@ -11,17 +11,29 @@ const OUT_DIR = fileURLToPath(new URL('../metrics/.out/', import.meta.url));
 export interface MetricEvaluation {
   asserted: string[];
   inactive: string[];
+  /** Active parts whose row lists tiers that exclude this run's tier: measured and recorded, not gated. */
+  otherTier: string[];
   errors: string[];
 }
 
+const TIERS: readonly MetricsTier[] = ['fast', 'quick', 'full'];
+
+/** The tier of this metrics run (`METRICS_TIER`, set per vitest project; 'fast' outside them). */
+export function currentTier(): MetricsTier {
+  const t = process.env.METRICS_TIER ?? 'fast';
+  if (t !== 'fast' && t !== 'quick' && t !== 'full') throw new Error(`METRICS_TIER '${t}' (fast, quick or full)`);
+  return t;
+}
+
 export function evaluateMetric(
   id: string,
   parts: readonly string[],
   values: Readonly<Record<string, number>>,
   table: ThresholdTable = THRESHOLDS,
   started: readonly SubProjectId[] = STARTED_SPS,
+  tier: MetricsTier = currentTier(),
 ): MetricEvaluation {
-  const result: MetricEvaluation = { asserted: [], inactive: [], errors: [] };
+  const result: MetricEvaluation = { asserted: [], inactive: [], otherTier: [], errors: [] };
   const row = table[id as MetricId];
   for (const part of parts) {
     const t = row?.[part];
@@ -29,6 +41,7 @@ export function evaluateMetric(
     const value = values[part];
     if (value === undefined) { result.errors.push(`${id}.${part}: no value returned`); continue; }
     if (!started.includes(t.activeFrom)) { result.inactive.push(part); continue; }
+    if (t.tiers !== undefined && !t.tiers.includes(tier)) { result.otherTier.push(part); continue; }
     result.asserted.push(part);
     if (t.min !== undefined && value < t.min) result.errors.push(`${id}.${part} = ${value} < min ${t.min}`);
     if (t.max !== undefined && value > t.max) result.errors.push(`${id}.${part} = ${value} > max ${t.max}`);
@@ -36,7 +49,10 @@ export function evaluateMetric(
   return result;
 }
 
-/** Registers one metric test. Inactive parts still run and record their value, then the test is skipped. */
+/**
+ * Registers one metric test. Inactive parts, and parts gated on other tiers only, still run and record their value;
+ * the test is skipped when no part is gated on this run.
+ */
 export function metricTest(
   id: MetricId,
   parts: readonly string[],
@@ -50,8 +66,11 @@ export function metricTest(
     const r = evaluateMetric(id, parts, values);
     expect(r.errors, r.errors.join('\n')).toEqual([]);
     if (r.asserted.length === 0) {
-      const next = r.inactive.map((p) => THRESHOLDS[id]?.[p]?.activeFrom).join(', ');
-      ctx.skip(true, `inactive until ${next} (value recorded)`);
+      const why = [
+        ...r.inactive.map((p) => `${p} inactive until ${THRESHOLDS[id]?.[p]?.activeFrom}`),
+        ...r.otherTier.map((p) => `${p} gated on ${THRESHOLDS[id]?.[p]?.tiers?.join(', ')} only`),
+      ];
+      ctx.skip(true, `${why.join('; ')} (value recorded)`);
     }
   }, timeoutMs);
 }
@@ -100,6 +119,10 @@ export function coverageErrors(
   }
   for (const [id, row] of Object.entries(table)) {
     for (const [part, t] of Object.entries(row ?? {})) {
+      if (t.tiers !== undefined) {
+        const bad = t.tiers.filter((x, i) => !TIERS.includes(x) || t.tiers!.indexOf(x) !== i);
+        if (t.tiers.length === 0 || bad.length > 0) errors.push(`${id}.${part}: tiers [${t.tiers.join(', ')}] (a non-empty subset of fast, quick, full)`);
+      }
       if (!started.includes(t.activeFrom)) continue;
       const n = calls.filter((c) => c.id === id && c.parts.includes(part)).length;
       if (n === 0) errors.push(`${id}.${part} is active but no metricTest covers it`);
```

Modify `test/thresholds.ts` (apply with `git apply`):

```diff
diff --git a/test/thresholds.ts b/test/thresholds.ts
index f3f905d..36393c1 100644
--- a/test/thresholds.ts
+++ b/test/thresholds.ts
@@ -1,10 +1,17 @@
 import type { MetricId, SubProjectId } from '../src/core/ids';
 
+export type MetricsTier = 'fast' | 'quick' | 'full';
+
 export interface ThresholdPart {
   min?: number;
   max?: number;
   /** First sub-project that gates this part (per-part, master §10 Definition of done). */
   activeFrom: SubProjectId;
+  /**
+   * The metrics tiers that gate this part (absent: every tier). On the other tiers its value is measured and recorded
+   * as an ungated diagnostic (SP3b spec §8.2: T3 gates on the full tier only).
+   */
+  tiers?: readonly MetricsTier[];
 }
 
 /** One entry per metric id; part keys are stable slugs, one per threshold cell of the §6.4 row. */
@@ -34,6 +41,14 @@ export const THRESHOLDS: ThresholdTable = {
   B5: { perKm2Min: { min: 0.2, activeFrom: 'SP2a' }, perKm2Max: { max: 2, activeFrom: 'SP2a' }, highShare: { min: 0.3, activeFrom: 'SP2a' } },
   U2: { value: { min: 1, activeFrom: 'SP2b' } },
   DT1: { mismatches: { max: 0, activeFrom: 'SP3a' } },
+  T1: {
+    band: { max: 0.25, activeFrom: 'SP3b' }, span: { min: 60, activeFrom: 'SP3b' },
+    above120: { min: 0.06, activeFrom: 'SP3b' }, above200: { min: 0.005, activeFrom: 'SP3b' },
+  },
+  T2: { overhangs: { min: 0.015, activeFrom: 'SP3b' }, overhangsPeaks: { min: 0.1, activeFrom: 'SP3b' } },
+  T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: ['full'] } },
+  T4: { floorSd: { min: 3, activeFrom: 'SP3b' }, exposedBedrock: { max: 0, activeFrom: 'SP3b' }, deepFloor: { max: 0, activeFrom: 'SP3b' } },
+  T5: { median: { max: 1, activeFrom: 'SP3b' }, p90: { max: 2, activeFrom: 'SP3b' }, p99: { max: 6, activeFrom: 'SP3b' } },
   DT2: { probeBulk: { max: 0, activeFrom: 'SP3b' }, compiledReference: { max: 0, activeFrom: 'SP3b' } },
   M1: { states: { max: 4096, activeFrom: 'SP3a' }, roundTripFailures: { max: 0, activeFrom: 'SP3a' }, lockChanges: { max: 0, activeFrom: 'SP3a' } },
   U4: {
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:accept-thresholds`

The command writes `test/thresholds.lock.json`; the dry run's result:

Modify `test/thresholds.lock.json` (apply with `git apply`):

```diff
diff --git a/test/thresholds.lock.json b/test/thresholds.lock.json
index 006de3d..555ac17 100644
--- a/test/thresholds.lock.json
+++ b/test/thresholds.lock.json
@@ -1,5 +1,5 @@
 {
-  "sha256": "6c0f299b4a0cbd10724f64bf9be3c4f07dfee8af547c15d24aab2b7945f9df98",
+  "sha256": "8c64417e7865e7dd7a08a9404c69a1a7a7809cab05bfc04f920dfa47800b9b82",
   "canonical": {
     "startedSps": [
       "SP0",
@@ -176,12 +176,77 @@
           "max": 0.001
         }
       },
+      "T1": {
+        "above120": {
+          "activeFrom": "SP3b",
+          "min": 0.06
+        },
+        "above200": {
+          "activeFrom": "SP3b",
+          "min": 0.005
+        },
+        "band": {
+          "activeFrom": "SP3b",
+          "max": 0.25
+        },
+        "span": {
+          "activeFrom": "SP3b",
+          "min": 60
+        }
+      },
       "T1lowland": {
         "value": {
           "activeFrom": "SP2a",
           "max": 0.4
         }
       },
+      "T2": {
+        "overhangs": {
+          "activeFrom": "SP3b",
+          "min": 0.015
+        },
+        "overhangsPeaks": {
+          "activeFrom": "SP3b",
+          "min": 0.1
+        }
+      },
+      "T3": {
+        "value": {
+          "activeFrom": "SP3b",
+          "max": 1.5,
+          "tiers": [
+            "full"
+          ]
+        }
+      },
+      "T4": {
+        "deepFloor": {
+          "activeFrom": "SP3b",
+          "max": 0
+        },
+        "exposedBedrock": {
+          "activeFrom": "SP3b",
+          "max": 0
+        },
+        "floorSd": {
+          "activeFrom": "SP3b",
+          "min": 3
+        }
+      },
+      "T5": {
+        "median": {
+          "activeFrom": "SP3b",
+          "max": 1
+        },
+        "p90": {
+          "activeFrom": "SP3b",
+          "max": 2
+        },
+        "p99": {
+          "activeFrom": "SP3b",
+          "max": 6
+        }
+      },
       "T6": {
         "maxGain": {
           "activeFrom": "SP2a",
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project metrics-fast --project unit test/metrics/terrain.metric.ts test/unit/lock.test.ts test/unit/metric.test.ts`

Expected: PASS (exit 0)

```
Test Files  3 passed (3)
Tests  21 passed | 1 skipped (22)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  135 passed | 2 skipped (137)
Tests  1804 passed | 4 skipped (1808)
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md test/harness/lock.ts test/harness/metric.ts test/metrics/terrain.metric.ts test/thresholds.lock.json test/thresholds.ts test/unit/lock.test.ts test/unit/metric.test.ts
git commit -F - <<'EOF'
feat(metrics): terrain metrics T1-T5 on voxels with their rows; tier-gated threshold parts

SP3b spec §8. test/metrics/terrain.metric.ts measures T1 (land height band,
span, shares above 120 and 200), T2 (overhangs, in peaks), T3 (stratified
border steps between two lowland biomes), T4 (ocean floor sd, exposed
bedrock, deep floor) and T5 (surfaceEst3 against the true top) on the real
T. T1, T2, T3 and T5 read one pass of scattered columns generated on 4
region workers (T3 on the neighbour pairs inside each column, at least
2,000 lowland border pairs per profile on every tier); T4 uses 16 x 16
regions without the region cache. Other T3 families, the water-wall share
and a floating-rock share are recorded as ungated diagnostics.

ThresholdPart gains an optional `tiers` list (absent = every tier):
evaluateMetric gates a part only on its listed tiers and records it
elsewhere; coverageErrors validates the list and the lock diff classifies
a tier change. The T3 row gates on the full tier only (user decision).
Rows activeFrom SP3b, lock accepted, Threshold log and the master §6.4 /
SP3b §8 amendments.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `e46a18e` on `dry/sp3a`; 9 files changed, 725 insertions(+), 9 deletions(-)):

From "Task 13 — commit (after the controller's decisions)":

Commit Task 13 on `dry/sp3b` (worktree `P/dry`, parent Task 12; 9 files, 736 insertions, 20 deletions). RED (the commit's 3 test files over a `git archive` copy of Task 12): `terrain.metric.ts` 5 of 5 fail with "T1.band … / T2.overhangs / T3.value / T5.median / T4.floorSd: not in THRESHOLDS"; `metric.test.ts` 3 and `lock.test.ts` 1 fail (no `otherTier` in the result, tier-gated part asserted on fast, tier list not validated, no tier change in the diff); 13 `tsc -p tsconfig.test.json` errors (`tiers` not in `ThresholdPart`, `evaluateMetric`'s 6th argument). GREEN: typecheck clean; `npm test` 135 files passed, 2 skipped; 1785 tests passed, 4 skipped (54 s wall, load 4.3 at the start, right after my full-tier run); `GOVERNANCE_BASE=main` governance + thresholds + masterSpec tests 7/7.

- FINAL MEASUREMENT (same values as the stopped run except T4 on fast; every gated part passes; `.out` copies were in the scratchpad, the numbers are here):

  | part (threshold) | fast default / large_biomes | quick | full | gated |
  |---|---|---|---|---|
  | T1.band (≤ 0.25) | 0.2344 / 0.1792 | 0.2319 / 0.1834 | 0.2390 / 0.1828 | all tiers |
  | T1.span (≥ 60) | 105 / 110 | 107 / 111 | 104 / 107 | all |
  | T1.above120 (≥ 0.06) | 0.1665 / 0.1943 | 0.1670 / 0.1925 | 0.1567 / 0.1790 | all |
  | T1.above200 (≥ 0.005) | 0.0221 / 0.0224 | 0.0234 / 0.0233 | 0.0204 / 0.0214 | all |
  | T2.overhangs (≥ 0.015) | 0.0369 / 0.0445 | 0.0352 / 0.0433 | 0.0373 / 0.0432 | all |
  | T2.overhangsPeaks (≥ 0.10) | 0.1035 / 0.1234 | 0.1005 / 0.1202 | 0.1093 / 0.1180 | all |
  | T3.value (≤ 1.5) | 1.371 / 0.924 (2,613 / 2,843 pairs) recorded | 1.509 / 0.794 (5,006 / 5,171) recorded | 1.189 / 0.944 (9,977 / 10,752) | full only |
  | T4.floorSd (≥ 3) | 7.46 / 3.164 (4 regions) | 7.46 / 3.164 (4) | 5.69 / 3.193 (64) | all |
  | T4.exposedBedrock / deepFloor (0) | 0 / 0 (min floor 8 / 4) | 0 / 0 (8 / 4) | 0 / 0 (5 / 5) | all |
  | T5 median / p90 / p99 (≤ 1 / 2 / 6) | 1 / 2 / 4 (max 25 / 30) | 1 / 2 / 4 (30 / 38) | 1 / 2 / 4 (27 / 55) | all |

  Fast and quick report T3 as "skipped: value gated on full only (value recorded)" (4 passed, 1 skipped); the 2,000-pair minimum is still a soft failure on every tier. Diagnostics unchanged from the Task 13 stop block (floating rocks 1.7 % / 2.0 % of land positions, 4.6-5.5 % in peaks; water-wall share ≈ 1-4e-4 in the scattered columns, ≤ 3e-5 in the T4 regions; highland T3 1.14-1.28 / 1.08-1.17).
  Wall time of the file (`/usr/bin/time`, load 1.6-3 from my own consecutive runs): fast 19.3 s (scattered 3.4 + 12.7 s, T4 2.4 s; RSS 0.72 GB), quick 37.1 s (6.9 + 27.1 s, T4 2.3 s; 0.84 GB), full 105.5 s (14.0 + 53.2 s, T4 37.5 s; 0.87 GB). Region cache: `test/.cache/regions` 537,138,088 bytes before and after every tier (T1-T5 write nothing). The new worker builds are `test/.cache/terrainScatterWorker-<tier>` and `terrainRegionWorker-<tier>` (a few hundred KB each).

- Ruling (tier-gated parts): `ThresholdPart.tiers?: readonly MetricsTier[]` (`'fast' | 'quick' | 'full'`, exported from `test/thresholds.ts`; absent = every tier, so no existing row or lock entry changes). `evaluateMetric(…, tier = currentTier())` puts an active part outside its tiers in `otherTier` (value still required, never gated; an inactive part stays `inactive`); `metricTest` skips the test when nothing is gated and names why. `currentTier()` (in `test/harness/metric.ts`) reads `METRICS_TIER` ('fast' when unset, anything else throws). `coverageErrors` still requires exactly one call for a tier-restricted active part and rejects an empty, unknown or repeated tier list. `diffGovernance`: dropping a tier (including all → a subset) is LOOSEN, only adding tiers is TIGHTEN, an equal set (e.g. absent vs all three) is no change; the lock stores the list through `canonicalize` (sha changes). The T3 row lands new (an "added" TIGHTEN in the diff against main), so no LOOSEN of an existing row happens here. Cost if wrong: none.
- Ruling (the scattered sampler lives in the metric file): `forEachColumnThreaded` moved from `test/harness/region.ts` (the stopped draft) into `terrain.metric.ts`, built from the existing `buildNodeTaskWorker(…, {entry: 'test/harness/regionWorker.ts'})` and `ask`, with its own build directory `terrainScatterWorker-<tier>` (T4's `genRegion` keeps `terrainRegionWorker-<tier>`). This keeps the RED clean (over the parent every test fails with "not in THRESHOLDS", not with a missing harness export) and leaves `region.ts` untouched. Results are identical to the stopped run on every key (all tiers). Cost if wrong: a later metric wanting the sampler moves it into the harness.
- Ruling (spec text): §8.1 now states the scattered columns for T1/T2/T3/T5 with the new counts, T3 on in-column pairs, T4 `cache: false` with fast 4 regions, and the lowland-pair minimum on every tier; §8.2's T3 row and paragraph, the diagnostics bullet (floating rocks, other families) and §14's §6.4 bullet say lowland borders, full tier only; master §6.4's T3 row and SP3b's master exit line are amended the same way. One Threshold-log line (Task 13). Cost if wrong: wording only (the docs task re-reads them).

From "Task 13":

NO COMMIT (parts fail: T4.floorSd on fast, T3.value on quick; full passes). `dry/sp3b` stays at Task 12, worktree `P/dry` clean. The work is saved: `P/plan/task-13-terrain.metric.ts.draft` (the new `test/metrics/terrain.metric.ts`), `P/plan/task-13-uncommitted.patch` (`test/harness/region.ts` + `forEachColumnThreaded`, the T1-T5 rows in `test/thresholds.ts` = Task 12's row patch unchanged, and the accepted `test/thresholds.lock.json`; `git apply --check` clean on Task 12), the per-tier `.out` JSONs in `P/plan/task-13-out/{fast,quick,full}/T*.json`, and `P/plan/task-13-out/t4-variants.json`. RED evidence (before the rows): the file fails on Task 12 with "T1.band … T4.deepFloor: not in THRESHOLDS" (5 tests); `npm run typecheck` clean and `test/arch/thresholds.test.ts` 3/3 green with the rows and the lock. No Threshold-log line was added (nothing committed).

- MEASUREMENT (T1-T5 on the retuned world Task 12; each part = worse profile, seeds pooled per profile; `npx vitest run --project metrics-<tier> test/metrics/terrain.metric.ts`):

  | part (threshold) | fast default / large_biomes | quick default / large_biomes | full default / large_biomes | verdict |
  |---|---|---|---|---|
  | T1.band (≤ 0.25) | 0.2344 / 0.1792 | 0.2319 / 0.1834 | 0.2390 / 0.1828 | pass (default margin 0.011-0.018) |
  | T1.span (≥ 60) | 105 / 110 | 107 / 111 | 104 / 107 | pass |
  | T1.above120 (≥ 0.06) | 0.1665 / 0.1943 | 0.1670 / 0.1925 | 0.1567 / 0.1790 | pass |
  | T1.above200 (≥ 0.005) | 0.0221 / 0.0224 | 0.0234 / 0.0233 | 0.0204 / 0.0214 | pass |
  | T2.overhangs (≥ 0.015) | 0.0369 / 0.0445 | 0.0352 / 0.0433 | 0.0373 / 0.0432 | pass |
  | T2.overhangsPeaks (≥ 0.10) | 0.1035 / 0.1234 | 0.1005 / 0.1202 | 0.1093 / 0.1180 | pass (default margin 0.0005-0.009) |
  | T3.value, lowland only (≤ 1.5) | 1.371 / 0.924 (pairs 2,613 / 2,843) | **1.509** / 0.794 (5,006 / 5,171) | 1.189 / 0.944 (9,977 / 10,752) | **FAIL quick (default)** |
  | T4.floorSd (≥ 3) | 7.80 / **2.653** (1 region each) | 7.46 / 3.164 (4) | 5.69 / 3.193 (64) | **FAIL fast (large_biomes)** |
  | T4.exposedBedrock (0) | 0 / 0 (min floor 13 / 6) | 0 / 0 (8 / 4) | 0 / 0 (5 / 5) | pass |
  | T4.deepFloor (0) | 0 / 0 | 0 / 0 | 0 / 0 | pass |
  | T5.median (≤ 1) | 1 / 1 | 1 / 1 | 1 / 1 | pass |
  | T5.p90 (≤ 2) | 2 / 2 | 2 / 2 | 2 / 2 | pass |
  | T5.p99 (≤ 6) | 4 / 4 (max 25 / 30) | 4 / 4 (30 / 38) | 4 / 4 (27 / 55) | pass |

  Populations (default / large_biomes): columns fast 4,096 / 16,384, quick 8,192 / 32,768, full 16,384 / 65,536 (4 seeds); land positions fast 574,507 / 2,286,613, quick 1,153,094 / 4,593,133, full 2,251,347 / 9,021,799 (land share 0.54); peak columns fast 611 / 2,196, quick 1,170 / 4,426, full 2,275 / 8,407; T5 single-surface fast 33,768 / 132,674, quick 67,898 / 266,882, full 132,188 / 524,890 (multi-surface ≈ 6-7 %); T3 dropped pairs 0 on every tier; T4 site draws 3 / 28 / 456.
  Diagnostics (ungated): T3 other families (fast / quick / full, default; large_biomes): highland 1.141 / 1.234 / 1.277 (2,460 / 4,574 / 9,516 pairs); 1.123 / 1.171 / 1.080; all same-family pairs (§8.2's wording) 1.172 / 1.273 / 1.262; 1.084 / 1.117 / 1.066; coast/ocean/river borders are a few hundred pairs at most, ratio 0 (river 37.96 on 13 large_biomes full pairs). Floating rocks (land positions with a ≤ 6-high solid run on a ≥ 3 air gap, y ≥ −56): share fast 0.0171 / 0.0203, quick 0.0167 / 0.0201, full 0.0178 / 0.0203; within the peak biomes 0.046-0.055; voxels in such runs per land position 0.057-0.069. Water-wall share: scattered columns (in-column neighbours) fast 3.53e-4 / 1.18e-4, quick 3.81e-4 / 1.03e-4, full 3.64e-4 / 0.96e-4; T4 ocean regions 1.7e-5 (fast, 85 of 4.9 M), 4.3e-6 (quick), 2.9e-5 (full, 9,620 of 332 M).
  Wall time of the file (cold, no region cache involved; load 0.3-1 before each run, the full run itself pushes it to 4.6): fast 16.9 s (scattered default 3.3 s + large_biomes 12.3 s, T4 0.5 s; 61 s CPU, RSS 0.59 GB), quick 34.5 s (6.4 + 25.0 s, T4 2.3 s; RSS 0.74 GB), full 103.7 s (13.2 + 52.2 s, T4 37.5 s; RSS 0.99 GB). Region cache disk use: `test/.cache/regions` was 537,138,088 bytes before and after each tier's run: T1-T5 write 0 bytes (T3 has no regions, T4 `cache: false`); the 0.54 GB there are older DT1/Task-12 dumps (Task 12's draft wrote 1.2 GB quick / 9.3 GB full).

- Ruling (T3 lowland only, controller's/user's decision): `value` = Σ steep / Σ (p_a + p_b)/2 over land x/z neighbour pairs of two different biomes both in `biomeFamily` 'lowland'; every other family's ratio (`familyValue.<family>.<profile>`), its pair count and the all-same-family ratio (`allFamiliesValue.<profile>`) are recorded ungated in `.out/T3.json`. p_b is still biome b's inside steep share over the same columns (all families' inside pairs are counted). Cost if wrong: none.
- Ruling (T3 on the scattered columns): pairs are the 2 × 15 × 16 x/z neighbour pairs inside each 16 × 16 column of the T1/T2/T5 pass (aux A per-block `surfaceBiome`, land ⇔ WS = OF, top = WS − 1); no harness regions. The pair statistic is order-independent: per biome pair `(min << 8) | max` counts and steep counts in two Float64Arrays, summed in index order (deterministic). Cost if wrong: none.
- Ruling (column counts; Spec defect below): the 2,000 lowland-pair minimum needs ≈ 0.64 pairs per default column and ≈ 0.17 per large_biomes column (4× larger biomes): §8.1's 512 gave 447 / 106. Columns per (profile, seed) are now fast 4,096 / 16,384, quick 8,192 / 32,768, full 4,096 / 16,384 (× 4 seeds); fast measures 2,613 / 2,843 pairs. Cost if wrong: time (above).
- Ruling (threads): the scattered pass runs on 4 region workers (`forEachColumnThreaded` in `test/harness/region.ts`, reusing `regionWorker.ts`: one small shared store per worker, 8 MiB pools, a worker's next column only after `visit` freed its previous one, so torus slots never collide and repeated draws are fine), and the main thread reads each finished column (solidity, T1/T2/T5 scans, surfaceEst3, T3 pairs). Single-threaded the fast tier took 40.4 s; threaded 15.8 s, the main thread bound (fill 1.57 ms on a worker vs surfaceEst3 0.39 ms + scans per column here). Every accumulator is an integer count, a sorted array or the index-ordered T3 sums, so the result does not depend on completion order: checked against the single-thread run of the same draws, T1/T2/T5 identical, T3 equal to the last 2-3 ulps (the old list summed in draw order). Cost if wrong: back to 40 s single-threaded.
- Ruling (T4 `cache: false`): regions via `genRegion(..., threads: 4, cache: false)` into a 256 × 256 grid; no dump is read or written. Cost if wrong: none.
- Ruling (floating-rock diagnostic): per land position, scanning y −56 … top + 1, a maximal solid run of height ≤ 6 whose air gap directly below is ≥ 3 blocks counts; `floatingRockShare` = land positions with ≥ 1 such run / land positions, `floatingRockVoxels` = voxels in such runs / land positions, `floatingRockPeaksShare` the same share within the five peak biomes, recorded in `.out/T2.json` (ungated). It is a per-column proxy: thin overhang roofs and arch tops also count, true 3D islet detection is SP3d/SP6's cleanup. Cost if wrong: the diagnostic over-counts by the thin ledges.
- Ruling (water-wall diagnostic): now on the scattered columns with in-column neighbours (`.out/T1.json`, `waterWallShare.<profile>`) and on the T4 regions (`.out/T4.json`), with Task 12's aux-A definition. Cost if wrong: an undercount at column borders.
- Spec defect: §8.1 "Columns per (profile, seed): fast 512, quick 2048, full 4096" with T3 on the scattered columns and "same-family border pairs for T3: 2,000" (now lowland pairs) → fast 4,096 / 16,384, quick 8,192 / 32,768, full 4,096 / 16,384 per seed (default / large_biomes), generated on 4 workers.
- MEASUREMENT (why T3 fails on quick, no knob per §8.3): T3 is noise-limited, not biased. The default lowland ratio rests on few steep events: quick has 83 steep border pairs against 55.0 expected (5,006 pairs, steep share 1.66 % vs 1.10 %). Quick's first 4,096 default columns are fast's (same stream): 1.371 (40 steep / 29.2 expected); its other 4,096 give ≈ 1.67 (43 / 25.8); full's 16,384 columns on 4 seeds give 1.189 (132 / 111). Poisson alone puts the sd of a 2,000-5,000-pair estimate at ≈ 0.15-0.25 (and steep pairs cluster within a column), so a 1.5 gate on a true ≈ 1.2-1.4 fails some fixed draws. Options for the controller/user: gate T3 only on full (record on fast/quick); a minimum of ~10,000 lowland pairs (≈ 16 k default / 64 k large_biomes columns per tier, ≈ +60 s fast); quick on 4 seeds like full; or a different threshold.
- MEASUREMENT (why T4 fails on fast): fast has 1 region per profile, and a single large_biomes ocean region's floor sd varies 2.65-3.84 (`t4-variants.json`: seed '42', the first 4 T4 sites of each profile with the current defaults, the pre-retune overhang noise, the SP1 offset/σ fixtures, and both reverted). The shape retune changes no ocean site (σ 3 there, identical values); the overhang noise retune moves single sites both ways (2.72 vs 3.60, 3.12 vs 3.42, 3.84 vs 3.04, 2.97 vs 2.87 large_biomes; default 7.8 vs 9.0, 12.9 vs 12.0, 3.01 vs 3.27, 6.09 vs 6.71). The large_biomes mean is ≈ 3.2 (quick 3.164 over 4, full 3.193 over 64), a thin margin over 3; Task 12 measured fast 3.08 / quick 3.23 / full 3.26 before the retune. Options: fast 4 T4 regions like quick (+≈ 2 s, 3.16 passes), or the §8.3 knob (σ and jag at ocean C; not measured here), or the user decides.

From "Controller — decisions after the Task 13 stop (2026-10-07)":

- Ruling (controller): T4 measures 4 regions per (profile, seed) on fast as on quick (fast's single region per profile was sampling noise: large_biomes 2.653 vs ≈ 3.2 over more regions) — cost: ≈ 2 s on the fast tier.
- User decision: T3 (lowland borders) GATES ONLY ON THE FULL TIER (4 seeds, the most stable sample: 1.19); fast and quick measure and record it ungated. Implementation: `ThresholdPart` gains an optional `tiers?: readonly ('fast' | 'quick' | 'full')[]` (absent = every tier, as now); `evaluateMetric` gates a part only on its listed tiers and records it as a diagnostic elsewhere; the thresholds lock includes the field (`npm run test:accept-thresholds`, Threshold-log line), and the spec gets the amendment (§8.2 and master §6.4: "T3 gates on the full tier only") — cost if wrong: quick/fast regressions of T3 surface only in the full tier (run before every exit).

---

### Task 14: Bench rows and the T gate

**Spec:** §10 Bench

**Files:**
- Modify: `test/baselines.json`
- Modify: `test/bench/gates.ts`
- Modify: `test/bench/noise.bench.ts`
- Modify: `test/unit/benchGates.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/gen/density/context.ts` (Task 6): `createDensityContext`
- Produces (exports added by this task):
  - `test/bench/gates.ts`:
    - `export const TERRAIN_P50_MAX_MS = 4;`
    - `export interface AbsoluteLatencies`
    - `export function absoluteGateFailures(l: AbsoluteLatencies): string[]`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/benchGates.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/benchGates.test.ts b/test/unit/benchGates.test.ts
index 04497df..2db49fc 100644
--- a/test/unit/benchGates.test.ts
+++ b/test/unit/benchGates.test.ts
@@ -1,11 +1,25 @@
 import { readFileSync } from 'node:fs';
 import { expect, test } from 'vitest';
-import { BENCH_ROWS, gateFailures, KILL_RATIO_MAX, P1_MAX_REGRESSION, type Baselines } from '../bench/gates';
+import {
+  absoluteGateFailures, BENCH_ROWS, COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, KILL_RATIO_MAX, P1_MAX_REGRESSION, TERRAIN_P50_MAX_MS,
+  type Baselines,
+} from '../bench/gates';
 
 const base: Baselines = { machine: 'm', node: 'v24', date: '2026-09-27', killRatio: 1.2, kernels: { a: { nsPerEval: 10, ratio: 2 }, b: { nsPerEval: 5, ratio: 1 } } };
 
 test('constants', () => {
   expect([P1_MAX_REGRESSION, KILL_RATIO_MAX]).toEqual([1.3, 1.6]);
+  expect([COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, TERRAIN_P50_MAX_MS]).toEqual([0.7, 1.2, 4]);
+});
+
+test('absolute gates: column p50 / p95 (P1, SP2a) and the real T column p50 (SP3b §10), inclusive', () => {
+  expect(absoluteGateFailures({ columnP50: 0.7, columnP95: 1.2, terrainP50: 4 })).toEqual([]);
+  expect(absoluteGateFailures({ columnP50: 0.71, columnP95: 1.21, terrainP50: 4.01 })).toEqual([
+    'P1 column p50 0.710 ms > 0.7 ms',
+    'P1 column p95 1.210 ms > 1.2 ms',
+    'terrain.real p50 4.010 ms > 4 ms',
+  ]);
+  expect(absoluteGateFailures({ columnP50: 0.3, columnP95: 0.5, terrainP50: 4.5 })).toEqual(['terrain.real p50 4.500 ms > 4 ms']);
 });
 
 test('no baseline: only the kill criterion gates', () => {
@@ -19,13 +33,14 @@ test('P1: a kernel ratio above 1.3 × its baseline fails; new kernels are ignore
   ]);
 });
 
-test('the bench rows: SP1 to SP2b, then the SP3a store and provisional T rows (SP3a §7)', () => {
+test('the bench rows: SP1 to SP2b, the SP3a store row, then the SP3b density corner and real T rows (SP3b §10)', () => {
   expect(BENCH_ROWS).toEqual([
     'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
     'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
     'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
-    'store.alloc', 'terrain.provisional',
+    'store.alloc', 'density.corner', 'terrain.real',
   ]);
+  expect(BENCH_ROWS).not.toContain('terrain.provisional');
   expect(new Set(BENCH_ROWS).size).toBe(BENCH_ROWS.length);
 });
 
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/benchGates.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× constants 5ms
× absolute gates: column p50 / p95 (P1, SP2a) and the real T column p50 (SP3b §10), inclusive 0ms
× the bench rows: SP1 to SP2b, the SP3a store row, then the SP3b density corner and real T rows (SP3b §10) 1ms
FAIL  |unit| test/unit/benchGates.test.ts > constants
AssertionError: expected [ 0.7, 1.2, undefined ] to deeply equal [ 0.7, 1.2, 4 ]
FAIL  |unit| test/unit/benchGates.test.ts > absolute gates: column p50 / p95 (P1, SP2a) and the real T column p50 (SP3b §10), inclusive
TypeError: absoluteGateFailures is not a function
FAIL  |unit| test/unit/benchGates.test.ts > the bench rows: SP1 to SP2b, the SP3a store row, then the SP3b density corner and real T rows (SP3b §10)
AssertionError: expected [ 'calibration.fmix32', …(19) ] to deeply equal [ 'calibration.fmix32', …(20) ]
Test Files  1 failed (1)
Tests  3 failed | 3 passed (6)
```

- [ ] **Step 3: Implement**

Modify `test/bench/gates.ts` (apply with `git apply`):

```diff
diff --git a/test/bench/gates.ts b/test/bench/gates.ts
index d647581..3f6b611 100644
--- a/test/bench/gates.ts
+++ b/test/bench/gates.ts
@@ -4,17 +4,20 @@ export const KILL_RATIO_MAX = 1.6;
 /** P1 column-stage budget (master §3.0): buildColumnSample p50 / p95 in ms on the reference machine (SP2a; p95 gated through p99). */
 export const COLUMN_P50_MAX_MS = 0.7;
 export const COLUMN_P95_MAX_MS = 1.2;
+/** SP3b exit (master §10, SP3b spec §10): the real T stage's `terrain.real` p50 in ms per column, its ColumnSample included. */
+export const TERRAIN_P50_MAX_MS = 4;
 
 /**
  * Every gated bench row, in measurement order: `noise.bench.ts` measures exactly these, and `test/baselines.json`
  * records every one (a unit test), so a row added without `npm run bench:record` cannot stay ungated.
- * SP3a §7 appends `store.alloc` and `terrain.provisional`.
+ * SP3a §7 appends `store.alloc` and `terrain.provisional`; SP3b §10 appends `density.corner` and replaces
+ * `terrain.provisional` by `terrain.real`.
  */
 export const BENCH_ROWS = [
   'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
   'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
   'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
-  'store.alloc', 'terrain.provisional',
+  'store.alloc', 'density.corner', 'terrain.real',
 ] as const;
 
 export interface BenchKernel {
@@ -43,3 +46,22 @@ export function gateFailures(baseline: Baselines | null, kernels: Readonly<Recor
   }
   return out;
 }
+
+/** The absolute latencies the bench gates, in ms per call (`columnP95` is the measured p99, an upper bound of p95). */
+export interface AbsoluteLatencies {
+  readonly columnP50: number;
+  readonly columnP95: number;
+  readonly terrainP50: number;
+}
+
+/**
+ * The absolute gates (P1 column budget, SP2a; the real T budget, SP3b): checked by `npm run bench` and before
+ * `npm run bench:record` writes, so a record refuses to write when one fails.
+ */
+export function absoluteGateFailures(l: AbsoluteLatencies): string[] {
+  const out: string[] = [];
+  if (l.columnP50 > COLUMN_P50_MAX_MS) out.push(`P1 column p50 ${l.columnP50.toFixed(3)} ms > ${COLUMN_P50_MAX_MS} ms`);
+  if (l.columnP95 > COLUMN_P95_MAX_MS) out.push(`P1 column p95 ${l.columnP95.toFixed(3)} ms > ${COLUMN_P95_MAX_MS} ms`);
+  if (l.terrainP50 > TERRAIN_P50_MAX_MS) out.push(`terrain.real p50 ${l.terrainP50.toFixed(3)} ms > ${TERRAIN_P50_MAX_MS} ms`);
+  return out;
+}
```

Modify `test/bench/noise.bench.ts` (apply with `git apply`):

```diff
diff --git a/test/bench/noise.bench.ts b/test/bench/noise.bench.ts
index 3738d98..7576742 100644
--- a/test/bench/noise.bench.ts
+++ b/test/bench/noise.bench.ts
@@ -13,13 +13,14 @@ import { genKey, stageHashes } from '../../src/core/stage/hash';
 import { DENSITY3D_DEF, JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
 import { seedFromInput } from '../../src/core/seed';
 import { createGenContext } from '../../src/gen/context';
+import { createDensityContext } from '../../src/gen/density/context';
 import { columnPoint } from '../../src/gen/column/columnPoint';
 import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
 import { paintTile } from '../../src/gen/map/tile';
 import { fillColumnT } from '../../src/metrics/region';
 import { createStore } from '../../src/world/store/store';
 import { createTaskHandler } from '../../src/workers/taskHandler';
-import { BENCH_ROWS, COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, type Baselines, type BenchKernel } from './gates';
+import { absoluteGateFailures, BENCH_ROWS, gateFailures, type Baselines, type BenchKernel } from './gates';
 import { buildPerm, perm3 } from './perm512';
 
 const FMIX = fmix32;
@@ -33,11 +34,12 @@ const BASELINE_PATH = fileURLToPath(new URL('../baselines.json', import.meta.url
 const N = 4096;
 let sink = 0;
 
-test('SP1, SP2a, SP2b and SP3a kernels', async ({ bench }) => {
+test('SP1, SP2a, SP2b, SP3a and SP3b kernels', async ({ bench }) => {
   const ns: Record<string, number> = {};
   const measure = async (name: string, evals: number, fn: () => void, iterations?: number) => {
     const r = await bench(name, fn).run(iterations === undefined ? undefined : { iterations, time: 0, warmupIterations: 1 });
     ns[name] = (r.latency.p50 * 1e6) / evals;
+    return r;
   };
   const rng = new Xoshiro128(7);
   const ints = Uint32Array.from({ length: N }, () => rng.nextU32());
@@ -101,14 +103,25 @@ test('SP1, SP2a, SP2b and SP3a kernels', async ({ bench }) => {
   await measure('map.tile.b256.biome', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'biome', 256, tx, tz, tile); sink += tile[0]!; }, 8);
   await measure('map.tile.b256.relief', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'relief', 256, tx, tz, tile); sink += tile[0]!; }, 8);
   // SP3a §7, on one shared store (the backend the 4-thread harness and SP4's streaming use): one alloc and free on
-  // the byte pool (the lock, a stack pop and push, the refcount), and one column's provisional T stage including its
-  // ColumnSample, through fillColumnT (claim, 24 sections, aux A, commit) and the freeColumn that recycles its slots.
+  // the byte pool (the lock, a stack pop and push, the refcount), and (SP3b §10) one column's real T stage including
+  // its ColumnSample, through fillColumnT (claim, density phase, water, 24 sections, aux A and B, commit) and the
+  // freeColumn that recycles its slots.
   const store = createStore({ shared: true, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
   const bytePool = store.bytePool;
   await measure('store.alloc', N, () => { for (let i = 0; i < N; i++) { const id = bytePool.alloc(); bytePool.free(id); sink += id; } });
+  // SP3b §10: one corner of the default density expression (cornerFn: every interpolated slot at one corner, no
+  // early-outs), measured as the 5 × 49 × 5 corners of column (0, 0) with the column's corner cache cleared first.
+  const dc = createDensityContext(gen);
+  dc.column(0, 0);
+  const compiled = dc.compiled;
+  await measure('density.corner', 1225, () => {
+    compiled.cornerReady.fill(0);
+    for (let k = 0; k < 49; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) compiled.cornerFn(i, k, j);
+    sink += compiled.cornerValues[612]!;
+  });
   const never = (): boolean => false;
   let tc = 0;
-  await measure('terrain.provisional', 1, () => {
+  const terrainRun = await measure('terrain.real', 1, () => {
     tc++;
     const tcx = (tc * 7919) % 60000 - 30000;
     const tcz = (tc * 104729) % 60000 - 30000;
@@ -126,8 +139,9 @@ test('SP1, SP2a, SP2b and SP3a kernels', async ({ bench }) => {
   console.table(kernels);
   console.log(`killRatio ${killRatio}`);
   console.log(`column.sample p50 ${columnRun.latency.p50.toFixed(3)} ms, p99 (≥ p95) ${columnP95.toFixed(3)} ms`);
-  expect(columnRun.latency.p50, 'P1 column p50').toBeLessThanOrEqual(COLUMN_P50_MAX_MS);
-  expect(columnP95, 'P1 column p95').toBeLessThanOrEqual(COLUMN_P95_MAX_MS);
+  console.log(`terrain.real p50 ${terrainRun.latency.p50.toFixed(3)} ms, p99 ${terrainRun.latency.p99.toFixed(3)} ms`);
+  // Before the record: bench:record refuses to write when an absolute gate fails.
+  expect(absoluteGateFailures({ columnP50: columnRun.latency.p50, columnP95, terrainP50: terrainRun.latency.p50 }), 'absolute gates').toEqual([]);
   expect(Number.isFinite(sink)).toBe(true);
   if (process.env.BENCH_RECORD === '1') {
     const next: Baselines = { machine: cpus()[0]?.model ?? 'unknown', node: process.version, date: new Date().toISOString().slice(0, 10), kernels, killRatio };
```

- [ ] **Step 4: Regenerate the governed files**

`test/baselines.json` is recorded on your machine, not copied: its numbers are machine-specific. `npm run bench:record` rewrites every row and refuses to write when an absolute gate fails (column p50 ≤ 0.7 ms, p95 ≤ 1.2 ms, and from this task `terrain.real` p50 ≤ 4 ms), so nothing else may load the CPU (SP3a spec §7). In this order:

1. `npm run bench`: against the SP3a baseline the existing rows must pass (the two new rows are skipped while absent).
2. `npm run bench:record`.
3. `npm run bench`: every row within +30 %.

Then check that `git diff test/baselines.json` adds `density.corner` and `terrain.real` and removes `terrain.provisional`. On the reference machine `terrain.real` is about 1.45 ms per column and `density.corner` about 188 ns per corner.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/benchGates.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  6 passed (6)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  135 passed | 2 skipped (137)
Tests  1805 passed | 4 skipped (1809)
```

- [ ] **Step 7: Commit**

```bash
git add test/baselines.json test/bench/gates.ts test/bench/noise.bench.ts test/unit/benchGates.test.ts
git commit -F - <<'EOF'
test(bench): density.corner and terrain.real rows, the T p50 gate, re-recorded baseline (SP3b §10)

density.corner  one corner of the default density expression (cornerFn,
                the 5 × 49 × 5 corners of column (0, 0), corner cache
                cleared per sample), reported per corner;
terrain.real    one column's real T stage including its ColumnSample,
                through fillColumnT + freeColumn, replacing
                terrain.provisional.

gates.ts gains TERRAIN_P50_MAX_MS = 4 and absoluteGateFailures (column
p50/p95 and terrain.real p50), asserted before bench:record writes, so the
record refuses when one fails. Baseline recorded on the quiet reference
machine (bench -> record -> bench).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `ccc1622` on `dry/sp3a`; 4 files changed, 109 insertions(+), 54 deletions(-)):

Commit Task 14 on `dry/sp3b` (worktree `P/dry`, parent Task 13; 4 files, 109 insertions, 54 deletions: `test/bench/gates.ts`, `test/bench/noise.bench.ts`, `test/unit/benchGates.test.ts`, `test/baselines.json`). RED (the commit's `benchGates.test.ts` over a `git archive` copy of Task 13): 3 of 6 fail — `constants` (`[0.7, 1.2, undefined]` vs `[0.7, 1.2, 4]`), the absolute-gates test (`absoluteGateFailures is not a function`), the row list (`terrain.provisional` instead of `density.corner`, `terrain.real`); 2 `tsc -p tsconfig.test.json` errors (no exported `absoluteGateFailures`, `TERRAIN_P50_MAX_MS`). GREEN: typecheck clean; `npm test` 135 files passed, 2 skipped; 1786 tests passed, 4 skipped (49 s wall). Machine quiet throughout the bench: `uptime` load 0.18-0.70 (1-min) before each run, `top` 81 % idle, only short-lived `gh` processes and the desktop; no wait needed. Each bench run ≈ 30 s.

- BENCH NUMBERS (reference machine i7-12700H, node v24.21.0):
  - run 1, `npm run bench` against the SP3a baseline (2026-10-03), new code: PASS. calibration.fmix32 0.636 ns; column.sample p50 0.340 ms, p99 0.460 ms; `density.corner` 187.803 ns per corner (ratio 295.408); `terrain.real` p50 1.454 ms (ratio 2,287,312), p99 2.305 ms; store.alloc 157.469 ns; killRatio 0.869. Worst ratio against the old baseline: stageHashes.genKey 1.051, then lattice3.random 1.043 (the new rows are not in the old baseline, so ungated in this run, as SP3a's were).
  - `npm run bench:record`: written (exit 0). calibration 0.637 ns; column.sample p50 0.338 ms, p99 0.470 ms; `density.corner` 187.54 ns / ratio 294.204; `terrain.real` 1.463 ms (nsPerEval 1,462,816) / ratio 2,294,789.098, p99 2.354 ms; store.alloc 157.138 ns / 246.51; killRatio 0.832. Recorded/old ratio per kept row: worst stageHashes.genKey 1.064, all others ≤ 1.008. `terrain.provisional` is gone from the file.
  - run 3, `npm run bench` against the new baseline: PASS. calibration 0.636 ns; column.sample p50 0.341 ms, p99 0.482 ms; `density.corner` 189.409 ns / 297.59; `terrain.real` p50 1.453 ms, p99 2.331 ms; killRatio 0.828. Worst ratio against the record: map.tile.b256.relief 1.030, then lattice3.slice 1.013, density.corner 1.012.
  - `terrain.real` vs the gate: 1.45-1.46 ms against `TERRAIN_P50_MAX_MS` 4 (2.7 × margin); vs SP3a's quiet `terrain.provisional` 0.665 ms, the real T costs ≈ 2.2 ×.

- Ruling (`density.corner`): `createDensityContext(gen)` (default expression, seed '42', default params), column (0, 0) made current once (`dc.column`); each sample clears `compiled.cornerReady` and calls `cornerFn` on all 5 × 49 × 5 = 1,225 corners, reported per corner (evals 1225). This is "one corner" without early-outs and without the per-column corner cache; the 1,225-byte fill is noise next to ≈ 230 µs per sample. Column (0, 0) is the `sp3b.density.default` golden's column. Cost if wrong: corner cost may differ slightly by column (the noises cost the same everywhere).
- Ruling (`terrain.real`): exactly SP3a's `terrain.provisional` body under the new name — one column per sample at the `column.sample` pseudo-random sequence, `fillColumnT(store, gen, cx, cz, never)` + `store.freeColumn` on the shared store; it now runs the real T (density phase with early-outs, water v0, 24 sections, aux A and B) on the stage's own DensityContext (its WeakMap per GenContext, not the bench's `dc`). The no-leak asserts on both pools stay. The row is measured after `store.alloc` and `density.corner` (BENCH_ROWS order `…, 'store.alloc', 'density.corner', 'terrain.real'`). Cost if wrong: none.
- Ruling (gate wiring): `gates.ts` exports `TERRAIN_P50_MAX_MS = 4` and `absoluteGateFailures({columnP50, columnP95, terrainP50})` (inclusive bounds, messages like `terrain.real p50 4.010 ms > 4 ms`); the bench replaces its two column `expect`s by one `expect(absoluteGateFailures(…)).toEqual([])` placed before the `BENCH_RECORD` write, so `bench:record` refuses to write when any absolute gate fails (as the P1 column gate did). `columnP95` stays the measured p99 (SP2a). `measure` now returns the tinybench result so `terrain.real`'s p50 in ms is read directly. A unit test pins the three constants and the function (the failing-first test with the row list). The bench test title becomes 'SP1, SP2a, SP2b, SP3a and SP3b kernels'. Cost if wrong: none.
- Ruling (baseline): `test/baselines.json` is committed from the quiet record above (machine, node unchanged, date 2026-10-07); the executor re-records on its own machine per SP3a §7. Cost if wrong: none.
- Spec defects: none.
- Problems: none.

---

### Task 15: Review slices on the real T and the uiSmoke mountain line

**Spec:** §7 review slices and uiSmoke, §11 visual review

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/superpowers/specs/assets/sp3b/cross-section-voxels-mountain.png`
- Create: `docs/superpowers/specs/assets/sp3b/slice-coast.png`
- Create: `docs/superpowers/specs/assets/sp3b/slice-lake.png`
- Create: `docs/superpowers/specs/assets/sp3b/slice-mountain.png`
- Create: `docs/superpowers/specs/assets/sp3b/slice-river.png`
- Create: `docs/superpowers/specs/assets/sp3b/slice-y62.png`
- Create: `docs/superpowers/specs/assets/sp3b/slices.json`
- Modify: `package.json`
- Modify: `test/harness/reviewSlices.ts`
- Modify: `test/tools/uiSmoke.ts`
- Modify: `test/unit/reviewSlices.test.ts`
- Modify: `test/unit/uiSmoke.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `test/harness/reviewSlices.ts`:
    - `export const MOUNTAIN_SIGMA = 8;`
    - `export interface PositionVoxels`
    - `export function positionVoxels(view: RegionView, x: number, z: number): PositionVoxels`
    - `export function positionKind(view: RegionView, s: ColumnSample, x: number, z: number): ReviewKind`
    - `export function kindReader(ctx: GenContext, view: RegionView, z: number): (x: number) => ReviewKind`
    - `export interface LineSummary`
    - `export function lineSummary(view: RegionView, z: number, x0: number, n: number, kindOf: (x: number) => ReviewKind): LineSummary`
    - `export function siteLine(site: ReviewSite): { readonly z: number; readonly x0: number; readonly n: number }`
    - `export function mountainShare(ctx: GenContext, site: VerticalSite): number`
    - `export function cropProblems(view: RegionView, site: VerticalSite): string[]`
    - `export async function generateLine(seed: string, params: Params, site: ReviewSite): Promise<RegionView>`
  - `test/tools/uiSmoke.ts`:
    - `export interface Segment { readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }`
    - `export function parseSegment(text: string): Segment | null`
    - `export const MOUNTAIN_LINE =`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/reviewSlices.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/reviewSlices.test.ts b/test/unit/reviewSlices.test.ts
index dc4d6af..23f85fd 100644
--- a/test/unit/reviewSlices.test.ts
+++ b/test/unit/reviewSlices.test.ts
@@ -1,33 +1,54 @@
 import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
-import { describe, expect, test } from 'vitest';
-import { buildColumnSample, newColumnSample, readLevel } from '../../src/gen/column/columnStage';
-import { fluidType } from '../../src/world/blocks/fluid';
-import { BEDROCK } from '../../src/world/blocks/index';
+import { beforeAll, describe, expect, test } from 'vitest';
+import { buildColumnSample, newColumnSample, readField, readLevel } from '../../src/gen/column/columnStage';
+import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
+import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
 import { ctxFor, paramsWith } from '../harness/gen';
 import { encodePng, VOXEL_COLORS } from '../harness/png';
 import type { RegionView } from '../harness/region';
 import {
-  generateSite, lineKinds, positionKind, renderSite, REVIEW_KINDS, REVIEW_SITES, upscale, writeReviewSlices,
-  type ReviewKind, type VerticalSite,
+  cropProblems, generateLine, generateSite, kindReader, lineSummary, MOUNTAIN_SIGMA, mountainShare, positionKind, positionVoxels,
+  renderSite, REVIEW_KINDS, REVIEW_SITES, siteLine, upscale, writeReviewSlices, type ReviewKind, type ReviewSite, type VerticalSite,
 } from '../harness/reviewSlices';
 
 const ctx = ctxFor('42');
 const params = paramsWith();
 const verticals = REVIEW_SITES.filter((s): s is VerticalSite => s.kind === 'vertical');
+const site = (name: string): ReviewSite => REVIEW_SITES.find((s) => s.name === name)!;
 
-/** True when column (x, z) of the view holds a water voxel. */
-function wetAt(view: RegionView, x: number, z: number): boolean {
-  for (let y = -64; y <= 319; y++) if (fluidType(view.fluid(x, y, z)) !== 0) return true;
-  return false;
+type Runs = ReadonlyArray<readonly [number, number]>;
+
+/**
+ * A hand-built view: position x of the row (any z) holds `cols[x]`'s stone runs and water runs (default: stone up to
+ * y 40), bedrock at y −64; aux A as SP3a §3.4 computes it (OCEAN_FLOOR_WG over the highest stone, WORLD_SURFACE_WG
+ * over the highest stone or water).
+ */
+function fakeView(cols: ReadonlyArray<{ readonly stone: Runs; readonly water?: Runs }>): RegionView {
+  const at = (x: number) => cols[x] ?? { stone: [[-63, 40]] as Runs };
+  const inRuns = (runs: Runs | undefined, y: number) => (runs ?? []).some(([a, b]) => y >= a && y <= b);
+  const block = (x: number, y: number) => (y === -64 ? BEDROCK : inRuns(at(x).stone, y) ? STONE : AIR);
+  const fluid = (x: number, y: number) => (block(x, y) === AIR && inRuns(at(x).water, y) ? WATER_SOURCE : 0);
+  const highest = (x: number, wet: boolean) => {
+    for (let y = 319; y >= -64; y--) if (block(x, y) !== AIR || (wet && fluid(x, y) !== 0)) return y;
+    return -65;
+  };
+  return {
+    cx0: 0, cz0: 0, w: 1, h: 1,
+    block: (x: number, y: number) => block(x, y),
+    fluid: (x: number, y: number) => fluid(x, y),
+    biome: () => 0,
+    worldSurfaceWG: (x: number) => highest(x, true) + 1,
+    oceanFloorWG: (x: number) => highest(x, false) + 1,
+  } as unknown as RegionView;
 }
 
-describe('review sites (spec §12 visual review)', () => {
-  test('the sites: a coast, a lake and a river vertical slice, and a horizontal slice at y 62', () => {
-    expect(REVIEW_SITES.map((s) => s.name)).toEqual(['coast', 'lake', 'river', 'y62']);
+describe('review sites (SP3b spec §7, §11 visual review)', () => {
+  test('the sites: SP3a\'s coast, lake and river, a mountain, and a horizontal slice at y 62', () => {
+    expect(REVIEW_SITES.map((s) => s.name)).toEqual(['coast', 'lake', 'river', 'mountain', 'y62']);
     expect(new Set(REVIEW_SITES.map((s) => s.file)).size).toBe(REVIEW_SITES.length);
-    const y62 = REVIEW_SITES.find((s) => s.name === 'y62')!;
+    const y62 = site('y62');
     expect(y62.kind === 'horizontal' && y62.y).toBe(62);
     for (const s of REVIEW_SITES) {
       expect(s.w, s.name).toBeGreaterThanOrEqual(1);
@@ -38,51 +59,163 @@ describe('review sites (spec §12 visual review)', () => {
         expect(s.checkZ >> 4).toBeLessThan(s.cz0 + s.h);
       }
     }
+    // SP3a's lines, unchanged (the coast crop grew to y 159 with the real T's jag spike, SP3b Task 8).
+    for (const [name, cx0, w] of [['coast', -1696, 64], ['lake', -1024, 32], ['river', -972, 32]] as const) {
+      const s = site(name);
+      expect([s.kind, s.cx0, s.w, s.kind === 'vertical' && s.z]).toEqual(['vertical', cx0, w, -31992]);
+    }
+    expect(siteLine(site('coast'))).toEqual({ z: -31992, x0: -27136, n: 1024 });
+    expect(siteLine(site('y62'))).toEqual({ z: -31992, x0: -27136, n: 1024 });
   });
 
-  test.each(REVIEW_SITES.map((s) => [s.name, s] as const))('%s: the line crosses every kind the site needs', (_name, site) => {
-    const kinds = lineKinds(ctx, site);
-    expect(Object.values(kinds).reduce((a, b) => a + b, 0)).toBe(16 * site.w);
-    for (const k of site.needs) expect(kinds[k], `${site.name} needs ${k}: ${JSON.stringify(kinds)}`).toBeGreaterThan(0);
+  test('the mountain (found by a scan): its line runs through highland biomes with σ > 8 on the 2D world', () => {
+    const m = site('mountain') as VerticalSite;
+    expect(m.kind).toBe('vertical');
+    expect(MOUNTAIN_SIGMA).toBe(8);
+    expect(m.needs).toEqual(['land']);
+    expect(m.z & 15).toBe(8);
+    // The scan (seed '42', rows cz −1024 … 960 step 64 and −786, 64-column windows over cx −1088 … 1023, the quart
+    // points of the row lz 8) ranked this window first, with all 256 points highland and σ > 8; the share over every
+    // block position of the line is re-derived here, so a change of the 2D world that moves the massif fails.
+    const share = mountainShare(ctx, m);
+    expect(share, `highland σ > 8 share ${share}`).toBeGreaterThanOrEqual(0.9);
+    expect(mountainShare(ctx, site('coast') as VerticalSite)).toBeLessThan(0.2);
   });
+});
 
-  test('positionKind: every kind occurs on the sites; a position outside the sample column throws', () => {
-    const seen = new Set<ReviewKind>();
-    for (const s of verticals) for (const [k, n] of Object.entries(lineKinds(ctx, s))) if (n > 0) seen.add(k as ReviewKind);
-    expect([...seen].sort()).toEqual([...REVIEW_KINDS].sort());
+describe('positions and lines read from the voxels', () => {
+  test('positionVoxels: the true top, the water surface, the open and filled extents, the transitions near the top', () => {
+    const v = fakeView([
+      { stone: [[-63, 70], [80, 90]] }, // an overhang: a dry pocket 71 … 79 under a stone roof
+      { stone: [[-63, 40]], water: [[41, 63]] }, // sea
+      { stone: [[-63, 50], [60, 62]], water: [[51, 59]] }, // water under a stone lid
+      { stone: [[-63, 10], [20, 25], [40, 45]] }, // two transitions above top − 30, one below
+    ]);
+    expect(positionVoxels(v, 0, 0)).toEqual({ top: 90, water: null, lowestOpen: 71, highestFilled: 90, transitions: 2, waterUnderTop: 0 });
+    expect(positionVoxels(v, 1, 0)).toEqual({ top: 40, water: 63, lowestOpen: 41, highestFilled: 63, transitions: 1, waterUnderTop: 0 });
+    expect(positionVoxels(v, 2, 0)).toEqual({ top: 62, water: null, lowestOpen: 51, highestFilled: 62, transitions: 2, waterUnderTop: 9 });
+    expect(positionVoxels(v, 3, 0)).toEqual({ top: 45, water: null, lowestOpen: 11, highestFilled: 45, transitions: 2, waterUnderTop: 0 });
+  });
+
+  test('cropProblems: read from the voxels, so a pocket under an overhang below the crop fails though its top is inside', () => {
+    const v = fakeView([{ stone: [[-63, 70], [80, 90]] }, { stone: [[-63, 40]], water: [[41, 63]] }]);
+    const crop = (yMin: number, yMax: number): VerticalSite => ({
+      name: 't', file: 't.png', kind: 'vertical', cx0: 0, w: 1, z: 0, yMin, yMax, scale: 1, needs: [],
+    });
+    // Positions 2 … 15 hold stone up to 40.
+    expect(cropProblems(v, crop(41, 90))).toEqual([]);
+    expect(cropProblems(v, crop(72, 90))).toEqual([
+      '(0, 0): open at y 71, below the crop',
+      ...Array.from({ length: 15 }, (_, i) => `(${i + 1}, 0): open at y 41, below the crop`),
+    ]);
+    expect(cropProblems(v, crop(41, 89))).toEqual(['(0, 0): filled at y 90, above the crop']);
+    expect(cropProblems(v, crop(41, 62))).toEqual(['(0, 0): filled at y 90, above the crop', '(1, 0): filled at y 63, above the crop']);
+  });
+
+  test('positionKind: wet or dry from the voxels, not from the 2D estimate; a position outside the sample\'s column throws', () => {
     const s = buildColumnSample(ctx, 3, -2, newColumnSample());
-    expect(() => positionKind(s, 16 * 3 + 16, -32)).toThrow(RangeError);
-    expect(() => positionKind(s, 16 * 3, -33)).toThrow(RangeError);
+    // (48, −32) is dry land on the 2D estimate (no water level above ⌊surfaceEst⌋).
+    expect(Math.floor(readLevel(s, 'surfaceWaterLevel', 48, -32))).toBeLessThanOrEqual(Math.floor(readField(s, 'surfaceEst', 48, -32)));
+    const dry = fakeView([]);
+    const wet = { ...dry, worldSurfaceWG: () => 64 } as RegionView;
+    expect(positionKind(dry, s, 48, -32)).toBe('land');
+    expect(positionKind(wet, s, 48, -32)).toBe('sea');
+    expect(() => positionKind(dry, s, 16 * 3 + 16, -32)).toThrow(RangeError);
+    expect(() => positionKind(dry, s, 16 * 3, -33)).toThrow(RangeError);
   });
-});
 
-describe('vertical review slices over the generated voxels', () => {
-  test.each(verticals.map((s) => [s.name, s] as const))('%s: kinds agree with the voxels; the crop removes only air and stone', async (_name, site) => {
-    const view = await generateSite('42', params, site);
-    const s = newColumnSample();
+  test('lineSummary on a hand-built row: kinds, tops, overhang positions, water-wall faces, water under stone', () => {
+    const v = fakeView([
+      { stone: [[-63, 70], [80, 90]] },
+      { stone: [[-63, 40]], water: [[41, 63]] },
+      { stone: [[-63, 30]] },
+      { stone: [[-63, 40]], water: [[41, 63]] },
+      { stone: [[-63, 50], [60, 62]], water: [[51, 59]] },
+    ]);
+    const kinds: ReviewKind[] = ['land', 'sea', 'land', 'sea', ...Array<ReviewKind>(12).fill('land')];
+    const sum = lineSummary(v, 0, 0, 16, (x) => kinds[x]!);
+    expect(sum.kinds).toEqual({ land: 14, sea: 2, lake: 0, river: 0 });
+    expect([sum.topMin, sum.topMax, sum.waterMax]).toEqual([30, 90, 63]);
+    // ≥ 2 solid→air transitions in [top − 30, top] on land: position 0 (the roof) and 4 (the lid).
+    expect(sum.overhangs).toBe(2);
+    // Water beside dry air along the line: x 1 and x 3 beside x 2 (y 41 … 63: 23 + 23), x 3 beside x 4 at y 63 (1),
+    // x 4's water beside x 5 (y 51 … 59: 9).
+    expect(sum.waterWallFaces).toBe(56);
+    expect(sum.waterUnderStone).toBe(9);
+  });
+
+  // The real lines (seed '42', the real T), each generated once.
+  const views = new Map<string, RegionView>();
+  beforeAll(async () => {
+    for (const s of REVIEW_SITES) views.set(s.name, await generateLine('42', params, s));
+  }, 120_000);
+
+  test.each(REVIEW_SITES.map((s) => [s.name, s] as const))('%s: the line crosses every kind the site needs, read from the voxels', (_name, s) => {
+    const view = views.get(s.name)!;
+    const { z, x0, n } = siteLine(s);
+    const sum = lineSummary(view, z, x0, n, kindReader(ctx, view, z));
+    expect(Object.values(sum.kinds).reduce((a, b) => a + b, 0)).toBe(n);
+    for (const k of s.needs) expect(sum.kinds[k], `${s.name} needs ${k}: ${JSON.stringify(sum.kinds)}`).toBeGreaterThan(0);
+    const cs = newColumnSample();
     let cx = Number.NaN;
+    for (let x = x0; x < x0 + n; x++) {
+      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), z >> 4, cs);
+      const p = positionVoxels(view, x, z);
+      // Wet ⇔ a water voxel at WORLD_SURFACE_WG − 1, and every wet position has a water level (the T's water rule).
+      expect(p.water !== null, `(${x}, ${z})`).toBe(fluidType(view.fluid(x, view.worldSurfaceWG(x, z) - 1, z)) !== 0);
+      if (p.water !== null) expect(readLevel(cs, 'surfaceWaterLevel', x, z), `(${x}, ${z}) is wet`).not.toBe(-Infinity);
+      expect(p.top).toBe(view.oceanFloorWG(x, z) - 1);
+      expect(view.block(x, -64, z)).toBe(BEDROCK);
+    }
+    if (s.kind === 'vertical') expect(cropProblems(view, s), s.name).toEqual([]);
+  });
+
+  test('the coast line holds positions the 2D estimate calls land that are wet on the voxels, and they count as water', () => {
+    const coast = site('coast');
+    const view = views.get('coast')!;
+    const { z, x0, n } = siteLine(coast);
+    const kindOf = kindReader(ctx, view, z);
+    const cs = newColumnSample();
+    let cx = Number.NaN;
+    let wetOn2dLand = 0;
+    for (let x = x0; x < x0 + n; x++) {
+      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), z >> 4, cs);
+      const land2d = Math.floor(readLevel(cs, 'surfaceWaterLevel', x, z)) <= Math.floor(readField(cs, 'surfaceEst', x, z));
+      if (land2d && positionVoxels(view, x, z).water !== null) {
+        wetOn2dLand++;
+        expect(kindOf(x), `(${x}, ${z})`).not.toBe('land');
+      }
+    }
+    expect(wetOn2dLand).toBeGreaterThan(0);
+  });
+
+  test('every kind occurs on the vertical lines; lake water stands above y 63; the mountain rises above y 200 with overhangs', () => {
+    const seen = new Set<ReviewKind>();
     let lakeAbove63 = 0;
-    // On the real T (SP3b) σ, jag and detail move each position's top away from the 2D estimate, so the 2D kind no
-    // longer predicts every position's water: a wet position needs a finite water level, and each needed kind must
-    // show up wet (land: dry) somewhere on the line. Task 14 derives the kinds from the voxels.
-    const seen = { land: 0, sea: 0, lake: 0, river: 0 };
-    for (let x = 16 * site.cx0; x < 16 * (site.cx0 + site.w); x++) {
-      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), site.z >> 4, s);
-      const kind = positionKind(s, x, site.z);
-      const wet = wetAt(view, x, site.z);
-      if (wet) expect(readLevel(s, 'surfaceWaterLevel', x, site.z), `(${x}, ${site.z}) is wet`).not.toBe(-Infinity);
-      if (wet === (kind !== 'land')) seen[kind]++;
-      const top = view.worldSurfaceWG(x, site.z) - 1;
-      const floor = view.oceanFloorWG(x, site.z) - 1;
-      expect(top, `(${x}, ${site.z}) top ${top} above the crop`).toBeLessThanOrEqual(site.yMax);
-      expect(floor, `(${x}, ${site.z}) ground ${floor} below the crop`).toBeGreaterThanOrEqual(site.yMin);
-      if (kind === 'lake' && fluidType(view.fluid(x, top, site.z)) !== 0 && top > 63) lakeAbove63++;
-      expect(view.block(x, -64, site.z)).toBe(BEDROCK);
+    for (const s of verticals) {
+      const view = views.get(s.name)!;
+      const { z, x0, n } = siteLine(s);
+      const kindOf = kindReader(ctx, view, z);
+      const sum = lineSummary(view, z, x0, n, kindOf);
+      for (const k of REVIEW_KINDS) if (sum.kinds[k] > 0) seen.add(k);
+      if (s.name === 'lake') {
+        for (let x = x0; x < x0 + n; x++) {
+          const water = positionVoxels(view, x, z).water;
+          if (kindOf(x) === 'lake' && water !== null && water > 63) lakeAbove63++;
+        }
+      }
+      if (s.name === 'mountain') {
+        // The retuned overhang noise (SP3b §8.4): the review mountain shows T2's overhangs (214 of 1024 positions).
+        expect(sum.topMax).toBeGreaterThan(200);
+        expect(sum.overhangs, 'mountain overhang positions').toBeGreaterThanOrEqual(150);
+      }
     }
-    for (const k of site.needs) expect(seen[k], `${site.name}: ${k} on the voxels`).toBeGreaterThan(0);
-    if (site.needs.includes('lake')) expect(lakeAbove63).toBeGreaterThan(0);
+    expect([...seen].sort()).toEqual([...REVIEW_KINDS].sort());
+    expect(lakeAbove63).toBeGreaterThan(0);
   });
+});
 
+describe('review slice images', () => {
   test('renderSite: the slice size, the bottom row of bedrock at y −64, the upscale', async () => {
     const coast = verticals.find((s) => s.name === 'coast')!;
     expect([coast.yMin, coast.scale]).toEqual([-64, 1]);
@@ -109,32 +242,37 @@ describe('vertical review slices over the generated voxels', () => {
     expect(upscale(one, 1)).toBe(one);
   });
 
-  test('writeReviewSlices writes each site as the PNG of its slice', async () => {
+  test('writeReviewSlices writes each site as the PNG of its slice, with its line summary', async () => {
     const dir = mkdtempSync(join(tmpdir(), 'wi10-review-'));
     try {
-      const site: VerticalSite = { ...verticals.find((s) => s.name === 'coast')!, w: 4, file: 'small.png' };
-      const [written] = await writeReviewSlices(dir, '42', params, [site]);
+      const s: VerticalSite = { ...verticals.find((v) => v.name === 'coast')!, w: 4, file: 'small.png' };
+      const [written] = await writeReviewSlices(dir, '42', params, [s]);
       expect(written!.path).toBe(join(dir, 'small.png'));
       const bytes = readFileSync(written!.path);
-      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(encodePng(renderSite(await generateSite('42', params, site), site))));
+      const view = await generateSite('42', params, s);
+      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(encodePng(renderSite(view, s))));
       expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 224]);
       expect([written!.width, written!.height, written!.bytes]).toEqual([64, 224, bytes.length]);
+      expect(written!.summary).toEqual(lineSummary(view, s.z, 16 * s.cx0, 64, kindReader(ctx, view, s.z)));
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
+
+  test('npm run docs:review-slices writes SP3b\'s assets (SP3a\'s stay)', () => {
+    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
+    expect(pkg.scripts['docs:review-slices']).toBe('REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3b vitest run --project unit test/unit/reviewSlices.test.ts');
+  });
 });
 
 /**
- * `npm run docs:review-slices` sets REVIEW_SLICES_DIR to `docs/superpowers/specs/assets/sp3a` and writes every site
- * there (the 64 × 64 horizontal slice takes a few seconds), plus `slices.json` (each site and the kinds its line
- * crosses); without it nothing is written.
+ * `npm run docs:review-slices` sets REVIEW_SLICES_DIR to `docs/superpowers/specs/assets/sp3b` and writes every site
+ * there (the 64 × 64 horizontal slice takes several seconds), plus `slices.json` (each site and its line summary read
+ * from the voxels); without it nothing is written.
  */
 test.runIf(process.env.REVIEW_SLICES_DIR !== undefined)('write the review slices into REVIEW_SLICES_DIR', async () => {
   const written = await writeReviewSlices(process.env.REVIEW_SLICES_DIR!, '42', params);
   expect(written.map((w) => w.site.file)).toEqual(REVIEW_SITES.map((s) => s.file));
-  const summary = written.map((w) => ({
-    file: w.site.file, width: w.width, height: w.height, site: w.site, lineKinds: lineKinds(ctx, w.site),
-  }));
-  writeFileSync(join(process.env.REVIEW_SLICES_DIR!, 'slices.json'), `${JSON.stringify({ seed: '42', profile: 'default', slices: summary }, null, 2)}\n`);
+  const slices = written.map((w) => ({ file: w.site.file, width: w.width, height: w.height, site: w.site, summary: w.summary }));
+  writeFileSync(join(process.env.REVIEW_SLICES_DIR!, 'slices.json'), `${JSON.stringify({ seed: '42', profile: 'default', slices }, null, 2)}\n`);
 }, 300_000);
```

Modify `test/unit/uiSmoke.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/uiSmoke.test.ts b/test/unit/uiSmoke.test.ts
index 849da38..241933c 100644
--- a/test/unit/uiSmoke.test.ts
+++ b/test/unit/uiSmoke.test.ts
@@ -8,12 +8,15 @@ import { allGoldenKeys } from '../../src/metrics/sp2aGoldens';
 import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
 import { DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
 import { presetText } from '../../src/ui/presets/presetFile';
+import { segmentText } from '../../src/ui/crossSection/model';
 import { sliceSummary, voxelReadout } from '../../src/ui/crossSection/voxels';
 import { WATER_SOURCE } from '../../src/world/blocks/fluid';
 import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
 import { SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
+import { REVIEW_SITES } from '../harness/reviewSlices';
 import {
-  canonicalJson, goldenCount, ignoredLog, mapHash, parseArgs, presetProblems, readMapHash, sameJson, selftestAllMatch, SIZE_8, VIEWPORT, voxelReadoutOk, voxelSummaryOk, type MapUrlState,
+  canonicalJson, goldenCount, ignoredLog, mapHash, MOUNTAIN_LINE, parseArgs, parseSegment, presetProblems, readMapHash, sameJson, selftestAllMatch, SIZE_8, VIEWPORT,
+  voxelReadoutOk, voxelSummaryOk, type MapUrlState,
 } from '../tools/uiSmoke';
 
 const EDITED: MapState = {
@@ -104,6 +107,25 @@ describe('UI smoke test: pure parts (SP2b spec §8 Tools, §12)', () => {
     expect(voxelSummaryOk('offset 1.0 to 2.0 blocks · water on 0.0 % of the line')).toBe(false);
   });
 
+  test('the cut line\'s text reads back as its segment', () => {
+    for (const seg of [{ ax: -1664, az: 8, bx: -640, bz: 8 }, { ax: 5122, az: 3074, bx: 6658, bz: 3074 }, { ax: -2030, az: 7, bx: 1950, bz: -1990 }]) {
+      expect(parseSegment(segmentText(seg))).toEqual(seg);
+    }
+    expect(parseSegment('')).toBeNull();
+    expect(parseSegment('A (1, 2) → B (3, 4)')).toBeNull();
+  });
+
+  test('the mountain line (SP3b spec §7 uiSmoke) is the review mountain\'s line, drawn at 2 blocks/px from the view centre', () => {
+    const m = REVIEW_SITES.find((s) => s.name === 'mountain')!;
+    if (m.kind !== 'vertical') throw new Error('the mountain site is a vertical slice');
+    const { view, a, b } = MOUNTAIN_LINE;
+    expect(a).toEqual([16 * m.cx0, m.z]);
+    expect(b).toEqual([16 * (m.cx0 + m.w), m.z]);
+    expect(view).toEqual({ x: (a[0] + b[0]) / 2, z: m.z, bpp: 2, layer: 'relief' });
+    // ± 256 CSS px from the canvas centre: inside the map canvas of the 1400 px wide page.
+    expect((b[0] - a[0]) / view.bpp).toBe(512);
+  });
+
   test('arguments: build, the OS temp directory and no screenshots by default', () => {
     expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
     expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/reviewSlices.test.ts test/unit/uiSmoke.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× the cut line's text reads back as its segment 2ms
× the mountain line (SP3b spec §7 uiSmoke) is the review mountain's line, drawn at 2 blocks/px from the view centre 0ms
× the sites: SP3a's coast, lake and river, a mountain, and a horizontal slice at y 62 9ms
× the mountain (found by a scan): its line runs through highland biomes with σ > 8 on the 2D world 0ms
× writeReviewSlices writes each site as the PNG of its slice, with its line summary 31ms
× npm run docs:review-slices writes SP3b's assets (SP3a's stay) 1ms
FAIL  |unit| test/unit/reviewSlices.test.ts > positions and lines read from the voxels
TypeError: generateLine is not a function
FAIL  |unit| test/unit/reviewSlices.test.ts > review sites (SP3b spec §7, §11 visual review) > the sites: SP3a's coast, lake and river, a mountain, and a horizontal slice at y 62
AssertionError: expected [ 'coast', 'lake', 'river', 'y62' ] to deeply equal [ 'coast', 'lake', 'river', …(2) ]
FAIL  |unit| test/unit/reviewSlices.test.ts > review sites (SP3b spec §7, §11 visual review) > the mountain (found by a scan): its line runs through highland biomes with σ > 8 on the 2D world
TypeError: Cannot read properties of undefined (reading 'kind')
FAIL  |unit| test/unit/reviewSlices.test.ts > review slice images > writeReviewSlices writes each site as the PNG of its slice, with its line summary
TypeError: kindReader is not a function
… (5 more lines)
Test Files  2 failed (2)
Tests  6 failed | 11 passed | 11 skipped (28)
```

- [ ] **Step 3: Implement**

Modify `CLAUDE.md` (apply with `git apply`):

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index af5368c..9fbfe4e 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -24,12 +24,12 @@ Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with cus
 - `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
 - `npm run test:accept-state-ids` — append the states of new block types to `test/stateIds.lock.json` (append-only: refuses a changed id, a removed entry or a new state of a locked type; the commit message says the lock changed)
 - `npm run docs:params` — regenerate the README parameter table from the schema
-- `npm run docs:review-slices` — write the SP3a review PNG slices of the provisional terrain (a coast, a lake and a river, and y 62; seed 42) into `docs/superpowers/specs/assets/sp3a/` through the region harness
+- `npm run docs:review-slices` — write the SP3b review PNG slices of the T stage (a coast, a lake, a river and a mountain, and y 62; seed 42) and their `slices.json` into `docs/superpowers/specs/assets/sp3b/` through the region harness (SP3a's slices stay in `assets/sp3a/`)
 - `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1, SP2a and SP3a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
 - `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section with its Profile | Voxels toggle (SP3a: the real vertical slice of voxels), global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
 - `?map&perf=edit` — the same page with the SP2b latency hook (`src/ui/map/perfHook.ts`, `globalThis.__wiPerf`): pins the canvas to 1100 × 825 at seed 42, default profile, view (0, 0, 64 bpp)
 - `node test/tools/mapLatency.ts [--profile-dir DIR]` — the SP2b §2.8 edit → preview latency runner (not in CI; about 35 min): builds, serves `dist` on its own free port (never 5183), drives its own headless Chrome and writes `docs/superpowers/specs/assets/sp2b/latency-*.json`; `--quick` for a short run
-- `node test/tools/uiSmoke.ts [--profile-dir DIR] [--shots DIR]` — the SP2b UI smoke test (not in CI; about 1 min; SP3a adds the Voxels toggle): `?selftest=1`, then every editor driven with real pointer and key input and checked through the DOM and the URL, no console errors; `--shots` also writes the spec §12 screenshots
+- `node test/tools/uiSmoke.ts [--profile-dir DIR] [--shots DIR]` — the SP2b UI smoke test (not in CI; about 1 min; SP3a adds the Voxels toggle): `?selftest=1`, then every editor driven with real pointer and key input and checked through the DOM and the URL, no console errors; `--shots` also writes the spec §12 screenshots and (SP3b) the Voxels mode on a mountain line, `cross-section-voxels-mountain.png`
 - `docker compose up world-imaginer-voxel`
 - Each sub-project appends its id to `STARTED_SPS` in `test/harness/sp.ts` in its first commit. Appending changes the lock (`test/thresholds.lock.json`), so run `npm run test:accept-thresholds` and amend the spec in the same change.
 
```

Modify `package.json` (apply with `git apply`):

```diff
diff --git a/package.json b/package.json
index c905c86..1a707e6 100644
--- a/package.json
+++ b/package.json
@@ -21,7 +21,7 @@
     "test:accept-schema": "ACCEPT_SCHEMA=1 vitest run --project arch test/arch/schemaShape.test.ts",
     "test:accept-state-ids": "ACCEPT_STATE_IDS=1 vitest run --project arch test/arch/stateIds.test.ts",
     "docs:params": "WRITE_PARAMS_DOC=1 vitest run --project arch test/arch/paramsDoc.test.ts",
-    "docs:review-slices": "REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3a vitest run --project unit test/unit/reviewSlices.test.ts"
+    "docs:review-slices": "REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3b vitest run --project unit test/unit/reviewSlices.test.ts"
   },
   "dependencies": {
     "three": "~0.186.1"
```

Modify `test/harness/reviewSlices.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/reviewSlices.ts b/test/harness/reviewSlices.ts
index 56b5aa0..a4ad5bf 100644
--- a/test/harness/reviewSlices.ts
+++ b/test/harness/reviewSlices.ts
@@ -1,45 +1,147 @@
 /**
- * The SP3a visual review (spec §12, master §10 "PNG slices … attached to the SP spec"): the harness PNG slices of
- * the provisional T stage, at world seed '42' on the default profile — vertical slices across a coast, a lake and a
- * river, and a horizontal slice at y 62 — written by `npm run docs:review-slices` into
- * `docs/superpowers/specs/assets/sp3a/`.
+ * The visual review (SP3b spec §7, §11; SP3a spec §12; master §10 "PNG slices … attached to the SP spec"): the harness
+ * PNG slices of the T stage, at world seed '42' on the default profile — vertical slices across a coast, a lake, a
+ * river and a mountain, and a horizontal slice at y 62 — written by `npm run docs:review-slices` into
+ * `docs/superpowers/specs/assets/sp3b/` (SP3a's slices of the provisional T stay in `assets/sp3a/`).
  *
- * Each site states which kinds of position its line crosses (`needs`), and `lineKinds` re-derives them from the
- * ColumnSample (the §4 inputs), so a change of the 2D world that moves a coast, a lake or a river away from its
- * site fails the unit test instead of silently writing a slice without it.
+ * Each site states which kinds of position its line crosses (`needs`). The kinds and the crop checks are read from
+ * the voxels (SP3b §7): a position is wet when water stands above its highest stone, and only the water body (sea,
+ * lake or river) comes from the ColumnSample, so a world change that moves a coast, a lake or a river away from its
+ * site fails the unit test instead of silently writing a slice without it, and an overhang is checked as voxels.
  */
 import { mkdirSync, writeFileSync } from 'node:fs';
 import { join } from 'node:path';
 import type { Params } from '../../src/core/params/schema';
+import { seedFromInput } from '../../src/core/seed';
+import { biomeFamily } from '../../src/gen/biomes/registry';
 import {
-  buildColumnSample, latticeIndex, newColumnSample, readField, readLevel, riverWetAt, type ColumnSample,
+  buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, riverWetAt, type ColumnSample,
 } from '../../src/gen/column/columnStage';
-import type { GenContext } from '../../src/gen/context';
+import { createGenContext, type GenContext } from '../../src/gen/context';
+import { fluidType } from '../../src/world/blocks/fluid';
+import { AIR } from '../../src/world/blocks/index';
 import { genRegion, type RegionView } from './region';
 import { encodePng, sliceY, sliceZ, type RgbaImage } from './png';
 
-/** What a block position holds on the provisional T: dry land, or water of the sea, a lake or a river. */
+/** What a block position holds: dry land, or water of the sea, a lake or a river. */
 export type ReviewKind = 'land' | 'sea' | 'lake' | 'river';
 
 export const REVIEW_KINDS: readonly ReviewKind[] = ['land', 'sea', 'lake', 'river'];
 
+/** The σ a mountain site's line must exceed (SP3b spec §7 "a highland site with σ > 8"). */
+export const MOUNTAIN_SIGMA = 8;
+
+const MIN_Y = -64;
+const MAX_Y = 319;
+/** T2's overhang window (SP3b spec §8.2): transitions in [top − 30, top]. */
+const OVERHANG_DEPTH = 30;
+
+/** One position's column, read from the voxels. */
+export interface PositionVoxels {
+  /** The true top: the highest solid voxel (`OCEAN_FLOOR_WG − 1`). */
+  readonly top: number;
+  /** The water surface above the top (`WORLD_SURFACE_WG − 1`), or null when no water stands above the top. */
+  readonly water: number | null;
+  /** The lowest air voxel (with or without water) above the bedrock: the crop's yMin must not cut it. */
+  readonly lowestOpen: number;
+  /** The highest voxel that is not dry air (stone or water): the crop's yMax must not cut it. */
+  readonly highestFilled: number;
+  /** Solid→air transitions (solid at y, air at y + 1) with y in [top − 30, top] (T2's count). */
+  readonly transitions: number;
+  /** Water voxels below the top (under an overhang). */
+  readonly waterUnderTop: number;
+}
+
+const solidAt = (view: RegionView, x: number, y: number, z: number): boolean => y <= MAX_Y && view.block(x, y, z) !== AIR;
+const wetAt = (view: RegionView, x: number, y: number, z: number): boolean => view.block(x, y, z) === AIR && fluidType(view.fluid(x, y, z)) !== 0;
+
+export function positionVoxels(view: RegionView, x: number, z: number): PositionVoxels {
+  const top = view.oceanFloorWG(x, z) - 1;
+  const surface = view.worldSurfaceWG(x, z) - 1;
+  let lowestOpen = MAX_Y + 1;
+  let highestFilled = MIN_Y;
+  let transitions = 0;
+  let waterUnderTop = 0;
+  for (let y = MIN_Y; y <= MAX_Y; y++) {
+    const solid = solidAt(view, x, y, z);
+    const wet = !solid && wetAt(view, x, y, z);
+    if (!solid && y < lowestOpen) lowestOpen = y;
+    if (solid || wet) highestFilled = y;
+    if (wet && y < top) waterUnderTop++;
+    if (solid && !solidAt(view, x, y + 1, z) && y >= top - OVERHANG_DEPTH && y <= top) transitions++;
+  }
+  return { top, water: surface > top ? surface : null, lowestOpen, highestFilled, transitions, waterUnderTop };
+}
+
 /**
- * The kind of position (x, z), from a ColumnSample built for its column: land when it holds no water voxel
- * (`⌊surfaceWaterLevel⌋ ≤ ⌊surfaceEst⌋`, or no water level at all); otherwise a lake when the nearest quart corner
- * (as `readLevel` picks it) is inside a lake mask, a river when that corner is a wet river channel, else the sea.
+ * The kind of position (x, z): land when no water stands above its highest stone (on the voxels); otherwise the water
+ * body of the quart corner the T stage reads its level from (`readLevel`'s nearest corner): a lake when that corner is
+ * inside a lake mask, a river when it is a wet river channel, else the sea. `s` must be the sample of (x, z)'s column.
  */
-export function positionKind(s: ColumnSample, x: number, z: number): ReviewKind {
+export function positionKind(view: RegionView, s: ColumnSample, x: number, z: number): ReviewKind {
   const lx = x - 16 * s.cx;
   const lz = z - 16 * s.cz;
   if (lx < 0 || lx > 15 || lz < 0 || lz > 15) throw new RangeError(`positionKind: (${x}, ${z}) is outside column (${s.cx}, ${s.cz})`);
-  const top = Math.floor(readField(s, 'surfaceEst', x, z));
-  const swl = readLevel(s, 'surfaceWaterLevel', x, z);
-  if (swl === -Infinity || Math.floor(swl) <= top) return 'land';
+  if (view.worldSurfaceWG(x, z) <= view.oceanFloorWG(x, z)) return 'land';
   const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
   if (s.f.lakeMask[k] === 1) return 'lake';
   return riverWetAt(s, k) ? 'river' : 'sea';
 }
 
+/** `positionKind` along the row z of `view`, building each column's ColumnSample once. */
+export function kindReader(ctx: GenContext, view: RegionView, z: number): (x: number) => ReviewKind {
+  const s = newColumnSample();
+  let cx = Number.NaN;
+  return (x) => {
+    if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), z >> 4, s);
+    return positionKind(view, s, x, z);
+  };
+}
+
+/** A line's kinds and voxel facts, for the slices' summary (`slices.json`) and the rulings. */
+export interface LineSummary {
+  readonly kinds: Record<ReviewKind, number>;
+  /** The lowest and highest true top on the line. */
+  readonly topMin: number;
+  readonly topMax: number;
+  /** The highest water surface above a top, or null when the line is dry. */
+  readonly waterMax: number | null;
+  /** Land positions with ≥ 2 solid→air transitions in [top − 30, top] (T2's overhang count). */
+  readonly overhangs: number;
+  /** Water voxels' faces along the line (x ± 1, same y) that touch dry air: the v0 water walls (SP3b §4). */
+  readonly waterWallFaces: number;
+  /** Water voxels under the true top. */
+  readonly waterUnderStone: number;
+}
+
+/** The summary of the n positions x0 … x0 + n − 1 of row z of `view`, with each position's kind from `kindOf`. */
+export function lineSummary(view: RegionView, z: number, x0: number, n: number, kindOf: (x: number) => ReviewKind): LineSummary {
+  const kinds: Record<ReviewKind, number> = { land: 0, sea: 0, lake: 0, river: 0 };
+  let topMin = Infinity;
+  let topMax = -Infinity;
+  let waterMax: number | null = null;
+  let overhangs = 0;
+  let waterWallFaces = 0;
+  let waterUnderStone = 0;
+  const dryAir = (x: number, y: number) => x >= x0 && x < x0 + n && view.block(x, y, z) === AIR && fluidType(view.fluid(x, y, z)) === 0;
+  for (let x = x0; x < x0 + n; x++) {
+    const kind = kindOf(x);
+    kinds[kind]++;
+    const p = positionVoxels(view, x, z);
+    topMin = Math.min(topMin, p.top);
+    topMax = Math.max(topMax, p.top);
+    if (p.water !== null) waterMax = Math.max(waterMax ?? -Infinity, p.water);
+    if (kind === 'land' && p.transitions >= 2) overhangs++;
+    waterUnderStone += p.waterUnderTop;
+    for (let y = MIN_Y; y <= MAX_Y; y++) {
+      if (!wetAt(view, x, y, z)) continue;
+      if (dryAir(x - 1, y)) waterWallFaces++;
+      if (dryAir(x + 1, y)) waterWallFaces++;
+    }
+  }
+  return { kinds, topMin, topMax, waterMax, overhangs, waterWallFaces, waterUnderStone };
+}
+
 /**
  * A vertical slice: the z plane `z` of the one-row region of columns cx0 … cx0 + w − 1 at cz = z >> 4, x across,
  * y from `yMax` (row 0) down to `yMin`.
@@ -69,21 +171,27 @@ export interface HorizontalSite {
   readonly w: number;
   readonly h: number;
   readonly y: number;
-  /** The row checked against `needs` (a full-region scan would cost a ColumnSample per column). */
+  /** The row checked against `needs` (a full-region check would generate all w × h columns). */
   readonly checkZ: number;
   readonly needs: readonly ReviewKind[];
 }
 
 export type ReviewSite = VerticalSite | HorizontalSite;
 
-/** The row z = −31992 (column row cz −2000, lz 8) of world seed '42', default profile, found by a scan. */
+/** The row z = −31992 (column row cz −2000, lz 8) of world seed '42', default profile, found by a scan (SP3a). */
 const ROW_CZ = -2000;
 const ROW_Z = 16 * ROW_CZ + 8;
 
 /**
- * The review sites (world seed '42', default profile). Vertical slices are cropped in y: the tests check that every
- * column's water and ground surface lies inside the crop, so it removes only air above and stone below. The lake and
- * river slices are narrow bands and are drawn at 2 pixels per block.
+ * The review sites (world seed '42', default profile). Vertical slices are cropped in y: the tests check on the
+ * voxels that the crop removes only dry air above and solid voxels below. The lake and river slices are narrow
+ * bands and are drawn at 2 pixels per block.
+ *
+ * The mountain was found by a scan of the 2D world: rows cz −1024 … 960 (step 64) and −786, every 64-column window
+ * over cx −1088 … 1023, scored by the quart points of the row lz 8 that are highland with σ > 8. The window
+ * cx −104 … −41 at cz 0 ranked first, with all 256 points (σ up to 15.9). After the SP3b retune (§8.4) the scan
+ * gives seven rows a full 256-point window; the six generated have 75 … 214 overhang positions of 1024 and this row
+ * the most (214), so the line stays: its voxel tops run 140 … 257, with undercut crests and floating rocks.
  */
 export const REVIEW_SITES: readonly ReviewSite[] = [
   {
@@ -98,21 +206,42 @@ export const REVIEW_SITES: readonly ReviewSite[] = [
     name: 'river', file: 'slice-river.png', kind: 'vertical', cx0: -972, w: 32, z: ROW_Z, yMin: 32, yMax: 127, scale: 2,
     needs: ['river', 'land'],
   },
+  {
+    name: 'mountain', file: 'slice-mountain.png', kind: 'vertical', cx0: -104, w: 64, z: 8, yMin: 64, yMax: 319, scale: 1,
+    needs: ['land'],
+  },
   {
     name: 'y62', file: 'slice-y62.png', kind: 'horizontal', cx0: -1696, cz0: ROW_CZ - 32, w: 64, h: 64, y: 62, checkZ: ROW_Z,
     needs: ['sea', 'land'],
   },
 ];
 
-/** Kind counts (block positions) along a site's line: the vertical slice's line, or a horizontal site's `checkZ` row. */
-export function lineKinds(ctx: GenContext, site: ReviewSite): Record<ReviewKind, number> {
-  const out: Record<ReviewKind, number> = { land: 0, sea: 0, lake: 0, river: 0 };
-  const z = site.kind === 'vertical' ? site.z : site.checkZ;
-  const cz = z >> 4;
+/** The line a site's kinds are read on: the vertical slice's line, or a horizontal site's `checkZ` row. */
+export function siteLine(site: ReviewSite): { readonly z: number; readonly x0: number; readonly n: number } {
+  return { z: site.kind === 'vertical' ? site.z : site.checkZ, x0: 16 * site.cx0, n: 16 * site.w };
+}
+
+/** The share of a vertical site's line positions whose 2D surface biome is highland with σ > MOUNTAIN_SIGMA. */
+export function mountainShare(ctx: GenContext, site: VerticalSite): number {
   const s = newColumnSample();
+  let hits = 0;
   for (let cx = site.cx0; cx < site.cx0 + site.w; cx++) {
-    buildColumnSample(ctx, cx, cz, s);
-    for (let lx = 0; lx < 16; lx++) out[positionKind(s, 16 * cx + lx, z)]++;
+    buildColumnSample(ctx, cx, site.z >> 4, s);
+    for (let x = 16 * cx; x < 16 * cx + 16; x++) {
+      if (biomeFamily(readBiome(s, ctx, x, site.z)) === 'highland' && readField(s, 'sigma', x, site.z) > MOUNTAIN_SIGMA) hits++;
+    }
+  }
+  return hits / (16 * site.w);
+}
+
+/** What is wrong with a vertical site's crop, read from the voxels: an open voxel below yMin or a filled one above yMax. */
+export function cropProblems(view: RegionView, site: VerticalSite): string[] {
+  const out: string[] = [];
+  const { z, x0, n } = siteLine(site);
+  for (let x = x0; x < x0 + n; x++) {
+    const p = positionVoxels(view, x, z);
+    if (p.lowestOpen < site.yMin) out.push(`(${x}, ${z}): open at y ${p.lowestOpen}, below the crop`);
+    if (p.highestFilled > site.yMax) out.push(`(${x}, ${z}): filled at y ${p.highestFilled}, above the crop`);
   }
   return out;
 }
@@ -139,7 +268,7 @@ export function renderSite(view: RegionView, site: ReviewSite): RgbaImage {
   return upscale(sliceZ(view, site.z, { yMin: site.yMin, yMax: site.yMax }), site.scale);
 }
 
-/** Generates a site's region: provisional T, cold (no region cache), spiral order, 1 thread. */
+/** Generates a site's region: T, cold (no region cache), spiral order, 1 thread. */
 export async function generateSite(seed: string, params: Params, site: ReviewSite): Promise<RegionView> {
   const h = site.kind === 'vertical' ? 1 : site.h;
   const cz0 = site.kind === 'vertical' ? site.z >> 4 : site.cz0;
@@ -147,24 +276,36 @@ export async function generateSite(seed: string, params: Params, site: ReviewSit
   return r.view;
 }
 
+/** Generates only the one-row region of a site's line (a horizontal site's `checkZ` row), for the unit checks. */
+export async function generateLine(seed: string, params: Params, site: ReviewSite): Promise<RegionView> {
+  const { z } = siteLine(site);
+  const r = await genRegion({ seed, params, cx0: site.cx0, cz0: z >> 4, w: site.w, h: 1, upTo: 'T', order: 'spiral', threads: 1 });
+  return r.view;
+}
+
 export interface WrittenSlice {
   readonly site: ReviewSite;
   readonly path: string;
   readonly width: number;
   readonly height: number;
   readonly bytes: number;
+  /** The site's line, read from the same generated voxels. */
+  readonly summary: LineSummary;
 }
 
 /** Generates every site and writes its PNG into `dir` (created if missing). */
 export async function writeReviewSlices(dir: string, seed: string, params: Params, sites: readonly ReviewSite[] = REVIEW_SITES): Promise<WrittenSlice[]> {
   mkdirSync(dir, { recursive: true });
+  const ctx = createGenContext(seedFromInput(seed), params);
   const out: WrittenSlice[] = [];
   for (const site of sites) {
-    const img = renderSite(await generateSite(seed, params, site), site);
+    const view = await generateSite(seed, params, site);
+    const img = renderSite(view, site);
     const png = encodePng(img);
     const path = join(dir, site.file);
     writeFileSync(path, png);
-    out.push({ site, path, width: img.width, height: img.height, bytes: png.length });
+    const { z, x0, n } = siteLine(site);
+    out.push({ site, path, width: img.width, height: img.height, bytes: png.length, summary: lineSummary(view, z, x0, n, kindReader(ctx, view, z)) });
   }
   return out;
 }
```

Modify `test/tools/uiSmoke.ts` (apply with `git apply`):

```diff
diff --git a/test/tools/uiSmoke.ts b/test/tools/uiSmoke.ts
index deb52e3..2fa56ea 100644
--- a/test/tools/uiSmoke.ts
+++ b/test/tools/uiSmoke.ts
@@ -27,7 +27,8 @@
  * - tabs: ArrowRight, ArrowLeft, Home and End move the selection and the focus on both tab bars;
  * - console: no exception, console error or failed load, except the known favicon.ico 404.
  * With --shots DIR it then writes the spec §12 screenshots into DIR, at seed 42 from a newly loaded page (the
- * repository keeps them re-saved as 256-colour palette PNGs, as SP1 and SP2a did).
+ * repository keeps them re-saved as 256-colour palette PNGs, as SP1 and SP2a did), and last the Voxels mode on the
+ * mountain line (SP3b spec §7: `cross-section-voxels-mountain.png`; the line text and the slice summary are checked).
  * Options: --skip-build, --profile-dir DIR, --shots DIR. The exit code is 0 only when every check passes.
  */
 import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
@@ -101,6 +102,26 @@ export function voxelSummaryOk(text: string): boolean {
   return /^ground top y -?\d+ to -?\d+ · (?:no water|water on \d+\.\d % of the line, up to \d+ deep)$/.test(text);
 }
 
+/** A cut line's ends, as the cross-section's line text writes them. */
+export interface Segment { readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }
+
+/** The segment of the cross-section's line text `A (ax, az) → B (bx, bz) · N blocks`, or null. */
+export function parseSegment(text: string): Segment | null {
+  const m = /^A \((-?\d+), (-?\d+)\) → B \((-?\d+), (-?\d+)\) · [\d ]+ blocks$/.exec(text);
+  return m === null ? null : { ax: Number(m[1]), az: Number(m[2]), bx: Number(m[3]), bz: Number(m[4]) };
+}
+
+/**
+ * The mountain line of the Voxels-mode screenshot (SP3b spec §7 uiSmoke, §11): the review slices' mountain site
+ * (`test/harness/reviewSlices.ts`, a highland row with σ > 8 found by a scan; a unit test keeps them equal), from
+ * A (−1664, 8) to B (−640, 8), clicked at ± 256 CSS px around the centre of a view at 2 blocks/px.
+ */
+export const MOUNTAIN_LINE = {
+  view: { x: -1152, z: 8, bpp: 2, layer: 'relief' },
+  a: [-1664, 8],
+  b: [-640, 8],
+} as const satisfies { readonly view: MapUrlView; readonly a: readonly [number, number]; readonly b: readonly [number, number] };
+
 /** A page log entry the smoke test does not count: the favicon.ico 404 (index.html declares no icon). */
 export function ignoredLog(text: string, url: string | undefined): boolean {
   return url !== undefined && /\/favicon\.ico(\?|$)/.test(url) && text.includes('404');
@@ -839,6 +860,31 @@ async function runShots(p: Page, dir: string): Promise<string[]> {
   await p.mouse('mouseMoved', vox.box.x + vox.box.width * 0.1, vox.box.y + (vox.box.height * (319 - 50)) / 384);
   await sleep(1000);
   await save('cross-section-voxels.png');
+
+  // The Voxels mode on the mountain line (SP3b spec §7, §11): the real T's peaks, the pointer on the rock below them.
+  const { view: mv, a, b } = MOUNTAIN_LINE;
+  await p.goto(`${p.base}?map#${mapHash({ ...START, view: mv })}`, MAP_READY);
+  await p.click('#map-tab-world');
+  await p.click('.map-cut');
+  const mc = await p.center('.map-canvas');
+  const at = (x: number, z: number): [number, number] => [mc.x + (x - mv.x) / mv.bpp, mc.y + (z - mv.z) / mv.bpp];
+  await p.clickAt(...at(a[0], a[1]));
+  await p.clickAt(...at(b[0], b[1]));
+  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh cross-section of the mountain line');
+  const text = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
+  const seg = parseSegment(text);
+  if (seg === null || Math.max(Math.abs(seg.ax - a[0]), Math.abs(seg.az - a[1]), Math.abs(seg.bx - b[0]), Math.abs(seg.bz - b[1])) > 1) {
+    throw new Error(`the mountain line is ${text}, expected A (${a[0]}, ${a[1]}) → B (${b[0]}, ${b[1]})`);
+  }
+  await p.click('.cs-mode[data-mode="voxels"]');
+  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice of the mountain line');
+  const summary = await p.eval<string>(`document.querySelector('.cs-summary').textContent`);
+  if (!voxelSummaryOk(summary)) throw new Error(`the mountain slice: ${summary}`);
+  console.log(`  mountain line: ${text}; ${summary}`);
+  const mvox = await p.center('.cs-voxels');
+  await p.mouse('mouseMoved', mvox.box.x + mvox.box.width * 0.4, mvox.box.y + (mvox.box.height * (319 - 120)) / 384);
+  await sleep(1000);
+  await save('cross-section-voxels-mountain.png');
   return out;
 }
 
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run docs:review-slices`

`docs/superpowers/specs/assets/sp3b/cross-section-voxels-mountain.png` is the smoke test's screenshot: run `node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots $(mktemp -d /tmp/wi10-shots-XXXX)` and copy `cross-section-voxels-mountain.png` from the shots directory, re-saved as a 256-colour palette PNG (the other screenshots are SP2b's and SP3a's and are not copied).

`docs/superpowers/specs/assets/sp3b/slice-coast.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3b/slice-lake.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3b/slice-mountain.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3b/slice-river.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3b/slice-y62.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3b/slices.json` is written by the command above (not copied).

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/reviewSlices.test.ts test/unit/uiSmoke.test.ts`

Expected: PASS (exit 0)

```
Test Files  2 passed (2)
Tests  28 passed | 1 skipped (29)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  135 passed | 2 skipped (137)
Tests  1812 passed | 4 skipped (1816)
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/assets/sp3b/cross-section-voxels-mountain.png docs/superpowers/specs/assets/sp3b/slice-coast.png docs/superpowers/specs/assets/sp3b/slice-lake.png docs/superpowers/specs/assets/sp3b/slice-mountain.png docs/superpowers/specs/assets/sp3b/slice-river.png docs/superpowers/specs/assets/sp3b/slice-y62.png docs/superpowers/specs/assets/sp3b/slices.json package.json test/harness/reviewSlices.ts test/tools/uiSmoke.ts test/unit/reviewSlices.test.ts test/unit/uiSmoke.test.ts
git commit -F - <<'EOF'
test(harness,tools): review slices on the real T and the uiSmoke mountain line

reviewSlices.ts reads each line's kinds and crop checks from the voxels
(wet = water above the highest stone; the water body from the
ColumnSample's nearest quart corner; crop = lowest open and highest filled
voxel), adds a mountain site (cx -104 ... -41, z 8: a scan's best
highland window with sigma > 8, re-derived by a test, and the full-score
window with the most overhang positions after the retune) and a line
summary (tops, overhang positions, water-wall faces, water under stone).
`npm run docs:review-slices` now writes docs/superpowers/specs/assets/sp3b/
(SP3a's assets stay) from the retuned world. uiSmoke's --shots adds the
Voxels mode on the mountain line (cross-section-voxels-mountain.png),
checking the line text and the slice summary.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `6e35b8f` on `dry/sp3a`; 13 files changed, 617 insertions(+), 95 deletions(-)):

From "Task 15 — review slices on the retuned world":

Commit Task 15 on `dry/sp3b` (worktree `P/dry`, parent Task 14; 13 files, 617 insertions, 95 deletions): Task 15 (the earlier "## Task 14" review-slices commit, written on Task 11) cherry-picked and amended. The cherry-pick merged cleanly: `test/harness/reviewSlices.ts` keeps Task 12's river crop y 32 … 127 next to 848be13's voxel kinds, crop checks and mountain site; no test file of Task 12 touched the review slices. RED (the commit's `reviewSlices.test.ts` and `uiSmoke.test.ts` over a `git archive` copy of Task 14): 6 failed in 2 files (reviewSlices ×4: the site list without `mountain`, the mountain site undefined, `kindReader is not a function`, the script still writing `assets/sp3a`; uiSmoke ×2: `parseSegment is not a function`, the mountain site undefined) and the "positions and lines read from the voxels" block (11 tests) fails in `beforeAll` with `generateLine is not a function`; 19 `tsc -p tsconfig.test.json` errors (the missing exports). GREEN: typecheck clean; `npm test` 135 files passed, 2 skipped; 1793 tests passed, 4 skipped (49 s wall, load 0.9). `npm run docs:review-slices` 10 s. uiSmoke (`node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots <scratchpad>`, own build, preview and headless Chrome, all stopped by the tool, the empty profile dir removed by me): `smoke: 77/77 checks pass`, exit 0, 45 s; Voxels step "ground top y 22 to 248 · water on 14.5 % of the line, up to 41 deep"; mountain line "A (-1664, 8) → B (-640, 8) · 1 024 blocks; ground top y 140 to 257 · no water". No hang this time. Only `cross-section-voxels-mountain.png` copied into `assets/sp3b/`, re-saved as a 256-colour palette PNG with PIL `quantize(256)` (747 KB → 251 KB). All assets also copied to `P/shots/task-15/`. No golden, threshold, schema or baseline change, so no Threshold-log line.

- Ruling (sites re-checked on the retuned world; all kept): the line summaries before (Task 11) → after (Task 14):
  coast: land 437 → 452, sea 563 → 551, river 24 → 21; tops 19 … 144 → 18 … 129; overhangs 0 → 2; water-wall faces 9 → 5. Crop −64 … 159 still holds (needs sea, land: yes).
  lake: land 352 → 345, lake 133 → 140, river 27 =; tops 57 … 74 → 58 … 89; lake surface 70 → 82; water-wall faces 4 → 9. Crop 32 … 95 holds (highest filled 89); lake water above y 63: yes.
  river: land 424 → 422, river 88 → 90; tops 56 … 78 → 56 … 109 (Task 12 widened the crop to 127 for this); overhangs 1 → 0; 1 water-wall face.
  y62: the coast line's figures (it is checked on the coast row).
  No retune moved a coast, lake or river off its site, so no site was re-picked. Cost if wrong: none.
- Ruling (the mountain site stays at cx −104 … −41, z 8): `mountainShare` re-derives 1.000 (1,024 of 1,024 positions highland with σ > 8; the test needs ≥ 0.9). I re-ran 848be13's scan on the retuned 2D world (throwaway test, deleted): seven rows now reach a full 256-point window (cz −960, −832, −256, 0, 128, 832, 896). Generated on the voxels, the first six give 159 / 159 / 118 / 214 / 75 / 166 overhang positions of 1,024 (tops up to 216 / 258 / 216 / 257 / 182 / 244). This line gives 214 (cz 0's first full window, cx −109, also gives 214), i.e. the most, so it is still the best review of the new overhangs. Task 12's line (−1054, −786) gives 74, with share 0.411 and sea. Keeping it also keeps uiSmoke's `MOUNTAIN_LINE` unchanged. The test now also pins `overhangs ≥ 150` on the mountain line (measured 214; 5 before the retune). A world change that flattens the crests fails the review test. The harness comment's tops now read 140 … 257. Cost if wrong: re-pick the line (the uiSmoke line is tied by its unit test).
- Ruling (floating-rock count on the lines; uses Task 13's per-column proxy: a ≤ 6-high solid run over a ≥ 3-block air gap, y ≥ −56): mountain 97 of 1,024 positions; coast, lake and river 0. Diagnostic only; not in `slices.json` (the summary fields are unchanged from 848be13). Cost if wrong: none.
- Visual review (what the PNGs show; seed '42', default, real T after the retune; air sky blue, stone grey, water blue darkening with depth):
  - `slice-mountain.png` (1024 × 256, y 64 … 319): the change is dramatic. Before, it was a smooth massif with one pair of needle spires. Now the whole crest line is broken up. Tops are 140 … 257 (p10 173, median 208, p90 240). Mushroom- and hook-shaped crags lean over their bases: 214 positions have ≥ 2 solid→air transitions, spread across the whole line. Many rocks float: a dozen visible islets of 3-15 blocks hang 5-30 blocks above the crest, mostly in the west third and the east half (97 positions by the proxy). Small enclosed air pockets sit inside the rock just under the crest, at y ≈ 120-170. The solid body below ≈ y 150 is unbroken. No water. It reads as the "overhangs and floating rocks above peaks" the user accepted, with SP3d/SP6 handling the islets.
  - `cross-section-voxels-mountain.png` (1400 × 900): the map in relief at 2 blocks/px. The line crosses the brown stony-peaks massif between two lakes; the right side panel shows stony_peaks with σ 17.1 at B. The drawer is in Voxels mode: "ground top y 140 to 257 · no water", hover "(−1256, 120, 8) · stone · no fluid". At 1024 blocks across the drawer's width the crags, islets and pockets show as a ragged crest with specks above it. The review PNG at 1 px/block shows them better.
  - `slice-coast.png` (1024 × 224, y −64 … 159): the sea fills the west 40 %, its floor 40-60 with small bumps. The coast plain sits just above the sea: land tops median 67, p90 84. At x ≈ −26620 a hill rises to ≈ 110. On it stands a thin needle to 129, its foot undercut (the line's 2 overhang positions). The jag spike of 144 before is gone. A second smaller peak stands at ≈ 100 near x ≈ −26340, then the land drops into the east sea basin. Water walls: 5 faces, all at the small dry pit west of the river mouth (x −27026, y 60 … 63, and one at −27021 y 63). It is a 4-block water face beside a 1-wide dry hole, barely visible at 1 px/block. No floating rock.
  - `slice-lake.png` (2 px/block, y 32 … 95): rolling plains with tops 62 … 89 (median 77), clearly higher than before (57 … 74). The lake stands at y 82 (was 70), 140 positions, 12-20 deep. Its west shore is a stone spike to y 89. Between the spike and the water there is a 1-wide dry slot at x −16094. There the lake shows a 9-block vertical water wall (x −16093, y 74 … 82, all 9 of the line's water-wall faces): the v0 artefact §4 names, now taller because the lake is deeper. West of the spike a lower river pool sits at y 63 (27 positions). No overhangs.
  - `slice-river.png` (2 px/block, y 32 … 127): a wide valley. The banks rise steeply to plateaus at ≈ 100-109 on both sides (before 78); the raised lowland offset is the plain on each side. The river at y 63 fills the valley floor, broken into 5 pools by stone bumps (90 river positions). One water-wall face (x −15365 y 63). No overhangs, no floating rock.
  - `slice-y62.png` (64 × 64 columns, plan at y 62): the coast region. Open sea west and east, a long peninsula running from the south-west to a northern landmass, an island chain in the west, and a wide inlet with islands across the middle. A dozen dark-blue lakes lie inland in the south, with surfaces above 62. Light-blue dry air at y 62 (0.9 % of the plane: 9,245 voxels against 619,274 water and 420,057 stone) fringes many shores 1-3 blocks wide. It also fills one inland basin (centre) and a small islet south-east. These are the v0 water rule's dry hollows below sea level next to water, i.e. water walls seen in plan. The picture is close to the pre-retune one; the coastline barely moved (the retune raised land above sea level, not the sea floor).
  - Plains overall: after the retune the lowland sits above y 64 nearly everywhere on these lines. Coast plain median 67, lake plains median 77, river plateaus 100-109. There is no flat land at sea level any more except the coast plain's first few blocks.
- Problems: none (the uiSmoke run passed first time).

From "Task 14":

Commit Task 15 on `dry/sp3b` (worktree `P/dry`, parent Task 11; 13 files, 611 insertions, 95 deletions; independent of Task 12/13 files). RED (the commit's 2 test files over the parent, in a throwaway worktree): 6 failed in 2 files (reviewSlices ×4: the site list without `mountain`, the mountain site undefined, `kindReader is not a function`, the script still writing `assets/sp3a`; uiSmoke ×2: `parseSegment is not a function`, the mountain site undefined) and the "positions and lines read from the voxels" block (11 tests) failed in `beforeAll` with `generateLine is not a function`; 19 `tsc -p tsconfig.test.json` errors (the missing exports). GREEN: typecheck clean; `npm test` 133 files passed, 2 skipped; 1779 tests passed, 3 skipped (34 s wall, load 0.5); `reviewSlices.test.ts` 17 tests ≈ 2 s. `npm run docs:review-slices` 10 s. uiSmoke (`node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots <scratch>`, own build, preview and headless Chrome, all stopped by the tool): `smoke: 77/77 checks pass`, exit 0; Voxels step "ground top y 21 to 252 · water on 14.5 % of the line, up to 42 deep"; mountain line "A (-1664, 8) → B (-640, 8) · 1 024 blocks; ground top y 136 to 267 · no water". A first run hung for over an hour inside SP2b's undo step (Ctrl+Z to step 3, before any SP3b code; the host clock jumped, probably a suspend); I stopped it (SIGINT to my own node process, whose cleanup stopped its Chrome and preview) and the rerun passed. No golden, threshold, schema or baseline file changes, so no Threshold-log line.

- Ruling (kinds from the voxels, `test/harness/reviewSlices.ts`): `positionKind(view, s, x, z)` is land when `WORLD_SURFACE_WG ≤ OCEAN_FLOOR_WG` (no water above the highest stone). Otherwise the water body comes from the quart corner `readLevel` reads (lake mask → lake, wet river channel → river, else sea). The voxels cannot tell which body water belongs to, and that corner is where the T takes its level from. `kindReader(ctx, view, z)` builds each column's ColumnSample once. Water under stone (an overhang pocket) does not make a position wet. Cost if wrong: a position wet from a neighbouring body's corner would be labelled with the corner's body; counts only.
- Ruling (crop checks from the voxels): `positionVoxels` gives `lowestOpen` (the lowest air voxel, with or without water, above the bedrock) and `highestFilled` (the highest stone or water voxel). `cropProblems` requires lowestOpen ≥ yMin and highestFilled ≤ yMax. This replaces SP3a's aux-A check (`OCEAN_FLOOR_WG − 1 ≥ yMin`), which cannot see a pocket under an overhang below the crop: a hand-built view pins that case, and a mutation back to `top < yMin` fails it. Cost if wrong: none.
- Ruling (the tests do not depend on the 2D estimate): `wet ⇔ 2D kind ≠ land` (dropped at Task 8) is not restored. Instead: (1) on the coast line, every position that the 2D estimate calls land (`⌊surfaceWaterLevel⌋ ≤ ⌊surfaceEst⌋`) but that is wet on the voxels counts as water (> 0 such positions; Task 8's (−27021, −31992) is one); (2) a hand-built wet view at a 2D-land position is 'sea'; (3) every wet position has a finite `surfaceWaterLevel`, and wet ⇔ a water voxel at `WORLD_SURFACE_WG − 1`. A mutation that brings back the 2D land rule fails (1) and (2). Cost if wrong: none.
- Ruling (the mountain site): found by a scan of the 2D world (seed '42', default). Rows cz −1024 … 960 in steps of 64, plus cz −786 (Task 6's σ 11.5 row). Every 64-column window over cx −1088 … 1023 was scored by the quart points of the row lz 8 that are highland with σ > 8. The best window is cx −104 … −41 at cz 0 (z 8): 256 of 256 points, σ up to 15.9. The next were (−1030, −384) 247 and (865, 704) 243; Task 6/8/12's line (−1054, −786) scored 98. It is hard-coded as `{cx0 −104, w 64, z 8, y 64 … 319, 1 px/block, needs ['land']}`. The re-derivation test asserts that ≥ 90 % of the line's 1024 block positions are highland (`readBiome`) with σ (`readField`) > `MOUNTAIN_SIGMA` 8. It measures 100 % here, against 2.2 % on the coast and 0 on the lake and river. The test also asserts tops above y 200. Not Task 12's mountain: the user's Task-12 before/after set used (−1054, −786), which is 38 % highland σ > 8 and ends in the sea. The scan winner is a whole-highland line and lies near the spawn and the map's default view. Cost if wrong: re-pick the line; the site and the uiSmoke `MOUNTAIN_LINE` are tied by a unit test.
- Ruling (`y62`'s needs): checked on its `checkZ` row (the coast line), generated as a one-row region (`generateLine`). The 64 × 64 region is generated only by `docs:review-slices`, as in SP3a. Cost if wrong: none.
- Ruling (`slices.json`): each site now records `summary` (= `lineSummary` over the same voxels the PNG was drawn from), not SP3a's `lineKinds`. The fields are kinds, topMin/topMax, waterMax, `overhangs` (land positions with ≥ 2 solid→air transitions in [top − 30, top], T2's count), `waterWallFaces` (water voxels' x ± 1 faces along the line touching dry air) and `waterUnderStone`. These are the rulings' figures below. Cost if wrong: none (diagnostic).
- Ruling (uiSmoke): `MOUNTAIN_LINE = {view (−1152, 8, 2 bpp, relief), A (−1664, 8), B (−640, 8)}`, which equals the review mountain's line (unit test). The clicks are computed from the canvas centre, ± 256 CSS px. After the SP3a shots, `runShots` draws it, checks the line text (`parseSegment`, ± 1 block) and the Voxels summary format, and throws otherwise (the exit code is then 1). It writes `cross-section-voxels-mountain.png` with the pointer on the rock at y 120. The main smoke steps (77 checks) are unchanged. Only that screenshot is copied into `assets/sp3b/`, re-saved as a 256-colour palette PNG per the tool's header (737 KB → 246 KB). Cost if wrong: none.
- Ruling (docs): CLAUDE.md's `docs:review-slices` and `uiSmoke.ts` lines name SP3b's assets and the mountain shot. The SP3b spec's visual-review/exit text and README are Task 15's. Cost if wrong: wording only.
- Ruling (retune): if Task 12 leads to an approved retune of `shape.*` (or `density.*`) defaults, the retune task must rerun `npm run docs:review-slices` and the uiSmoke `--shots` mountain screenshot, and commit the regenerated `assets/sp3b/`. These assets show the current defaults (`dry/sp3b` at Task 11, no retune). The mountain re-derivation (≥ 90 % highland σ > 8) and the lake/river/coast needs may need re-checking. Task 12's candidate raises σ at C 0.05 but leaves highland σ alone. Cost if wrong: stale evidence images.
- Visual review (what the PNGs show; seed '42', default, real T, no retune; air sky blue, stone grey, water blue darkening with depth):
  - `slice-coast.png` (1024 × 224, y −64 … 159): the sea on the west two fifths, its floor a gently undulating 40-60 with 1-3-block bumps. One jagged spike about 80 blocks tall (top 144) rises straight from the coast plain at x ≈ −26620. A ridged highland lies to the east (≈ 110-130), and a deeper sea basin at the east end. 563 sea, 437 land and 24 river positions; 0 overhangs. 9 water-wall faces: the 1-block dry pit in the sea surface at x ≈ −27024, visible as one sea-level-line pixel.
  - `slice-lake.png` (2 px/block, y 32 … 95): rolling ground at 57-74. The lake stands at y 70 (133 lake positions, above y 63), held by a small stone peak on its west shore. A lower river pool at y 63 lies west of it (27 river positions). 4 water-wall faces, 0 overhangs.
  - `slice-river.png` (2 px/block): the river at y 63 fills the channel's hollows. Detail-noise bumps of stone break its surface in several places, so it reads as a string of pools. 88 river positions, 1 water-wall face, 1 overhang position.
  - `slice-mountain.png` (1024 × 256, y 64 … 319): an all-highland massif, tops 136 … 267. A western shoulder at ≈ 210 drops to a saddle at ≈ 160. Twin needle spires at x ≈ −1270 … −1235 reach 267 with a deep notch between them; it is the tallest feature. Rounded summits follow at ≈ 240-250, then a valley at ≈ 165 near the east end. 5 overhang positions (the spires' undercut flanks); no water, no floating rock. The crests are steep but almost single-surface: the T2 shortfall Task 12 measured is visible here too.
  - `slice-y62.png` (64 × 64 columns at y 62): the coast region in plan. Open sea, a long peninsula and islands, and lake/river inlets. Light-blue (dry air at y 62) fringes line many shores and fill a few inland basins. These are ground below y 62 with no water level: the v0 water rule's dry hollows and wall faces next to water. One dark-blue spot inland is a lake whose surface is well above 62.
  - `cross-section-voxels-mountain.png` (1400 × 900, the map in relief at 2 blocks/px with the line across the brown massif between two lakes; the drawer in Voxels mode): the slice matches `slice-mountain.png`. "ground top y 136 to 267 · no water", the twin spires at ≈ 400 blocks from A, hover "(−1256, 120, 8) · stone · no fluid". At this scale (1024 blocks across 384 rows) the relief looks flat; the review PNG at 1 px/block shows it better.
  - I also looked at the SP3a-line `cross-section-voxels.png` from the same run (not copied): the sea on the west half up to 49 deep, the badlands rising to 259 with crenellated tops, and a small lake on the plateau at ≈ 150.
- Problems: the first uiSmoke run hung (see above); the rerun passed with no code change.

---

### Task 16: Amendments, docs and exit evidence

**Spec:** §14, §11

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-26-architecture-design.md`
- Modify: `docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md`
- Modify: `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md`
- Modify: `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md`
- Create: `docs/superpowers/specs/assets/sp3b/retune/after-coast-zoom.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/after-coast.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/after-mountain-zoom.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/after-mountain.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/after-plain.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/before-coast-zoom.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/before-coast.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/before-mountain-zoom.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/before-mountain.png`
- Create: `docs/superpowers/specs/assets/sp3b/retune/before-plain.png`
- Modify: `test/arch/masterSpec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces: no new exports from `src/` or the harness.

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/masterSpec.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/masterSpec.test.ts b/test/arch/masterSpec.test.ts
index de2baab..284ec43 100644
--- a/test/arch/masterSpec.test.ts
+++ b/test/arch/masterSpec.test.ts
@@ -2,16 +2,20 @@
  * The master spec's sub-project list agrees with the code (SP3a spec §11: the master §2.5 and §10 amendments): the
  * `SubProjectId` type of §2.5 lists `SUB_PROJECTS` in order, §10 has one header per sub-project in that order whose
  * parenthetical names every dependency `SP_DEPS` transcribes from it, and the critical path is a dependency chain.
+ * SP3b (its spec §14): §2.5's store interfaces name every method of `world/store/api.ts`, and §3.6's default
+ * expression states the density noises and amplitudes of the schema defaults, so a retune must amend the master.
  */
 import { readFileSync } from 'node:fs';
 import { fileURLToPath } from 'node:url';
 import { describe, expect, test } from 'vitest';
 import { SUB_PROJECTS, type SubProjectId } from '../../src/core/ids';
+import { DEFAULTS } from '../../src/core/params/defaults';
 import { SP_DEPS } from '../harness/sp';
 
 // Resolved from this file, not the cwd (SP3b spec §7), so the test also runs from another directory.
 const MASTER = fileURLToPath(new URL('../../docs/superpowers/specs/2026-09-26-architecture-design.md', import.meta.url));
 const text = readFileSync(MASTER, 'utf8');
+const API = fileURLToPath(new URL('../../src/world/store/api.ts', import.meta.url));
 const SP_TOKEN = /\bSP(?:\d+[a-z]?)\b/g;
 
 /** §10 headers: `**SPx — Title** (size; dependencies …)`, in document order. */
@@ -50,3 +54,34 @@ describe('master spec sub-projects (SP3a §11)', () => {
     }
   });
 });
+
+/** The method names declared in `interface <name> { … }` (up to its first closing brace) of a TypeScript source, comments removed. */
+function interfaceMethods(source: string, name: string): string[] {
+  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
+  const start = src.search(new RegExp(`interface ${name} \\{`));
+  if (start < 0) return [];
+  const body = src.slice(src.indexOf('{', start) + 1, src.indexOf('}', start));
+  return [...body.matchAll(/\b([a-zA-Z]\w*)\(/g)].map((m) => m[1]!);
+}
+
+describe('master spec amendments (SP3b §14)', () => {
+  test.each(['ColumnWriter', 'ColumnView', 'NeighborhoodReader'])('§2.5 %s names every method of world/store/api.ts', (name) => {
+    const api = interfaceMethods(readFileSync(API, 'utf8'), name);
+    expect(api.length, `no interface ${name} in api.ts`).toBeGreaterThan(0);
+    expect(new Set(interfaceMethods(text, name))).toEqual(new Set(api));
+  });
+
+  test('§3.6 default expression states the schema defaults of the density noises and amplitudes', () => {
+    const d = DEFAULTS.density;
+    const jag = /u = noise2\('jag'\) \/ clampSigma \(λ (\d+), (\d+) oct\)/.exec(text);
+    expect(jag, "no `u = noise2('jag') / clampSigma (λ …, … oct)` in §3.6").not.toBeNull();
+    expect([Number(jag![1]), Number(jag![2])]).toEqual([d.noises.jag.wavelength, d.noises.jag.octaves]);
+    const n3 = /N3 = noise\('overhang'\) λ (\d+), λy (\d+), (\d+) oct, persistence ([\d.]+)/.exec(text);
+    expect(n3, "no `N3 = noise('overhang') λ …, λy …, … oct, persistence …` in §3.6").not.toBeNull();
+    const o = d.noises.overhang;
+    expect(n3!.slice(1).map(Number)).toEqual([o.wavelength, o.wavelength / o.yScale, o.octaves, o.persistence]);
+    const det = /detail {4}= noise\('detail'\) λ (\d+), (\d+) oct × amp\(E\) ([\d.]+)-([\d.]+)/.exec(text);
+    expect(det, "no `detail = noise('detail') λ …, … oct × amp(E) …-…` in §3.6").not.toBeNull();
+    expect(det!.slice(1).map(Number)).toEqual([d.noises.detail.wavelength, d.noises.detail.octaves, d.detailAmpLo, d.detailAmpHi]);
+  });
+});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch test/arch/masterSpec.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× §2.5 ColumnView names every method of world/store/api.ts 4ms
× §3.6 default expression states the schema defaults of the density noises and amplitudes 1ms
FAIL  |arch| test/arch/masterSpec.test.ts > master spec amendments (SP3b §14) > §2.5 ColumnView names every method of world/store/api.ts
AssertionError: expected Set{ 'block', 'fluid', 'light', …(3) } to deeply equal Set{ 'block', 'fluid', 'light', …(4) }
FAIL  |arch| test/arch/masterSpec.test.ts > master spec amendments (SP3b §14) > §3.6 default expression states the schema defaults of the density noises and amplitudes
AssertionError: no `u = noise2('jag') / clampSigma (λ …, … oct)` in §3.6: expected null not to be null
Test Files  1 failed (1)
Tests  2 failed | 5 passed (7)
```

- [ ] **Step 3: Implement**

Modify `CLAUDE.md` (apply with `git apply`):

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index 9fbfe4e..8403fd2 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -6,7 +6,7 @@ This file provides guidance to Claude Code (claude.ai/code) when working with co
 
 Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.
 
-**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3), SP3a complete (2026-10-03, GENERATOR_VERSION 3). SP3b (density and terrain shape) in progress.
+**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3), SP3a complete (2026-10-03, GENERATOR_VERSION 3), SP3b complete (2026-10-07, GENERATOR_VERSION 4). SP3c is next.
 
 ## Source of truth
 
@@ -18,15 +18,15 @@ Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with cus
 - `npm run dev` / `npm run preview` — http://localhost:5183 (COOP/COEP headers; open via localhost or HTTPS)
 - `npm run build` — `typecheck` (three tsconfigs) + `vite build`
 - `npm test` — vitest projects `unit`, `arch`, `metrics-fast`, then `integration` (real worker threads, one file at a time); `npm run test:metrics` (quick, CI), `npm run test:metrics:full` (SP exit), `npm run bench`
-- `npm run bench:record` — write `test/baselines.json` on the reference machine (per-kernel ratios to a calibration kernel, plus the lattice3/perm512 kill ratio); `npm run bench` gates +30 % per kernel and kill ratio ≤ 1.6
+- `npm run bench:record` — write `test/baselines.json` on the reference machine (per-kernel ratios to a calibration kernel, plus the lattice3/perm512 kill ratio); `npm run bench` gates +30 % per kernel and kill ratio ≤ 1.6, plus the absolute gates (column p50/p95, and SP3b's `terrain.real` p50 ≤ 4 ms), which `bench:record` also enforces before writing
 - `npm run test:accept-thresholds` — rewrite `test/thresholds.lock.json` (needs a spec amendment in the same change; CI checks it)
 - `npm run test:goldens` — record and merge goldens (refuses changed goldens without a `GENERATOR_VERSION` bump)
 - `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
 - `npm run test:accept-state-ids` — append the states of new block types to `test/stateIds.lock.json` (append-only: refuses a changed id, a removed entry or a new state of a locked type; the commit message says the lock changed)
 - `npm run docs:params` — regenerate the README parameter table from the schema
 - `npm run docs:review-slices` — write the SP3b review PNG slices of the T stage (a coast, a lake, a river and a mountain, and y 62; seed 42) and their `slices.json` into `docs/superpowers/specs/assets/sp3b/` through the region harness (SP3a's slices stay in `assets/sp3a/`)
-- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1, SP2a and SP3a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
-- `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section with its Profile | Voxels toggle (SP3a: the real vertical slice of voxels), global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
+- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1, SP2a, SP3a and SP3b) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
+- `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section with its Profile | Voxels toggle (SP3a: the real vertical slice of voxels; SP3b: the density terrain, the slice split across the workers), global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
 - `?map&perf=edit` — the same page with the SP2b latency hook (`src/ui/map/perfHook.ts`, `globalThis.__wiPerf`): pins the canvas to 1100 × 825 at seed 42, default profile, view (0, 0, 64 bpp)
 - `node test/tools/mapLatency.ts [--profile-dir DIR]` — the SP2b §2.8 edit → preview latency runner (not in CI; about 35 min): builds, serves `dist` on its own free port (never 5183), drives its own headless Chrome and writes `docs/superpowers/specs/assets/sp2b/latency-*.json`; `--quick` for a short run
 - `node test/tools/uiSmoke.ts [--profile-dir DIR] [--shots DIR]` — the SP2b UI smoke test (not in CI; about 1 min; SP3a adds the Voxels toggle): `?selftest=1`, then every editor driven with real pointer and key input and checked through the DOM and the URL, no console errors; `--shots` also writes the spec §12 screenshots and (SP3b) the Voxels mode on a mountain line, `cross-section-voxels-mountain.png`
@@ -36,7 +36,7 @@ Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with cus
 ## Conventions
 
 - TypeScript strict. Runtime dependency: `three` only. Dev dependencies: `vite`, `typescript`, `vitest`, `@types/three`, `@types/node`.
-- Tests are mandatory (vitest): unit, arch and metric tests. Metric thresholds are locked (`test/thresholds.lock.json`); never loosen one without amending the spec. Golden changes require a `GENERATOR_VERSION` bump.
+- Tests are mandatory (vitest): unit, arch and metric tests. Metric thresholds are locked (`test/thresholds.lock.json`); never loosen one without amending the spec. A part may gate on some tiers only (`tiers`; SP3b's T3 gates on full and is recorded on fast and quick), and dropping a tier counts as loosening. Golden changes require a `GENERATOR_VERSION` bump.
 - Layer rules (spec §1) are enforced by arch tests: `core` ← `world` ← `gen` ← L2 (`light`, `mesh`, `sim`, `persist`, `metrics`); `render/` is the only place three is imported and `render/materials/**` the only place GLSL lives; `sound/` is the only place WebAudio is used.
 - In `core/`, `world/` and `gen/`: no `Math.random`, `Date.now`, `performance.now` or `console.*`; in `gen/` no `Math.sin/cos/exp/...` (use `core/detMath`) and no exported numeric constants (tunables live in `ParamSchema`).
 - No audio files (`.ogg`/`.mp3`/`.wav`) in the repository; sound packs are user-supplied.
```

Modify `README.md` (apply with `git apply`):

```diff
diff --git a/README.md b/README.md
index 7ce4472..8f86084 100644
--- a/README.md
+++ b/README.md
@@ -6,7 +6,7 @@ It is the successor of [world-imaginer](https://github.com/MaestreDniel/world-im
 
 ## Status
 
-SP0, SP1, SP2a, SP2b and SP3a are complete: `?map` shows the generated world's biomes, relief, rivers and lakes and edits every parameter, spline and biome box with a live preview (parameter panel, spline editor, biome table with share chart, presets, cross-section, undo/redo); the cross-section's Voxels mode shows the real vertical slice of voxels (SP3a: block registry, shared voxel store and a provisional terrain stage filled from the 2D world), and `?selftest=1` checks every golden in the browser (deployed at https://world-imaginer-voxel.vercel.app). SP3b (density, surfaceEstimate, terrain and surface rules) is next.
+SP0, SP1, SP2a, SP2b, SP3a and SP3b are complete: `?map` shows the generated world's biomes, relief, rivers and lakes and edits every parameter, spline and biome box with a live preview (parameter panel, spline editor, biome table with share chart, presets, cross-section, undo/redo); the cross-section's Voxels mode shows the real vertical slice of voxels (SP3a: block registry, shared voxel store and region harness; SP3b: 3D terrain from a density expression with overhangs, jagged peaks and water, split across the workers), and `?selftest=1` checks every golden in the browser (deployed at https://world-imaginer-voxel.vercel.app). SP3c (surface rules and terrain palette) is next.
 
 ## Development
 
```

Modify `docs/superpowers/specs/2026-09-26-architecture-design.md` (apply with `git apply`):

````diff
diff --git a/docs/superpowers/specs/2026-09-26-architecture-design.md b/docs/superpowers/specs/2026-09-26-architecture-design.md
index d8957ee..5044cfc 100644
--- a/docs/superpowers/specs/2026-09-26-architecture-design.md
+++ b/docs/superpowers/specs/2026-09-26-architecture-design.md
@@ -104,6 +104,8 @@ world-imaginer-voxel/          (repository root)
       column/climate.ts shape.ts rivers.ts lakes.ts steep.ts columnPoint.ts columnStage.ts columnCache.ts surfaceEstimate.ts spawn.ts
       map/layers.ts tile.ts palette.ts   pure map-tile painting (SP2a)
       density/expr.ts nodes.ts compile.ts bounds.ts reference.ts defaults.ts beardifier.ts
+                                (SP3b: + context.ts, the DensityContext of the compiled expression and its caches, and probe.ts;
+                                beardifier.ts arrives with SP9; amended by SP3b)
       caves/carvers.ts carverCache.ts
       fluids/aquifer.ts settle.ts
       biomes/registry.ts picker.ts zoom.ts
@@ -125,9 +127,9 @@ world-imaginer-voxel/          (repository root)
     metrics/*.ts                                    pure metric definitions shared by vitest and the in-app dashboard (SP1: noiseStats.ts,
                                 sp1Fixtures.ts, sp1Goldens.ts; SP2a: columnStats.ts, sp2aGoldens.ts; SP2b: biomeShares.ts,
                                 splineStats.ts, liveness.ts, crossSection.ts, also run by the workers' stats job; SP3a: region.ts
-                                (fillColumnT, genRegionInProcess, regionHash) and sp3aGoldens.ts)
+                                (fillColumnT, genRegionInProcess, regionHash) and sp3aGoldens.ts; SP3b: sp3bGoldens.ts)
     workers/protocol.ts taskHandler.ts task.worker.ts sim.worker.ts   (taskHandler: pure message handler, SP2a; SP3a: sliceJob.ts,
-                                the slice job with its worker-local store and LRU)
+                                the slice job with its worker-local store and LRU; SP3b splits a slice across the workers)
     engine/                     main thread, no three
       coordinator.ts scheduler.ts rings.ts workerPool.ts throttle.ts uploadBudget.ts session.ts invalidation.ts capabilities.ts
     render/                     the only place three is imported (ui canvases are 2D; amended by SP0)
@@ -150,7 +152,7 @@ world-imaginer-voxel/          (repository root)
     main.ts
   tools/detmath-oracle.py       (SP1) CPython port of detMath, a manual oracle for the detMath goldens
   test/ unit/ metrics/ bench/ arch/ harness/{region,refs,cache,stats,flood}.ts fixtures/ tools/ (SP2b: tools/mapLatency.ts, tools/uiSmoke.ts)
-        (SP3a: harness/{region,cache,png,regionWorker,fuzzWorker}.ts)
+        (SP3a: harness/{region,cache,png,regionWorker,fuzzWorker}.ts; SP3b: harness/densityFuzz.ts, metrics/terrain.metric.ts)
         schema-shape.lock.json (SP1) stateIds.lock.json (SP3a)
         thresholds.ts thresholds.lock.json goldens.json baselines.json
 ```
@@ -303,7 +305,7 @@ Each channel is stored on its own: uniform when every value of that channel is e
 
 Byte offsets (amended by SP3a): `WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WORLD_SURFACE` 1024, `MOTION_BLOCKING` 1536, `OCEAN_FLOOR` 2048, `LIGHT_BLOCKING` 2560, `surfaceBiome` 3072, `tintTH` 3328; per-position arrays use the column index `lz·16 + lx`, and Int16 values are little-endian. A heightmap value is the absolute y of the highest qualifying voxel plus one, −64 when none qualifies: `WORLD_SURFACE_WG` and `WORLD_SURFACE` count a state ≠ air or a fluid type ≠ 0; `OCEAN_FLOOR_WG` and `OCEAN_FLOOR` count `COLLIDE` ≠ none (the fluid byte is ignored); `MOTION_BLOCKING` counts `COLLIDE` ≠ none or a fluid type ≠ 0; `LIGHT_BLOCKING` follows the §2.2 light rule, pinned by SP4.
 
-**Aux slot B:** `caveBiomeQ` Uint8[4·96·4 = 1536] at 0 and `surfaceBiomeQ` Uint8[16] at 1536 (offsets amended by SP3a). Both aux slots are zero-filled when allocated (a recycled slot included), so a field no stage has written reads 0.
+**Aux slot B:** `caveBiomeQ` Uint8[4·96·4 = 1536] at 0 and `surfaceBiomeQ` Uint8[16] at 1536 (offsets amended by SP3a). The index orders are `surfaceBiomeQ[qz·4 + qx]` (the quart's 2D biome before the zoom) and `caveBiomeQ[(qy·4 + qz)·4 + qx]` with `qy = (y + 64) >> 2`; SP3b's T writes `surfaceBiomeQ` and leaves `caveBiomeQ` 0 until SP6 (amended by SP3b; the SP3b spec §4). Both aux slots are zero-filled when allocated (a recycled slot included), so a field no stage has written reads 0.
 
 **Epoch cell.** A SAB `Int32Array` epoch cell per scope is checked by workers between phases, so a job can abort mid-run. SP3a builds the per-scope cells (terrain 0, decorate 1, light 2, mesh 3); SP4 wires them in place of SP2b's pool-wide cell (amended by SP3a).
 
@@ -349,8 +351,13 @@ type Expr =                                  // 3D density composition (preset d
   | { op:'interpolated'; a:Expr }            // subgraph evaluated at 4x8x4 corners + trilerp
   | { op:'tap'; name:string; a:Expr; mute?:number }   // named intermediate for inspector/probe/mute
   | { op:'ref'; id:string };
+// SP3b implements const, y, col, noise2, noise, add, mul, min, max, neg, abs, square, clamp, slide (x · a piecewise linear s(y)),
+// interpolated, rangeChoice, tap and ref, with the field names of its spec §1.1 (col.field, noise.id, the child of a one-child op
+// is x, slide.knots: [y, v][], ref.name); the other ops arrive with the SPs that need them (amended by SP3b).
 interface CompiledDensity { cornerFn(ctx, x:number, y:number, z:number): number; voxelFn(ctx, i:number, interp:Float64Array): number;
   boundsCell(ctx, cellX:number, cellY:number, cellZ:number): [number, number]; point(x:number, y:number, z:number, tap?:string): number; }
+// SP3b's compileDensity(expr, noises) emits columnFn, positionFn, cornerFn, voxelFn and tapFn closures over its own typed scratch;
+// the cell bounds live in bounds.ts and the point evaluation in probe.ts (the SP3b spec §2; amended by SP3b).
 // From store.claimColumn(cx, cz, epoch) (amended by SP3a; SP3a spec §3.5). Each setter copies its 4096-entry arrays.
 interface ColumnWriter { setProto(sy:number, blocks:Uint16Array, fluid:Uint8Array): void;
   setFinal(sy:number, blocks:Uint16Array, light:Uint8Array, fluid:Uint8Array): void;
@@ -358,7 +365,7 @@ interface ColumnWriter { setProto(sy:number, blocks:Uint16Array, fluid:Uint8Arra
   aux(): AuxView; auxB(): AuxBView; commit(status: 1|2|3): void /* blockVersion += 1, then status last */ }
 interface ColumnView { block(lx:number, y:number, lz:number): number; fluid(lx:number, y:number, lz:number): number;
   light(lx:number, y:number, lz:number): number; sectionBlocks(sy:number): Uint16Array|number; sectionFluid(sy:number): Uint8Array|number;
-  aux(): AuxView | null }
+  aux(): AuxView | null; auxB(): AuxBView | null /* null when the column has no such slot; auxB amended by SP3b */ }
 interface NeighborhoodReader { proto(dx:number, dz:number): ColumnView | null; final(dx:number, dz:number): ColumnView | null;
   versions(): Int32Array /* 3x3 in (dz, dx) order, blockVersion then lightVersion, -1 when absent */ }
 interface SectionMesh { secKey:number; pass:0|1|2; quads:number; position:Uint8Array /*Uint8x4*/; data:Uint32Array; index:Uint32Array;
@@ -563,7 +570,7 @@ Sky costs about 0, and the probe == bulk test (DT2) proves no voxel changes.
 
 ```
 terrain   = tap('terrain', interpolated( col.offset + col.jag·J − y + col.sigma·N3·slide(y) ))
-            J = (1 − |noise2('jag')|)²  (λ 28, 3 oct)     N3 = noise('overhang') λxz 80 λy 48, 3 oct
+            J = (1 − |u|)², u = noise2('jag') / clampSigma (λ 28, 2 oct)     N3 = noise('overhang') λ 32, λy 32, 2 oct, persistence 0.65
             slide(y) = 1 on [−40,240], linear to 0 at −64 and 320; + 2·max(0,−56−y) − 2·max(0,y−296)
 detail    = noise('detail') λ 10, 1 oct × amp(E) 0.6-1.5            (VOXEL, only in straddling cells)
 cheese    = 4·L² + clamp(Nch + 0.27, −1, 1) + clamp((12 − terrain)/24, 0, 0.5)    Nch λxz 96 λy 144, 4 oct; L λxz 96 λy 12
@@ -585,13 +592,21 @@ final     = max( min( min(terrain + detail, max(caves, lakeRoof)), 16·noodle ),
 - `beard` is the structure term (3.13), evaluated per voxel only near pieces.
 - Every term is a `tap`, so the inspector, probe and mutes work on it. In the harness, a debug channel records the winning cave term per carved voxel.
 
-### 3.7 surfaceEstimate and surfaceWaterLevel (shared by map, LOD, aquifer, structures, spawn and teleport)
+**As built by SP3b** (amended by SP3b; the SP3b spec §1-§3 hold the exact rules):
+- **Ops.** `const`, `y`, `col`, `noise2`, `noise`, `add`, `mul`, `min`, `max`, `neg`, `abs`, `square`, `clamp`, `slide`, `interpolated`, `rangeChoice`, `tap` and `ref`; caves add their ops on the same base in SP6. `slide` is `x · s(y)` with s piecewise linear over half-open segments [y_k, y_{k+1}), constant outside the knots.
+- **Evaluation order.** Every binary op evaluates a, then b; arithmetic is IEEE double in the written order, never fused or reassociated. `min(a, b)` is `b < a ? b : a` and `max(a, b)` is `b > a ? b : a`, so ties (+0 against −0 included) return a; −0 is a valid density. Trilinear interpolation lerps along x, then z, then y, with `lerp(a, b, t) = a + t·(b − a)`.
+- **Placement.** COLUMN nodes depend only on `const`, `col` and `noise2`; CELL nodes are the other nodes inside `interpolated`, VOXEL nodes the other nodes outside it; `y` and `slide` are never COLUMN. CSE is keyed by (structure, inside-`interpolated` flag). The closures are `columnFn` (the COLUMN nodes CELL nodes read, at the 5 × 5 corner columns, reading lattice values exactly), `positionFn` (the COLUMN nodes VOXEL nodes read, at the 16 × 16 block positions: `col` as the bilinear readout, `noise2` at the integer position), `cornerFn` and `voxelFn`. `interpolated` is never nested.
+- **Interval rules.** `noise` and `noise2` are ±clampSigma (amplitude is a `mul`); `col` inside `interpolated` takes the hull of the cell's 4 corner columns; a COLUMN value read at voxel level takes the hull of its 16 position values; `slide` takes s at the cell's ends and at each interior knot. Every interval leaving `interpolated`, and every voxel-level COLUMN interval, is widened by `1e-9 · (1 + max(|lo|, |hi|))`. A cell is non-solid when hi < 0 and solid when lo > 0 (no cave taps before SP6).
+- **`col`** reads finite fields only until SP6, which adds the level fields' −∞ interval rule.
+- **Noises.** Density noises sample unscaled world block coordinates (`large_biomes`' `scaleMul` stretches climate only) and have `remap: 'none'`. J uses `u = z / clampSigma`. Jag has 2 octaves, because a third at λ 7 would alias on the 4-block corner lattice. The overhang noise was retuned with the user's approval (SP3b spec §8.4) to λ 32, 2 octaves, persistence 0.65 and yScale 1: its octaves at λy 32 and 16 stay ≥ 2 × the 8-block vertical corner step.
+- **Code, not data, until SP3d:** `SLIDE`, the floor and ceiling terms and `islands` = −1e6; `density.defs` becomes an editable leaf in SP3d.
 
-SP2a uses the 2D estimate `surfaceEst = offset` (after rivers and lakes); SP3b introduces the density-tap search below and bumps the `surfaceEst` stage version (SP3a keeps the 2D estimate; amended by SP3a).
+### 3.7 surfaceEstimate and surfaceWaterLevel (shared by map, LOD, aquifer, structures, spawn and teleport)
 
+SP2a uses the 2D estimate `surfaceEst = offset` (after rivers and lakes). SP3b adds the 3D estimate below as `surfaceEst3` (`gen/column/surfaceEstimate.ts`), used by T5 and by later consumers (aquifers, structures, spawn, teleport). The ColumnSample's `surfaceEst`, which the map, the biome picker and the column stage read, stays the 2D `offset`, so the `surfaceEst` stage version is not bumped (amended by SP3b; the SP3b spec's Decision 2 and §5).
 
-- **surfaceEstimate(x,z):** start at `col.offset`, step ±8 blocks evaluating the `terrain` tap at the point, then bisect 4 times. That is about 6-10 point evaluations, ≈ 8 µs.
-- The column stage caches it on the 7×7 quart lattice.
+- **surfaceEstimate(x,z)** (`surfaceEst3`): start at ⌊`offset`⌋ (the bilinear ColumnSample value, clamped to [−64, 319]) and step ±8 blocks through the probe of the `terrain` tap (interpolated, without `detail`) until the sign changes, then bisect the 8-block bracket 3 times to one block. No sign change up to 319 returns 319, none down to −64 returns −64. An 8-step scan can cross a gap and return an overhang's underside; T5 measures single-surface positions only (amended by SP3b).
+- Caching on the quart lattice comes with its first consumer (aquifers, structures, spawn, teleport: SP4-SP9; amended by SP3b, which caches nothing).
 - T5 holds `|est − true top|` to median ≤ 1, p90 ≤ 2, p99 ≤ 6.
 - **surfaceWaterLevel:** 63 for ocean and river, Lw for lakes, otherwise −∞.
 - **Teleport:** go to `surfaceEst + 2`, then snap to `MOTION_BLOCKING` once the column is published. While unloaded, the player hovers.
@@ -1289,7 +1304,7 @@ WASD; Space (up/jump); Shift (down/sneak); Ctrl (sprint); F (walk/fly); M (map);
 - flood from sky and connected components;
 - a raycast visibility reference for cave culling.
 
-**Region cache** (`cache.ts`): binary dumps keyed by `genKey + srcKey + REGION_CACHE_FORMAT + region + upTo`, plus `stageHash('mesh')` when upTo is 'MESH', in `test/.cache/regions`. `srcKey` hashes the generator sources and the format version is bumped when the dump layout changes, because `genKey` does not track code changes made without a stage bump (amended by SP3a).
+**Region cache** (`cache.ts`): binary dumps keyed by `genKey + srcKey + REGION_CACHE_FORMAT + region + upTo`, plus `stageHash('mesh')` when upTo is 'MESH', in `test/.cache/regions`. `srcKey` hashes the generator sources and the format version is bumped when the dump layout changes, because `genKey` does not track code changes made without a stage bump (amended by SP3a). Format 2 stores each column's aux A and then aux B, and the region hash covers aux B too; CI restores `test/.cache/regions` with `actions/cache` before `npm run test:metrics` (amended by SP3b).
 
 **Suites:**
 
@@ -1304,7 +1319,7 @@ Metric values are written to `test/metrics/.out/*.json` for trends. The harness
 
 ### 6.2 Governance
 
-- **Thresholds** live in `test/thresholds.ts`. `thresholds.test.ts` compares a hash against `thresholds.lock.json`, so changing one requires `npm run test:accept-thresholds` and a spec amendment. Agents cannot silently loosen a gate.
+- **Thresholds** live in `test/thresholds.ts`. `thresholds.test.ts` compares a hash against `thresholds.lock.json`, so changing one requires `npm run test:accept-thresholds` and a spec amendment. Agents cannot silently loosen a gate. A part may list the metric tiers it gates on (`tiers`, absent = every tier); on the other tiers its value is recorded, never gated, and dropping a tier counts as loosening (amended by SP3b, whose T3 gates on the full tier only).
 - **Goldens** (region hashes per built-in preset, per stage) change only via `npm run test:goldens`. A golden change requires a `GENERATOR_VERSION` bump, which a test checks.
 - **Dev saves** whose genKey no longer matches (stale generatorVersion or params) go through the fork dialog of §2.7 (option 3 is read-only with a warning).
 
@@ -1348,19 +1363,19 @@ Metric values are written to `test/metrics/.out/*.json` for trends. The harness
 | N2 | \|r\| between schema noises at the same seed, and f([b,0]) vs g([b+k,0]), k = 1..64, n ≥ 100k random points | ≤ 0.02 |
 | N3 | aperiodicity: mean\|f(p) − f(p+P·λ0·e)\| for P ∈ {256…4096}, e ∈ {x, z, xz} (+y), all noises incl. single-stack | ≥ 0.9 × random-pair mean |
 | N4 | origin: sd of each field at (0,0) over 64 seeds / spawn | ≥ 0.8 × global sd; most common spawn biome ≤ 30%; ≥ 8 distinct spawn biomes; spawn on land 100% |
-| N5 | 16-bin gradient-direction histogram (central differences, h = λ_min/128), max/min, noises with ≥ 2 lattice terms; horizontal plane and vertical plane of 3D noises | ≤ 1.15 each |
+| N5 | 16-bin gradient-direction histogram (central differences, h = λ_min/128), max/min, noises with ≥ 2 lattice terms; horizontal plane and vertical plane of 3D noises, the vertical one in lattice coordinates (the gradient of z3(x, y / yScale, z), so a noise with yScale ≠ 1 is not failed by construction; amended by SP3b) | ≤ 1.15 each |
 | N6 | lattice zeros: P(\|z\| < 1e-6) at integer points and 4×8×4 corners, incl. adversarial single-stack small-λ defs | ≤ 0.1% |
 | T1 | land heights: largest 10-block band / p5..p95 span / share y > 120 / share y > 200 | ≤ 25% / ≥ 60 blocks / ≥ 6% / ≥ 0.5% |
 | T1lowland | share of land columns with offset0 in [66, 76) on the pure offset (SP2a) | ≤ 40% |
 | T2 | land columns with ≥ 2 solid→air transitions above surface − 30 (pre-cave) | ≥ 1.5%, ≥ 10% in peaks/windswept (amplified: Z1) |
 | T3 | P(\|Δh\| ≥ 4 across a border between two lowland biomes) / P(within those biomes), stratified by the pair's biomes (SP3b spec §8.2); gates on the full metrics tier only, fast and quick record it | ≤ 1.5 |
 | T4 | ocean floor sd per 256² / exposed bedrock under water / floor ≤ −50 | ≥ 3 / 0 / 0 |
-| T5 | surfaceEst vs true top (single-surface, no canopy) | median ≤ 1, p90 ≤ 2, p99 ≤ 6 |
+| T5 | surfaceEst vs true top (single-surface, no canopy); SP3b: `surfaceEst3` vs the voxels' true top at land positions with exactly one solid→air transition above y −56 (amended by SP3b) | median ≤ 1, p90 ≤ 2, p99 ≤ 6 |
 | T6 | spline gain: raising a knot by 10 blocks, `gain = ΣΔoffset_col / Σw_col` over columns with w_col > 0 (w_col = product of Hermite value-basis weights along the knot path, tangents fixed), one knot per depth | 10 ± 1.5 |
 | T7 | steep continuity: border/interior gradient ratio | 0.9-1.1 |
 | T8 | per-axis relief in the default profile: sd of land `offset` from varying E_u over [−1,1] (resp. W) at sampled C, W (resp. C, E), on the column-stage point path | E ≥ 10 blocks / PV ≥ 10 blocks |
 | B1 | surface biome shares | each ≥ 0.3% (rare ≥ 0.1%); largest land biome ≤ 16%; ocean family 25-45%; exact ties 0; outside all boxes ≤ 2% |
-| B2 | rivers: water at surface / median connected length / share of land / river-biome columns without surface water / river components ≥ 300 blocks that touch ocean water / gorge columns cut ≥ 8 blocks below offset0 per 100 km² of land with offset0 ≥ 120 | ≥ 95% / ≥ 300 blocks / 2-7% / 0 / ≥ 50% / ≥ 1 |
+| B2 | rivers: water at surface / median connected length / share of land / river-biome columns without surface water (SP2a's 2D statement, kept 2D by SP3b; a voxel river-water check comes with SP3c) / river components ≥ 300 blocks that touch ocean water / gorge columns cut ≥ 8 blocks below offset0 per 100 km² of land with offset0 ≥ 120 | ≥ 95% / ≥ 300 blocks / 2-7% / 0 / ≥ 50% / ≥ 1 |
 | B3 | cave biomes per 8×8 km | lush, dripstone, abyss each ≥ 0.5% of cave air |
 | B4 | hot/cold columns in windswept or spruce / snow in desert / coast-band land columns that are beach, stony shore or snowy beach / land-biome tops below sea level outside rivers and lakes | < 1% / 0 / ≥ 70% / ≤ 1% |
 | B5 | lakes per km² of land / share with Lw ≥ 70 / lake water with air horizontally adjacent | 0.2-2 / ≥ 30% / 0 |
@@ -1388,7 +1403,7 @@ Metric values are written to `test/metrics/.out/*.json` for trends. The harness
 | X1 | villages per 100 km² / start x mod 16 / piece overlaps / median pieces per village | ±35% of analytic / χ² p ≥ 0.01 / 0 / ≥ 8 |
 | X2 | rigid floor cells supported / clearance above / starts below surfaceEst − 4 | ≥ 95% / ≥ 95% / 0 |
 | DT1 | region hash: spiral vs shuffled, 1 vs 4 threads, cold vs warm, 2 runs, goldens | exact |
-| DT2 | probe == bulk / compiled == reference / batch == point (column stage, at quart corners) | 0 mismatches / bit-exact / bit-exact (tightened by SP2a) |
+| DT2 | probe == bulk / compiled == reference / batch == point (column stage, at quart corners). SP3b's parts: `probeBulk` counts voxels whose probe solidity differs from the block, and voxels the bulk evaluated where `Object.is(probe, bulk)` fails; `compiledReference` counts corner and voxel values where compiled ≠ reference; batch == point stays a unit test (amended by SP3b) | 0 mismatches / bit-exact / bit-exact (tightened by SP2a) |
 | R1 | hidden seam faces emitted / visible faces missing vs brute force | 0 / 0 |
 | R2 | greedy quads per visible face (AO on / off) | ≤ 0.6 / ≤ 0.35 |
 | R3 | wrongly culled sections vs raycast reference / culled from an underground camera | 0 / ≥ 50% |
@@ -1405,7 +1420,7 @@ Metric values are written to `test/metrics/.out/*.json` for trends. The harness
 | E1-E6 | diff codec; `.wiworld` round-trip hash; reload with edits hash; fault-injected aborted flush consistent (flushSeq); edit→unload→reload returns the latest diff; genKey mismatch shows the fork dialog and each option (including Cancel) yields its specified world state | exact |
 | E7 | two worlds with the same genKey: edits in one never appear in the other / delete removes every `diffs` key of that worldId / hotbar and player restored per world / `stateTable` remap on load | exact |
 | U1 | stage-run counters: decorate edit re-runs only {D, L, mesh}; terrain edit spares raw climate; climate re-runs all | exact |
-| U2 | param liveness: ±15% on each non-live param changes its stage output hash in ≥ 1 of 16 columns. SP2b (its spec §7): perturbations per kind (number and int ±15 % of \|v\| or of the range span, noise wavelength, every numeric spline knot by 15 % of the y span, box intervals shrunk and grown by 15 %); the stage output hash of the leaf's home stage (climate, shape or biome2d); 16 class columns chosen by the lattice conditions under which leaves act (land, coast, channel, gorge, basin, rim and one per lake gate), and bounded witnesses for leaves no class column decides (amended by SP2b) | 100% |
+| U2 | param liveness: ±15% on each non-live param changes its stage output hash in ≥ 1 of 16 columns. SP2b (its spec §7): perturbations per kind (number and int ±15 % of \|v\| or of the range span, noise wavelength, every numeric spline knot by 15 % of the y span, box intervals shrunk and grown by 15 %); the stage output hash of the leaf's home stage (climate, shape or biome2d); 16 class columns chosen by the lattice conditions under which leaves act (land, coast, channel, gorge, basin, rim and one per lake gate), and bounded witnesses for leaves no class column decides (amended by SP2b). SP3b adds the `terrain` stage: its output hash is the region hash of one column after `fillColumnT`, tried at the land and coast class columns only, with no witness search, and every `density.*` leaf must be decided (amended by SP3b) | 100% |
 | U3 | no-placebo: params with `effectMetric` move that metric by > 0.5% at ±15% | 100% |
 | U4 | registry invariants (every leaf has meta and scope, every non-live leaf a covering stage); migration invariant, fixtures and export → import identity; schema-shape lock; README generated block is fresh | exact (0 issues each) |
 | Z1 | amplified: land columns with ≥ 2 transitions (T2) / p99 land height | ≥ 8% / ≥ 250 |
@@ -1515,6 +1530,7 @@ Metric values are written to `test/metrics/.out/*.json` for trends. The harness
 | Mesh | about 9 non-trivial sections × ≤ 1.0 ms | ≈ 9 / 20 |
 | **Total** | | **≈ 26 ms per column** |
 
+- **Measured in SP3b** (amended by SP3b): the column stage's ColumnSample p50 0.34 ms (it keeps the 2D surfaceEst, so the row's surfaceEst cost moves to `surfaceEst3`'s consumers); T without caves (`terrain.real`: ColumnSample, density with early-outs, water, 24 sections, aux A and B) p50 1.42-1.46 ms, p99 2.2-2.4 ms, gated at ≤ 4 ms p50 by `TERRAIN_P50_MAX_MS`; one corner of the default expression ≈ 0.19 µs.
 - **Kill criterion:** if DAG closure overhead exceeds 25% of T (measured by bench against a hand-inlined default expression), add `new Function` codegen behind a CSP probe, keeping `reference.ts` as the oracle.
 - **Fill:** RD12 needs T 755 / D 660 / L 573 / mesh 491 columns ≈ 16-17 CPU-seconds.
   - Wall time ≤ 6 s on the reference laptop with the bench cap of 4 workers and the throttle; ≤ 4 s with the default 6 workers (09 took 71 s at RD16).
@@ -1659,7 +1675,7 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 - **Cut line:** the lab's A/B mode (→ SP10).
 
 **SP2a — Column stage, worker pool and map** (L; SP1). Spec: `2026-09-28-sp2a-column-stage-map-design.md` (the 2026-09-28 split of the former SP2).
-- Climate with warps and CDF, PV fold; offset / σ / jag splines in blocks; steep from the halo; rivers (channel, valley, gorges) and lakes (column terms); a 2D `surfaceEst = offset` (SP3b replaces it); surface biome registry, picker and zoom; spawn search; ColumnSample LRU; point reference `columnPoint` and batched `buildColumnSample`, bit-exact at quart corners.
+- Climate with warps and CDF, PV fold; offset / σ / jag splines in blocks; steep from the halo; rivers (channel, valley, gorges) and lakes (column terms); a 2D `surfaceEst = offset` (SP3b keeps it for the map, the biome picker and the column stage; its 3D `surfaceEst3` is used by the voxel metrics and later consumers; amended by SP3b); surface biome registry, picker and zoom; spawn search; ColumnSample LRU; point reference `columnPoint` and batched `buildColumnSample`, bit-exact at quart corners.
 - Task pool and protocol (`MAP_TILE`, `point`, `selftest`); the standalone `?map` page (coarse-first tiles; biome, relief, rivers, lakes, raw fields and offset/σ/jag layers; hover; spawn marker; click shows a coordinate); seed box, ready-profile select and a JSON patch box over `WorldSession`, in the URL hash.
 - `?selftest=1` page: recomputes column-stage and map-tile golden hashes in a real module worker.
 - **Deliverable:** an interactive world map of the default and large_biomes worlds, parameterised by URL patch.
@@ -1672,7 +1688,7 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 - **Deliverable:** the SP2a map updates live while splines and biome boxes are edited; a 1-10 biome-size slider drives `climate.scaleMul = 4^((v − 5)/5)` (5 = default, 10 = large_biomes; user request 2026-09-29).
 - **Exit:** U2 for column-scope params; spline-edit map preview ≤ 300 ms; preset unit tests; the SP1 deferred minors reachable through the editor (spline knot/tangent bounds, tiny amplitudes).
 - Received from SP2a (amended by SP2b): the raw W/T/H/R layers and the grid overlay exist; the spawn fallback refinement is closed as not needed (N4 spawnOnLand is 100 % over 64 seeds with the SP2a fallback).
-- Handed on (SP2b spec Appendix A): SP2a minors 5 and 6 → SP3 (SP3b after the split); the `?lab=noise` minors → SP10.
+- Handed on (SP2b spec Appendix A): SP2a minors 5 and 6 → SP3 (SP3b after the split; SP3b moves minor 6 on to SP3c); the `?lab=noise` minors → SP10.
 - **Cut line:** the biome share preview and the cross-section profile (→ SP10). Both were delivered in SP2b, so nothing moved to SP10.
 
 SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a spec's Decisions): the context review sized it at 9-12 weeks, three to four times an "L". SP4 and SP6 depend on SP3b; SP3c can run alongside SP4.
````

Modify `docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md b/docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md
index c25c586..709bc73 100644
--- a/docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md
+++ b/docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md
@@ -538,6 +538,7 @@ Sampling rules shared by N1-N6 (implemented in `src/metrics/noiseStats.ts`):
 - All parts are `activeFrom: 'SP1'`. Single-cell rows use the part name `value` (SP0 convention).
 - **N2 sizes.** From sampling alone max |r| sits near 4/√n, but large-λ fields inflate the variance of r over the window (rms(r)·√n = 1.45 for T, 1.21 for C at 100 k), so T–T pairs sit about 4.4σ from the gate. With n = 100 k every tier's false-failure rate on a hash or seeding change stays well under 1 % (the 50 k fast tier measured about 0.5 %). Measured at the pinned configurations: 0.011-0.014.
 - N5 excludes single-lattice-term noises, which are intrinsically anisotropic (1.1-1.4 measured). It skips clamped samples because both differences are 0 there and atan2(0, 0) = 0 inflates one bin (bias about 0.02).
+- **N5's vertical rose in lattice coordinates** (amended by SP3b; the SP3b spec §3.3): the schema gained 3D density noises, which N5 covers like every schema noise (the xz plane in `horizontal`, the xy plane in `vertical`). The vertical rose is the gradient of `z3(x, y / yScale, z)`, i.e. measured on the noise's own lattice, because a noise with yScale ≠ 1 is anisotropic on world axes by construction (with the pre-retune overhang noise, yScale 1.25, `N5.vertical` measured 1.58 on world axes, failing the 1.15 gate, and 1.07 in lattice coordinates; fast tier). For yScale 1 the two are the same samples, so the SP1 values do not change.
 - N6 needs the adversarial defs: double stacks and large-λ fields pass even with integer origins (which give 0.66-1.97 % on the adversarial defs), so without them the metric measures nothing.
 - P = 65536 in N3 catches a 16-bit lattice-coordinate wrap that {256 … 4096} misses.
 - Measured by the review re-implementation (balanced gradients, ±2^19): N1 D ≤ 0.0118 (16 × 50 k) and ≤ 0.0073 (16 × 200 k), sdErr ≤ 0.011; N3 0.951; N5 1.031-1.100. The plan's dry run (fast tier, 7 s under vitest): N1 D 0.0100, sdErr 0.0076; N2 0.0122; N3 0.953; N5 1.074 / 1.051; N6 0.058 %, all from `test.adv2d16` (exact cancellations of a single-octave field on the ½ slice at integer points; 0.054 % at 1 M points, so the 0.1 % gate keeps a 1.9× margin while integer origins would give 0.66 %).
```

Modify `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
index 0d64443..fcf1f68 100644
--- a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
+++ b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
@@ -192,7 +192,7 @@ Master §2.1, as code: integer x and z; y ∈ [−64, 319]; `cx = x >> 4`, `cz =
   - `shareFinal(sy, light: Uint8Array)`: the final blocks and fluid become the proto entries (each dense slot retained), the light is stored as by `setFinal`, and meta is computed;
   - `aux(): AuxView` and `auxB(): AuxBView`: §3.4; `AuxView` has the named fields of §3.4 as typed subarrays of the slot (`worldSurfaceWG`, `oceanFloorWG`, `worldSurface`, `motionBlocking`, `oceanFloor`, `lightBlocking`: Int16Array(256); `surfaceBiome`: Uint8Array(256); `tintTH`: Uint8Array(768)), `AuxBView` likewise (`caveBiomeQ`, `surfaceBiomeQ`);
   - `commit(status: 1 | 2 | 3)`: `Atomics.add(blockVersion, 1)`, then `Atomics.store(status)` last, so a reader never sees a partial column.
-- **`ColumnView`:** `block(lx, y, lz)`, `fluid(lx, y, lz)`, `light(lx, y, lz)`; `sectionBlocks(sy)` and `sectionFluid(sy)` return a view over the slot or the uniform value; `aux()` returns the column's `AuxView`, or null when it has none.
+- **`ColumnView`:** `block(lx, y, lz)`, `fluid(lx, y, lz)`, `light(lx, y, lz)`; `sectionBlocks(sy)` and `sectionFluid(sy)` return a view over the slot or the uniform value; `aux()` returns the column's `AuxView`, or null when it has none; `auxB()` likewise returns its `AuxBView`, or null when it has no aux B slot (amended by SP3b; the SP3b spec §7).
 - **`NeighborhoodReader`:** `proto(dx, dz)` and `final(dx, dz)` over the 3 × 3 neighbourhood (null for an absent column); `versions()` returns an Int32Array(18): the 3 × 3 in (dz, dx) order from (−1, −1), blockVersion then lightVersion per column, −1 for an absent column. Defined now, consumed from SP4.
 
 ### 3.6 Tests
@@ -227,10 +227,10 @@ Master §2.1, as code: integer x and z; y ∈ [−64, 319]; `cx = x >> 4`, `cz =
 ### 5.1 Worker job
 
 - **Protocol:** `{type: 'slice', jobId, epoch, ax, az, bx, bz}` → `{type: 'sliceResult', jobId, epoch, blocks: ArrayBuffer, fluid: ArrayBuffer}` (transferred). `BAD_ARGS` for an end outside the half-open window or a zero-length segment, as for `crossSection` (SP2b §5.4).
-- **Pool:** `pool.slice(segment, priority = 500): Promise<SliceResult>` sends a slice as one job to one worker, never split, at the stats priority (SP2b §5.4); a configure rejects it with `JobCancelled`, and `ABORTED` resolves as `JobCancelled`, as for stats jobs.
+- **Pool:** `pool.slice(segment, priority = 500): Promise<SliceResult>` sends a slice as one job to one worker, never split, at the stats priority (SP2b §5.4; amended by SP3b, whose real T costs about twice as much per column: the slice is split into one contiguous sample range [from, to) per worker, as `pool.stats` splits, each part laid out `(319 − y)·(to − from) + (i − from)` and merged row by row into the layout below, byte-identical to one job, the first failing part dropping its queued siblings; `BAD_ARGS` for a bad range; the SP3b spec §6); a configure rejects it with `JobCancelled`, and `ABORTED` resolves as `JobCancelled`, as for stats jobs.
 - **Samples:** sample (i, y) reads the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋), where (xᵢ, zᵢ) = `segmentPointAt(segment, i)` (SP2b §4.5: A + (B − A)·i/511, clamped to the segment's box), for i 0 … 511 and y −64 … 319.
 - **Buffers:** `blocks` is a Uint16Array and `fluid` a Uint8Array, 512 × 384 = 196,608 entries each, index (319 − y)·512 + i: row 0 is y 319, the order the Voxels mode draws in.
-- **Slice store:** each worker creates its own store on its first slice job, `createStore({shared: false, maxBlockBytes: 32 MiB, maxByteBytes: 16 MiB})` (65 proto columns need at most 1,560 block and 1,625 byte slots), and keeps it for its lifetime. An LRU keyed by `colKey` holds at most 64 columns of one configured epoch; a configure frees every resident column and empties the LRU.
+- **Slice store:** each worker creates its own store on its first slice job, `createStore({shared: false, maxBlockBytes: 32 MiB, maxByteBytes: 16 MiB})` (65 proto columns need at most 1,560 block and 1,625 byte slots; 1,690 byte slots once SP3b's T writes aux B), and keeps it for its lifetime. An LRU keyed by `colKey` holds at most 64 columns of one configured epoch; a configure frees every resident column and empties the LRU.
 - **Generation:** the worker walks the samples in order; a straight segment enters each column once, so a column's samples are contiguous. On reaching a new column it checks the abort cell, then takes the column from the LRU, or on a miss: frees (`freeColumn`) and drops the LRU column that holds the same torus record, if any; frees and drops the least recently used column if 64 are resident; then runs `fillColumnT` with `stop` and the job's epoch. It reads all of that column's samples before moving on, so it never needs two columns of one torus record at once and `claimColumn` never throws `SlotBusy` here.
 - **Abort:** `stop` is true once the pool's abort cell leaves the job's epoch (the handler's `NEVER` when the cell is null, SP2b §2.2). A stopped column is freed by `fillColumnT`, not inserted into the LRU, and the job replies `ABORTED`.
 
```

Modify `docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
index 5232566..a60cdf1 100644
--- a/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
+++ b/docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md
@@ -516,6 +516,91 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
    - SP2a minor 5 is a retained-heap assertion (< 16 KiB over 1,000 warm columns): the closures and noise calls box about 1.5 MB of short-lived doubles per column, so literal zero allocation would need a compiler rewrite;
    - the ocean-floor σ/jag stripe (§8.4 item 4) is not visible on voxels.
 
+## Exit evidence
+
+Dry run of the implementation plan (2026-10-07, branch `dry/sp3b`, Tasks 1-16; 12th Gen Intel(R) Core(TM) i7-12700H with 20 threads, Node v24.21.0, headless Chrome 155.0.8059.39, Bun 1.4.2). Every figure below was measured on the dry-run branch; the executor re-measures each one on its own branch and replaces this block.
+- `npm run build` and `npm test` (135 files passed, 2 skipped; 1797 tests passed, 4 skipped; 49 s) are green. The integration project alone: 4 files and 7 tests in 16 s; the 4-thread harness equals the 1-thread one in every order on the real T, for both profiles. `npm run test:metrics` (57 s) and `npm run test:metrics:full` (148 s; DT1 found the dumps of earlier runs: 2 and 8 first cache hits; peak RSS 1.08 GB) are green with DT1, DT2 and T1-T5 active.
+- `git diff main -- test/goldens.json`:
+  - `generatorVersion` 3 → 4;
+  - `sp1.params` → 948e09daacb25342 (it hashes `genKey`, so the version);
+  - from the retune: `sp2a.column.point.default` and `.large_biomes`, `sp2a.column.sample`, `sp2a.spawn`, `sp2a.tile.biome.16` and `.64`, `sp2a.tile.relief.{4,16,64,256}` and `sp2a.tile.rivers.{4,16,64,256}`;
+  - `sp3a.region.T.default` → e9992ef6d99595d4 and `sp3a.region.T.large_biomes` → 6dcf464ccfb0f81d;
+  - added `sp3b.density.default` 020212de61dc83da and `sp3b.density.ops` adad71e21efc60cb.
+
+  Unchanged: every other `sp1.*` key, `sp2a.tile.C.*`, `sp2a.tile.biome.4` and `.256` (no moved height threshold crosses them) and `sp3a.registry`. The file holds 52 entries.
+
+Terrain and density metrics. Each part gates the worse profile; the cells show default / large_biomes.
+
+| part | threshold | fast | quick | full |
+|---|---|---|---|---|
+| T1.band | ≤ 0.25 | 0.234 / 0.179 | 0.232 / 0.183 | 0.239 / 0.183 |
+| T1.span | ≥ 60 | 105 / 110 | 107 / 111 | 104 / 107 |
+| T1.above120 | ≥ 0.06 | 0.167 / 0.194 | 0.167 / 0.192 | 0.157 / 0.179 |
+| T1.above200 | ≥ 0.005 | 0.0221 / 0.0224 | 0.0234 / 0.0232 | 0.0204 / 0.0214 |
+| T2.overhangs | ≥ 0.015 | 0.0369 / 0.0445 | 0.0352 / 0.0433 | 0.0373 / 0.0432 |
+| T2.overhangsPeaks | ≥ 0.10 | 0.1035 / 0.1234 | 0.1005 / 0.1202 | 0.1092 / 0.1180 |
+| T3.value (lowland borders) | ≤ 1.5 on full | 1.371 / 0.924, recorded | 1.509 / 0.794, recorded | 1.189 / 0.944 |
+| T4.floorSd | ≥ 3 | 7.46 / 3.16 | 7.46 / 3.16 | 5.69 / 3.19 |
+| T4.exposedBedrock / deepFloor | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
+| T5 median / p90 / p99 | ≤ 1 / 2 / 6 | 1 / 2 / 4 | 1 / 2 / 4 | 1 / 2 / 4 |
+| DT1.mismatches | 0 | 0 (10 regions) | 0 (10) | 0 (40) |
+| DT2.probeBulk / compiledReference | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
+
+- **Populations** (default / large_biomes):
+  - columns fast 4,096 / 16,384, quick 8,192 / 32,768, full 16,384 / 65,536 (4 seeds); land positions on full 2.25 M / 9.02 M;
+  - peak columns fast 611 / 2,196, full 2,275 / 8,407;
+  - T5 single-surface positions full 132,188 / 524,890 (multi-surface about 6-7 %; largest error 27 / 55);
+  - T3 lowland border pairs fast 2,613 / 2,843, quick 5,006 / 5,171, full 9,977 / 10,752;
+  - T4 regions 4 / 4 / 64 per profile (fast and quick draw the same 4);
+  - DT2 voxels 512 / 8,192 / 32,768, of which the bulk evaluated 324 / 5,217 / 20,866.
+- **Diagnostics** (ungated):
+  - floating rocks (land positions with a solid run ≤ 6 blocks high on an air gap ≥ 3, y ≥ −56): 1.78 % / 2.03 % of land positions on full, 5.1 % / 5.5 % within the peak biomes, 0.06 / 0.07 voxels per land position; fast and quick are within 0.1 points;
+  - water walls (water voxels with dry air beside them at the same y): 3.6e-4 / 1.0e-4 of the water voxels in the scattered columns on full (fast and quick 3.5-3.8e-4 / 1.0-1.2e-4), and 2.9e-5 in the T4 ocean regions;
+  - T3 of the other families on full: highland 1.277 / 1.080 (9,516 / 9,182 pairs); all same-family pairs together 1.262 / 1.066; coast, ocean and river borders are a few hundred pairs at most (ratio 0, river 38 on 13 large_biomes pairs).
+- **Every 2D metric still passes** (fast / quick / full):
+  - B1 minShare 0.00368 / 0.00372 / 0.00366, largestLand 0.068, oceanFamily 0.441, ties 0, outside 0.0017;
+  - B2 medianLength 403 / 403 / 464, landShare 0.037 / 0.032 / 0.035, mouths 0.65 / 0.70 / 0.60, gorgesPer100km2 5,572 / 7,611 / 6,897, dryRiverBiome 0;
+  - B4 hotColdSpruceWindswept 0, coastBandBeach 0.993 / 0.992 / 0.989; B5 perKm2 1.12 / 1.44 / 1.20, highShare 0.50 / 0.65 / 0.75;
+  - T1lowland 0.078 / 0.076 / 0.076; T6 10; T7 0.997 / 0.989 / 0.999, borderMismatch 0; T8 E 14.04 / 14.08 / 14.14, PV 10.93 / 10.90 / 11.16;
+  - N1 ksD 0.0087 / 0.0094 / 0.0062, sdErr ≤ 0.0087; N2 0.0083 / 0.0133 / 0.0133; N3 0.953 / 0.979 / 0.986; N4 originSdRatio 0.90, spawnTopShare 0.125, 17 distinct, on land 1; N5 horizontal 1.074 / 1.056 / 1.041, vertical 1.062 / 1.048 / 1.038; N6 0.00058 / 0.00052 / 0.00054;
+  - U2 1 (56 leaves, every `density.*` leaf decided); U4 0; M1 3 states, 0, 0.
+
+  Before the retune (quick / full): T1lowland 0.334 / 0.335, T8.E 21.19 / 21.28, B5.highShare 0.474 / 0.462, B2.gorgesPer100km2 8,133 / 7,573.
+
+Bench: `npm run bench` against the baseline recorded in the dry run's bench task (bench → record → bench on the quiet machine, killRatio 0.832). This run had a quiet machine (99 % idle, the load average decaying from the metric runs) and took 30 s. PASS: the worst ratio to the baseline is perm512.random 1.024; killRatio 0.821; `column.sample` p50 0.342 ms, p99 0.475 ms. The SP3b rows:
+
+| kernel | ns/eval | ratio to calibration |
+|---|---|---|
+| `calibration.fmix32` | 0.636 | 1 |
+| `density.corner` (SP3b; one corner of the default expression) | 185.5 | 291.7 |
+| `terrain.real` (SP3b; one column with its ColumnSample, replaces `terrain.provisional`) | 1,423,465 | 2,238,201 |
+
+`terrain.real` p50 1.423 ms and p99 2.246 ms, against `TERRAIN_P50_MAX_MS` 4. SP3a's provisional T took 0.66 ms.
+
+JavaScriptCore: `npx --yes bun@1 test/tools/goldensJsc.ts` → `52/52 match on Bun 1.4.2 (JavaScriptCore)` (6 s).
+
+Browser checks (`node test/tools/uiSmoke.ts --profile-dir <tmp> --shots <dir>`: its own build, `vite preview` on a free port and headless Chrome 155, 1400 × 900 at DPR 1; 45 s) → `smoke: 77/77 checks pass`:
+- `?selftest=1`: `✓ all 52 goldens match (5.9 s)`, and `test/goldens.json` holds 52 entries.
+- The Voxels mode on SP3a's line A (−12800, 0) → B (12800, 0): "ground top y 22 to 248 · water on 14.5 % of the line, up to 41 deep", 38 colours in the 512 × 384 slice, hover "(25, 12, 0) · stone · no fluid".
+- The mountain line A (−1664, 8) → B (−640, 8): "1 024 blocks; ground top y 140 to 257 · no water", screenshot `cross-section-voxels-mountain.png`.
+- No page error apart from the favicon.ico 404.
+- Firefox (`?selftest=1` 52/52) and CI (with the region-cache step) are checked after the merge, as in SP3a.
+
+Visual review (`docs/superpowers/specs/assets/sp3b/`; world seed '42', default profile, the real T after the retune; air sky blue, stone grey, water blue darkening with depth). `npm run docs:review-slices` (`test/harness/reviewSlices.ts`) writes the slices. It reads each line's kinds and crop from the voxels, and `slices.json` records each line's summary (kinds, tops, overhangs, water-wall faces).
+- `slice-mountain.png` (1024 × 256, y 64 … 319; x −1664 … −641, z 8; every position highland with σ > 8): the crest is broken into mushroom- and hook-shaped crags that lean over their bases; 214 of 1,024 positions have ≥ 2 solid→air transitions (5 before the retune). Tops 140 … 257. **Floating rocks:** about a dozen islets of 3-15 blocks hang 5-30 blocks above the crest, mostly in the west third and the east half (97 positions by the proxy); small enclosed air pockets sit under the crest at y ≈ 120-170. No water.
+- `slice-coast.png` (1024 × 224, y −64 … 159; x −27136 … −26113, z −31992): the sea fills the west 40 % over a 40-60 floor. The coast plain sits just above the sea (land tops median 67), and a hill at x ≈ −26620 carries a thin needle to 129 with an undercut foot (2 overhang positions). 551 sea, 452 land and 21 river positions. Water walls: 5 faces, a 4-block water face beside a 1-wide dry hole west of the river mouth (x −27026, y 60 … 63).
+- `slice-lake.png` (2 px per block, y 32 … 95; x −16384 … −15873): rolling plains at 62 … 89; the lake stands at y 82, 140 positions, 12-20 deep, with a stone spike to y 89 on its west shore. **Water wall:** between the spike and the water a 1-wide dry slot at x −16094 leaves a 9-block vertical water face (x −16093, y 74 … 82), the v0 artefact of §4. A river pool at y 63 lies west of the spike.
+- `slice-river.png` (2 px per block, y 32 … 127; x −15552 … −15041): a wide valley whose banks rise to plateaus at about 100-109. The river at y 63 fills the valley floor in 5 pools between stone bumps (90 river positions), with 1 water-wall face.
+- `slice-y62.png` (1024 × 1024, the y plane 62 of the coast's 64 × 64 columns): open sea, a peninsula, islands and inland lakes. Dry air at y 62 (0.9 % of the plane) fringes many shores 1-3 blocks wide and fills one inland basin: the v0 water rule's dry hollows next to water, i.e. water walls seen in plan.
+- `cross-section-voxels-mountain.png` (1400 × 900, `uiSmoke.ts --shots`): `?map` in relief at 2 blocks/px with the line across the stony-peaks massif between two lakes, and the drawer in Voxels mode. It matches `slice-mountain.png`; hover "(−1256, 120, 8) · stone · no fluid".
+- `retune/` holds the before/after set the user approved (§8.4), 1 px per block unless noted:
+  - a plain (x −15408 … −14385, z −31400): tops 62 … 85 → 63 … 116: a flat strip just above sea level becomes a gently rolling plateau 20-30 blocks higher inland;
+  - the coast: tops 19 … 144 → 18 … 129, the 80-block jag spike thinner, 0 → 2 overhang positions;
+  - a mountain (x −16864 … −15841, z −12568): tops 41 … 192 → 35 … 238, 0 → 74 overhang positions, crests broken into arches, hooks and undercut ledges, and a few floating rocks above the peaks;
+  - zooms of the coast (4 px per block) and the mountain (3 px per block, a 20-block arch with a hole and a floating blob).
+- **Ocean-floor σ/jag stripe** (§8.4 item 4): three 256 × 256-block ocean windows crossed by a river channel (seed '42', cz −1024 … −1009, cx −800, −704 and −688). On the voxel floor, the mean |Δfloor| between x-neighbours is 0.29-0.34 inside the channel's σ-0.5 band against 0.36-0.37 outside. The floor's height map shows no stripe along the channel, so no T4 knob was changed.
+- The user's approval of this visual review is the last exit criterion; the dry run records the assets, and the executor shows them to the user.
+
 ## Threshold log
 
 (One line per commit that changes `test/thresholds.lock.json`.)
```

- [ ] **Step 4: Regenerate the governed files**

`docs/superpowers/specs/assets/sp3b/retune/after-coast-zoom.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/after-coast-zoom.png > docs/superpowers/specs/assets/sp3b/retune/after-coast-zoom.png`.

`docs/superpowers/specs/assets/sp3b/retune/after-coast.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/after-coast.png > docs/superpowers/specs/assets/sp3b/retune/after-coast.png`.

`docs/superpowers/specs/assets/sp3b/retune/after-mountain-zoom.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/after-mountain-zoom.png > docs/superpowers/specs/assets/sp3b/retune/after-mountain-zoom.png`.

`docs/superpowers/specs/assets/sp3b/retune/after-mountain.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/after-mountain.png > docs/superpowers/specs/assets/sp3b/retune/after-mountain.png`.

`docs/superpowers/specs/assets/sp3b/retune/after-plain.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/after-plain.png > docs/superpowers/specs/assets/sp3b/retune/after-plain.png`.

`docs/superpowers/specs/assets/sp3b/retune/before-coast-zoom.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/before-coast-zoom.png > docs/superpowers/specs/assets/sp3b/retune/before-coast-zoom.png`.

`docs/superpowers/specs/assets/sp3b/retune/before-coast.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/before-coast.png > docs/superpowers/specs/assets/sp3b/retune/before-coast.png`.

`docs/superpowers/specs/assets/sp3b/retune/before-mountain-zoom.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/before-mountain-zoom.png > docs/superpowers/specs/assets/sp3b/retune/before-mountain-zoom.png`.

`docs/superpowers/specs/assets/sp3b/retune/before-mountain.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/before-mountain.png > docs/superpowers/specs/assets/sp3b/retune/before-mountain.png`.

`docs/superpowers/specs/assets/sp3b/retune/before-plain.png` is part of the user-approved before/after set: copy it from the dry run, `git show dry/sp3b:docs/superpowers/specs/assets/sp3b/retune/before-plain.png > docs/superpowers/specs/assets/sp3b/retune/before-plain.png`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch test/arch/masterSpec.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  7 passed (7)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  135 passed | 2 skipped (137)
Tests  1816 passed | 4 skipped (1820)
```

- [ ] **Step 7: Measure the exit evidence**

Run each and replace the dry-run numbers in the spec's Exit evidence block (Step 3) with yours:

- `npm run build && npm test`
- `npm run test:metrics` and `npm run test:metrics:full` (DT1, DT2, T1-T5 and every 2D metric pass; T3 gates on full only; record the tier times and the diagnostics)
- `npx --yes bun@1 test/tools/goldensJsc.ts` → `52/52 match`
- `node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots $(mktemp -d /tmp/wi10-shots-XXXX)` → `smoke: 77/77 checks pass`, including `?selftest=1` "✓ all 52 goldens match"
- `npx vitest run --project integration`
- `npm run bench` (on a quiet machine; `terrain.real` p50 ≤ 4 ms)
- `git diff main -- test/goldens.json`: only `generatorVersion`, `sp1.params`, the `sp2a.*` keys of the retune, `sp3a.region.T.*` change, and the two `sp3b.density.*` keys are added

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md README.md docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md docs/superpowers/specs/2026-10-07-sp3b-density-terrain-design.md docs/superpowers/specs/assets/sp3b/retune/after-coast-zoom.png docs/superpowers/specs/assets/sp3b/retune/after-coast.png docs/superpowers/specs/assets/sp3b/retune/after-mountain-zoom.png docs/superpowers/specs/assets/sp3b/retune/after-mountain.png docs/superpowers/specs/assets/sp3b/retune/after-plain.png docs/superpowers/specs/assets/sp3b/retune/before-coast-zoom.png docs/superpowers/specs/assets/sp3b/retune/before-coast.png docs/superpowers/specs/assets/sp3b/retune/before-mountain-zoom.png docs/superpowers/specs/assets/sp3b/retune/before-mountain.png docs/superpowers/specs/assets/sp3b/retune/before-plain.png test/arch/masterSpec.test.ts
git commit -F - <<'EOF'
docs(spec): SP3b exit — master, SP1 and SP3a amendments, dry-run revision and exit evidence

The master spec takes the remaining SP3b amendments (SP3b spec §14): the §1
module layout (density context and probe, sp3bGoldens, densityFuzz, the
terrain metric), §2.3 aux B index orders, §2.5 ColumnView.auxB() and notes on
SP3b's Expr subset and closures, §3.6 as built (ops, evaluation order,
placement with positionFn, interval rules and widening, finite col fields,
J on u, jag 2 octaves, the retuned overhang noise), §3.7 surfaceEst3 beside
the unchanged 2D surfaceEst, §6.1 region cache format 2, §6.2 tier-gated
threshold parts, §6.4 N5 in lattice coordinates, T5 on surfaceEst3, DT2's
parts, U2's terrain stage and B2's 2D dryRiverBiome, §7 the measured T cost,
and §10's SP2a and SP2b lines. The SP1 spec notes N5's lattice-coordinate
vertical rose; the SP3a spec notes ColumnView.auxB() (§3.5) and the slice
split (§5.1). test/arch/masterSpec.test.ts now also checks that §2.5's store
interfaces name every method of world/store/api.ts and that §3.6's default
expression states the schema defaults of the density noises and amplitudes.

The SP3b spec records the dry run's changes (§16: the approved retune, T3
on lowland borders gated on full, the sampling, the diagnostics, aux B in the
region hash at version 4, and the corrections) and its exit evidence before
the Threshold log; the before/after set of the retune joins assets/sp3b.
README and CLAUDE.md say SP3b is complete and SP3c is next.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

- [ ] **Step 9: Hand off to the user (do not push on your own)**

Report that the branch is ready. With the user's go-ahead, merge to `main` and push; CI must be green (with the region-cache step). Then the user checks `?selftest=1` in Firefox (52/52) and sends the JSON, which goes into `docs/superpowers/specs/assets/sp3b/selftest-firefox.json`; the user also looks at the Voxels mode on a mountain line in production. Add both to Exit evidence and set the SP3b spec Status to complete in that commit, as SP3a did.

**Dry-run notes** (dry-run commit `c615e6f` on `dry/sp3a`; 17 files changed, 165 insertions(+), 28 deletions(-)):

Commit `7c056c6` on `dry/sp3b` (worktree `P/dry`, parent Task 15; 17 files, 223 insertions, 45 deletions: the master, SP1, SP3a and SP3b specs, README, CLAUDE.md, `test/arch/masterSpec.test.ts`, and 10 PNGs in `assets/sp3b/retune/`). RED (the commit's `masterSpec.test.ts` over a `git archive` copy of Task 15): 2 of 7 fail: "§2.5 ColumnView names every method of world/store/api.ts" (the master's ColumnView lacks `auxB`) and "§3.6 default expression states the schema defaults…" (no `u = noise2('jag') / clampSigma (λ …, … oct)` line); `tsc -p tsconfig.test.json` clean. GREEN: typecheck clean; `npm test` 135 files passed, 2 skipped; 1797 tests passed, 4 skipped (49.6 s); `GOVERNANCE_BASE=main` governance + masterSpec + thresholds 11/11. No threshold, golden, schema or baseline change, so no Threshold-log line.

- EVIDENCE RUNS (on Task 15, docs-only diff after; machine otherwise idle): `npm run build` green (typecheck + vite 0.2 s); `npm test` 135/1793 (48.5 s); `npm run test:metrics` 8 files, 23 passed, 1 skipped (T3 recorded on quick), 57 s, RSS 0.84 GB; `npm run test:metrics:full` 8 files, 24 passed, 148 s, RSS 1.08 GB (DT1 2 / 8 first cache hits from earlier dumps); integration project alone 4 files, 7 tests, 16 s; `npm run bench` PASS on a quiet machine (load 1.66 decaying from the metric runs, top 99 % idle), 30 s: worst ratio to the Task-14 baseline perm512.random 1.024, killRatio 0.821, column.sample p50 0.342 / p99 0.475 ms, density.corner 185.5 ns (291.7), terrain.real 1,423,465 ns (2,238,201), p50 1.423 ms, p99 2.246 ms; Bun `52/52 match on Bun 1.4.2 (JavaScriptCore)` 6.3 s; uiSmoke `smoke: 77/77 checks pass` 45 s, `✓ all 52 goldens match (5.9 s)`, Voxels "ground top y 22 to 248 · water on 14.5 % of the line, up to 41 deep", mountain "ground top y 140 to 257 · no water", Chrome 155.0.8059.39 (its profile dir was empty after the run and removed by me). Every metric value equals Tasks 12-15's (table in the spec's Exit evidence). `git diff main -- test/goldens.json` = Task 12's list exactly (generatorVersion, sp1.params, 16 sp2a keys, 2 sp3a.region.T keys, 2 added sp3b.density keys; sp3a.registry unchanged); 52 entries.
- Ruling (the failing-first test): two arch checks in `masterSpec.test.ts`, both tied to code so they stay meaningful: (1) for `ColumnWriter`, `ColumnView` and `NeighborhoodReader`, the master §2.5 interface's method names (comments stripped) equal those of `src/world/store/api.ts`; (2) the master §3.6 default-expression lines state the schema defaults: jag λ/octaves, overhang λ, λy = λ / yScale, octaves, persistence, detail λ/octaves and `detailAmpLo`-`detailAmpHi`. A future retune of the density noises therefore has to amend the master in the same change. A negative text check on §3.7 ("bumps the `surfaceEst` stage version") was not added: it ties to no code. Cost if wrong: none.
- Ruling (what was amended in the master, beyond what Task 1/13 did): §1 (density context/probe, sp3bGoldens, densityFuzz, terrain.metric, the slice split; beardifier.ts "arrives with SP9"), §2.3 aux B index orders (from SP3b §4; §14 did not list it), §2.5 ColumnView `auxB(): AuxBView | null` plus two comment lines on SP3b's Expr subset/field names and its compileDensity closures (the master's `Expr`/`CompiledDensity` sketches differ from the built ones; rewriting them was not asked), §3.6 the J/N3 figures in the formula block and an "As built by SP3b" bullet block, §3.7 (surfaceEst3 beside the 2D estimate, no stage bump, 3 bisections not 4, caching with its first consumer), §6.1 region cache format 2 and the CI cache, §6.2 `tiers`, §6.4 N5/T5/B2/DT2/U2 (T3 was Task 13's), §7 a "Measured in SP3b" bullet, §10 SP2a's "(SP3b replaces it)" (Task 1's defect) and SP2b's hand-over (minor 6 → SP3c). Cost if wrong: wording only.
- Ruling (spec status): the SP3b spec's Status stays "Approved … Revised by the implementation-plan dry run (2026-10-07, §16)", as SP3a's docs commit did (`08e6dac`); README and CLAUDE.md say "SP3b complete (2026-10-07, GENERATOR_VERSION 4). SP3c is next." as instructed. The Exit evidence says Firefox `?selftest=1`, CI and the user's approval of the visual review come after the merge. The executor writes its own date. Cost if wrong: wording only.
- Ruling (§16 added): the controller's Integration ruling sent the Task 6 defects to "the spec's dry-run revision (§16)"; it now lists the retune, T3, sampling, diagnostics, aux B in the hash at v4, the corrections (§3.2 floor term, §3.3 N5 1.58, U2 class columns, sp1.params, SP9 for structures, §8.3 T2 knob, §14 additions) and the unchanged measurements. The texts were also fixed in place: §3.2, §3.3 (overhang row, departures, N5 figure, U2), §5 and §13 (SP4-SP9), §8.3, §8.4 item 5 (done), §9, §11, §14, Non-goals. §15 stays as the historical record of the review. Cost if wrong: wording only.
- Ruling (retune evidence committed): §11's visual review names "the before/after set of any retune", so `P/shots/task-12/{before,after}-*.png` (10 PNGs, 47 KB; rendered by `task-12-zshots.metric.ts.draft`, and Task 12's commit showed the committed defaults reproduce `after-mountain.png` byte for byte) are committed as `docs/superpowers/specs/assets/sp3b/retune/`. No script regenerates them; the executor copies them from the plan (they are deterministic). Cost if wrong: 47 KB of evidence images without a generator.
- MEASUREMENT (§8.4 item 4, the ocean-floor σ/jag stripe, not checked by any earlier task): throwaway `P/shots/task-16/zzStripe.test.ts.draft` (deleted from the worktree). Seed '42', the first three 16 × 16-column windows in cz −1024 … −1009 whose 8 × 8 sample points are all ocean (offset < 40) with ≥ 3 channel points (σ < 1): cx −800, −704, −688. Mean |Δfloor| between x-neighbours (OCEAN_FLOOR_WG − 1): inside the σ < 1 band 0.295 / 0.341 / 0.286 (4,586 / 15,750 / 11,260 pairs), outside (σ ≥ 2) 0.360 / 0.363 / 0.371; floors 10 … 43. The floor height maps (`P/shots/task-16/stripe-{0,1,2}.png`, σ < 1 tinted blue) show no stripe along the channel lines: the floor's relief comes from offset and the detail noise, not σ. No T4 knob changed. Cost if wrong: a faint stripe the user may still see in-game (SP4).
- Spec defect: SP3b Non-goals "structures and the beard term (SP7)", §5 and §13 "SP4-SP7" → master §10 puts structures in SP9: "(SP9)", "SP4-SP9" (fixed in the commit).
- Spec defect: §8.3 "T1, T2 | offset knots (the lowland band), σ knots" → the approved retune also needed the overhang noise for T2 (Task 12's measurement); the knob list now names it (fixed in the commit).
- Problems: none. Every run passed first time; nothing I started is left running (uiSmoke stopped its own preview and Chrome).

---

# SP3a — Block registry, voxel store and region harness: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the block registry and the voxel encoding, build the shared voxel store, and generate real voxel columns from a provisional terrain stage. Make those columns visible and verifiable: a region harness with DT1, the `sp3a.*` goldens, and a Voxels mode in `?map`'s cross-section.

**Architecture:**
- **Blocks.** `world/blocks` builds a frozen registry from definitions: u16 state ids, per-state tables and canonical keys. It also holds the fluid and light bytes. An append-only state-id lock guards the ids from now on.
- **Store.** `world/store` keeps sections in two slab pools, each one growable buffer (a `SharedArrayBuffer` or a resizable `ArrayBuffer`) with a lock, a free stack and refcounts. Columns live in a 64 × 64 torus of column records, with uniform/dense section descriptors, aux slots and epoch cells. Generation stages write through `ColumnWriter` and read through `ColumnView` and `NeighborhoodReader`.
- **Terrain and tools.**
  - A provisional T stage fills each column from SP2a's ColumnSample.
  - `metrics/region.ts` generates regions and hashes them.
  - The test harness runs the generation on 1 or 4 `worker_threads`, with a region cache and PNG slices.
  - A worker slice job feeds the Voxels mode.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`, `node:zlib`), Bun 1 for the JavaScriptCore golden check, headless Chrome over CDP for the browser tools. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md`, revised by this plan's dry run (spec §13). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`.

**Dry run.** Every task below was executed before this plan was written, as one commit per task on a scratch branch (`dry/sp3a`). Tasks 2-4 and 5-8 were built as two parallel chains and then joined in plan order without conflicts. The code blocks and diffs are copied from those commits, and every `Expected:` line is what the replay printed. The replay applied each task's tests over its parent commit (they fail), then ran the commit (they pass), then the whole suite. The results:
- **Tests and metrics:** `npm test` passes 1,575 tests (121 files). The quick and full metric tiers are green with DT1 = 0 and M1 = 0.
- **Determinism:** the 3 new goldens are recorded and no existing golden changes. All 50 goldens match in V8 (`?selftest=1` in Chrome) and in Bun (JavaScriptCore).
- **Slab fuzz:** 4 threads × 100k operations; 0 double allocations, 0 lost slots, exact refcounts.
- **DT1 full tier:** 132 s cold.
- **UI smoke test:** 77/77.
- **Bench:** within +30 % on a quiet machine; `terrain.provisional` 0.66 ms.

The task notes give the details.

## Global Constraints

- **Language and tooling:**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or constructor parameter properties), `verbatimModuleSyntax`; ES2022 modules.
  - The tsconfig `lib` moves to ES2024 in Task 5 (the target is unchanged).
  - **No new runtime or dev dependencies.**
- **Determinism rules.** They apply to `gen/**`, `core/**`, `world/blocks/**` (from Task 3) and the `DET_FILES`: `metrics/sp1Goldens.ts`, `sp1Fixtures.ts`, `sp2aGoldens.ts`, `biomeShares.ts`, `liveness.ts`, `splineStats.ts`, `crossSection.ts`, plus SP3a's `metrics/region.ts` (Task 9) and `metrics/sp3aGoldens.ts` (Task 10).
  - Only the Math allowlist: no `Math.fround`, no `**`, no `Math.pow`; transcendentals go through `core/detMath`.
  - No `Intl`, `localeCompare`, `toLocale*`, `normalize`, `TextEncoder` or `TextDecoder`.
  - No `Math.random`, `Date.now`, `performance.now` or `console`.
- **Import aliasing.** In `gen/**`, `core/noise/**`, `core/spline/**`, `metrics/**` and `world/blocks/**`, imported values are used only through top-level `const X = binding;` aliases. Types come in through `import type`. Namespace imports are not used.
- **No numeric exports from gen.** `gen/**` exports no numeric constants and no numeric data. (`world/` may export them.)
- **Layer imports** (`test/arch/rules/imports.ts`):
  - `world` imports only core and world;
  - `gen` may value-import `world/blocks/**` and only type-import `world/store/api.ts`;
  - `engine` value-imports core, world, engine and `workers/protocol.ts`;
  - `metrics` may import core, gen and world;
  - `ui` may import everything except `*.worker.ts`;
  - only `engine/` spawns workers (tests and the harness may use `worker_threads`);
  - `src/` never imports `test/**`.
- **Coordinates.** colKeys are numeric only. The world window is half-open, `[−2^19, 2^19)`. North is −z, east is +x.
- **Goldens.** No existing golden changes and `GENERATOR_VERSION` stays 3. The three `sp3a.*` keys are added with `npm run test:goldens` in Task 10 only; check that `git diff test/goldens.json` adds only those keys.
- **Governance.**
  - Every commit that changes `test/thresholds.lock.json` also appends one line to the SP3a spec's `## Threshold log` (CI checks this per push).
  - `test/stateIds.lock.json` changes only through `npm run test:accept-state-ids`, and the commit message says so.
- **TDD.** Write the test, run it and see it fail for the stated reason, implement, run it and see it pass. `npm run typecheck && npm test` must be green before every commit.
- UI copy is English.
- **Processes.** Never kill, signal or touch processes you did not start. The browser tools start their own `vite preview` on a free port (never 5183) and their own headless Chrome, with a short `--profile-dir $(mktemp -d /tmp/wi10-XXXX)`, and stop only what they started.
- **Bench.** The bench needs a quiet machine: nothing else may load the CPU while `npm run bench` or `npm run bench:record` runs (spec §7).
- **Outward-facing actions.** Pushes and merges happen only with the user's go-ahead.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc`.
- **Staging.** `git add` takes explicit paths only.

## Review Focus

1. **A slice superseded mid-flight.** While a Voxels slice is being computed the person edits a parameter (a new session epoch) or draws a new line; the superseded job may still settle (succeed or fail) after its successor, or before it. A reasonable person expects only the slice of the current line and the latest requested draft to be drawn: a late result of an older epoch or line never replaces the newer one, a late failure of a superseded job is not reported, and the newer request stays pending until it settles.
   Test: Task 14 "a slice superseded by a param edit or a new line is never shown, even when it settles after its successor"
2. **Region-cache dumps of earlier code.** Every edit under `src/core`, `src/world`, `src/gen` or `src/metrics/region.ts` changes `srcKey`, so every `npm test` (DT1 fast) and `npm run test:metrics` after an edit writes new dumps (≈ 3 MB per edit for the fast tier, ≈ 50-200 MB for quick and full) while the old ones can never hit again. A person iterating on SP3b expects the cache not to grow without bound: writing a dump deletes the dumps of other srcKeys (and `.bin` files that are not dumps of this format) once they are 15 minutes old, keeps every dump of the current code, keeps recent dumps of other code (a concurrent run), and touches no other file.
   Test: Task 11 "writing a dump deletes the dumps of other srcKeys untouched for REGION_CACHE_PRUNE_MS; this srcKey's and recent ones stay"
3. **A damaged dump of the right length.** A cached region dump whose header and layout still parse but whose payload changed (a dense slot overwritten with one value, a flipped bit in a slot or in the aux bytes, an extra trailing byte). A person expects a miss that regenerates and rewrites the dump: never a crash in the rebuild, never a silently wrong region served as a hit (which DT1 would then report as a determinism failure).
   Tests: Task 11 "a dense slot overwritten with one value (same length) is a miss and the file is rewritten", "one flipped bit in a dense slot (same length) is a miss and the file is rewritten", "one flipped bit in the last column's aux bytes (same length) is a miss and the file is rewritten", "a trailing byte appended is a miss and the file is rewritten", "the header: magic, format, genKey, srcKey, cx0, cz0, w, h, upTo; then the first record"
4. **Cut lines at the world window's edges.** A Voxels line that starts on the window's first block (−524288, −524288), i.e. column (−32768, −32768), on its last block (524287, 524287), i.e. column (32767, 32767), heading towards negative x and z, or that runs along the window's last row z = 524287. A person expects the slice to show exactly the voxels (⌊xᵢ⌋, y, ⌊zᵢ⌋) there, as anywhere else: negative coordinates floor and shift correctly, the colKeys and torus records at the extremes do not collide, and nothing is refused or shifted by a block.
   Tests: Task 13 "from the window's negative corner (−524288, −524288), column (−32768, −32768): sample (i, y) is the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋) of a region generated in process, byte for byte", "from the window's last block (524287, 524287), column (32767, 32767), towards negative x and z: sample (i, y) is the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋) of a region generated in process, byte for byte", "along the window's last row z = 524287 from its first block x = −524288: sample (i, y) is the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋) of a region generated in process, byte for byte"
5. **The store full in the middle of a column.** `fillColumnT` runs out of slots part-way through a column: the block pool during a dense `setProto`, or the byte pool during a fluid section or the aux A allocation after the sections. A person expects `StoreFull` to surface to the caller, the half-written column to be freed (its record free, no slot leaked: the live slots are exactly the committed columns' dense entries and aux slots), the committed columns intact, and the store usable again once columns are freed (the failed column then fills and equals a fresh fill).
   Tests: Task 9 "the block pool full in the middle of a column: StoreFull surfaces, the column is freed, no slot leaks", "the byte pool full in the middle of a column: StoreFull surfaces, the column is freed, no slot leaks"

## Branch

Create `sp3a/blocks-store-harness` from `main` before Task 1: `git switch -c sp3a/blocks-store-harness`.

## How to apply the code blocks

- **New files:** create them with exactly the content shown.
- **Modified files:** each diff is `git diff` output. Apply it from the repository root with `git apply` (or `git apply --3way`), in task order; every diff applies on top of all earlier tasks.
- **Generated files** come from the commands shown:
  - `test/thresholds.lock.json`, `test/stateIds.lock.json` and `test/goldens.json` are shown as the dry run's output, and yours must match;
  - `test/baselines.json` and the PNG assets are produced on your machine.
- **Expected outputs** come from the dry-run replay on the reference machine (i7-12700H, 20 threads, Node 24.21, Chrome 153). Timings vary; counts must match, except where a task's notes say otherwise.
- **Order inside a task:** the failing tests first (Step 1), watched failing (Step 2), then the implementation. The test-support code under `test/harness/`, `test/arch/rules/`, `test/bench/` and `test/tools/` is part of the implementation step, because the tests fail without it.
- **Dry-run notes** under each task record the rulings the dry run made, and the executor follows them. "Task N" in a note means that task's dry-run commit.

---

### Task 1: Governance: SP3a/SP3b/SP3c

**Spec:** §9, §11 (§2.5 ids)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md`
- Modify: `src/core/ids.ts`
- Modify: `src/core/params/profiles.ts`
- Modify: `test/arch/sp.test.ts`
- Modify: `test/harness/sp.ts`
- Modify: `test/thresholds.lock.json`
- Modify: `test/unit/lock.test.ts`
- Modify: `test/unit/presetFile.test.ts`
- Modify: `test/unit/profiles.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/core/ids.ts`:
    - `export const CURRENT_SP: SubProjectId = 'SP3a';`
  - `test/harness/sp.ts`:
    - `export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'];`
    - `export function currentSpOf(started: readonly SubProjectId[], order: readonly SubProjectId[] = SP_ORDER): SubProjectId | null`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/sp.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/sp.test.ts b/test/arch/sp.test.ts
index 4c2d38b..927abcd 100644
--- a/test/arch/sp.test.ts
+++ b/test/arch/sp.test.ts
@@ -1,6 +1,6 @@
 import { describe, expect, test } from 'vitest';
 import { CURRENT_SP, SUB_PROJECTS } from '../../src/core/ids';
-import { SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';
+import { currentSpOf, SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';
 
 describe('started sub-projects', () => {
   test('the committed list is valid', () => {
@@ -11,14 +11,29 @@ describe('started sub-projects', () => {
     expect(STARTED_SPS).toContain(CURRENT_SP);
   });
 
-  test('SP_DEPS covers all 16 sub-projects and SP_ORDER follows it', () => {
+  test('CURRENT_SP follows the SP3a §9 rule: the last SP of the longest fully started prefix', () => {
+    expect(CURRENT_SP).toBe(currentSpOf(STARTED_SPS));
+  });
+
+  test('currentSpOf stops at the first unstarted SP (SP4 alongside SP3c)', () => {
+    const upTo3b = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b'] as const;
+    expect(currentSpOf([])).toBeNull();
+    expect(currentSpOf(['SP0', 'SP1'])).toBe('SP1');
+    expect(currentSpOf([...upTo3b, 'SP4'])).toBe('SP3b');
+    expect(currentSpOf([...upTo3b, 'SP4', 'SP3c'])).toBe('SP4');
+  });
+
+  test('SP_DEPS covers all 18 sub-projects and SP_ORDER follows it', () => {
     expect(SP_ORDER).toEqual([
-      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
+      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP4', 'SP5', 'SP6', 'SP7',
       'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
     ]);
     for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
     expect(SP_ORDER).toEqual([...SUB_PROJECTS]);
-    expect([SP_DEPS.SP2a, SP_DEPS.SP2b, SP_DEPS.SP3]).toEqual([['SP1'], ['SP2a'], ['SP2b']]);
+    expect([SP_DEPS.SP2a, SP_DEPS.SP2b]).toEqual([['SP1'], ['SP2a']]);
+    expect([SP_DEPS.SP3a, SP_DEPS.SP3b, SP_DEPS.SP3c, SP_DEPS.SP4, SP_DEPS.SP6]).toEqual([
+      ['SP2b'], ['SP3a'], ['SP3b'], ['SP3b'], ['SP3b', 'SP5'],
+    ]);
   });
 
   test('duplicates and unknown ids are rejected', () => {
@@ -32,12 +47,19 @@ describe('started sub-projects', () => {
   });
 
   test('parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started', () => {
-    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
+    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
     expect(validateStarted(path)).toEqual([]);
   });
 
   test('parallel SPs: SP8c without SP7 is rejected', () => {
-    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP8c'];
+    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP4', 'SP5', 'SP8c'];
     expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
   });
+
+  test('parallel SPs: SP3c may start after SP4; SP4 needs SP3b, SP3c needs SP3b', () => {
+    const upTo3a = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'];
+    expect(validateStarted([...upTo3a, 'SP3b', 'SP4', 'SP3c'])).toEqual([]);
+    expect(validateStarted([...upTo3a, 'SP4'])).toEqual(['SP4 started before its dependency SP3b']);
+    expect(validateStarted([...upTo3a, 'SP3c'])).toEqual(['SP3c started before its dependency SP3b']);
+  });
 });
```

Modify `test/unit/lock.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/lock.test.ts b/test/unit/lock.test.ts
index acea4c9..94517f7 100644
--- a/test/unit/lock.test.ts
+++ b/test/unit/lock.test.ts
@@ -2,8 +2,8 @@ import { describe, expect, test } from 'vitest';
 import { canonicalJson, diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState } from '../harness/lock';
 
 const base: GovernanceState = {
-  thresholds: { T1: { band: { max: 0.25, activeFrom: 'SP3' }, span: { min: 60, activeFrom: 'SP3' } } },
-  startedSps: ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3'],
+  thresholds: { T1: { band: { max: 0.25, activeFrom: 'SP3a' }, span: { min: 60, activeFrom: 'SP3a' } } },
+  startedSps: ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'],
 };
 
 describe('canonical JSON and lock', () => {
@@ -41,7 +41,7 @@ describe('diffGovernance', () => {
       { path: 'T1.span', detail: 'min 60→50', kind: 'LOOSEN' },
     );
     expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.span!.activeFrom = 'SP6'; }))[0]).toEqual(
-      { path: 'T1.span', detail: 'activeFrom SP3→SP6', kind: 'LOOSEN' },
+      { path: 'T1.span', detail: 'activeFrom SP3a→SP6', kind: 'LOOSEN' },
     );
   });
 
@@ -56,7 +56,7 @@ describe('diffGovernance', () => {
 
   test('removing a started SP loosens; adding one tightens', () => {
     expect(diffGovernance(base, edit((s) => { s.startedSps = ['SP0', 'SP1', 'SP2a', 'SP2b']; }))).toEqual([
-      { path: 'startedSps', detail: 'removed SP3', kind: 'LOOSEN' },
+      { path: 'startedSps', detail: 'removed SP3a', kind: 'LOOSEN' },
     ]);
     expect(diffGovernance(base, edit((s) => { s.startedSps = [...s.startedSps, 'SP4']; }))).toEqual([
       { path: 'startedSps', detail: 'added SP4', kind: 'TIGHTEN' },
```

Modify `test/unit/presetFile.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/presetFile.test.ts b/test/unit/presetFile.test.ts
index 0be7536..4d12c14 100644
--- a/test/unit/presetFile.test.ts
+++ b/test/unit/presetFile.test.ts
@@ -144,7 +144,7 @@ describe('readPresetText', () => {
     ['reserved name', doc({ name: 'default' }), ['name: RESERVED_NAME — "default" is a built-in profile name']],
     ['unknown profile', doc({ profile: 'nope' }), ['profile: UNKNOWN_PROFILE — unknown profile "nope"']],
     ['newer schema version', doc({ schemaVersion: 2 }), ['schemaVersion: NEWER_SCHEMA_VERSION — schemaVersion 2 is newer than this build (1)']],
-    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3']],
+    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3c']],
     ['a profile that is not ready, with invalid params: import issues first', doc({ profile: 'archipelago', params: { climate: { scaleMull: 4 } } }), [
       'params.climate.scaleMull: UNKNOWN_KEY — unknown key "scaleMull"',
     ]],
@@ -250,7 +250,7 @@ describe('presets tab logic', () => {
     ['not JSON', '{"format":', [/^file is not JSON: ./]],
     ['an invalid parameter', doc({ params: { rivers: { widthMin: 999 } } }), ['params.rivers.widthMin: OUT_OF_RANGE — 999 outside [1, 64]']],
     ['an unknown key', doc({ extra: true }), ['extra: UNKNOWN_KEY — unknown key "extra"']],
-    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3']],
+    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3c']],
   ])('a refused file (%s) lists its issues and leaves the session alone', (_name, text, issues) => {
     const s = edited();
     const state = s.state;
```

Modify `test/unit/profiles.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/profiles.test.ts b/test/unit/profiles.test.ts
index 14b7c3d..98915d9 100644
--- a/test/unit/profiles.test.ts
+++ b/test/unit/profiles.test.ts
@@ -16,16 +16,17 @@ describe('profiles', () => {
   test('ids, readiness and overlays', () => {
     expect(Object.keys(PROFILES)).toEqual([...PROFILE_IDS]);
     expect(PROFILE_IDS.map((id) => [id, PROFILES[id].readyFrom])).toEqual([
-      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3'], ['amplified', 'SP3'], ['floating_islands', 'SP3'], ['cave_heavy', 'SP6'],
+      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3c'], ['amplified', 'SP3c'], ['floating_islands', 'SP3c'], ['cave_heavy', 'SP6'],
     ]);
     expect(resolveProfile('large_biomes').climate.scaleMul).toBe(4);
     expect(resolveProfile('archipelago').climate.C.wavelength).toBe(840);
     expect(resolveProfile('default')).toBe(DEFAULTS);
   });
   test('readiness follows CURRENT_SP', () => {
-    expect(CURRENT_SP).toBe('SP2b');
+    expect(CURRENT_SP).toBe('SP3a');
     expect(PROFILE_IDS.filter((id) => isProfileReady(id))).toEqual(['default', 'large_biomes']);
-    expect(isProfileReady('archipelago', 'SP3')).toBe(true);
+    expect(isProfileReady('archipelago', 'SP3c')).toBe(true);
+    expect(isProfileReady('archipelago', 'SP3b')).toBe(false);
     expect(isProfileReady('large_biomes', 'SP1')).toBe(false);
   });
   test('switching profile dirties exactly what its overlay touches', () => {
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/sp.test.ts test/unit/lock.test.ts test/unit/presetFile.test.ts test/unit/profiles.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× CURRENT_SP follows the SP3a §9 rule: the last SP of the longest fully started prefix 2ms
× currentSpOf stops at the first unstarted SP (SP4 alongside SP3c) 1ms
× SP_DEPS covers all 18 sub-projects and SP_ORDER follows it 3ms
× parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started 1ms
× parallel SPs: SP8c without SP7 is rejected 1ms
× parallel SPs: SP3c may start after SP4; SP4 needs SP3b, SP3c needs SP3b 0ms
× ids, readiness and overlays 6ms
× readiness follows CURRENT_SP 1ms
× a profile that is not ready 5ms
× a refused file (a profile that is not ready) lists its issues and leaves the session alone 3ms
FAIL  |unit| test/unit/presetFile.test.ts > readPresetText > a profile that is not ready
AssertionError: expected { ok: false, …(1) } to deeply equal { ok: false, …(1) }
FAIL  |unit| test/unit/presetFile.test.ts > presets tab logic > a refused file (a profile that is not ready) lists its issues and leaves the session alone
AssertionError: expected 'profile archipelago arrives in SP3' to match 'profile archipelago arrives in SP3c'
… (14 more lines)
Test Files  3 failed | 1 passed (4)
Tests  10 failed | 83 passed (93)
```

- [ ] **Step 3: Implement**

Modify `CLAUDE.md` (apply with `git apply`):

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index 3fbd70e..c783077 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -6,7 +6,7 @@ This file provides guidance to Claude Code (claude.ai/code) when working with co
 
 Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.
 
-**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3). SP3 is next.
+**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3). SP3a (block registry, voxel store, region harness) in progress.
 
 ## Source of truth
 
```

Modify `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
index 33f0c5a..c7af50e 100644
--- a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
+++ b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
@@ -374,3 +374,5 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
 ## Threshold log
 
 (One line per commit that changes `test/thresholds.lock.json`.)
+
+- Task 1: `STARTED_SPS` gains `SP3a` (SP3 split into SP3a, SP3b and SP3c); no threshold rows change.
```

Modify `src/core/ids.ts` (apply with `git apply`):

```diff
diff --git a/src/core/ids.ts b/src/core/ids.ts
index 3d49f92..e11990b 100644
--- a/src/core/ids.ts
+++ b/src/core/ids.ts
@@ -1,15 +1,20 @@
-/** Sub-project ids of master spec §10 (SP2 split into SP2a and SP2b on 2026-09-28). */
+/** Sub-project ids of master spec §10 (SP2 split into SP2a and SP2b on 2026-09-28; SP3 into SP3a, SP3b and SP3c on 2026-10-02). */
 export type SubProjectId =
-  | 'SP0' | 'SP1' | 'SP2a' | 'SP2b' | 'SP3' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
+  | 'SP0' | 'SP1' | 'SP2a' | 'SP2b' | 'SP3a' | 'SP3b' | 'SP3c' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
   | 'SP8a' | 'SP8b' | 'SP8c' | 'SP9' | 'SP10' | 'SP11' | 'SP12';
 
 /** Every sub-project in master §10 order. */
 export const SUB_PROJECTS: readonly SubProjectId[] = [
-  'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7', 'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
+  'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a', 'SP3b', 'SP3c', 'SP4', 'SP5', 'SP6', 'SP7',
+  'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
 ];
 
-/** The sub-project this build belongs to; hides profiles whose readyFrom comes later (SP2a spec §4.4). */
-export const CURRENT_SP: SubProjectId = 'SP2b';
+/**
+ * The sub-project this build belongs to; hides profiles whose readyFrom comes later (SP2a spec §4.4).
+ * It is the last SP of the longest prefix of SUB_PROJECTS whose members have all started (SP3a spec §9),
+ * so an SP running alongside an earlier unstarted one (SP4 before SP3c) does not advance it.
+ */
+export const CURRENT_SP: SubProjectId = 'SP3a';
 
 /** Every metric id of master spec §6.4 (E1-E6 expanded). */
 export type MetricId =
```

Modify `src/core/params/profiles.ts` (apply with `git apply`):

```diff
diff --git a/src/core/params/profiles.ts b/src/core/params/profiles.ts
index 3e78dfc..30d3506 100644
--- a/src/core/params/profiles.ts
+++ b/src/core/params/profiles.ts
@@ -17,9 +17,9 @@ export const PROFILE_IDS: readonly ProfileId[] = ['default', 'large_biomes', 'ar
 export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
   default: { overlay: {}, readyFrom: 'SP1' },
   large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2a' },
-  archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3' },
-  amplified: { overlay: {}, readyFrom: 'SP3' },
-  floating_islands: { overlay: {}, readyFrom: 'SP3' },
+  archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3c' },
+  amplified: { overlay: {}, readyFrom: 'SP3c' },
+  floating_islands: { overlay: {}, readyFrom: 'SP3c' },
   cave_heavy: { overlay: {}, readyFrom: 'SP6' },
 };
 
```

Modify `test/harness/sp.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/sp.ts b/test/harness/sp.ts
index 347176b..7897de9 100644
--- a/test/harness/sp.ts
+++ b/test/harness/sp.ts
@@ -6,10 +6,12 @@ export const SP_DEPS: Readonly<Record<SubProjectId, readonly SubProjectId[]>> =
   SP1: ['SP0'],
   SP2a: ['SP1'],
   SP2b: ['SP2a'],
-  SP3: ['SP2b'],
-  SP4: ['SP3'],
+  SP3a: ['SP2b'],
+  SP3b: ['SP3a'],
+  SP3c: ['SP3b'],
+  SP4: ['SP3b'],
   SP5: ['SP4'],
-  SP6: ['SP3', 'SP5'],
+  SP6: ['SP3b', 'SP5'],
   SP7: ['SP6', 'SP5'],
   SP8a: ['SP4'],
   SP8b: ['SP7', 'SP8a'],
@@ -26,12 +28,26 @@ export const SP_ORDER = Object.keys(SP_DEPS) as SubProjectId[];
  * Append-only list of sub-projects whose first commit has landed.
  * Each SP appends its id in its first commit. Part of the locked governance state.
  */
-export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b'];
+export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'];
 
 export function spIndex(sp: SubProjectId): number {
   return SP_ORDER.indexOf(sp);
 }
 
+/**
+ * The SP3a spec §9 rule for `CURRENT_SP`: the last SP of the longest prefix of `order` whose members
+ * have all started (null when the first has not). An SP running alongside an earlier unstarted one
+ * (SP4 before SP3c) therefore does not advance it.
+ */
+export function currentSpOf(started: readonly SubProjectId[], order: readonly SubProjectId[] = SP_ORDER): SubProjectId | null {
+  let last: SubProjectId | null = null;
+  for (const sp of order) {
+    if (!started.includes(sp)) break;
+    last = sp;
+  }
+  return last;
+}
+
 export function validateStarted(
   started: readonly string[],
   deps: Readonly<Record<SubProjectId, readonly SubProjectId[]>> = SP_DEPS,
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:accept-thresholds`

The command writes `test/thresholds.lock.json`; the dry run's result:

Modify `test/thresholds.lock.json` (apply with `git apply`):

```diff
diff --git a/test/thresholds.lock.json b/test/thresholds.lock.json
index 31cb743..7538650 100644
--- a/test/thresholds.lock.json
+++ b/test/thresholds.lock.json
@@ -1,11 +1,12 @@
 {
-  "sha256": "e53be667238ae3d7b4f0c4f3dc27a09686e304b0c52084b85ec5f39b4b2b18d2",
+  "sha256": "c65639a9c6f45a5e27df2f85ed6a3ec5450b860e439a0c641569e8d96beff608",
   "canonical": {
     "startedSps": [
       "SP0",
       "SP1",
       "SP2a",
-      "SP2b"
+      "SP2b",
+      "SP3a"
     ],
     "thresholds": {
       "B1": {
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/sp.test.ts test/unit/lock.test.ts test/unit/presetFile.test.ts test/unit/profiles.test.ts`

Expected: PASS (exit 0)

```
Test Files  4 passed (4)
Tests  93 passed (93)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  93 passed | 2 skipped (95)
Tests  1185 passed | 2 skipped (1187)
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md src/core/ids.ts src/core/params/profiles.ts test/arch/sp.test.ts test/harness/sp.ts test/thresholds.lock.json test/unit/lock.test.ts test/unit/presetFile.test.ts test/unit/profiles.test.ts
git commit -F - <<'EOF'
chore(governance): start SP3a; SP3 split into SP3a/SP3b/SP3c

- SubProjectId, SUB_PROJECTS and SP_DEPS replace 'SP3' with 'SP3a', 'SP3b',
  'SP3c' (SP3a <- SP2b, SP3b <- SP3a, SP3c <- SP3b, SP4 <- SP3b,
  SP6 <- SP3b, SP5), SP3a spec §9.
- STARTED_SPS gains 'SP3a'; CURRENT_SP = 'SP3a'; an arch test checks
  CURRENT_SP against the §9 rule (last SP of the longest fully started
  prefix of SUB_PROJECTS), via currentSpOf in test/harness/sp.ts.
- archipelago, amplified and floating_islands move to readyFrom 'SP3c'.
- Thresholds lock accepted (startedSps only); Threshold-log line in the
  SP3a spec; CLAUDE.md status.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `af4fdaf` on `dry/sp3a`; 10 files changed, 77 insertions(+), 30 deletions(-)):

RED replay (commit's `test/**` over the parent): 6 failed (sp.test ×2, profiles ×2, presetFile ×2); GREEN: typecheck clean, `npm test` 93 files / 1185 passed, 2 skipped (≈39 s); `GOVERNANCE_BASE=main` governance test passes.

- Ruling: the §9 CURRENT_SP rule is a test-side helper `currentSpOf(started, order = SP_ORDER): SubProjectId | null` in `test/harness/sp.ts`, and the arch test asserts `CURRENT_SP === currentSpOf(STARTED_SPS)`, plus examples (SP4 before SP3c → 'SP3b'; with SP3c → 'SP4'; [] → null) — STARTED_SPS lives in the test harness and `src` never imports `test/`, so the rule cannot be computed in `src`; `CURRENT_SP` stays a literal — cost if wrong: none (move the helper).
- Ruling: `test/unit/lock.test.ts` fixture uses `activeFrom: 'SP3a'` (not 'SP3b') for its T1 parts and `startedSps` ending in 'SP3a' — `diffGovernance` treats removing a part as LOOSEN only when its `activeFrom` has started, so the fixture's activeFrom must be in its startedSps — cost if wrong: none (fixture only).
- Ruling: README's "SP3 (voxel store, density, surface rules) is next." is left for Task 16 (README/CLAUDE status), following the SP2b precedent `240c2d4` where the governance-start commit touched only CLAUDE.md — cost if wrong: README status is stale between Task 1 and Task 16.
- Ruling: Threshold-log line: "Task 1: `STARTED_SPS` gains `SP3a` (SP3 split into SP3a, SP3b and SP3c); no threshold rows change." — mirrors the SP2b Task 1 line — cost if wrong: wording only.
- Ruling: the "SP_DEPS covers all 16 sub-projects" test title becomes 18; a new test checks the §9 dependencies (SP3a ← SP2b, SP3b ← SP3a, SP3c ← SP3b, SP4 ← SP3b, SP6 ← SP3b, SP5) and the SP3c-after-SP4 path — cost if wrong: none.
- No spec defects found for Task 1.

---

### Task 2: core: coordinates and streaming FNV

**Spec:** §1, §6.2 (streaming FNV)

**Files:**
- Create: `src/core/coords.ts`
- Modify: `src/core/hash.ts`
- Create: `test/unit/coords.test.ts`
- Create: `test/unit/fnvStream.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/core/coords.ts`:
    - `export const SECTIONS = 24;`
    - `export const SECTION_VOXELS = 4096;`
    - `export const MAX_Y = 319;`
    - `export const QUARTS_Y = 96;`
    - `export const TORUS_SIZE = 64;`
    - `export const TORUS_RECORDS = 4096;`
    - `export const WINDOW_HALF = 524288;`
    - `export const chunkCoord = (v: number): number => v >> 4;`
    - `export const localCoord = (v: number): number => v & 15;`
    - `export const sectionY = (y: number): number => (y - Y0) >> 4;`
    - `export const localY = (y: number): number => (y - Y0) & 15;`
    - `export const sectionBaseY = (sy: number): number => sy * 16 + Y0;`
    - `export const yInWorld = (y: number): boolean => y >= Y0 && y <= MAX_Y;`
    - `export const voxelIndex = (lx: number, ly: number, lz: number): number => (ly << 8) | (lz << 4) | lx;`
    - `export const voxelLx = (i: number): number => i & 15;`
    - `export const voxelLy = (i: number): number => i >> 8;`
    - `export const voxelLz = (i: number): number => (i >> 4) & 15;`
    - `export const columnIndex = (lx: number, lz: number): number => (lz << 4) | lx;`
    - `export const colKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);`
    - `export const colKeyCx = (key: number): number => Math.floor(key / 65536) - 32768;`
    - `export const colKeyCz = (key: number): number => (key % 65536) - 32768;`
    - `export const sectionKey = (cx: number, cz: number, sy: number): number => colKey(cx, cz) * 32 + sy;`
    - `export const sectionKeyColKey = (key: number): number => Math.floor(key / 32);`
    - `export const sectionKeySy = (key: number): number => key % 32;`
    - `export const torusSlot = (cx: number, cz: number): number => (cx & 63) + ((cz & 63) << 6);`
    - `export const quartCoord = (v: number): number => v >> 2;`
    - `export const quartY = (y: number): number => (y - Y0) >> 2;`
    - `export const inWindow = (x: number, z: number): boolean =>`
    - `export const columnInWindow = (cx: number, cz: number): boolean => cx >= -32768 && cx < 32768 && cz >= -32768 && cz < 32768;`
  - `src/core/hash.ts`:
    - `export interface Fnv64`
    - `export function createFnv64(): Fnv64`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/coords.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  colKey, colKeyCx, colKeyCz, columnIndex, columnInWindow, chunkCoord, inWindow, localCoord, localY, MAX_Y, quartCoord,
  quartY, QUARTS_Y, SECTION_VOXELS, sectionBaseY, sectionKey, sectionKeyColKey, sectionKeySy, sectionY, SECTIONS,
  TORUS_RECORDS, TORUS_SIZE, torusSlot, voxelIndex, voxelLx, voxelLy, voxelLz, WINDOW_HALF, yInWorld,
} from '../../src/core/coords';
import { HEIGHT, MIN_Y } from '../../src/core/constants';
import { testRng } from '../harness/stats';

/** A uniform integer in [lo, hi). */
function intIn(next: () => number, lo: number, hi: number): number {
  return lo + (next() % (hi - lo));
}

describe('constants (master §2.1)', () => {
  test('24 sections of 4096 voxels span y −64 … 319; 96 vertical quarts; a 64 × 64 torus', () => {
    expect(SECTIONS).toBe(24);
    expect(SECTION_VOXELS).toBe(4096);
    expect(MAX_Y).toBe(319);
    expect(MAX_Y - MIN_Y + 1).toBe(HEIGHT);
    expect(SECTIONS * 16).toBe(HEIGHT);
    expect(QUARTS_Y).toBe(96);
    expect(TORUS_SIZE).toBe(64);
    expect(TORUS_RECORDS).toBe(4096);
    expect(WINDOW_HALF).toBe(524288);
  });
});

describe('x/y/z ↔ cx/cz/sy/lx/ly/lz', () => {
  test('cx = x >> 4 and lx = x & 15 round-trip over the window, negatives included', () => {
    const next = testRng(101);
    for (let i = 0; i < 20000; i++) {
      const x = intIn(next, -WINDOW_HALF, WINDOW_HALF);
      const cx = chunkCoord(x), lx = localCoord(x);
      expect(lx).toBeGreaterThanOrEqual(0);
      expect(lx).toBeLessThan(16);
      expect(cx * 16 + lx).toBe(x);
    }
    expect([chunkCoord(-1), localCoord(-1)]).toEqual([-1, 15]);
    expect([chunkCoord(-16), localCoord(-16)]).toEqual([-1, 0]);
    expect([chunkCoord(-17), localCoord(-17)]).toEqual([-2, 15]);
    expect([chunkCoord(15), chunkCoord(16)]).toEqual([0, 1]);
  });

  test('sy = (y + 64) >> 4 and ly round-trip for every y; sectionBaseY is the section floor', () => {
    for (let y = MIN_Y; y <= MAX_Y; y++) {
      const sy = sectionY(y), ly = localY(y);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThan(SECTIONS);
      expect(ly).toBeGreaterThanOrEqual(0);
      expect(ly).toBeLessThan(16);
      expect(sectionBaseY(sy) + ly).toBe(y);
    }
    expect([sectionY(-64), sectionY(-49), sectionY(-48), sectionY(0), sectionY(319)]).toEqual([0, 0, 1, 4, 23]);
    expect(sectionBaseY(0)).toBe(-64);
    expect(sectionBaseY(23)).toBe(304);
  });

  test('yInWorld is the closed range [−64, 319]', () => {
    expect([yInWorld(-65), yInWorld(-64), yInWorld(319), yInWorld(320)]).toEqual([false, true, true, false]);
  });
});

describe('voxel and column indices', () => {
  test('voxelIndex = ly << 8 | lz << 4 | lx is a bijection onto 0 … 4095 and decodes back', () => {
    const seen = new Uint8Array(SECTION_VOXELS);
    for (let ly = 0; ly < 16; ly++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const i = voxelIndex(lx, ly, lz);
          expect(i).toBe(ly * 256 + lz * 16 + lx);
          expect([voxelLx(i), voxelLy(i), voxelLz(i)]).toEqual([lx, ly, lz]);
          seen[i]!++;
        }
      }
    }
    expect(seen.every((c) => c === 1)).toBe(true);
    expect(voxelIndex(15, 15, 15)).toBe(4095);
  });

  test('columnIndex = lz·16 + lx', () => {
    expect(columnIndex(0, 0)).toBe(0);
    expect(columnIndex(3, 0)).toBe(3);
    expect(columnIndex(0, 1)).toBe(16);
    expect(columnIndex(15, 15)).toBe(255);
  });
});

describe('colKey and sectionKey (numeric, < 2^32 and < 2^37)', () => {
  test('colKey = (cx + 32768)·65536 + (cz + 32768) at the window corners', () => {
    expect(colKey(-32768, -32768)).toBe(0);
    expect(colKey(32767, 32767)).toBe(4294967295);
    expect(colKey(0, 0)).toBe(32768 * 65536 + 32768);
    expect(colKey(-32768, 32767)).toBe(65535);
    expect(colKey(32767, -32768)).toBe(65535 * 65536);
  });

  test('colKey round-trips through colKeyCx/colKeyCz over the whole window', () => {
    const next = testRng(102);
    const edges = [-32768, -32767, -1, 0, 1, 32766, 32767];
    const pairs: Array<[number, number]> = [];
    for (const a of edges) for (const b of edges) pairs.push([a, b]);
    for (let i = 0; i < 20000; i++) pairs.push([intIn(next, -32768, 32768), intIn(next, -32768, 32768)]);
    for (const [cx, cz] of pairs) {
      const k = colKey(cx, cz);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(4294967296);
      expect([colKeyCx(k), colKeyCz(k)]).toEqual([cx, cz]);
    }
  });

  test('sectionKey = colKey·32 + sy round-trips, maximum included', () => {
    const next = testRng(103);
    for (let i = 0; i < 5000; i++) {
      const cx = intIn(next, -32768, 32768), cz = intIn(next, -32768, 32768), sy = intIn(next, 0, SECTIONS);
      const k = sectionKey(cx, cz, sy);
      expect(k).toBe(colKey(cx, cz) * 32 + sy);
      expect(sectionKeyColKey(k)).toBe(colKey(cx, cz));
      expect(sectionKeySy(k)).toBe(sy);
    }
    const top = sectionKey(32767, 32767, 23);
    expect(top).toBe(4294967295 * 32 + 23);
    expect(sectionKeyColKey(top)).toBe(4294967295);
    expect(sectionKeySy(top)).toBe(23);
  });
});

describe('torus slot', () => {
  test('(cx & 63) + 64·(cz & 63), with columns 64 apart on the same record', () => {
    expect(torusSlot(0, 0)).toBe(0);
    expect(torusSlot(63, 0)).toBe(63);
    expect(torusSlot(0, 1)).toBe(64);
    expect(torusSlot(-1, -1)).toBe(4095);
    expect(torusSlot(-32768, -32768)).toBe(0);
    expect(torusSlot(32767, 32767)).toBe(4095);
    expect(torusSlot(64, -64)).toBe(0);
    // The slice job's all-record-0 line: x 0 … 523264 is cx 0 … 32704, every 64th column on record 0.
    expect(torusSlot(chunkCoord(523264), 0)).toBe(0);
  });

  test('any 64 × 64 block of columns covers every record once', () => {
    for (const [cx0, cz0] of [[0, 0], [-32768, -32768], [-17, 5], [32704, 32704]] as const) {
      const seen = new Uint8Array(TORUS_RECORDS);
      for (let dz = 0; dz < TORUS_SIZE; dz++) for (let dx = 0; dx < TORUS_SIZE; dx++) seen[torusSlot(cx0 + dx, cz0 + dz)]!++;
      expect(seen.every((c) => c === 1)).toBe(true);
    }
  });
});

describe('quart coordinates', () => {
  test('qx = x >> 2 and qy = (y + 64) >> 2 in 0 … 95', () => {
    expect([quartCoord(0), quartCoord(3), quartCoord(4), quartCoord(-1), quartCoord(-4), quartCoord(-5)]).toEqual([0, 0, 1, -1, -1, -2]);
    expect([quartCoord(-WINDOW_HALF), quartCoord(WINDOW_HALF - 1)]).toEqual([-131072, 131071]);
    for (let y = MIN_Y; y <= MAX_Y; y++) {
      const qy = quartY(y);
      expect(qy).toBe(Math.floor((y - MIN_Y) / 4));
      expect(qy).toBeGreaterThanOrEqual(0);
      expect(qy).toBeLessThan(QUARTS_Y);
    }
  });
});

describe('the half-open world window [−2^19, 2^19) (SP2b §6.3)', () => {
  test('inWindow at the edges', () => {
    expect(inWindow(-524288, -524288)).toBe(true);
    expect(inWindow(524287, 524287)).toBe(true);
    expect(inWindow(524288, 0)).toBe(false);
    expect(inWindow(0, 524288)).toBe(false);
    expect(inWindow(-524289, 0)).toBe(false);
    expect(inWindow(0, -524289)).toBe(false);
    expect(inWindow(0, 0)).toBe(true);
  });

  test('columnInWindow is the window in columns, cx, cz ∈ [−32768, 32768)', () => {
    expect(columnInWindow(-32768, -32768)).toBe(true);
    expect(columnInWindow(32767, 32767)).toBe(true);
    expect(columnInWindow(32768, 0)).toBe(false);
    expect(columnInWindow(0, -32769)).toBe(false);
    expect(columnInWindow(chunkCoord(-524288), chunkCoord(524287))).toBe(true);
    expect(columnInWindow(chunkCoord(524288), 0)).toBe(false);
  });

  test('every block of the window has a column in the window', () => {
    const next = testRng(104);
    for (let i = 0; i < 5000; i++) {
      const x = intIn(next, -WINDOW_HALF, WINDOW_HALF), z = intIn(next, -WINDOW_HALF, WINDOW_HALF);
      expect(inWindow(x, z)).toBe(true);
      expect(columnInWindow(chunkCoord(x), chunkCoord(z))).toBe(true);
    }
  });
});
```

Create `test/unit/fnvStream.test.ts`:

```ts
import { expect, test } from 'vitest';
import { createFnv64, fnv1a64, fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { testRng } from '../harness/stats';

function randomBytes(next: () => number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = next() & 255;
  return b;
}

test('an empty stream digests to the FNV-1a 64 offset basis', () => {
  expect(createFnv64().digest()).toEqual(fnv1a64(''));
  expect(hex64(createFnv64().digest())).toBe('cbf29ce484222325');
});

test('update over random splits equals fnv1a64Bytes over the concatenation (500 strings)', () => {
  const next = testRng(201);
  for (let i = 0; i < 500; i++) {
    const all = randomBytes(next, next() % 300);
    const h = createFnv64();
    let at = 0;
    while (at < all.length) {
      const len = Math.min(all.length - at, next() % 40);
      h.update(all.subarray(at, at + len));
      at += len;
    }
    expect(h.digest()).toEqual(fnv1a64Bytes(all));
  }
});

test('update hashes a subarray view only, not its whole buffer', () => {
  const buf = Uint8Array.of(9, 1, 2, 3, 9);
  const h = createFnv64();
  h.update(buf.subarray(1, 4));
  expect(h.digest()).toEqual(fnv1a64Bytes(Uint8Array.of(1, 2, 3)));
});

test('updateU8, updateU16LE and updateU32LE write little-endian bytes, masked to their width', () => {
  const h = createFnv64();
  h.updateU8(0x1ab);
  h.updateU16LE(0xbeef);
  h.updateU16LE(0x12345);
  h.updateU32LE(0xdeadbeef);
  h.updateU32LE(-1);
  h.updateU16LE(-2);
  const expected = Uint8Array.of(0xab, 0xef, 0xbe, 0x45, 0x23, 0xef, 0xbe, 0xad, 0xde, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff);
  expect(h.digest()).toEqual(fnv1a64Bytes(expected));
});

test('a Uint16Array hashed as bytes equals updateU16LE per value (typed arrays are little-endian)', () => {
  const next = testRng(202);
  const vals = new Uint16Array(4096);
  for (let i = 0; i < vals.length; i++) vals[i] = next() & 0xffff;
  const a = createFnv64();
  a.update(new Uint8Array(vals.buffer, vals.byteOffset, vals.byteLength));
  const b = createFnv64();
  for (let i = 0; i < vals.length; i++) b.updateU16LE(vals[i]!);
  expect(a.digest()).toEqual(b.digest());
});

test('updateRepeatU8 and updateRepeatU16LE equal the expanded bytes (a uniform section)', () => {
  const blocks = new Uint16Array(4096).fill(0x0102);
  const fluid = new Uint8Array(4096).fill(0x08);
  const concat = new Uint8Array(8192 + 4096 + 3);
  concat.set(new Uint8Array(blocks.buffer), 0);
  concat.set(fluid, 8192);
  const h = createFnv64();
  h.updateRepeatU16LE(0x0102, 4096);
  h.updateRepeatU8(0x108, 4096);
  h.updateRepeatU8(0, 3);
  h.updateRepeatU16LE(7, 0);
  expect(h.digest()).toEqual(fnv1a64Bytes(concat));
});

test('digest does not finish the stream: later updates continue it', () => {
  const next = testRng(203);
  const a = randomBytes(next, 100), b = randomBytes(next, 57);
  const h = createFnv64();
  h.update(a);
  const mid = h.digest();
  expect(mid).toEqual(fnv1a64Bytes(a));
  expect(h.digest()).toEqual(mid);
  h.update(b);
  const ab = new Uint8Array(157);
  ab.set(a, 0);
  ab.set(b, 100);
  expect(h.digest()).toEqual(fnv1a64Bytes(ab));
});

test('streams are independent', () => {
  const a = createFnv64(), b = createFnv64();
  a.updateU8(1);
  expect(b.digest()).toEqual(fnv1a64(''));
  expect(a.digest()).toEqual(fnv1a64Bytes(Uint8Array.of(1)));
});

test('updates are chainable', () => {
  const h = createFnv64().updateU8(1).updateU16LE(0x0302).update(Uint8Array.of(4));
  expect(h.digest()).toEqual(fnv1a64Bytes(Uint8Array.of(1, 2, 3, 4)));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/coords.test.ts test/unit/fnvStream.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× an empty stream digests to the FNV-1a 64 offset basis 3ms
× update over random splits equals fnv1a64Bytes over the concatenation (500 strings) 0ms
× update hashes a subarray view only, not its whole buffer 0ms
× updateU8, updateU16LE and updateU32LE write little-endian bytes, masked to their width 0ms
× a Uint16Array hashed as bytes equals updateU16LE per value (typed arrays are little-endian) 1ms
× updateRepeatU8 and updateRepeatU16LE equal the expanded bytes (a uniform section) 0ms
× digest does not finish the stream: later updates continue it 0ms
× streams are independent 0ms
× updates are chainable 0ms
FAIL  |unit| test/unit/coords.test.ts [ test/unit/coords.test.ts ]
Error: Cannot find module '../../src/core/coords' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/coords.test.ts
FAIL  |unit| test/unit/fnvStream.test.ts > an empty stream digests to the FNV-1a 64 offset basis
TypeError: createFnv64 is not a function
FAIL  |unit| test/unit/fnvStream.test.ts > update over random splits equals fnv1a64Bytes over the concatenation (500 strings)
… (7 more lines)
Test Files  2 failed (2)
Tests  9 failed (9)
```

- [ ] **Step 3: Implement**

Create `src/core/coords.ts`:

```ts
/**
 * Voxel coordinates, indices and numeric keys (master §2.1, SP3a spec §1). Every argument is an integer; x and z lie
 * in the half-open window [−2^19, 2^19) (SP2b spec §6.3), so cx and cz lie in [−2^15, 2^15) and a colKey is < 2^32.
 * No string keys anywhere.
 */
import { MIN_Y } from './constants';

const Y0 = MIN_Y;

/** Sections per column: y −64 … 319 in 24 sections of 16. */
export const SECTIONS = 24;
/** Voxels per section (16³). */
export const SECTION_VOXELS = 4096;
/** Highest block y (inclusive). */
export const MAX_Y = 319;
/** Vertical quarts per column (4-block cells): qy ∈ [0, 96). */
export const QUARTS_Y = 96;
/** Side of the loaded-column torus. */
export const TORUS_SIZE = 64;
/** Records in the torus (64 × 64). */
export const TORUS_RECORDS = 4096;
/** Half-width of the world window: x, z ∈ [−WINDOW_HALF, WINDOW_HALF). */
export const WINDOW_HALF = 524288;

/** Column (chunk) coordinate of a block coordinate: cx = x >> 4 (also cz from z). */
export const chunkCoord = (v: number): number => v >> 4;
/** Coordinate inside the column, 0 … 15: lx = x & 15 (also lz from z). */
export const localCoord = (v: number): number => v & 15;
/** Section index of a block y: sy = (y + 64) >> 4, 0 … 23. */
export const sectionY = (y: number): number => (y - Y0) >> 4;
/** y inside its section, 0 … 15. */
export const localY = (y: number): number => (y - Y0) & 15;
/** Absolute y of a section's lowest voxel: sy·16 − 64. */
export const sectionBaseY = (sy: number): number => sy * 16 + Y0;
/** True for y in the world's closed range [−64, 319]. */
export const yInWorld = (y: number): boolean => y >= Y0 && y <= MAX_Y;

/** Voxel index inside a section: ly << 8 | lz << 4 | lx (0 … 4095). */
export const voxelIndex = (lx: number, ly: number, lz: number): number => (ly << 8) | (lz << 4) | lx;
/** lx of a voxel index. */
export const voxelLx = (i: number): number => i & 15;
/** ly of a voxel index. */
export const voxelLy = (i: number): number => i >> 8;
/** lz of a voxel index. */
export const voxelLz = (i: number): number => (i >> 4) & 15;
/** Index in a 16 × 16 per-position column map (heightmaps, surfaceBiome): lz·16 + lx. */
export const columnIndex = (lx: number, lz: number): number => (lz << 4) | lx;

/** Numeric column key: (cx + 32768)·65536 + (cz + 32768), in [0, 2^32). */
export const colKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
/** cx of a colKey. */
export const colKeyCx = (key: number): number => Math.floor(key / 65536) - 32768;
/** cz of a colKey. */
export const colKeyCz = (key: number): number => (key % 65536) - 32768;
/** Numeric section key: colKey·32 + sy, in [0, 2^37). */
export const sectionKey = (cx: number, cz: number, sy: number): number => colKey(cx, cz) * 32 + sy;
/** colKey of a section key. */
export const sectionKeyColKey = (key: number): number => Math.floor(key / 32);
/** sy of a section key. */
export const sectionKeySy = (key: number): number => key % 32;

/** Record of a column in the 64 × 64 torus: (cx & 63) + 64·(cz & 63). Columns 64 apart share a record. */
export const torusSlot = (cx: number, cz: number): number => (cx & 63) + ((cz & 63) << 6);

/** Horizontal quart coordinate: qx = x >> 2 (also qz from z). */
export const quartCoord = (v: number): number => v >> 2;
/** Vertical quart coordinate: qy = (y + 64) >> 2, 0 … 95. */
export const quartY = (y: number): number => (y - Y0) >> 2;

/** True when the block (x, z) lies in the half-open window [−2^19, 2^19)². */
export const inWindow = (x: number, z: number): boolean =>
  x >= -WINDOW_HALF && x < WINDOW_HALF && z >= -WINDOW_HALF && z < WINDOW_HALF;
/** True when the column (cx, cz) lies in the window: cx, cz ∈ [−2^15, 2^15). */
export const columnInWindow = (cx: number, cz: number): boolean => cx >= -32768 && cx < 32768 && cz >= -32768 && cz < 32768;
```

Modify `src/core/hash.ts` (apply with `git apply`):

```diff
diff --git a/src/core/hash.ts b/src/core/hash.ts
index f5b93ff..dba500a 100644
--- a/src/core/hash.ts
+++ b/src/core/hash.ts
@@ -83,6 +83,84 @@ export function fnv1a64Bytes(bytes: Uint8Array): Hash64 {
   return [lo, hi];
 }
 
+/**
+ * A streaming FNV-1a 64 (SP3a spec §6.2): `digest()` after any sequence of updates equals `fnv1a64Bytes` over the
+ * concatenation of the bytes written. Multi-byte values are written little-endian and masked to their width.
+ * `digest()` does not end the stream (FNV has no finalisation); later updates continue it. Updates return the stream.
+ */
+export interface Fnv64 {
+  update(bytes: Uint8Array): Fnv64;
+  updateU8(v: number): Fnv64;
+  updateU16LE(v: number): Fnv64;
+  updateU32LE(v: number): Fnv64;
+  /** `v & 255` written n times. */
+  updateRepeatU8(v: number, n: number): Fnv64;
+  /** `v & 0xffff` written n times, little-endian (a uniform section expanded). */
+  updateRepeatU16LE(v: number, n: number): Fnv64;
+  digest(): Hash64;
+}
+
+/** The step of `fnv1a64Bytes`, byte by byte over a running [lo, hi]. */
+export function createFnv64(): Fnv64 {
+  let lo = 0x84222325;
+  let hi = 0xcbf29ce4;
+  const step = (b: number): void => {
+    lo = (lo ^ b) >>> 0;
+    const p = lo * 0x1b3;
+    const nlo = p >>> 0;
+    hi = (Math.imul(hi, 0x1b3) + (p - nlo) / 4294967296 + (lo << 8)) >>> 0;
+    lo = nlo;
+  };
+  const stream: Fnv64 = {
+    update(bytes) {
+      let l = lo, h = hi;
+      for (let i = 0; i < bytes.length; i++) {
+        l = (l ^ bytes[i]!) >>> 0;
+        const p = l * 0x1b3;
+        const nl = p >>> 0;
+        h = (Math.imul(h, 0x1b3) + (p - nl) / 4294967296 + (l << 8)) >>> 0;
+        l = nl;
+      }
+      lo = l;
+      hi = h;
+      return stream;
+    },
+    updateU8(v) {
+      step(v & 255);
+      return stream;
+    },
+    updateU16LE(v) {
+      step(v & 255);
+      step((v >>> 8) & 255);
+      return stream;
+    },
+    updateU32LE(v) {
+      step(v & 255);
+      step((v >>> 8) & 255);
+      step((v >>> 16) & 255);
+      step((v >>> 24) & 255);
+      return stream;
+    },
+    updateRepeatU8(v, n) {
+      const b = v & 255;
+      for (let i = 0; i < n; i++) step(b);
+      return stream;
+    },
+    updateRepeatU16LE(v, n) {
+      const b0 = v & 255, b1 = (v >>> 8) & 255;
+      for (let i = 0; i < n; i++) {
+        step(b0);
+        step(b1);
+      }
+      return stream;
+    },
+    digest() {
+      return [lo, hi];
+    },
+  };
+  return stream;
+}
+
 export function fnv1a64(str: string): Hash64 {
   return fnv1a64Bytes(utf8Bytes(str));
 }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/coords.test.ts test/unit/fnvStream.test.ts`

Expected: PASS (exit 0)

```
Test Files  2 passed (2)
Tests  24 passed (24)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  95 passed | 2 skipped (97)
Tests  1209 passed | 2 skipped (1211)
```

- [ ] **Step 6: Commit**

```bash
git add src/core/coords.ts src/core/hash.ts test/unit/coords.test.ts test/unit/fnvStream.test.ts
git commit -F - <<'EOF'
feat(core): coordinates and keys (coords.ts) and a streaming FNV-1a 64

SP3a spec §1 and §6.2. core/coords.ts: block ↔ column/section/local
coordinates, voxel and column indices, numeric colKey and sectionKey with
their decoders, the torus slot, quart coordinates and the half-open world
window checks. core/hash.ts gains createFnv64(), whose digest equals
fnv1a64Bytes over the concatenated bytes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `ed7cccf` on `dry/sp3a`; 4 files changed, 444 insertions(+)):

RED replay (`test/**` over the parent): `test/unit/coords.test.ts` fails to import `src/core/coords` (file failed, no tests) and `test/unit/fnvStream.test.ts` 9 of 9 fail (`createFnv64 is not a function`). GREEN: typecheck clean; `npm test` 95 files passed, 2 skipped / 1209 tests passed, 2 skipped (≈44 s); the two new files 26 tests.

- Ruling: `core/coords.ts` names — constants `SECTIONS` 24, `SECTION_VOXELS` 4096, `MAX_Y` 319, `QUARTS_Y` 96, `TORUS_SIZE` 64, `TORUS_RECORDS` 4096, `WINDOW_HALF` 524288; functions `chunkCoord(v)` (v >> 4, for x and z), `localCoord(v)` (v & 15), `sectionY(y)`, `localY(y)`, `sectionBaseY(sy)`, `yInWorld(y)`, `voxelIndex(lx, ly, lz)`, `voxelLx/voxelLy/voxelLz(i)`, `columnIndex(lx, lz)`, `colKey(cx, cz)`, `colKeyCx/colKeyCz(key)`, `sectionKey(cx, cz, sy)`, `sectionKeyColKey/sectionKeySy(key)`, `torusSlot(cx, cz)`, `quartCoord(v)` (x >> 2, for x and z), `quartY(y)`, `inWindow(x, z)`, `columnInWindow(cx, cz)` — all arrow-function `const`s; `MIN_Y` comes from `constants.ts` through a top-level alias — the skeleton leaves names to the task — cost if wrong: renames in Tasks 3-14.
- Ruling: the existing duplicated colKey (`gen/column/columnCache.ts:17`) and the three `WINDOW = 524288` copies (`workers/protocol.ts`, `metrics/noiseStats.ts`, `ui/map/*`) are left as they are — Task 2 adds helpers only and touches no golden-adjacent code; later tasks import from `core/coords` — cost if wrong: a later cleanup commit.
- Ruling: streaming FNV API `createFnv64(): Fnv64` with `update(bytes)`, `updateU8`, `updateU16LE`, `updateU32LE` (little-endian, masked to their width), `updateRepeatU8(v, n)`, `updateRepeatU16LE(v, n)` (uniform sections expanded without a scratch buffer, for `regionHash`), and a non-finalising `digest(): Hash64`; updates return the stream (chainable). `fnv1a64Bytes` is left untouched (its step is copied, not shared) so no existing golden path changes — cost if wrong: none (an equality test pins both).
- Ruling: the local variable is named `stream`, not `self` — the arch `worker-api` rule bans the identifier `self` in `core/` — cost if wrong: none.
- No spec defects found for Task 2.

---

### Task 3: world/blocks: kinds, registry engine, fluid and light bytes

**Spec:** §2.1, §2.2 (all but the real defs), §2.4 fixture tests, §2.5

**Files:**
- Create: `src/world/blocks/fluid.ts`
- Create: `src/world/blocks/kinds.ts`
- Create: `src/world/blocks/light.ts`
- Create: `src/world/blocks/registry.ts`
- Modify: `test/arch/banned.test.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/blocks/direct.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/blocks/encoder.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/blocks/locale.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/blocks/ns.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/blocks/pow.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/blocks/trig.ts`
- Create: `test/arch/fixtures/banned/bad/src/world/store/clock.ts`
- Create: `test/arch/fixtures/banned/good/src/world/blocks/aliased.ts`
- Create: `test/arch/fixtures/banned/good/src/world/store/free.ts`
- Modify: `test/arch/rules/banned.ts`
- Create: `test/harness/blockFixtures.ts`
- Create: `test/unit/blockRegistry.test.ts`
- Create: `test/unit/fluidLight.test.ts`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/world/blocks/fluid.ts`:
    - `export const FLUID_NONE = 0;`
    - `export const FLUID_WATER = 1;`
    - `export const FLUID_LAVA = 2;`
    - `export const NO_FLUID = 0;`
    - `export const WATER_SOURCE = 16;`
    - `export const packFluid = (type: number, level: number, falling = false, unsettled = false): number =>`
    - `export const fluidLevel = (b: number): number => b & 7;`
    - `export const fluidFalling = (b: number): boolean => (b & 8) !== 0;`
    - `export const fluidType = (b: number): number => (b >> 4) & 3;`
    - `export const fluidUnsettled = (b: number): boolean => (b & 64) !== 0;`
    - `export const hasFluid = (b: number): boolean => (b & 48) !== 0;`
  - `src/world/blocks/kinds.ts`:
    - `export const PROPERTY_KINDS = Object.freeze(['axis', 'facing4', 'facing6', 'half', 'open', 'hinge', 'slabType'] as const);`
    - `export type PropertyKind = (typeof PROPERTY_KINDS)[number];`
    - `export const KIND_VALUES: Readonly<Record<PropertyKind, readonly string[]>> = Object.freeze(`
    - `export const FACE_NAMES = KIND_VALUES.facing6;`
    - `export const FACE_NORTH = 0;`
    - `export const FACE_EAST = 1;`
    - `export const FACE_SOUTH = 2;`
    - `export const FACE_WEST = 3;`
    - `export const FACE_UP = 4;`
    - `export const FACE_DOWN = 5;`
    - `export const FACE_COUNT = 6;`
    - `export const ALL_FACES = 63;`
    - `export const PASS_VALUES = Object.freeze(['none', 'opaque', 'cutout', 'translucent'] as const);`
    - `export type Pass = (typeof PASS_VALUES)[number];`
    - `export const PASS_NONE = 0;`
    - `export const PASS_OPAQUE = 1;`
    - `export const PASS_CUTOUT = 2;`
    - `export const PASS_TRANSLUCENT = 3;`
    - `export const SHAPE_VALUES = Object.freeze(['none', 'cube', 'cross', 'fluid', 'pointed', 'box'] as const);`
    - `export type Shape = (typeof SHAPE_VALUES)[number];`
    - `export const SHAPE_NONE = 0;`
    - `export const SHAPE_CUBE = 1;`
    - `export const SHAPE_CROSS = 2;`
    - `export const SHAPE_FLUID = 3;`
    - `export const SHAPE_POINTED = 4;`
    - `export const SHAPE_BOX = 5;`
    - `export const COLLIDE_VALUES = Object.freeze(['none', 'cube', 'boxes'] as const);`
    - `export type Collide = (typeof COLLIDE_VALUES)[number];`
    - `export const COLLIDE_NONE = 0;`
    - `export const COLLIDE_CUBE = 1;`
    - `export const COLLIDE_BOXES = 2;`
    - `export const FLUID_MODE_VALUES = Object.freeze(['block', 'hold', 'displace'] as const);`
    - `export type FluidMode = (typeof FLUID_MODE_VALUES)[number];`
    - `export const FLUID_MODE_BLOCK = 0;`
    - `export const FLUID_MODE_HOLD = 1;`
    - `export const FLUID_MODE_DISPLACE = 2;`
    - `export const TINT_VALUES = Object.freeze(['none', 'grass', 'foliage', 'water', 'fixed'] as const);`
    - `export type Tint = (typeof TINT_VALUES)[number];`
    - `export const TINT_NONE = 0;`
    - `export const TINT_GRASS = 1;`
    - `export const TINT_FOLIAGE = 2;`
    - `export const TINT_WATER = 3;`
    - `export const TINT_FIXED = 4;`
    - `export const SOUND_VALUES = Object.freeze(['none', 'stone', 'dirt', 'grass', 'sand', 'gravel', 'wood', 'snow', 'glass', 'leaves', 'metal', 'abyss'] as const);`
    - `export type Sound = (typeof SOUND_VALUES)[number];`
    - `export const SOUND_NONE = 0;`
    - `export const SOUND_STONE = 1;`
    - `export const SOUND_DIRT = 2;`
    - `export const SOUND_GRASS = 3;`
    - `export const SOUND_SAND = 4;`
    - `export const SOUND_GRAVEL = 5;`
    - `export const SOUND_WOOD = 6;`
    - `export const SOUND_SNOW = 7;`
    - `export const SOUND_GLASS = 8;`
    - `export const SOUND_LEAVES = 9;`
    - `export const SOUND_METAL = 10;`
    - `export const SOUND_ABYSS = 11;`
  - `src/world/blocks/light.ts`:
    - `export const MAX_LIGHT = 15;`
    - `export const packLight = (sky: number, block: number): number => ((sky & 15) << 4) | (block & 15);`
    - `export const skyLight = (b: number): number => (b >> 4) & 15;`
    - `export const blockLight = (b: number): number => b & 15;`
  - `src/world/blocks/registry.ts`:
    - `export const MAX_STATES = 4096;`
    - `export type PropValues = Readonly<Record<string, string>>;`
    - `export type PerState<T> = T | ((props: PropValues) => T);`
    - `export interface PropertyDef`
    - `export interface StateTables`
    - `export interface BlockDef extends StateTables`
    - `export interface BlockRegistry`
    - `export function buildRegistry(defs: readonly BlockDef[]): BlockRegistry`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/banned.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/banned.test.ts b/test/arch/banned.test.ts
index f90bfc7..2cefb66 100644
--- a/test/arch/banned.test.ts
+++ b/test/arch/banned.test.ts
@@ -58,7 +58,14 @@ test('bad fixture tree reports every banned use', () => {
     'src/render/threeAudioReexport.ts:1 three-audio',
     'src/ui/audio.ts:1 webaudio-outside-sound',
     'src/ui/shader.ts:1 glsl-outside-materials',
+    'src/world/blocks/direct.ts:2 hot-import-reference',
+    'src/world/blocks/encoder.ts:1 engine-dependent-api',
+    'src/world/blocks/locale.ts:1 engine-dependent-api',
+    'src/world/blocks/ns.ts:1 hot-import-namespace',
+    'src/world/blocks/pow.ts:1 math-pow-operator',
+    'src/world/blocks/trig.ts:1 math-member',
     'src/world/clock.ts:1 nondeterministic',
+    'src/world/store/clock.ts:1 nondeterministic',
   ]);
 });
 
```

Create `test/arch/fixtures/banned/bad/src/world/blocks/direct.ts`:

```ts
import { k } from '../../core/k';
export function m(): number { return k(); }
```

Create `test/arch/fixtures/banned/bad/src/world/blocks/encoder.ts`:

```ts
export const e = new TextEncoder();
```

Create `test/arch/fixtures/banned/bad/src/world/blocks/locale.ts`:

```ts
export const c = (a: string, b: string): number => a.localeCompare(b);
```

Create `test/arch/fixtures/banned/bad/src/world/blocks/ns.ts`:

```ts
import * as h from '../../core/hash';
export const g = h;
```

Create `test/arch/fixtures/banned/bad/src/world/blocks/pow.ts`:

```ts
export const p = (x: number): number => x ** 2;
```

Create `test/arch/fixtures/banned/bad/src/world/blocks/trig.ts`:

```ts
export const s = (x: number): number => Math.sin(x);
```

Create `test/arch/fixtures/banned/bad/src/world/store/clock.ts`:

```ts
export const now = (): number => performance.now();
```

Create `test/arch/fixtures/banned/good/src/world/blocks/aliased.ts`:

```ts
import { k, type K } from '../../core/k';
const KF = k;
export const STONE = 1;
export const m = (t: K): number => KF(t) + Math.floor(1.5) + Math.imul(3, 5);
```

Create `test/arch/fixtures/banned/good/src/world/store/free.ts`:

```ts
/** world/store keeps the ND bans only (SP3a spec §2.5): no Math allowlist, no ** ban, no hot-import rule. */
import { k } from '../../core/k';
export const len = (a: number, b: number): number => Math.hypot(a, b) + 2 ** 3 + k();
```

Create `test/harness/blockFixtures.ts`:

```ts
/**
 * The fixture block registry (SP3a spec §2.4): tests only, never locked. One type per property kind, a type with two
 * properties whose defaults are not the first kind values (`pillar`: axis default y, half default top), and a door
 * with the four properties of the §2.3 key example. Some table values are functions of the state's properties.
 */
import type { BlockDef, PropertyDef, StateTables } from '../../src/world/blocks/registry';
import type { PropertyKind } from '../../src/world/blocks/kinds';

const prop = (name: string, kind: PropertyKind, def: string): PropertyDef => ({ name, kind, default: def });

export const AIR_TABLES: StateTables = {
  opacity: 0, pass: 'none', shape: 'none', fullFaces: 0, emit: 0, carvable: false, replaceable: true,
  collide: 'none', fluidMode: 'displace', tint: 'none', sound: 'none', faceTex: 0,
};

export const SOLID_TABLES: StateTables = {
  opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: true, replaceable: false,
  collide: 'cube', fluidMode: 'block', tint: 'none', sound: 'stone', faceTex: 0,
};

export const FIXTURE_DEFS: readonly BlockDef[] = [
  { name: 'air', props: [], ...AIR_TABLES },
  { name: 'log', props: [prop('axis', 'axis', 'y')], ...SOLID_TABLES, sound: 'wood' },
  { name: 'chest', props: [prop('facing', 'facing4', 'north')], ...SOLID_TABLES, sound: 'wood' },
  {
    name: 'piston', props: [prop('facing', 'facing6', 'north')], ...SOLID_TABLES,
    // Face i shows texture 1 when it is the facing face, 2 otherwise.
    faceTex: (p) => ['north', 'east', 'south', 'west', 'up', 'down'].map((f) => (f === p['facing'] ? 1 : 2)),
  },
  { name: 'half_block', props: [prop('half', 'half', 'bottom')], ...SOLID_TABLES, shape: 'box' },
  {
    name: 'trapdoor', props: [prop('open', 'open', 'false')], ...SOLID_TABLES,
    opacity: (p) => (p['open'] === 'true' ? 0 : 1), pass: 'cutout', collide: (p) => (p['open'] === 'true' ? 'none' : 'boxes'),
  },
  { name: 'gate', props: [prop('hinge', 'hinge', 'left')], ...SOLID_TABLES, emit: (p) => (p['hinge'] === 'right' ? 7 : 0) },
  {
    name: 'slab', props: [prop('type', 'slabType', 'bottom')], ...SOLID_TABLES,
    fullFaces: (p) => (p['type'] === 'double' ? 63 : p['type'] === 'top' ? 16 : 32),
  },
  { name: 'pillar', props: [prop('axis', 'axis', 'y'), prop('half', 'half', 'top')], ...SOLID_TABLES, tint: 'foliage' },
  {
    name: 'door',
    props: [prop('facing', 'facing4', 'north'), prop('half', 'half', 'bottom'), prop('open', 'open', 'false'), prop('hinge', 'hinge', 'left')],
    ...SOLID_TABLES, opacity: 0, pass: 'cutout', fluidMode: 'hold', sound: 'wood', fullFaces: 0,
  },
];

/** First state id of each fixture type (ids follow the definition order). */
export const FIXTURE_BASE = {
  air: 0, log: 1, chest: 4, piston: 8, half_block: 14, trapdoor: 16, gate: 18, slab: 20, pillar: 23, door: 29,
} as const;
export const FIXTURE_STATE_COUNT = 61;
```

Create `test/unit/blockRegistry.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  ALL_FACES, COLLIDE_BOXES, COLLIDE_CUBE, COLLIDE_NONE, COLLIDE_VALUES, FACE_COUNT, FACE_DOWN, FACE_EAST, FACE_NAMES,
  FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST, FLUID_MODE_BLOCK, FLUID_MODE_DISPLACE, FLUID_MODE_HOLD, FLUID_MODE_VALUES,
  KIND_VALUES, PASS_CUTOUT, PASS_NONE, PASS_OPAQUE, PASS_TRANSLUCENT, PASS_VALUES, PROPERTY_KINDS, SHAPE_BOX, SHAPE_CROSS,
  SHAPE_CUBE, SHAPE_FLUID, SHAPE_NONE, SHAPE_POINTED, SHAPE_VALUES, SOUND_ABYSS, SOUND_DIRT, SOUND_GLASS, SOUND_GRASS,
  SOUND_GRAVEL, SOUND_LEAVES, SOUND_METAL, SOUND_NONE, SOUND_SAND, SOUND_SNOW, SOUND_STONE, SOUND_VALUES, SOUND_WOOD,
  TINT_FIXED, TINT_FOLIAGE, TINT_GRASS, TINT_NONE, TINT_VALUES, TINT_WATER,
} from '../../src/world/blocks/kinds';
import { buildRegistry, MAX_STATES, type BlockDef, type BlockRegistry, type PropertyDef } from '../../src/world/blocks/registry';
import { AIR_TABLES, FIXTURE_BASE, FIXTURE_DEFS, FIXTURE_STATE_COUNT, SOLID_TABLES } from '../harness/blockFixtures';

const R: BlockRegistry = buildRegistry(FIXTURE_DEFS);
const T = (name: string): number => R.typeId(name);
const S = (name: string, props: Record<string, string> = {}): number => R.stateOf(T(name), props);
const allStates = (): number[] => Array.from({ length: R.stateCount }, (_, s) => s);

describe('kinds and codes (SP3a spec §2.1, §2.2)', () => {
  test('property kinds and their values, in kind order', () => {
    expect(PROPERTY_KINDS).toEqual(['axis', 'facing4', 'facing6', 'half', 'open', 'hinge', 'slabType']);
    expect(KIND_VALUES).toEqual({
      axis: ['x', 'y', 'z'],
      facing4: ['north', 'east', 'south', 'west'],
      facing6: ['north', 'east', 'south', 'west', 'up', 'down'],
      half: ['bottom', 'top'],
      open: ['false', 'true'],
      hinge: ['left', 'right'],
      slabType: ['bottom', 'top', 'double'],
    });
    expect(Object.isFrozen(KIND_VALUES)).toBe(true);
    for (const k of PROPERTY_KINDS) expect(Object.isFrozen(KIND_VALUES[k])).toBe(true);
  });

  test('enum tables store the 0-based index of the value in the §2.1 order', () => {
    expect(PASS_VALUES).toEqual(['none', 'opaque', 'cutout', 'translucent']);
    expect([PASS_NONE, PASS_OPAQUE, PASS_CUTOUT, PASS_TRANSLUCENT]).toEqual([0, 1, 2, 3]);
    expect(SHAPE_VALUES).toEqual(['none', 'cube', 'cross', 'fluid', 'pointed', 'box']);
    expect([SHAPE_NONE, SHAPE_CUBE, SHAPE_CROSS, SHAPE_FLUID, SHAPE_POINTED, SHAPE_BOX]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(COLLIDE_VALUES).toEqual(['none', 'cube', 'boxes']);
    expect([COLLIDE_NONE, COLLIDE_CUBE, COLLIDE_BOXES]).toEqual([0, 1, 2]);
    expect(FLUID_MODE_VALUES).toEqual(['block', 'hold', 'displace']);
    expect([FLUID_MODE_BLOCK, FLUID_MODE_HOLD, FLUID_MODE_DISPLACE]).toEqual([0, 1, 2]);
    expect(TINT_VALUES).toEqual(['none', 'grass', 'foliage', 'water', 'fixed']);
    expect([TINT_NONE, TINT_GRASS, TINT_FOLIAGE, TINT_WATER, TINT_FIXED]).toEqual([0, 1, 2, 3, 4]);
    expect(SOUND_VALUES).toEqual(['none', 'stone', 'dirt', 'grass', 'sand', 'gravel', 'wood', 'snow', 'glass', 'leaves', 'metal', 'abyss']);
    expect([SOUND_NONE, SOUND_STONE, SOUND_DIRT, SOUND_GRASS, SOUND_SAND, SOUND_GRAVEL, SOUND_WOOD, SOUND_SNOW, SOUND_GLASS,
      SOUND_LEAVES, SOUND_METAL, SOUND_ABYSS]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('faces follow the facing6 order; FULL_FACES bit i is face i', () => {
    expect(FACE_NAMES).toEqual(KIND_VALUES.facing6);
    expect([FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST, FACE_UP, FACE_DOWN]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(FACE_COUNT).toBe(6);
    expect(ALL_FACES).toBe(63);
  });
});

describe('ids: contiguous per type, the default first, then mixed-radix order (§2.2)', () => {
  test('types and states follow the definition order', () => {
    expect(R.typeCount).toBe(FIXTURE_DEFS.length);
    expect(R.stateCount).toBe(FIXTURE_STATE_COUNT);
    FIXTURE_DEFS.forEach((d, t) => {
      expect(R.typeId(d.name)).toBe(t);
      expect(R.typeName(t)).toBe(d.name);
      expect(R.DEFAULT_STATE[t]).toBe(FIXTURE_BASE[d.name as keyof typeof FIXTURE_BASE]);
      expect(R.stateOf(t)).toBe(R.DEFAULT_STATE[t]);
    });
  });

  test('STATE_TYPE is contiguous: each type owns [DEFAULT_STATE, next DEFAULT_STATE)', () => {
    for (let t = 0; t < R.typeCount; t++) {
      const end = t + 1 < R.typeCount ? R.DEFAULT_STATE[t + 1]! : R.stateCount;
      for (let s = R.DEFAULT_STATE[t]!; s < end; s++) expect(R.STATE_TYPE[s]).toBe(t);
    }
    expect(R.STATE_TYPE.length).toBe(MAX_STATES);
  });

  test('axis default y: base + 0 is y, then x, then z (the §2.2 example)', () => {
    const b = FIXTURE_BASE.log;
    expect([S('log', { axis: 'y' }), S('log', { axis: 'x' }), S('log', { axis: 'z' })]).toEqual([b, b + 1, b + 2]);
  });

  test('two properties, defaults not first (axis y, half top): the exact id sequence', () => {
    const b = FIXTURE_BASE.pillar;
    const seq = [0, 1, 2, 3, 4, 5].map((i) => R.propsOf(b + i));
    expect(seq).toEqual([
      { axis: 'y', half: 'top' },
      { axis: 'x', half: 'bottom' },
      { axis: 'x', half: 'top' },
      { axis: 'y', half: 'bottom' },
      { axis: 'z', half: 'bottom' },
      { axis: 'z', half: 'top' },
    ]);
    expect(R.DEFAULT_STATE[T('pillar')]).toBe(b);
    expect(R.STATE_TYPE[b + 6]).toBe(T('door'));
  });

  test('the door: 4 × 2 × 2 × 2 states, the last property varying fastest', () => {
    const b = FIXTURE_BASE.door;
    expect(R.propsOf(b)).toEqual({ facing: 'north', half: 'bottom', open: 'false', hinge: 'left' });
    expect(R.propsOf(b + 1)).toEqual({ facing: 'north', half: 'bottom', open: 'false', hinge: 'right' });
    expect(R.propsOf(b + 2)).toEqual({ facing: 'north', half: 'bottom', open: 'true', hinge: 'left' });
    expect(R.propsOf(b + 8)).toEqual({ facing: 'east', half: 'bottom', open: 'false', hinge: 'left' });
    expect(R.propsOf(b + 31)).toEqual({ facing: 'west', half: 'top', open: 'true', hinge: 'right' });
  });
});

describe('round trips over every state', () => {
  test('stateOf(propsOf(s)) = s; propsOf is frozen and lists properties in declaration order', () => {
    for (const s of allStates()) {
      const p = R.propsOf(s);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.keys(p)).toEqual((FIXTURE_DEFS[R.STATE_TYPE[s]!]!.props ?? []).map((d) => d.name));
      expect(R.stateOf(R.STATE_TYPE[s]!, p)).toBe(s);
    }
  });

  test('missing props take the defaults', () => {
    expect(R.propsOf(S('pillar', { axis: 'z' }))).toEqual({ axis: 'z', half: 'top' });
    expect(R.propsOf(S('door', { hinge: 'right' }))).toEqual({ facing: 'north', half: 'bottom', open: 'false', hinge: 'right' });
  });

  test('withProp sets one property and leaves the others; setting it back returns the state', () => {
    for (const s of allStates()) {
      const t = R.STATE_TYPE[s]!;
      const p = R.propsOf(s);
      for (const d of FIXTURE_DEFS[t]!.props ?? []) {
        for (const v of KIND_VALUES[d.kind]) {
          const s2 = R.withProp(s, d.name, v);
          expect(R.STATE_TYPE[s2]).toBe(t);
          expect(R.propsOf(s2)).toEqual({ ...p, [d.name]: v });
          expect(R.withProp(s2, d.name, p[d.name]!)).toBe(s);
        }
      }
    }
  });

  test('stateKey/parseStateKey round-trip; keys are unique ASCII', () => {
    const keys = new Set<string>();
    for (const s of allStates()) {
      const k = R.stateKey(s);
      expect(k).toMatch(/^[\x20-\x7e]+$/);
      expect(R.parseStateKey(k)).toBe(s);
      keys.add(k);
    }
    expect(keys.size).toBe(R.stateCount);
  });

  test('canonical keys: bare name without properties, every property in declaration order otherwise', () => {
    expect(R.stateKey(0)).toBe('air');
    expect(R.stateKey(S('log'))).toBe('log[axis=y]');
    expect(R.stateKey(S('pillar', { axis: 'x', half: 'bottom' }))).toBe('pillar[axis=x,half=bottom]');
    expect(R.stateKey(S('door'))).toBe('door[facing=north,half=bottom,open=false,hinge=left]');
    expect(R.stateKey(S('slab', { type: 'double' }))).toBe('slab[type=double]');
  });
});

describe('rotateState: clockwise seen from +y (§2.2)', () => {
  test('one quarter turn for every kind', () => {
    expect(R.rotateState(S('chest', { facing: 'north' }), 1)).toBe(S('chest', { facing: 'east' }));
    expect(R.rotateState(S('chest', { facing: 'west' }), 1)).toBe(S('chest', { facing: 'north' }));
    expect(R.rotateState(S('piston', { facing: 'up' }), 1)).toBe(S('piston', { facing: 'up' }));
    expect(R.rotateState(S('piston', { facing: 'down' }), 1)).toBe(S('piston', { facing: 'down' }));
    expect(R.rotateState(S('piston', { facing: 'south' }), 1)).toBe(S('piston', { facing: 'west' }));
    expect(R.rotateState(S('log', { axis: 'x' }), 1)).toBe(S('log', { axis: 'z' }));
    expect(R.rotateState(S('log', { axis: 'z' }), 1)).toBe(S('log', { axis: 'x' }));
    expect(R.rotateState(S('log', { axis: 'y' }), 1)).toBe(S('log', { axis: 'y' }));
    for (const [name, prop, values] of [['half_block', 'half', ['bottom', 'top']], ['trapdoor', 'open', ['false', 'true']],
      ['gate', 'hinge', ['left', 'right']], ['slab', 'type', ['bottom', 'top', 'double']]] as const) {
      for (const v of values) for (const q of [1, 2, 3]) expect(R.rotateState(S(name, { [prop]: v }), q)).toBe(S(name, { [prop]: v }));
    }
    expect(R.rotateState(S('door', { facing: 'south', half: 'top', open: 'true', hinge: 'right' }), 1))
      .toBe(S('door', { facing: 'west', half: 'top', open: 'true', hinge: 'right' }));
    expect(R.rotateState(0, 1)).toBe(0);
  });

  test('quarterTurns −1 and 5', () => {
    const north = S('chest', { facing: 'north' });
    expect(R.rotateState(north, -1)).toBe(S('chest', { facing: 'west' }));
    expect(R.rotateState(north, 5)).toBe(S('chest', { facing: 'east' }));
    expect(R.rotateState(north, 2)).toBe(S('chest', { facing: 'south' }));
    expect(R.rotateState(north, -6)).toBe(S('chest', { facing: 'south' }));
    expect(R.rotateState(S('log', { axis: 'x' }), -1)).toBe(S('log', { axis: 'z' }));
    expect(R.rotateState(S('log', { axis: 'x' }), 2)).toBe(S('log', { axis: 'x' }));
  });

  test('four turns are the identity; q then −q is the identity', () => {
    for (const s of allStates()) {
      let r = s;
      for (let i = 0; i < 4; i++) r = R.rotateState(r, 1);
      expect(r).toBe(s);
      for (const q of [0, 1, 2, 3, 4, -3]) expect(R.rotateState(R.rotateState(s, q), -q)).toBe(s);
    }
  });
});

describe('mirrorState (§2.2)', () => {
  test("each mirror axis for every kind", () => {
    expect(R.mirrorState(S('chest', { facing: 'east' }), 'x')).toBe(S('chest', { facing: 'west' }));
    expect(R.mirrorState(S('chest', { facing: 'north' }), 'x')).toBe(S('chest', { facing: 'north' }));
    expect(R.mirrorState(S('chest', { facing: 'north' }), 'z')).toBe(S('chest', { facing: 'south' }));
    expect(R.mirrorState(S('chest', { facing: 'east' }), 'z')).toBe(S('chest', { facing: 'east' }));
    expect(R.mirrorState(S('piston', { facing: 'west' }), 'x')).toBe(S('piston', { facing: 'east' }));
    expect(R.mirrorState(S('piston', { facing: 'south' }), 'z')).toBe(S('piston', { facing: 'north' }));
    for (const a of ['x', 'z'] as const) {
      expect(R.mirrorState(S('piston', { facing: 'up' }), a)).toBe(S('piston', { facing: 'up' }));
      expect(R.mirrorState(S('piston', { facing: 'down' }), a)).toBe(S('piston', { facing: 'down' }));
      expect(R.mirrorState(S('gate', { hinge: 'left' }), a)).toBe(S('gate', { hinge: 'right' }));
      expect(R.mirrorState(S('gate', { hinge: 'right' }), a)).toBe(S('gate', { hinge: 'left' }));
      for (const v of ['x', 'y', 'z']) expect(R.mirrorState(S('log', { axis: v }), a)).toBe(S('log', { axis: v }));
      for (const v of ['bottom', 'top']) expect(R.mirrorState(S('half_block', { half: v }), a)).toBe(S('half_block', { half: v }));
      for (const v of ['false', 'true']) expect(R.mirrorState(S('trapdoor', { open: v }), a)).toBe(S('trapdoor', { open: v }));
      for (const v of ['bottom', 'top', 'double']) expect(R.mirrorState(S('slab', { type: v }), a)).toBe(S('slab', { type: v }));
      expect(R.mirrorState(0, a)).toBe(0);
    }
    expect(R.mirrorState(S('door', { facing: 'east', half: 'top', open: 'true', hinge: 'left' }), 'x'))
      .toBe(S('door', { facing: 'west', half: 'top', open: 'true', hinge: 'right' }));
  });

  test('mirroring twice is the identity', () => {
    for (const s of allStates()) for (const a of ['x', 'z'] as const) expect(R.mirrorState(R.mirrorState(s, a), a)).toBe(s);
  });
});

describe('withType (§2.2)', () => {
  test('keeps a shared property of the same kind', () => {
    expect(R.withType(S('door', { facing: 'east', open: 'true' }), T('chest'))).toBe(S('chest', { facing: 'east' }));
    expect(R.withType(S('pillar', { axis: 'z', half: 'bottom' }), T('log'))).toBe(S('log', { axis: 'z' }));
    expect(R.withType(S('log', { axis: 'x' }), T('pillar'))).toBe(S('pillar', { axis: 'x', half: 'top' }));
    expect(R.withType(S('half_block', { half: 'top' }), T('door'))).toBe(S('door', { half: 'top' }));
  });

  test('defaults a same-named property of another kind, and every property the source lacks', () => {
    expect(R.withType(S('piston', { facing: 'up' }), T('chest'))).toBe(S('chest'));
    expect(R.withType(S('piston', { facing: 'east' }), T('chest'))).toBe(S('chest'));
    expect(R.withType(S('chest', { facing: 'east' }), T('piston'))).toBe(S('piston'));
    expect(R.withType(0, T('door'))).toBe(S('door'));
    expect(R.withType(S('door', { facing: 'west' }), T('air'))).toBe(0);
  });

  test('to its own type it is the identity', () => {
    for (const s of allStates()) expect(R.withType(s, R.STATE_TYPE[s]!)).toBe(s);
  });
});

describe('per-state tables (SoA, sized MAX_STATES)', () => {
  test('constants and functions of the state properties', () => {
    expect(MAX_STATES).toBe(4096);
    for (const tab of [R.OPACITY, R.PASS, R.SHAPE, R.FULL_FACES, R.EMIT, R.CARVABLE, R.REPLACEABLE, R.COLLIDE, R.FLUID_MODE, R.TINT, R.SOUND]) {
      expect(tab).toBeInstanceOf(Uint8Array);
      expect(tab.length).toBe(MAX_STATES);
    }
    expect(R.STATE_TYPE).toBeInstanceOf(Uint16Array);
    expect(R.FACE_TEX).toBeInstanceOf(Uint16Array);
    expect(R.FACE_TEX.length).toBe(MAX_STATES * 6);
    const air = 0;
    expect([R.OPACITY[air], R.PASS[air], R.SHAPE[air], R.FULL_FACES[air], R.CARVABLE[air], R.REPLACEABLE[air], R.COLLIDE[air],
      R.FLUID_MODE[air], R.SOUND[air]]).toEqual([0, PASS_NONE, SHAPE_NONE, 0, 0, 1, COLLIDE_NONE, FLUID_MODE_DISPLACE, SOUND_NONE]);
    const log = S('log', { axis: 'z' });
    expect([R.OPACITY[log], R.PASS[log], R.SHAPE[log], R.FULL_FACES[log], R.CARVABLE[log], R.REPLACEABLE[log], R.COLLIDE[log],
      R.FLUID_MODE[log], R.SOUND[log], R.TINT[log], R.EMIT[log]]).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, 63, 1, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, SOUND_WOOD, TINT_NONE, 0]);
    expect(R.OPACITY[S('trapdoor', { open: 'true' })]).toBe(0);
    expect(R.OPACITY[S('trapdoor', { open: 'false' })]).toBe(1);
    expect(R.COLLIDE[S('trapdoor', { open: 'true' })]).toBe(COLLIDE_NONE);
    expect(R.COLLIDE[S('trapdoor', { open: 'false' })]).toBe(COLLIDE_BOXES);
    expect(R.PASS[S('trapdoor')]).toBe(PASS_CUTOUT);
    expect(R.EMIT[S('gate', { hinge: 'right' })]).toBe(7);
    expect(R.FULL_FACES[S('slab', { type: 'top' })]).toBe(1 << FACE_UP);
    expect(R.FULL_FACES[S('slab', { type: 'bottom' })]).toBe(1 << FACE_DOWN);
    expect(R.FULL_FACES[S('slab', { type: 'double' })]).toBe(ALL_FACES);
    expect(R.SHAPE[S('half_block')]).toBe(SHAPE_BOX);
    expect(R.TINT[S('pillar', { axis: 'x' })]).toBe(TINT_FOLIAGE);
    expect(R.FLUID_MODE[S('door')]).toBe(FLUID_MODE_HOLD);
  });

  test('FACE_TEX[state·6 + i] is face i; a constant fills all six', () => {
    const up = S('piston', { facing: 'up' });
    expect(Array.from(R.FACE_TEX.subarray(up * 6, up * 6 + 6))).toEqual([2, 2, 2, 2, 1, 2]);
    const east = S('piston', { facing: 'east' });
    expect(R.FACE_TEX[east * 6 + FACE_EAST]).toBe(1);
    expect(R.FACE_TEX[east * 6 + FACE_NORTH]).toBe(2);
    const log = S('log');
    expect(Array.from(R.FACE_TEX.subarray(log * 6, log * 6 + 6))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('entries past the last state stay 0', () => {
    for (const tab of [R.OPACITY, R.FULL_FACES, R.STATE_TYPE, R.SOUND]) expect(tab.subarray(R.stateCount).every((v) => v === 0)).toBe(true);
  });
});

describe('buildRegistry checks', () => {
  const opens = (n: number, name = 'many'): BlockDef => ({
    name, props: Array.from({ length: n }, (_, i): PropertyDef => ({ name: `o${i}`, kind: 'open', default: 'false' })), ...SOLID_TABLES,
  });

  test('MAX_STATES: exactly 4096 states build, one more throws', () => {
    const full = buildRegistry([opens(12)]);
    expect(full.stateCount).toBe(4096);
    expect(full.STATE_TYPE.length).toBe(MAX_STATES);
    expect(full.stateKey(4095)).toBe(`many[${Array.from({ length: 12 }, (_, i) => `o${i}=true`).join(',')}]`);
    expect(() => buildRegistry([opens(12), { name: 'air', ...AIR_TABLES }])).toThrow(/4096/);
    expect(() => buildRegistry([opens(13)])).toThrow(/4096/);
  });

  test('names, kinds and defaults', () => {
    const solid = (d: Partial<BlockDef> & { name: string }): BlockDef => ({ ...SOLID_TABLES, ...d });
    expect(() => buildRegistry([])).toThrow(/at least one/);
    expect(() => buildRegistry([solid({ name: 'Stone' })])).toThrow(/name/);
    expect(() => buildRegistry([solid({ name: '1stone' })])).toThrow(/name/);
    expect(() => buildRegistry([solid({ name: 'stone' }), solid({ name: 'stone' })])).toThrow(/duplicate/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'Axis', kind: 'axis', default: 'y' }] })])).toThrow(/name/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'a', kind: 'axis', default: 'y' }, { name: 'a', kind: 'half', default: 'top' }] })])).toThrow(/duplicate/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'a', kind: 'axis', default: 'w' }] })])).toThrow(/default/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'a', kind: 'color' as never, default: 'red' }] })])).toThrow(/kind/);
  });

  test('table values', () => {
    const bad = (d: Partial<BlockDef>) => () => buildRegistry([{ ...SOLID_TABLES, name: 'x', ...d } as BlockDef]);
    expect(bad({ opacity: 7 as never })).toThrow(/opacity/);
    expect(bad({ pass: 'glass' as never })).toThrow(/pass/);
    expect(bad({ shape: 'sphere' as never })).toThrow(/shape/);
    expect(bad({ collide: 'mesh' as never })).toThrow(/collide/);
    expect(bad({ fluidMode: 'flow' as never })).toThrow(/fluidMode/);
    expect(bad({ tint: 'red' as never })).toThrow(/tint/);
    expect(bad({ sound: 'boom' as never })).toThrow(/sound/);
    expect(bad({ fullFaces: 64 })).toThrow(/fullFaces/);
    expect(bad({ fullFaces: 1.5 })).toThrow(/fullFaces/);
    expect(bad({ emit: 16 })).toThrow(/emit/);
    expect(bad({ emit: -1 })).toThrow(/emit/);
    expect(bad({ faceTex: [0, 0, 0, 0, 0] })).toThrow(/faceTex/);
    expect(bad({ faceTex: 65536 })).toThrow(/faceTex/);
    expect(bad({ carvable: 1 as never })).toThrow(/carvable/);
    expect(bad({ opacity: (p) => (p['o'] === 'true' ? 3 : 0) as never, props: [{ name: 'o', kind: 'open', default: 'false' }] })).toThrow(/opacity.*x\[o=true\]/);
  });
});

describe('API errors', () => {
  test('unknown types, properties, values and states', () => {
    expect(() => R.typeId('stone')).toThrow(/stone/);
    expect(() => R.typeName(R.typeCount)).toThrow(RangeError);
    expect(() => R.stateOf(T('log'), { facing: 'north' })).toThrow(/facing/);
    expect(() => R.stateOf(T('log'), { axis: 'w' })).toThrow(/axis/);
    expect(() => R.stateOf(R.typeCount)).toThrow(RangeError);
    expect(() => R.withProp(S('log'), 'half', 'top')).toThrow(/half/);
    expect(() => R.withProp(S('log'), 'axis', 'up')).toThrow(/up/);
    for (const s of [-1, R.stateCount, 1.5, Number.NaN]) {
      expect(() => R.propsOf(s)).toThrow(RangeError);
      expect(() => R.stateKey(s)).toThrow(RangeError);
      expect(() => R.rotateState(s, 1)).toThrow(RangeError);
      expect(() => R.mirrorState(s, 'x')).toThrow(RangeError);
    }
    expect(() => R.rotateState(0, 0.5)).toThrow(RangeError);
    expect(() => R.mirrorState(0, 'y' as never)).toThrow(/axis/);
    expect(() => R.withType(0, -1)).toThrow(RangeError);
  });

  test('parseStateKey accepts only canonical keys of registered states', () => {
    for (const k of ['stone', 'log', 'log[]', 'log[axis=w]', 'log[axis=y ]', 'door[facing=north]',
      'door[half=bottom,facing=north,open=false,hinge=left]', 'air[]', 'pillar[axis=x, half=top]']) {
      expect(() => R.parseStateKey(k), k).toThrow(/state key/);
    }
  });

  test('the registry object is frozen', () => {
    expect(Object.isFrozen(R)).toBe(true);
  });
});
```

Create `test/unit/fluidLight.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  FLUID_LAVA, FLUID_NONE, FLUID_WATER, fluidFalling, fluidLevel, fluidType, fluidUnsettled, hasFluid, NO_FLUID, packFluid,
  WATER_SOURCE,
} from '../../src/world/blocks/fluid';
import { blockLight, MAX_LIGHT, packLight, skyLight } from '../../src/world/blocks/light';

describe('fluid byte (SP3a spec §2.1)', () => {
  test('bits 0-2 level, bit 3 falling, bits 4-5 type, bit 6 unsettled, bit 7 reserved', () => {
    expect([FLUID_NONE, FLUID_WATER, FLUID_LAVA]).toEqual([0, 1, 2]);
    expect(NO_FLUID).toBe(0);
    expect(packFluid(FLUID_NONE, 0)).toBe(0);
    expect(packFluid(FLUID_NONE, 7)).toBe(0b0000_0111);
    expect(packFluid(FLUID_NONE, 0, true)).toBe(0b0000_1000);
    expect(packFluid(FLUID_WATER, 0)).toBe(0b0001_0000);
    expect(packFluid(FLUID_LAVA, 0)).toBe(0b0010_0000);
    expect(packFluid(FLUID_NONE, 0, false, true)).toBe(0b0100_0000);
    expect(packFluid(FLUID_LAVA, 5, true, true)).toBe(0b0110_1101);
    expect(WATER_SOURCE).toBe(packFluid(FLUID_WATER, 0));
    expect(WATER_SOURCE).toBe(16);
  });

  test('pack and unpack round-trip over every byte with bit 7 clear', () => {
    for (let b = 0; b < 128; b++) {
      expect(packFluid(fluidType(b), fluidLevel(b), fluidFalling(b), fluidUnsettled(b))).toBe(b);
    }
  });

  test('fields read back; bit 7 is ignored by the readers and never set by packFluid', () => {
    for (const type of [0, 1, 2, 3]) {
      for (let level = 0; level < 8; level++) {
        for (const falling of [false, true]) {
          for (const unsettled of [false, true]) {
            const b = packFluid(type, level, falling, unsettled);
            expect(b & 0x80).toBe(0);
            for (const x of [b, b | 0x80]) {
              expect(fluidType(x)).toBe(type);
              expect(fluidLevel(x)).toBe(level);
              expect(fluidFalling(x)).toBe(falling);
              expect(fluidUnsettled(x)).toBe(unsettled);
              expect(hasFluid(x)).toBe(type !== 0);
            }
          }
        }
      }
    }
  });

  test('out-of-range fields are masked to their width', () => {
    expect(packFluid(FLUID_WATER, 9)).toBe(packFluid(FLUID_WATER, 1));
    expect(packFluid(5, 0)).toBe(packFluid(1, 0));
  });
});

describe('light byte (SP3a spec §2.1)', () => {
  test('sky << 4 | block, round trip over every byte', () => {
    expect(MAX_LIGHT).toBe(15);
    expect(packLight(15, 0)).toBe(0xf0);
    expect(packLight(0, 15)).toBe(0x0f);
    expect(packLight(3, 12)).toBe(0x3c);
    for (let b = 0; b < 256; b++) {
      expect(packLight(skyLight(b), blockLight(b))).toBe(b);
      expect(skyLight(b)).toBe(b >> 4);
      expect(blockLight(b)).toBe(b & 15);
    }
    expect(packLight(16, 17)).toBe(packLight(0, 1));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/banned.test.ts test/unit/blockRegistry.test.ts test/unit/fluidLight.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× bad fixture tree reports every banned use 22ms
FAIL  |unit| test/unit/blockRegistry.test.ts [ test/unit/blockRegistry.test.ts ]
Error: Cannot find module '../../src/world/blocks/kinds' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/blockRegistry.test.ts
FAIL  |unit| test/unit/fluidLight.test.ts [ test/unit/fluidLight.test.ts ]
Error: Cannot find module '../../src/world/blocks/fluid' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/fluidLight.test.ts
FAIL  |arch| test/arch/banned.test.ts > bad fixture tree reports every banned use
AssertionError: expected [ …(49) ] to deeply equal [ …(55) ]
Test Files  3 failed (3)
Tests  1 failed | 25 passed (26)
```

- [ ] **Step 3: Implement**

Create `src/world/blocks/fluid.ts`:

```ts
/**
 * The fluid byte (SP3a spec §2.1, frozen): bits 0-2 level (0 = source … 7), bit 3 falling, bits 4-5 type (0 none,
 * 1 water, 2 lava), bit 6 unsettled, bit 7 reserved (never set by `packFluid`, ignored by the readers). A pure fluid
 * voxel is `air` plus a fluid byte; the fluid byte of a waterlogged block is its waterlogging.
 */

export const FLUID_NONE = 0;
export const FLUID_WATER = 1;
export const FLUID_LAVA = 2;
/** The byte of a voxel without fluid. */
export const NO_FLUID = 0;
/** A still water source: type water, level 0, not falling, settled. */
export const WATER_SOURCE = 16;

/** Packs the fields; each is masked to its width (type 2 bits, level 3 bits). */
export const packFluid = (type: number, level: number, falling = false, unsettled = false): number =>
  (level & 7) | (falling ? 8 : 0) | ((type & 3) << 4) | (unsettled ? 64 : 0);
/** Level: 0 = source, 1 … 7 flowing. */
export const fluidLevel = (b: number): number => b & 7;
export const fluidFalling = (b: number): boolean => (b & 8) !== 0;
/** Type: 0 none, 1 water, 2 lava. */
export const fluidType = (b: number): number => (b >> 4) & 3;
export const fluidUnsettled = (b: number): boolean => (b & 64) !== 0;
/** True when the voxel holds a fluid (type ≠ 0). */
export const hasFluid = (b: number): boolean => (b & 48) !== 0;
```

Create `src/world/blocks/kinds.ts`:

```ts
/**
 * Property kinds, enum codes and the face order of the block registry (SP3a spec §2.1, §2.2). Frozen from SP3a: a
 * code is the 0-based index of its value in the lists below, and no list ever changes (new kinds or tables append).
 */

/** The property kinds, in kind order. */
export const PROPERTY_KINDS = Object.freeze(['axis', 'facing4', 'facing6', 'half', 'open', 'hinge', 'slabType'] as const);
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/**
 * Each kind's values in kind order; a value's code is its index. Horizontal facings run clockwise seen from +y
 * (north = −z, east = +x, south = +z, west = −x), so a clockwise quarter turn adds 1 mod 4.
 */
export const KIND_VALUES: Readonly<Record<PropertyKind, readonly string[]>> = Object.freeze({
  axis: Object.freeze(['x', 'y', 'z']),
  facing4: Object.freeze(['north', 'east', 'south', 'west']),
  facing6: Object.freeze(['north', 'east', 'south', 'west', 'up', 'down']),
  half: Object.freeze(['bottom', 'top']),
  open: Object.freeze(['false', 'true']),
  hinge: Object.freeze(['left', 'right']),
  slabType: Object.freeze(['bottom', 'top', 'double']),
});

/** Faces: face i is the facing6 value i; `FULL_FACES` bit i is face i; `FACE_TEX[state·6 + i]` is face i's texture. */
export const FACE_NAMES = KIND_VALUES.facing6;
export const FACE_NORTH = 0;
export const FACE_EAST = 1;
export const FACE_SOUTH = 2;
export const FACE_WEST = 3;
export const FACE_UP = 4;
export const FACE_DOWN = 5;
export const FACE_COUNT = 6;
/** `FULL_FACES` of a full cube. */
export const ALL_FACES = 63;

/** Render pass (`PASS`). */
export const PASS_VALUES = Object.freeze(['none', 'opaque', 'cutout', 'translucent'] as const);
export type Pass = (typeof PASS_VALUES)[number];
export const PASS_NONE = 0;
export const PASS_OPAQUE = 1;
export const PASS_CUTOUT = 2;
export const PASS_TRANSLUCENT = 3;

/** Model shape (`SHAPE`); `none` is air's (SP3a spec §11 amends the master). */
export const SHAPE_VALUES = Object.freeze(['none', 'cube', 'cross', 'fluid', 'pointed', 'box'] as const);
export type Shape = (typeof SHAPE_VALUES)[number];
export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_FLUID = 3;
export const SHAPE_POINTED = 4;
export const SHAPE_BOX = 5;

/** Collision (`COLLIDE`). */
export const COLLIDE_VALUES = Object.freeze(['none', 'cube', 'boxes'] as const);
export type Collide = (typeof COLLIDE_VALUES)[number];
export const COLLIDE_NONE = 0;
export const COLLIDE_CUBE = 1;
export const COLLIDE_BOXES = 2;

/** How the block meets a fluid (`FLUID_MODE`). */
export const FLUID_MODE_VALUES = Object.freeze(['block', 'hold', 'displace'] as const);
export type FluidMode = (typeof FLUID_MODE_VALUES)[number];
export const FLUID_MODE_BLOCK = 0;
export const FLUID_MODE_HOLD = 1;
export const FLUID_MODE_DISPLACE = 2;

/** Colour tint (`TINT`). */
export const TINT_VALUES = Object.freeze(['none', 'grass', 'foliage', 'water', 'fixed'] as const);
export type Tint = (typeof TINT_VALUES)[number];
export const TINT_NONE = 0;
export const TINT_GRASS = 1;
export const TINT_FOLIAGE = 2;
export const TINT_WATER = 3;
export const TINT_FIXED = 4;

/** Step and break sound (`SOUND`); `none` is air's and never played (SP3a spec §11 amends the master). */
export const SOUND_VALUES = Object.freeze(['none', 'stone', 'dirt', 'grass', 'sand', 'gravel', 'wood', 'snow', 'glass', 'leaves', 'metal', 'abyss'] as const);
export type Sound = (typeof SOUND_VALUES)[number];
export const SOUND_NONE = 0;
export const SOUND_STONE = 1;
export const SOUND_DIRT = 2;
export const SOUND_GRASS = 3;
export const SOUND_SAND = 4;
export const SOUND_GRAVEL = 5;
export const SOUND_WOOD = 6;
export const SOUND_SNOW = 7;
export const SOUND_GLASS = 8;
export const SOUND_LEAVES = 9;
export const SOUND_METAL = 10;
export const SOUND_ABYSS = 11;
```

Create `src/world/blocks/light.ts`:

```ts
/** The light byte (SP3a spec §2.1, frozen): `sky << 4 | block`, each level 0 … 15. */

export const MAX_LIGHT = 15;

/** Packs sky and block light; each is masked to 4 bits. */
export const packLight = (sky: number, block: number): number => ((sky & 15) << 4) | (block & 15);
export const skyLight = (b: number): number => (b >> 4) & 15;
export const blockLight = (b: number): number => b & 15;
```

Create `src/world/blocks/registry.ts`:

```ts
/**
 * The block registry engine (SP3a spec §2.1-2.3, frozen from SP3a). `buildRegistry(defs)` numbers the states, fills
 * the per-state tables (SoA, sized MAX_STATES) and returns the lookup API. The real definitions live in `defs.ts`;
 * tests build fixture registries from their own definitions.
 *
 * Ids: types and states follow the definition order, from 0. A type's states are contiguous with its default first:
 * number the property combinations in mixed-radix order (properties in declaration order, values in kind order, the
 * last property varying fastest); with k a combination's number and d the default's, the state id is
 * `base + (k = d ? 0 : k < d ? k + 1 : k)`, and `DEFAULT_STATE[type] = base`.
 *
 * Canonical key: the bare type name without properties, else `name[p1=v1,p2=v2,…]` listing every property in
 * declaration order, values spelled as their kind value names, no spaces.
 */
import {
  COLLIDE_VALUES, FLUID_MODE_VALUES, KIND_VALUES, PASS_VALUES, PROPERTY_KINDS, SHAPE_VALUES, SOUND_VALUES, TINT_VALUES,
  type Collide, type FluidMode, type Pass, type PropertyKind, type Shape, type Sound, type Tint,
} from './kinds';

const KINDS = KIND_VALUES;
const KIND_LIST = PROPERTY_KINDS;
const PASSES = PASS_VALUES;
const SHAPES = SHAPE_VALUES;
const COLLIDES = COLLIDE_VALUES;
const FLUID_MODES = FLUID_MODE_VALUES;
const TINTS = TINT_VALUES;
const SOUNDS = SOUND_VALUES;

/** Block states are u16, at most 4096 of them; every per-state table has this length. */
export const MAX_STATES = 4096;
const FACES = 6;
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** A state's properties by name, each value spelled as its kind value name. */
export type PropValues = Readonly<Record<string, string>>;
/** A per-state table value: a constant, or a function of the state's properties. */
export type PerState<T> = T | ((props: PropValues) => T);

export interface PropertyDef {
  /** Unique within the type; matches `[a-z][a-z0-9_]*`. */
  readonly name: string;
  readonly kind: PropertyKind;
  /** One of the kind's values. */
  readonly default: string;
}

/** The per-state table values of a definition (codes in SP3a spec §2.1). */
export interface StateTables {
  /** 0 (transparent), 1 (filters) or 15 (opaque). */
  readonly opacity: PerState<0 | 1 | 15>;
  readonly pass: PerState<Pass>;
  readonly shape: PerState<Shape>;
  /** Bit i: face i is a full face (0 … 63). */
  readonly fullFaces: PerState<number>;
  /** Emitted block light, 0 … 15. */
  readonly emit: PerState<number>;
  readonly carvable: PerState<boolean>;
  readonly replaceable: PerState<boolean>;
  readonly collide: PerState<Collide>;
  readonly fluidMode: PerState<FluidMode>;
  readonly tint: PerState<Tint>;
  readonly sound: PerState<Sound>;
  /** Texture ids (u16): one for all six faces, or six in face order. */
  readonly faceTex: PerState<number | readonly number[]>;
}

export interface BlockDef extends StateTables {
  /** Matches `[a-z][a-z0-9_]*`; unique in the registry. */
  readonly name: string;
  /** In declaration order; none for a single-state type. */
  readonly props?: readonly PropertyDef[];
}

export interface BlockRegistry {
  readonly typeCount: number;
  readonly stateCount: number;
  /** Per type: the type name. */
  readonly TYPE_NAMES: readonly string[];
  /** Per type: its default state, which is also its first id. */
  readonly DEFAULT_STATE: Uint16Array;
  // Per-state tables, sized MAX_STATES (entries past stateCount are 0). Never written after the build.
  readonly STATE_TYPE: Uint16Array;
  readonly OPACITY: Uint8Array;
  readonly PASS: Uint8Array;
  readonly SHAPE: Uint8Array;
  readonly FULL_FACES: Uint8Array;
  readonly EMIT: Uint8Array;
  readonly CARVABLE: Uint8Array;
  readonly REPLACEABLE: Uint8Array;
  readonly COLLIDE: Uint8Array;
  readonly FLUID_MODE: Uint8Array;
  readonly TINT: Uint8Array;
  readonly SOUND: Uint8Array;
  /** `FACE_TEX[state·6 + face]`, MAX_STATES × 6 entries. */
  readonly FACE_TEX: Uint16Array;
  /** Type id of a name; throws for an unknown name. */
  typeId(name: string): number;
  typeName(type: number): string;
  typeProperties(type: number): readonly PropertyDef[];
  /** The state of `type` with `props`; missing props take the defaults; unknown props or values throw. */
  stateOf(type: number, props?: PropValues): number;
  /** A frozen object with every property of the state's type, in declaration order. */
  propsOf(state: number): PropValues;
  withProp(state: number, prop: string, value: string): number;
  /**
   * The state of `type` that keeps each property the target declares with the same name and the same kind; every
   * other property takes the target's default.
   */
  withType(state: number, type: number): number;
  /**
   * Turns clockwise seen from +y by ((quarterTurns mod 4) + 4) mod 4 quarter turns: facing4 and facing6 step north →
   * east → south → west per turn (up and down stay), axis swaps x ↔ z on odd turns; other kinds are unchanged.
   */
  rotateState(state: number, quarterTurns: number): number;
  /**
   * 'x' negates x (east ↔ west), 'z' negates z (north ↔ south); up and down stay; hinge flips left ↔ right on either
   * axis; axis, half, open and slabType are unchanged.
   */
  mirrorState(state: number, axis: 'x' | 'z'): number;
  stateKey(state: number): string;
  /** The state whose canonical key is `key`; throws for any other string. */
  parseStateKey(key: string): number;
}

interface TypeInfo {
  readonly name: string;
  readonly props: readonly PropertyDef[];
  readonly propIndex: ReadonlyMap<string, number>;
  readonly radix: readonly number[];
  readonly stride: readonly number[];
  readonly defaultCodes: readonly number[];
  readonly defaultCombo: number;
  readonly base: number;
  readonly count: number;
}

const fail = (message: string): never => {
  throw new Error(`buildRegistry: ${message}`);
};

function typeInfo(def: BlockDef, base: number): TypeInfo {
  if (!NAME_RE.test(def.name)) fail(`type name "${def.name}" does not match [a-z][a-z0-9_]*`);
  const props = Object.freeze((def.props ?? []).map((p) => Object.freeze({ name: p.name, kind: p.kind, default: p.default })));
  const propIndex = new Map<string, number>();
  const radix: number[] = [];
  const defaultCodes: number[] = [];
  let count = 1;
  props.forEach((p, i) => {
    if (!NAME_RE.test(p.name)) fail(`property name "${p.name}" of ${def.name} does not match [a-z][a-z0-9_]*`);
    if (propIndex.has(p.name)) fail(`duplicate property ${p.name} in ${def.name}`);
    if (!KIND_LIST.includes(p.kind)) fail(`unknown kind ${String(p.kind)} of ${def.name}.${p.name}`);
    const code = KINDS[p.kind].indexOf(p.default);
    if (code < 0) fail(`default ${p.default} of ${def.name}.${p.name} is not a ${p.kind} value`);
    propIndex.set(p.name, i);
    radix.push(KINDS[p.kind].length);
    defaultCodes.push(code);
    count *= KINDS[p.kind].length;
    if (count > MAX_STATES) throw new RangeError(`buildRegistry: ${def.name} alone has more than ${MAX_STATES} states (MAX_STATES)`);
  });
  const stride: number[] = new Array<number>(props.length);
  let defaultCombo = 0;
  for (let i = props.length - 1, s = 1; i >= 0; s *= radix[i]!, i--) {
    stride[i] = s;
    defaultCombo += defaultCodes[i]! * s;
  }
  return { name: def.name, props, propIndex, radix, stride, defaultCodes, defaultCombo, base, count };
}

const stateOfCombo = (t: TypeInfo, k: number): number =>
  t.base + (k === t.defaultCombo ? 0 : k < t.defaultCombo ? k + 1 : k);

function comboOfCodes(t: TypeInfo, codes: readonly number[]): number {
  let k = 0;
  for (let i = 0; i < codes.length; i++) k += codes[i]! * t.stride[i]!;
  return k;
}

function codesOfCombo(t: TypeInfo, k: number): number[] {
  const codes: number[] = [];
  for (let i = 0; i < t.radix.length; i++) codes.push(Math.floor(k / t.stride[i]!) % t.radix[i]!);
  return codes;
}

const perState = <T>(v: PerState<T>, props: PropValues): T =>
  typeof v === 'function' ? (v as (p: PropValues) => T)(props) : v;

function enumCode(list: readonly string[], v: unknown, field: string, key: string): number {
  const i = typeof v === 'string' ? list.indexOf(v) : -1;
  if (i < 0) fail(`${field} of ${key} is ${String(v)} (expected one of ${list.join(', ')})`);
  return i;
}

function intIn(v: unknown, lo: number, hi: number, field: string, key: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) fail(`${field} of ${key} is ${String(v)} (expected an integer in [${lo}, ${hi}])`);
  return v as number;
}

function flag(v: unknown, field: string, key: string): number {
  if (typeof v !== 'boolean') fail(`${field} of ${key} is ${String(v)} (expected a boolean)`);
  return v ? 1 : 0;
}

export function buildRegistry(defs: readonly BlockDef[]): BlockRegistry {
  if (defs.length === 0) fail('a registry needs at least one block type');
  const types: TypeInfo[] = [];
  const typeIds = new Map<string, number>();
  let stateCount = 0;
  for (const def of defs) {
    const t = typeInfo(def, stateCount);
    if (typeIds.has(t.name)) fail(`duplicate type name ${t.name}`);
    if (stateCount + t.count > MAX_STATES) throw new RangeError(`buildRegistry: more than ${MAX_STATES} states (MAX_STATES) at ${t.name}`);
    typeIds.set(t.name, types.length);
    types.push(t);
    stateCount += t.count;
  }
  const typeCount = types.length;

  const STATE_TYPE = new Uint16Array(MAX_STATES);
  const OPACITY = new Uint8Array(MAX_STATES);
  const PASS = new Uint8Array(MAX_STATES);
  const SHAPE = new Uint8Array(MAX_STATES);
  const FULL_FACES = new Uint8Array(MAX_STATES);
  const EMIT = new Uint8Array(MAX_STATES);
  const CARVABLE = new Uint8Array(MAX_STATES);
  const REPLACEABLE = new Uint8Array(MAX_STATES);
  const COLLIDE = new Uint8Array(MAX_STATES);
  const FLUID_MODE = new Uint8Array(MAX_STATES);
  const TINT = new Uint8Array(MAX_STATES);
  const SOUND = new Uint8Array(MAX_STATES);
  const FACE_TEX = new Uint16Array(MAX_STATES * FACES);
  const DEFAULT_STATE = new Uint16Array(typeCount);
  const combo = new Uint16Array(stateCount);
  const codes: (readonly number[])[] = new Array<readonly number[]>(stateCount);
  const props: PropValues[] = new Array<PropValues>(stateCount);
  const keys: string[] = new Array<string>(stateCount);
  const keyIds = new Map<string, number>();

  types.forEach((t, ti) => {
    const def = defs[ti]!;
    DEFAULT_STATE[ti] = t.base;
    for (let k = 0; k < t.count; k++) {
      const s = stateOfCombo(t, k);
      const c = codesOfCombo(t, k);
      const p: Record<string, string> = {};
      t.props.forEach((pd, i) => { p[pd.name] = KINDS[pd.kind][c[i]!]!; });
      const key = t.props.length === 0 ? t.name : `${t.name}[${t.props.map((pd) => `${pd.name}=${p[pd.name]!}`).join(',')}]`;
      STATE_TYPE[s] = ti;
      combo[s] = k;
      codes[s] = Object.freeze(c);
      props[s] = Object.freeze(p);
      keys[s] = key;
      keyIds.set(key, s);

      const opacity = perState(def.opacity, props[s]!);
      if (opacity !== 0 && opacity !== 1 && opacity !== 15) fail(`opacity of ${key} is ${String(opacity)} (expected 0, 1 or 15)`);
      OPACITY[s] = opacity;
      PASS[s] = enumCode(PASSES, perState(def.pass, props[s]!), 'pass', key);
      SHAPE[s] = enumCode(SHAPES, perState(def.shape, props[s]!), 'shape', key);
      FULL_FACES[s] = intIn(perState(def.fullFaces, props[s]!), 0, 63, 'fullFaces', key);
      EMIT[s] = intIn(perState(def.emit, props[s]!), 0, 15, 'emit', key);
      CARVABLE[s] = flag(perState(def.carvable, props[s]!), 'carvable', key);
      REPLACEABLE[s] = flag(perState(def.replaceable, props[s]!), 'replaceable', key);
      COLLIDE[s] = enumCode(COLLIDES, perState(def.collide, props[s]!), 'collide', key);
      FLUID_MODE[s] = enumCode(FLUID_MODES, perState(def.fluidMode, props[s]!), 'fluidMode', key);
      TINT[s] = enumCode(TINTS, perState(def.tint, props[s]!), 'tint', key);
      SOUND[s] = enumCode(SOUNDS, perState(def.sound, props[s]!), 'sound', key);
      const tex = perState(def.faceTex, props[s]!);
      if (typeof tex === 'number') {
        const v = intIn(tex, 0, 65535, 'faceTex', key);
        for (let f = 0; f < FACES; f++) FACE_TEX[s * FACES + f] = v;
      } else {
        if (!Array.isArray(tex) || tex.length !== FACES) fail(`faceTex of ${key} must be a number or ${FACES} numbers`);
        for (let f = 0; f < FACES; f++) FACE_TEX[s * FACES + f] = intIn(tex[f], 0, 65535, 'faceTex', key);
      }
    }
  });

  const typeOfState = (s: number): TypeInfo => types[STATE_TYPE[s]!]!;
  const stateOfCodes = (t: TypeInfo, c: readonly number[]): number => stateOfCombo(t, comboOfCodes(t, c));

  // Rotation (q = 0 … 3) and mirror tables, built once.
  const turn = (s: number): number => {
    const t = typeOfState(s);
    const c = codes[s]!.map((v, i) => {
      const kind = t.props[i]!.kind;
      if ((kind === 'facing4' || kind === 'facing6') && v < 4) return (v + 1) & 3;
      if (kind === 'axis') return v === 1 ? v : 2 - v; // x ↔ z
      return v;
    });
    return stateOfCodes(t, c);
  };
  const mirror = (s: number, swapA: number, swapB: number): number => {
    const t = typeOfState(s);
    const c = codes[s]!.map((v, i) => {
      const kind = t.props[i]!.kind;
      if (kind === 'facing4' || kind === 'facing6') return v === swapA ? swapB : v === swapB ? swapA : v;
      if (kind === 'hinge') return 1 - v;
      return v;
    });
    return stateOfCodes(t, c);
  };
  const rotations = new Uint16Array(4 * stateCount);
  const mirrorX = new Uint16Array(stateCount);
  const mirrorZ = new Uint16Array(stateCount);
  for (let s = 0; s < stateCount; s++) {
    rotations[s] = s;
    for (let q = 1; q < 4; q++) rotations[q * stateCount + s] = turn(rotations[(q - 1) * stateCount + s]!);
    mirrorX[s] = mirror(s, 1, 3);
    mirrorZ[s] = mirror(s, 0, 2);
  }

  const checkState = (s: number, fn: string): void => {
    if (!Number.isInteger(s) || s < 0 || s >= stateCount) throw new RangeError(`${fn}: no state ${s} (stateCount ${stateCount})`);
  };
  const checkType = (t: number, fn: string): TypeInfo => {
    if (!Number.isInteger(t) || t < 0 || t >= typeCount) throw new RangeError(`${fn}: no type ${t} (typeCount ${typeCount})`);
    return types[t]!;
  };
  const valueCode = (t: TypeInfo, prop: string, value: string, fn: string): [number, number] => {
    const i = t.propIndex.get(prop);
    if (i === undefined) throw new Error(`${fn}: ${t.name} has no property ${prop}`);
    const kind = t.props[i]!.kind;
    const code = KINDS[kind].indexOf(value);
    if (code < 0) throw new Error(`${fn}: ${value} is not a value of ${t.name}.${prop} (${kind})`);
    return [i, code];
  };

  const TYPE_NAMES = Object.freeze(types.map((t) => t.name));

  return Object.freeze({
    typeCount, stateCount, TYPE_NAMES, DEFAULT_STATE,
    STATE_TYPE, OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE, FLUID_MODE, TINT, SOUND, FACE_TEX,
    typeId(name: string): number {
      const t = typeIds.get(name);
      if (t === undefined) throw new Error(`typeId: unknown block type ${name}`);
      return t;
    },
    typeName(type: number): string {
      return checkType(type, 'typeName').name;
    },
    typeProperties(type: number): readonly PropertyDef[] {
      return checkType(type, 'typeProperties').props;
    },
    stateOf(type: number, p: PropValues = {}): number {
      const t = checkType(type, 'stateOf');
      const c = t.defaultCodes.slice();
      for (const name of Object.keys(p)) {
        const [i, code] = valueCode(t, name, p[name]!, 'stateOf');
        c[i] = code;
      }
      return stateOfCodes(t, c);
    },
    propsOf(state: number): PropValues {
      checkState(state, 'propsOf');
      return props[state]!;
    },
    withProp(state: number, prop: string, value: string): number {
      checkState(state, 'withProp');
      const t = typeOfState(state);
      const [i, code] = valueCode(t, prop, value, 'withProp');
      return stateOfCombo(t, combo[state]! + (code - codes[state]![i]!) * t.stride[i]!);
    },
    withType(state: number, type: number): number {
      checkState(state, 'withType');
      const target = checkType(type, 'withType');
      const source = typeOfState(state);
      const c = target.props.map((pd, j) => {
        const i = source.propIndex.get(pd.name);
        return i !== undefined && source.props[i]!.kind === pd.kind ? codes[state]![i]! : target.defaultCodes[j]!;
      });
      return stateOfCodes(target, c);
    },
    rotateState(state: number, quarterTurns: number): number {
      checkState(state, 'rotateState');
      if (!Number.isInteger(quarterTurns)) throw new RangeError(`rotateState: quarterTurns ${quarterTurns} is not an integer`);
      const q = ((quarterTurns % 4) + 4) % 4;
      return rotations[q * stateCount + state]!;
    },
    mirrorState(state: number, axis: 'x' | 'z'): number {
      checkState(state, 'mirrorState');
      if (axis === 'x') return mirrorX[state]!;
      if (axis === 'z') return mirrorZ[state]!;
      throw new Error(`mirrorState: axis must be 'x' or 'z', not ${String(axis)}`);
    },
    stateKey(state: number): string {
      checkState(state, 'stateKey');
      return keys[state]!;
    },
    parseStateKey(key: string): number {
      const s = keyIds.get(key);
      if (s === undefined) throw new Error(`parseStateKey: ${JSON.stringify(key)} is not the canonical state key of a registered state`);
      return s;
    },
  });
}
```

Modify `test/arch/rules/banned.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/rules/banned.ts b/test/arch/rules/banned.ts
index b14df10..72a7fce 100644
--- a/test/arch/rules/banned.ts
+++ b/test/arch/rules/banned.ts
@@ -14,8 +14,13 @@ const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign',
  * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4).
  */
 const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts', 'metrics/biomeShares.ts', 'metrics/liveness.ts', 'metrics/splineStats.ts', 'metrics/crossSection.ts']);
+/**
+ * Directories outside core/ and gen/ that follow the core determinism rules: the block registry, whose ids and tables
+ * are hashed into goldens (SP3a spec §2.5). The rest of world/ (the store) keeps the ND bans only.
+ */
+const DET_DIRS = ['world/blocks/'];
 /** Modules whose hot loops must not read imported bindings (vitest turns them into getters; SP1 spec §1.8, SP2a spec §8). */
-const HOT_PREFIXES = ['core/noise/', 'core/spline/', 'metrics/', 'gen/'];
+const HOT_PREFIXES = ['core/noise/', 'core/spline/', 'metrics/', 'gen/', ...DET_DIRS];
 /** Matches the member name alone, so `.normalize.call(…)` and `.localeCompare.bind(…)` are caught too (SP1 review minor). */
 const ENGINE_DEPENDENT = /\bIntl\b|\.\s*(?:localeCompare|toLocale\w*|normalize)\b|\bTextEncoder\b|\bTextDecoder\b/g;
 const IMPORT_STMT = /\bimport\s+(type\s+)?([\w$*{},\s]+?)\s+from\s*(['"])[^'"\n]+\3\s*;?/g;
@@ -172,7 +177,7 @@ export function checkBanned(files: readonly ScannedFile[]): Violation[] {
     }
     if (JS_EXTS.has(ext)) {
       const { code, codeKeepStrings } = f;
-      const detFile = DET_FILES.has(srcRel);
+      const detFile = DET_FILES.has(srcRel) || DET_DIRS.some((p) => srcRel.startsWith(p));
       if (ND_LAYERS.has(layer) || detFile) {
         for (const m of code.matchAll(/\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|\bconsole\s*\./g)) at(code, m.index, 'nondeterministic', `${m[0]} in ${layer}/`);
       }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/banned.test.ts test/unit/blockRegistry.test.ts test/unit/fluidLight.test.ts`

Expected: PASS (exit 0)

```
Test Files  3 passed (3)
Tests  61 passed (61)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  97 passed | 2 skipped (99)
Tests  1244 passed | 2 skipped (1246)
```

- [ ] **Step 6: Commit**

```bash
git add src/world/blocks/fluid.ts src/world/blocks/kinds.ts src/world/blocks/light.ts src/world/blocks/registry.ts test/arch/banned.test.ts test/arch/fixtures/banned/bad/src/world/blocks/direct.ts test/arch/fixtures/banned/bad/src/world/blocks/encoder.ts test/arch/fixtures/banned/bad/src/world/blocks/locale.ts test/arch/fixtures/banned/bad/src/world/blocks/ns.ts test/arch/fixtures/banned/bad/src/world/blocks/pow.ts test/arch/fixtures/banned/bad/src/world/blocks/trig.ts test/arch/fixtures/banned/bad/src/world/store/clock.ts test/arch/fixtures/banned/good/src/world/blocks/aliased.ts test/arch/fixtures/banned/good/src/world/store/free.ts test/arch/rules/banned.ts test/harness/blockFixtures.ts test/unit/blockRegistry.test.ts test/unit/fluidLight.test.ts
git commit -F - <<'EOF'
feat(world/blocks): property kinds, registry engine, fluid and light bytes

SP3a spec §2.1, §2.2, §2.4 (fixture registry), §2.5. buildRegistry(defs)
numbers the states (contiguous per type, default first, then mixed-radix),
fills the per-state SoA tables sized MAX_STATES and returns the lookup API
(stateOf/propsOf/withProp/withType/rotateState/mirrorState, canonical
stateKey/parseStateKey). world/blocks/** now follows the core determinism
rules in the arch checks (Math allowlist, no **, engine-dependent APIs,
top-level aliases for imported values), with fixture tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `ad1c092` on `dry/sp3a`; 18 files changed, 1035 insertions(+), 2 deletions(-)):

RED replay (`test/**` over the parent): `test/unit/blockRegistry.test.ts` and `test/unit/fluidLight.test.ts` fail to import `src/world/blocks/{kinds,fluid}` (2 files failed, no tests); `test/arch/banned.test.ts` passes in the replay because the rule change lives in `test/arch/rules/banned.ts` (inside `test/**`) — during TDD the extended bad-fixture test was watched failing first (the 6 `world/blocks` violations missing) before the rule edit. GREEN: typecheck clean; `npm test` 97 files passed, 2 skipped / 1244 tests passed, 2 skipped (≈30 s); the two new unit files 35 tests.

- Ruling: arch — `banned.ts` gains `DET_DIRS = ['world/blocks/']`; a file under it counts as `detFile` (Math allowlist, `**` ban, engine-dependent-API ban; the ND bans already cover all of `world/`) and `HOT_PREFIXES` gains it (hot-import alias rule, no namespace imports); `world/store/**` keeps the ND bans only. Fixtures: bad `world/blocks/{trig,pow,locale,encoder,direct,ns}.ts` and `world/store/clock.ts` (ND still applies to the store); good `world/blocks/aliased.ts` (aliased import, `export const STONE = 1` allowed: the numeric-export rule stays gen-only) and `world/store/free.ts` (`Math.hypot`, `**` and a direct imported call are allowed in the store) — cost if wrong: none (rule scope only).
- Ruling: `kinds.ts` holds the property kinds (`PROPERTY_KINDS`, `KIND_VALUES`, frozen) and every §2.1 code list as frozen `as const` arrays (`PASS_VALUES`, `SHAPE_VALUES`, `COLLIDE_VALUES`, `FLUID_MODE_VALUES`, `TINT_VALUES`, `SOUND_VALUES`) with their literal types (`Pass`, `Shape`, …) and one named numeric constant per code (`PASS_OPAQUE` 1, `SHAPE_CUBE` 1, `COLLIDE_NONE` 0, `FLUID_MODE_DISPLACE` 2, `SOUND_STONE` 1, …), plus the face order `FACE_NAMES` (= facing6 values), `FACE_NORTH` … `FACE_DOWN` 0-5, `FACE_COUNT` 6, `ALL_FACES` 63 — the per-state tables keep the bare §2.2 names (`PASS`, `SHAPE`, …), so code lists take a `_VALUES` suffix and codes a `_<VALUE>` suffix; Task 6's meta word and Task 9's T stage compare against the named codes — cost if wrong: renames.
- Ruling: definition format — `BlockDef = StateTables & {name, props?: PropertyDef[]}`, `PropertyDef = {name, kind, default}`; every table value is required (no silent defaults) and is `PerState<T> = T | ((props: PropValues) => T)`; enum values are spelled as their value names (`pass: 'opaque'`, `sound: 'stone'`) and turned into codes by index; booleans for `carvable`/`replaceable`; `faceTex` is one number for all six faces or six numbers in face order; `opacity` is typed `0 | 1 | 15` — §2.2 says "a constant or a function of the state's properties" without a format — cost if wrong: Task 4's `defs.ts` changes shape.
- Ruling: `buildRegistry` validates and throws `Error('buildRegistry: …')` for: no defs, a type or property name not matching `[a-z][a-z0-9_]*`, duplicate type names, duplicate property names in a type, an unknown kind, a default not in the kind, any table value outside its domain (the message names the field and the state's canonical key); `RangeError` when the total passes `MAX_STATES` (4096 states build, 4097 throw) — the spec asks only for the MAX_STATES assertion; the rest makes a bad definition fail at build time rather than in a golden — cost if wrong: none.
- Ruling: `BlockRegistry` = `typeCount`, `stateCount`, `TYPE_NAMES`, `DEFAULT_STATE` (Uint16Array per type), the 13 tables (`STATE_TYPE`, `FACE_TEX` Uint16; the rest Uint8; sized `MAX_STATES`, `FACE_TEX` `MAX_STATES·6`; entries past `stateCount` are 0), and `typeId(name)`, `typeName(type)`, `typeProperties(type)`, `stateOf(type, props?)`, `propsOf(state)` (a frozen object, declaration order), `withProp`, `withType`, `rotateState`, `mirrorState(state, 'x' | 'z')`, `stateKey`, `parseStateKey`. Types are passed as ids (numbers), not names (`typeId` converts) — cost if wrong: an overload later.
- Ruling: the registry object is `Object.freeze`d; its typed arrays cannot be frozen (V8 throws on freezing a non-empty typed array) and are documented "never written after the build" — §2.2's "frozen" is read as the encoding, not runtime immutability — cost if wrong: a consumer bug that writes a table would go unnoticed until a golden changes (`sp3a.registry` catches it for SP3a's states).
- Ruling: invalid inputs throw: a state outside `[0, stateCount)` or non-integer (NaN included) → `RangeError`; an unknown type id → `RangeError`; an unknown property or value in `stateOf`/`withProp` → `Error`; non-integer `quarterTurns` → `RangeError`; a mirror axis other than 'x'/'z' → `Error` — cost if wrong: one compare per call (none of these are in a per-voxel loop in SP3a; T writes ids through the table aliases).
- Ruling: `parseStateKey` is strict — an exact lookup in a `Map` of the canonical keys, so it accepts only `stateKey(s)` strings (no missing properties, other order, spaces, `[]` on a property-less type) and throws `Error('parseStateKey: "…" is not the canonical state key of a registered state')` otherwise — the lock (Task 4) and saves (SP5) compare canonical keys, a lenient parser would hide a non-canonical key — cost if wrong: a lenient variant later.
- Ruling: `rotateState` and `mirrorState` are pure table lookups: tables `rotations` (4 × stateCount, q 0-3, built by composing one quarter turn) and `mirrorX`/`mirrorZ` are built once in `buildRegistry`; `withProp`/`withType`/`stateOf` compute ids from the mixed-radix strides — cost if wrong: none (≈ 6 × 2 B per state).
- Ruling: the fixture registry is `test/harness/blockFixtures.ts` (`FIXTURE_DEFS`: air, `log` axis=y, `chest` facing4, `piston` facing6 with a function `faceTex`, `half_block` half, `trapdoor` open with function `opacity`/`collide`, `gate` hinge with function `emit`, `slab` slabType with function `fullFaces`, `pillar` axis=y + half=top (the §2.4 two-property type), `door` facing4/half/open/hinge (the §2.3 key example); 10 types, 61 states; `FIXTURE_BASE`, `FIXTURE_STATE_COUNT`, `AIR_TABLES`, `SOLID_TABLES`) — Task 4's lock-rule tests on a fixture copy and Task 12's M1 can reuse it — cost if wrong: none (tests only).
- Ruling: `fluid.ts` — `FLUID_NONE/WATER/LAVA` 0-2, `NO_FLUID` 0, `WATER_SOURCE` 16, `packFluid(type, level, falling = false, unsettled = false)` (fields masked to their widths, bit 7 never set), `fluidLevel`, `fluidFalling` (boolean), `fluidType`, `fluidUnsettled` (boolean), `hasFluid` (type ≠ 0; bit 7 ignored by every reader); `light.ts` — `MAX_LIGHT` 15, `packLight(sky, block)` (masked), `skyLight`, `blockLight`. Task 6's private fluid-type mask (0x30) in `section.ts` can alias `hasFluid` after the merge — cost if wrong: renames.
- No spec defects found for Task 3.

---

### Task 4: world/blocks: the real registry and the append-only lock

**Spec:** §2.2 initial list, §2.3

**Files:**
- Modify: `CLAUDE.md`
- Modify: `package.json`
- Create: `src/world/blocks/defs.ts`
- Create: `src/world/blocks/index.ts`
- Create: `test/arch/stateIds.test.ts`
- Create: `test/harness/stateLock.ts`
- Create: `test/stateIds.lock.json`
- Create: `test/unit/blockDefs.test.ts`
- Create: `test/unit/stateLock.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/blocks/registry.ts` (Task 3): `BlockDef`, `BlockRegistry`, `buildRegistry`, `type BlockRegistry`
- Produces (exports added by this task):
  - `src/world/blocks/defs.ts`:
    - `export const BLOCK_DEFS: readonly BlockDef[] = Object.freeze([`
  - `src/world/blocks/index.ts`:
    - `export const REGISTRY: BlockRegistry = build(DEFS);`
    - `export const TYPE_NAMES = REGISTRY.TYPE_NAMES;`
    - `export const DEFAULT_STATE = REGISTRY.DEFAULT_STATE;`
    - `export const STATE_TYPE = REGISTRY.STATE_TYPE;`
    - `export const OPACITY = REGISTRY.OPACITY;`
    - `export const PASS = REGISTRY.PASS;`
    - `export const SHAPE = REGISTRY.SHAPE;`
    - `export const FULL_FACES = REGISTRY.FULL_FACES;`
    - `export const EMIT = REGISTRY.EMIT;`
    - `export const CARVABLE = REGISTRY.CARVABLE;`
    - `export const REPLACEABLE = REGISTRY.REPLACEABLE;`
    - `export const COLLIDE = REGISTRY.COLLIDE;`
    - `export const FLUID_MODE = REGISTRY.FLUID_MODE;`
    - `export const TINT = REGISTRY.TINT;`
    - `export const SOUND = REGISTRY.SOUND;`
    - `export const FACE_TEX = REGISTRY.FACE_TEX;`
    - `export const AIR: number = REGISTRY.parseStateKey('air');`
    - `export const STONE: number = REGISTRY.parseStateKey('stone');`
    - `export const BEDROCK: number = REGISTRY.parseStateKey('bedrock');`
  - `test/harness/stateLock.ts`:
    - `export type StateIdLock = Record<string, number>;`
    - `export const STATE_LOCK_PATH = fileURLToPath(new URL('../stateIds.lock.json', import.meta.url));`
    - `export const lockTypeName = (key: string): string =>`
    - `export function registryStateIds(reg: BlockRegistry): StateIdLock`
    - `export function lockFormatErrors(json: unknown): string[]`
    - `export function readStateLock(path = STATE_LOCK_PATH): StateIdLock | null`
    - `export function stateLockViolations(lock: StateIdLock | null, reg: BlockRegistry): string[]`
    - `export function acceptStateIds(`

- [ ] **Step 1: Write the failing tests**

Create `test/arch/stateIds.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { REGISTRY } from '../../src/world/blocks/index';
import { acceptStateIds, readStateLock, STATE_LOCK_PATH, stateLockViolations } from '../harness/stateLock';

// SP3a spec §2.3. `npm run test:accept-state-ids` (ACCEPT_STATE_IDS=1) appends the states of new types and refuses
// changed ids, removed entries and new states of locked types; a commit that changes the lock says so in its message.
test('test/stateIds.lock.json holds every state of the registry with its id (append-only)', () => {
  const lock = readStateLock();
  if (process.env.ACCEPT_STATE_IDS === '1') {
    const r = acceptStateIds(lock, REGISTRY);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) {
      writeFileSync(STATE_LOCK_PATH, `${JSON.stringify(r.next, null, 2)}\n`);
      console.log(r.appended.length > 0 ? `appended ${r.appended.length} state(s): ${r.appended.join(', ')}` : 'no new states; lock unchanged');
    }
    return;
  }
  expect(stateLockViolations(lock, REGISTRY)).toEqual([]);
});
```

Create `test/unit/blockDefs.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  ALL_FACES, COLLIDE_CUBE, COLLIDE_NONE, FLUID_MODE_BLOCK, FLUID_MODE_DISPLACE, PASS_NONE, PASS_OPAQUE, SHAPE_CUBE,
  SHAPE_NONE, SOUND_NONE, SOUND_STONE, TINT_NONE,
} from '../../src/world/blocks/kinds';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import {
  AIR, BEDROCK, CARVABLE, COLLIDE, DEFAULT_STATE, EMIT, FACE_TEX, FLUID_MODE, FULL_FACES, OPACITY, PASS, REGISTRY,
  REPLACEABLE, SHAPE, SOUND, STATE_TYPE, STONE, TINT, TYPE_NAMES,
} from '../../src/world/blocks/index';
import { MAX_STATES } from '../../src/world/blocks/registry';

const R = REGISTRY;

describe('the real registry: the SP3a initial list (SP3a spec §2.2)', () => {
  test('air 0, stone 1, bedrock 2, one state each', () => {
    expect(BLOCK_DEFS.map((d) => d.name)).toEqual(['air', 'stone', 'bedrock']);
    expect(Object.isFrozen(BLOCK_DEFS)).toBe(true);
    expect(R.typeCount).toBe(3);
    expect(R.stateCount).toBe(3);
    expect(TYPE_NAMES).toEqual(['air', 'stone', 'bedrock']);
    expect([AIR, STONE, BEDROCK]).toEqual([0, 1, 2]);
    expect([R.typeId('air'), R.typeId('stone'), R.typeId('bedrock')]).toEqual([0, 1, 2]);
    expect(Array.from(DEFAULT_STATE)).toEqual([0, 1, 2]);
    expect(Array.from(STATE_TYPE.subarray(0, 3))).toEqual([0, 1, 2]);
    for (let t = 0; t < 3; t++) expect(R.typeProperties(t)).toEqual([]);
  });

  test('canonical keys are the bare type names and parse back', () => {
    expect([AIR, STONE, BEDROCK].map((s) => R.stateKey(s))).toEqual(['air', 'stone', 'bedrock']);
    expect(['air', 'stone', 'bedrock'].map((k) => R.parseStateKey(k))).toEqual([AIR, STONE, BEDROCK]);
    expect(() => R.parseStateKey('stone[]')).toThrow(/canonical/);
  });

  test('the §2.2 table values, as §2.1 codes', () => {
    const row = (s: number): number[] => [
      OPACITY[s]!, PASS[s]!, SHAPE[s]!, FULL_FACES[s]!, EMIT[s]!, CARVABLE[s]!, REPLACEABLE[s]!, COLLIDE[s]!,
      FLUID_MODE[s]!, TINT[s]!, SOUND[s]!,
    ];
    //                     OPACITY PASS          SHAPE        FULL_FACES EMIT CARV REPL COLLIDE        FLUID_MODE           TINT       SOUND
    expect(row(AIR)).toEqual([0, PASS_NONE, SHAPE_NONE, 0, 0, 0, 1, COLLIDE_NONE, FLUID_MODE_DISPLACE, TINT_NONE, SOUND_NONE]);
    expect(row(STONE)).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 1, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_STONE]);
    expect(row(BEDROCK)).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 0, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_STONE]);
    expect(Array.from(FACE_TEX.subarray(0, 18))).toEqual(new Array<number>(18).fill(0));
  });

  test('the exported tables are the registry tables, sized MAX_STATES, 0 past the registered states', () => {
    const tables = { STATE_TYPE, OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE, FLUID_MODE, TINT, SOUND };
    for (const [name, table] of Object.entries(tables)) {
      expect(table, name).toBe(R[name as keyof typeof tables]);
      expect(table.length, name).toBe(MAX_STATES);
      expect(table.subarray(3).every((v) => v === 0), name).toBe(true);
    }
    expect(FACE_TEX).toBe(R.FACE_TEX);
    expect(FACE_TEX.length).toBe(MAX_STATES * 6);
    expect(DEFAULT_STATE).toBe(R.DEFAULT_STATE);
    expect(TYPE_NAMES).toBe(R.TYPE_NAMES);
  });

  test('rotations, mirrors and withType of property-less types are the identity or the default', () => {
    for (const s of [AIR, STONE, BEDROCK]) {
      for (const q of [-1, 0, 1, 2, 3, 5]) expect(R.rotateState(s, q)).toBe(s);
      expect(R.mirrorState(s, 'x')).toBe(s);
      expect(R.mirrorState(s, 'z')).toBe(s);
      expect(R.propsOf(s)).toEqual({});
      expect(R.stateOf(STATE_TYPE[s]!)).toBe(s);
    }
    expect(R.withType(STONE, R.typeId('bedrock'))).toBe(BEDROCK);
  });

  test('no placeable state uses SOUND none; only air has SHAPE none', () => {
    for (let s = 0; s < R.stateCount; s++) {
      expect(SOUND[s] === SOUND_NONE, R.stateKey(s)).toBe(s === AIR);
      expect(SHAPE[s] === SHAPE_NONE, R.stateKey(s)).toBe(s === AIR);
    }
  });
});
```

Create `test/unit/stateLock.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { buildRegistry, type BlockDef, type PropertyDef } from '../../src/world/blocks/registry';
import { AIR_TABLES, FIXTURE_DEFS, FIXTURE_STATE_COUNT, SOLID_TABLES } from '../harness/blockFixtures';
import {
  acceptStateIds, lockFormatErrors, lockTypeName, readStateLock, registryStateIds, stateLockViolations, type StateIdLock,
} from '../harness/stateLock';

const FIXTURE = buildRegistry(FIXTURE_DEFS);
const FIXTURE_LOCK: StateIdLock = registryStateIds(FIXTURE);
const prop = (name: string, kind: PropertyDef['kind'], def: string): PropertyDef => ({ name, kind, default: def });
const without = (name: string): BlockDef[] => FIXTURE_DEFS.filter((d) => d.name !== name);
const refusals = (lock: StateIdLock | null, defs: readonly BlockDef[]): string[] => {
  const r = acceptStateIds(lock, buildRegistry(defs));
  return r.ok ? [] : r.errors;
};

describe('the lock format (SP3a spec §2.3)', () => {
  test('a lock maps every canonical key to its id, in id order', () => {
    const keys = Object.keys(FIXTURE_LOCK);
    expect(keys).toHaveLength(FIXTURE_STATE_COUNT);
    expect(Object.values(FIXTURE_LOCK)).toEqual(Array.from({ length: FIXTURE_STATE_COUNT }, (_, i) => i));
    expect(keys.slice(0, 4)).toEqual(['air', 'log[axis=y]', 'log[axis=x]', 'log[axis=z]']);
    expect(FIXTURE_LOCK['door[facing=north,half=bottom,open=false,hinge=left]']).toBe(FIXTURE.stateOf(FIXTURE.typeId('door')));
    expect(lockFormatErrors(FIXTURE_LOCK)).toEqual([]);
  });

  test('lockTypeName is the bare name or the part before [', () => {
    expect(lockTypeName('stone')).toBe('stone');
    expect(lockTypeName('door[facing=north,half=bottom,open=false,hinge=left]')).toBe('door');
  });

  test('malformed locks are reported', () => {
    expect(lockFormatErrors([])).toEqual(['the lock is not a JSON object of key → id']);
    expect(lockFormatErrors(null)).toEqual(['the lock is not a JSON object of key → id']);
    expect(lockFormatErrors({ air: 0, stone: 0 })).toEqual(['stone: id 0 is also air']);
    expect(lockFormatErrors({ air: 1.5 })).toEqual(['air: id 1.5 is not a u16']);
    expect(lockFormatErrors({ air: '0' })).toEqual(['air: id "0" is not a u16']);
    expect(lockFormatErrors({ 'log[axis = y]': 0 })).toEqual(['"log[axis = y]" is not a canonical state key']);
    expect(lockFormatErrors({ 'Stone': 0 })).toEqual(['"Stone" is not a canonical state key']);
  });

  test('a missing lock fails the lock test; accepting creates it with every state', () => {
    expect(stateLockViolations(null, FIXTURE)).toEqual(['test/stateIds.lock.json is missing: run npm run test:accept-state-ids']);
    const r = acceptStateIds(null, FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toEqual(FIXTURE_LOCK);
    expect(Object.keys(r.next)).toEqual(Object.keys(FIXTURE_LOCK));
    expect(r.appended).toEqual(Object.keys(FIXTURE_LOCK));
  });
});

describe('the append-only rule on a fixture copy (SP3a spec §2.3, §2.4)', () => {
  test('an unchanged registry passes, and accepting it appends nothing', () => {
    expect(stateLockViolations(FIXTURE_LOCK, FIXTURE)).toEqual([]);
    const r = acceptStateIds(FIXTURE_LOCK, FIXTURE);
    expect(r).toEqual({ ok: true, next: FIXTURE_LOCK, appended: [] });
  });

  test('a new type appended at the end fails the lock test until accepted; accepting appends only its states', () => {
    const defs = [...FIXTURE_DEFS, { name: 'lever', props: [prop('face', 'facing6', 'up')], ...SOLID_TABLES }];
    const reg = buildRegistry(defs);
    const added = ['up', 'north', 'east', 'south', 'west', 'down'].map((f) => `lever[face=${f}]`);
    expect(stateLockViolations(FIXTURE_LOCK, reg)).toEqual([`states not yet in the lock (${added.join(', ')}): run npm run test:accept-state-ids`]);
    const r = acceptStateIds(FIXTURE_LOCK, reg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appended).toEqual(added);
    expect(Object.keys(r.next)).toEqual([...Object.keys(FIXTURE_LOCK), ...added]);
    expect(added.map((k) => r.next[k])).toEqual([61, 62, 63, 64, 65, 66]);
    for (const [k, id] of Object.entries(FIXTURE_LOCK)) expect(r.next[k], k).toBe(id);
    expect(stateLockViolations(r.next, reg)).toEqual([]);
  });

  test('a changed id is refused (a type inserted before locked ones)', () => {
    const defs = [...FIXTURE_DEFS.slice(0, 1), { name: 'dirt', ...SOLID_TABLES }, ...FIXTURE_DEFS.slice(1)];
    const errors = refusals(FIXTURE_LOCK, defs);
    expect(errors).toHaveLength(FIXTURE_STATE_COUNT - 1);
    expect(errors[0]).toBe('log[axis=y] is id 2, locked as 1: locked ids never change (append new types at the end)');
    expect(stateLockViolations(FIXTURE_LOCK, buildRegistry(defs))).toEqual([...errors, 'states not yet in the lock (dirt): run npm run test:accept-state-ids']);
  });

  test('a changed id is refused (two types swapped)', () => {
    const defs = [...FIXTURE_DEFS];
    [defs[1], defs[2]] = [defs[2]!, defs[1]!];
    const errors = refusals(FIXTURE_LOCK, defs);
    expect(errors).toContain('log[axis=y] is id 5, locked as 1: locked ids never change (append new types at the end)');
    expect(errors).toContain('chest[facing=north] is id 1, locked as 4: locked ids never change (append new types at the end)');
    expect(errors).toHaveLength(7);
  });

  test('a removed entry is refused (a locked type removed from the registry)', () => {
    const errors = refusals(FIXTURE_LOCK, without('door'));
    expect(errors).toHaveLength(32);
    expect(errors[0]).toBe('door[facing=north,half=bottom,open=false,hinge=left] (id 29) is no longer registered: a locked state never goes away');
    expect(stateLockViolations(FIXTURE_LOCK, buildRegistry(without('door')))).toEqual(errors);
  });

  test('a new value on a locked type is refused (its property moves to a kind with more values)', () => {
    const lever = (kind: PropertyDef['kind']): BlockDef => ({ name: 'lever', props: [prop('face', kind, 'bottom')], ...SOLID_TABLES });
    const lock = registryStateIds(buildRegistry([...FIXTURE_DEFS, lever('half')]));
    // half (bottom, top) → slabType (bottom, top, double): the two locked states keep their keys and ids.
    const errors = refusals(lock, [...FIXTURE_DEFS, lever('slabType')]);
    expect(errors).toEqual([
      'lever[face=double] (id 63) is a new state of the locked type lever: a locked type never gains properties or values (append a new type; withType converts)',
    ]);
  });

  test('a new property on a locked type is refused', () => {
    const door = FIXTURE_DEFS.find((d) => d.name === 'door')!;
    const errors = refusals(FIXTURE_LOCK, [...without('door'), { ...door, props: [...door.props!, prop('powered', 'open', 'false')] }]);
    expect(errors.filter((e) => e.includes('no longer registered'))).toHaveLength(32);
    expect(errors.filter((e) => e.includes('new state of the locked type door'))).toHaveLength(64);
  });

  test('an entry deleted from the lock file is not re-appended', () => {
    const lock = { ...FIXTURE_LOCK };
    delete lock['slab[type=top]'];
    expect(refusals(lock, FIXTURE_DEFS)).toEqual([
      'slab[type=top] (id 21) is a new state of the locked type slab: a locked type never gains properties or values (append a new type; withType converts)',
    ]);
  });

  test('a changed id written into the lock file is refused, never rewritten', () => {
    const lock = { ...FIXTURE_LOCK, air: 60, 'door[facing=west,half=top,open=true,hinge=right]': 0 };
    expect(refusals(lock, FIXTURE_DEFS)).toEqual([
      'air is id 0, locked as 60: locked ids never change (append new types at the end)',
      'door[facing=west,half=top,open=true,hinge=right] is id 60, locked as 0: locked ids never change (append new types at the end)',
    ]);
  });

  test('a type named like an Object.prototype member is compared as a key', () => {
    const defs: BlockDef[] = [{ name: 'air', ...AIR_TABLES }, { name: 'constructor', ...SOLID_TABLES }];
    const reg = buildRegistry(defs);
    expect(stateLockViolations({ air: 0 }, reg)).toEqual(['states not yet in the lock (constructor): run npm run test:accept-state-ids']);
    const r = acceptStateIds({ air: 0 }, reg);
    expect(r.ok && r.next).toEqual({ air: 0, constructor: 1 });
  });
});

describe('the real lock against a changed copy of the real definitions', () => {
  test('swapping stone and bedrock is refused', () => {
    const lock = readStateLock();
    expect(lock).not.toBeNull();
    expect(refusals(lock, [BLOCK_DEFS[0]!, BLOCK_DEFS[2]!, BLOCK_DEFS[1]!])).toEqual([
      'stone is id 2, locked as 1: locked ids never change (append new types at the end)',
      'bedrock is id 1, locked as 2: locked ids never change (append new types at the end)',
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/stateIds.test.ts test/unit/blockDefs.test.ts test/unit/stateLock.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/blockDefs.test.ts [ test/unit/blockDefs.test.ts ]
Error: Cannot find module '../../src/world/blocks/defs' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/blockDefs.test.ts
FAIL  |unit| test/unit/stateLock.test.ts [ test/unit/stateLock.test.ts ]
Error: Cannot find module '../../src/world/blocks/defs' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/stateLock.test.ts
FAIL  |arch| test/arch/stateIds.test.ts [ test/arch/stateIds.test.ts ]
Error: Cannot find module '../../src/world/blocks/index' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/arch/stateIds.test.ts
Test Files  3 failed (3)
Tests  no tests
```

- [ ] **Step 3: Implement**

Modify `CLAUDE.md` (apply with `git apply`):

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index c783077..0f73a13 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -22,6 +22,7 @@ Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with cus
 - `npm run test:accept-thresholds` — rewrite `test/thresholds.lock.json` (needs a spec amendment in the same change; CI checks it)
 - `npm run test:goldens` — record and merge goldens (refuses changed goldens without a `GENERATOR_VERSION` bump)
 - `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
+- `npm run test:accept-state-ids` — append the states of new block types to `test/stateIds.lock.json` (append-only: refuses a changed id, a removed entry or a new state of a locked type; the commit message says the lock changed)
 - `npm run docs:params` — regenerate the README parameter table from the schema
 - `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1 and SP2a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
 - `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section, global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
```

Modify `package.json` (apply with `git apply`):

```diff
diff --git a/package.json b/package.json
index 2053330..ec9a001 100644
--- a/package.json
+++ b/package.json
@@ -19,6 +19,7 @@
     "test:accept-thresholds": "ACCEPT_THRESHOLDS=1 vitest run --project arch test/arch/thresholds.test.ts",
     "test:goldens": "rm -rf test/.cache/goldens-obs && UPDATE_GOLDENS=1 vitest run --project unit --project metrics-quick && MERGE_GOLDENS=1 vitest run --project arch test/arch/goldensMerge.test.ts",
     "test:accept-schema": "ACCEPT_SCHEMA=1 vitest run --project arch test/arch/schemaShape.test.ts",
+    "test:accept-state-ids": "ACCEPT_STATE_IDS=1 vitest run --project arch test/arch/stateIds.test.ts",
     "docs:params": "WRITE_PARAMS_DOC=1 vitest run --project arch test/arch/paramsDoc.test.ts"
   },
   "dependencies": {
```

Create `src/world/blocks/defs.ts`:

```ts
/**
 * The real block definitions (SP3a spec §2.2), in id order. Append-only: ids follow this order and are locked by
 * `test/stateIds.lock.json` (§2.3), so a new type goes at the end, and a type with lock entries never changes its
 * properties or default. SP3b appends the terrain palette.
 *
 * Texture ids are 0 until SP8a; `SOUND` none is air's only (never played).
 */
import type { BlockDef } from './registry';

export const BLOCK_DEFS: readonly BlockDef[] = Object.freeze([
  {
    name: 'air',
    opacity: 0, pass: 'none', shape: 'none', fullFaces: 0, emit: 0, carvable: false, replaceable: true,
    collide: 'none', fluidMode: 'displace', tint: 'none', sound: 'none', faceTex: 0,
  },
  {
    name: 'stone',
    opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: true, replaceable: false,
    collide: 'cube', fluidMode: 'block', tint: 'none', sound: 'stone', faceTex: 0,
  },
  {
    name: 'bedrock',
    opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: false, replaceable: false,
    collide: 'cube', fluidMode: 'block', tint: 'none', sound: 'stone', faceTex: 0,
  },
]);
```

Create `src/world/blocks/index.ts`:

```ts
/**
 * The block registry of the game (SP3a spec §2.2): `REGISTRY = buildRegistry(BLOCK_DEFS)`, its per-state tables as
 * plain exports (hot code aliases them: `const OPAQ = OPACITY;`) and the state ids of the SP3a types. The tables are
 * never written after the build.
 */
import { BLOCK_DEFS } from './defs';
import { buildRegistry, type BlockRegistry } from './registry';

const build = buildRegistry;
const DEFS = BLOCK_DEFS;

export const REGISTRY: BlockRegistry = build(DEFS);

export const TYPE_NAMES = REGISTRY.TYPE_NAMES;
export const DEFAULT_STATE = REGISTRY.DEFAULT_STATE;
export const STATE_TYPE = REGISTRY.STATE_TYPE;
export const OPACITY = REGISTRY.OPACITY;
export const PASS = REGISTRY.PASS;
export const SHAPE = REGISTRY.SHAPE;
export const FULL_FACES = REGISTRY.FULL_FACES;
export const EMIT = REGISTRY.EMIT;
export const CARVABLE = REGISTRY.CARVABLE;
export const REPLACEABLE = REGISTRY.REPLACEABLE;
export const COLLIDE = REGISTRY.COLLIDE;
export const FLUID_MODE = REGISTRY.FLUID_MODE;
export const TINT = REGISTRY.TINT;
export const SOUND = REGISTRY.SOUND;
export const FACE_TEX = REGISTRY.FACE_TEX;

/** State ids (each type's only state); air is 0, which uniform-air descriptors and the meta word rely on. */
export const AIR: number = REGISTRY.parseStateKey('air');
export const STONE: number = REGISTRY.parseStateKey('stone');
export const BEDROCK: number = REGISTRY.parseStateKey('bedrock');
```

Create `test/harness/stateLock.ts`:

```ts
/**
 * The append-only state-id lock (SP3a spec §2.3): `test/stateIds.lock.json` maps every published state's canonical key
 * to its id. The lock test fails when an entry is missing from the registry or has another id, and when a state is not
 * yet in the lock; `npm run test:accept-state-ids` appends the new states of new types and refuses everything else: it
 * never rewrites or removes an entry, and a type that already has entries never gains states (a new property or value
 * on a locked type is a new type, §2.2).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BlockRegistry } from '../../src/world/blocks/registry';

/** Canonical key → state id, in id order. */
export type StateIdLock = Record<string, number>;

export const STATE_LOCK_PATH = fileURLToPath(new URL('../stateIds.lock.json', import.meta.url));
const ACCEPT = 'run npm run test:accept-state-ids';
const NAME = '[a-z][a-z0-9_]*';
const KEY_RE = new RegExp(`^${NAME}(\\[${NAME}=[a-z0-9_]+(,${NAME}=[a-z0-9_]+)*\\])?$`);

/** The type name of a canonical key: the bare name, or the part before `[`. */
export const lockTypeName = (key: string): string => {
  const i = key.indexOf('[');
  return i < 0 ? key : key.slice(0, i);
};

/** Every state of the registry as a lock: canonical key → id, in id order. */
export function registryStateIds(reg: BlockRegistry): StateIdLock {
  const out: StateIdLock = {};
  for (let s = 0; s < reg.stateCount; s++) out[reg.stateKey(s)] = s;
  return out;
}

/** Shape errors of a parsed lock file: an object of canonical-looking ASCII keys to unique integer ids. */
export function lockFormatErrors(json: unknown): string[] {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return ['the lock is not a JSON object of key → id'];
  const out: string[] = [];
  const seen = new Map<number, string>();
  for (const [key, id] of Object.entries(json as Record<string, unknown>)) {
    if (!KEY_RE.test(key)) out.push(`${JSON.stringify(key)} is not a canonical state key`);
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > 0xffff) {
      out.push(`${key}: id ${JSON.stringify(id)} is not a u16`);
      continue;
    }
    const other = seen.get(id);
    if (other !== undefined) out.push(`${key}: id ${id} is also ${other}`);
    seen.set(id, key);
  }
  return out;
}

/** Reads and validates the lock; null when the file does not exist. */
export function readStateLock(path = STATE_LOCK_PATH): StateIdLock | null {
  if (!existsSync(path)) return null;
  const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const errors = lockFormatErrors(json);
  if (errors.length > 0) throw new Error(`${path}:\n${errors.join('\n')}`);
  return json as StateIdLock;
}

interface Comparison {
  /** Changed ids, removed entries and new states of locked types: never accepted. */
  refusals: string[];
  /** States of types without lock entries, in id order: appended by the accept command. */
  appendable: string[];
}

function compare(lock: StateIdLock, reg: BlockRegistry): Comparison {
  // Maps, not `in` or indexing: a type may be named like an Object.prototype member (`constructor`).
  const live = new Map(Object.entries(registryStateIds(reg)));
  const locked = new Map(Object.entries(lock));
  const refusals = lockFormatErrors(lock);
  const lockedTypes = new Set<string>();
  for (const [key, id] of locked) {
    lockedTypes.add(lockTypeName(key));
    const now = live.get(key);
    if (now === undefined) refusals.push(`${key} (id ${id}) is no longer registered: a locked state never goes away`);
    else if (now !== id) refusals.push(`${key} is id ${now}, locked as ${id}: locked ids never change (append new types at the end)`);
  }
  const appendable: string[] = [];
  for (const [key, id] of live) {
    if (locked.has(key)) continue;
    const type = lockTypeName(key);
    if (lockedTypes.has(type)) {
      refusals.push(`${key} (id ${id}) is a new state of the locked type ${type}: a locked type never gains properties or values (append a new type; withType converts)`);
    } else {
      appendable.push(key);
    }
  }
  return { refusals, appendable };
}

/** The lock test: [] when the lock and the registry agree exactly. */
export function stateLockViolations(lock: StateIdLock | null, reg: BlockRegistry): string[] {
  if (lock === null) return [`test/stateIds.lock.json is missing: ${ACCEPT}`];
  const { refusals, appendable } = compare(lock, reg);
  if (appendable.length > 0) refusals.push(`states not yet in the lock (${appendable.join(', ')}): ${ACCEPT}`);
  return refusals;
}

/** `npm run test:accept-state-ids`: the lock with the new types' states appended, or the refusals. */
export function acceptStateIds(
  lock: StateIdLock | null,
  reg: BlockRegistry,
): { ok: true; next: StateIdLock; appended: string[] } | { ok: false; errors: string[] } {
  const base = lock ?? {};
  const { refusals, appendable } = compare(base, reg);
  if (refusals.length > 0) return { ok: false, errors: refusals };
  const next: StateIdLock = { ...base };
  for (const key of appendable) next[key] = reg.parseStateKey(key);
  return { ok: true, next, appended: appendable };
}
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:accept-state-ids`

The command writes `test/stateIds.lock.json`; the dry run's result:

Create `test/stateIds.lock.json`:

```json
{
  "air": 0,
  "stone": 1,
  "bedrock": 2
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/stateIds.test.ts test/unit/blockDefs.test.ts test/unit/stateLock.test.ts`

Expected: PASS (exit 0)

```
Test Files  3 passed (3)
Tests  22 passed (22)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  100 passed | 2 skipped (102)
Tests  1266 passed | 2 skipped (1268)
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md package.json src/world/blocks/defs.ts src/world/blocks/index.ts test/arch/stateIds.test.ts test/harness/stateLock.ts test/stateIds.lock.json test/unit/blockDefs.test.ts test/unit/stateLock.test.ts
git commit -F - <<'EOF'
feat(world/blocks): the real registry (air, stone, bedrock) and the append-only state-id lock

defs.ts holds the SP3a initial list with the spec §2.2 table values; index.ts builds
REGISTRY = buildRegistry(BLOCK_DEFS) and exports its tables and the AIR/STONE/BEDROCK ids.

State-id lock: adds test/stateIds.lock.json (air 0, stone 1, bedrock 2). The lock test
fails on a missing or changed entry and on states not yet locked; the new
npm run test:accept-state-ids appends new types' states and refuses changed ids,
removed entries and new states of locked types (spec §2.3).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `3bcd45e` on `dry/sp3a`; 9 files changed, 425 insertions(+)):

RED replay (the commit's `test/**` over the parent, in a throwaway worktree): `test/unit/blockDefs.test.ts`, `test/unit/stateLock.test.ts` fail to import `src/world/blocks/defs`, `test/arch/stateIds.test.ts` fails to import `src/world/blocks/index` (3 files failed, no tests). During TDD the lock test was also watched failing on the missing lock ("test/stateIds.lock.json is missing: run npm run test:accept-state-ids") before `npm run test:accept-state-ids` wrote it. GREEN: typecheck clean; `npm test` 100 files passed, 2 skipped / 1266 tests passed, 2 skipped (≈34 s); the three new files 22 tests.

- Ruling: `defs.ts` exports `BLOCK_DEFS` (frozen array of three `BlockDef`s, values spelled as in Task 3's format; a type-only import of `BlockDef`); `index.ts` exports `REGISTRY`, the per-state tables and `TYPE_NAMES`/`DEFAULT_STATE` as plain `export const X = REGISTRY.X`, and the state ids `AIR`, `STONE`, `BEDROCK` (computed with `parseStateKey`, asserted 0/1/2 in the test) — the hot-import rule needs `buildRegistry`/`BLOCK_DEFS` aliased (`const build = buildRegistry; const DEFS = BLOCK_DEFS;`); consumers (Task 6/7 meta via `PASS`, Task 9 T stage, Task 10 golden) import from `world/blocks/index` and alias in turn — cost if wrong: renames.
- Ruling: no type-id exports (`AIR_TYPE` …): nothing in SP3a needs them (`REGISTRY.typeId(name)` covers it) — cost if wrong: one line each later.
- Ruling: lock format — a flat JSON object canonical key → id in id order, written `JSON.stringify(lock, null, 2)` + newline, no header/hash (the spec says "maps every published state's canonical key to its id"; unlike the thresholds lock there is no canonical/sha256 envelope because the append-only rule is the guard, and CI runs the lock test) — cost if wrong: a format change before SP5 relies on it.
- Ruling: the lock logic lives in `test/harness/stateLock.ts` (`registryStateIds`, `lockTypeName`, `lockFormatErrors`, `readStateLock` (throws on a malformed file), `stateLockViolations(lock, reg)`, `acceptStateIds(lock, reg)` → `{ok, next, appended} | {ok: false, errors}`), mirroring `test/harness/schemaShape.ts`; the lock test is `test/arch/stateIds.test.ts`; `npm run test:accept-state-ids` = `ACCEPT_STATE_IDS=1 vitest run --project arch test/arch/stateIds.test.ts` (writes only when accepted). Task 12's M1 "lock entries unchanged" can call `stateLockViolations(readStateLock(), REGISTRY)` — cost if wrong: none.
- Ruling: what the accept refuses (all reported at once, nothing written): an entry whose key is no longer registered ("a locked state never goes away"), an entry whose id changed, and any unlocked state whose type name (the key up to `[`) already has lock entries — which also covers an entry hand-deleted from the lock file (it is not re-appended) and a new property (old keys vanish and new keys of the locked type appear). It appends only the states of types without entries, in id order, after the existing entries; it never rewrites an entry. The lock test reports the same refusals plus "states not yet in the lock (…): run npm run test:accept-state-ids" — cost if wrong: none.
- Ruling: the lock file is format-checked (object; keys match the canonical grammar `name` or `name[p=v,…]` with `[a-z][a-z0-9_]*` names and `[a-z0-9_]+` values; ids unique u16 integers) — catches a hand edit that the key/id comparison would report confusingly — cost if wrong: none.
- Ruling: comparisons use `Map`s, not `in`/indexing, because a type may legally be named `constructor` (`[a-z][a-z0-9_]*`); tested — cost if wrong: none.
- Ruling: "a new value on a locked type" is tested by moving a locked type's property to a kind with more values (`lever` face `half` → `slabType`: the two locked keys keep their ids, `lever[face=double]` is refused) — the kinds' value lists are frozen, so this is the only way a locked type can gain a value; the fixture copy is `[...FIXTURE_DEFS, lever]` so the change is isolated from id shifts. Also tested on fixture copies: a type inserted before locked ones and two types swapped (changed ids), `door` removed (32 removed entries), a fifth property on `door`, a hand-deleted and a hand-swapped lock entry; and on the real lock: stone ↔ bedrock swapped is refused — cost if wrong: none (tests only).
- Ruling: `test/unit/stateLock.test.ts` imports the real `BLOCK_DEFS` (the real-lock case), so the whole file fails on the parent; its fixture-only cases would pass there by themselves because the rule lives in `test/harness/` (as Task 3's arch-rule change) — cost if wrong: none.
- Ruling: CLAUDE.md's command list gains `npm run test:accept-state-ids` (the SP1 precedent: new scripts are listed when added); README has no accept-command list, so it is untouched — cost if wrong: one doc line.
- Ruling: the commit message says the lock changed ("State-id lock: adds test/stateIds.lock.json …"), per §2.3 — cost if wrong: none.
- No spec defects found for Task 4.

---

### Task 5: world/store: slab pool

**Spec:** §3.1

**Files:**
- Create: `src/world/store/pool.ts`
- Create: `test/unit/pool.test.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.test.json`
- Modify: `tsconfig.worker.json`

**Interfaces:**
- Consumes: nothing from earlier SP3a tasks.
- Produces (exports added by this task):
  - `src/world/store/pool.ts`:
    - `export const BLOCK_SLOT_BYTES = 8192;`
    - `export const BYTE_SLOT_BYTES = 4096;`
    - `export const GROW_BYTES = 1 << 20;`
    - `export const DEFAULT_MAX_BLOCK_BYTES = 768 * GROW_BYTES;`
    - `export const DEFAULT_MAX_BYTE_BYTES = 512 * GROW_BYTES;`
    - `export class StoreFull extends Error`
    - `export interface PoolOptions`
    - `export interface PoolHandles`
    - `export interface SlabPool`
    - `export function createPool(opts: PoolOptions): SlabPool`
    - `export function attachPool(h: PoolHandles): SlabPool`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/pool.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  attachPool, BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES,
  GROW_BYTES, StoreFull, type SlabPool,
} from '../../src/world/store/pool';
import { testRng } from '../harness/stats';

const MiB = 1 << 20;

/** Every slot is either on the free stack (once, refcount 0) or live (refcount > 0): SP3a spec §3.6 "no lost slots". */
function expectConsistent(p: SlabPool): void {
  const stack = Array.from(p.freeStack());
  expect(new Set(stack).size).toBe(stack.length);
  for (const id of stack) expect(p.refcount(id)).toBe(0);
  let live = 0;
  for (let id = 0; id < p.slotCount(); id++) if (p.refcount(id) > 0) live++;
  expect(stack.length + live).toBe(p.slotCount());
  expect(p.freeCount()).toBe(stack.length);
}

test('slot sizes, growth step and default maxima (SP3a spec §3.1)', () => {
  expect(BLOCK_SLOT_BYTES).toBe(8192);
  expect(BYTE_SLOT_BYTES).toBe(4096);
  expect(GROW_BYTES).toBe(MiB);
  expect(DEFAULT_MAX_BLOCK_BYTES).toBe(768 * MiB);
  expect(DEFAULT_MAX_BYTE_BYTES).toBe(512 * MiB);
});

test('bad options are refused', () => {
  expect(() => createPool({ shared: false, slotBytes: 3000, maxBytes: MiB })).toThrow(RangeError);
  expect(() => createPool({ shared: false, slotBytes: 4096, maxBytes: MiB + 4096 })).toThrow(RangeError);
  expect(() => createPool({ shared: false, slotBytes: 4096, maxBytes: 0 })).toThrow(RangeError);
});

describe.each([true, false])('shared %s', (shared) => {
  const blockPool = (maxBytes = 4 * MiB) => createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes });
  const bytePool = (maxBytes = 4 * MiB) => createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes });

  test('backing: one growable buffer per pool, of the requested kind', () => {
    const p = blockPool();
    const h = p.handles();
    for (const buf of [h.data, h.stack, h.refs]) {
      expect(buf instanceof SharedArrayBuffer).toBe(shared);
      if (buf instanceof SharedArrayBuffer) expect(buf.growable).toBe(true);
      else expect(buf.resizable).toBe(true);
    }
    expect(h.data.maxByteLength).toBe(4 * MiB);
    expect(h.stack.maxByteLength).toBe(4 * p.maxSlots);
    expect(h.refs.maxByteLength).toBe(4 * p.maxSlots);
    expect(h.ctl instanceof SharedArrayBuffer).toBe(shared);
    expect(p.maxSlots).toBe(512);
    expect(p.slotBytes).toBe(BLOCK_SLOT_BYTES);
  });

  test('the default maxima reserve address space only', () => {
    const b = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: DEFAULT_MAX_BLOCK_BYTES });
    const y = createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: DEFAULT_MAX_BYTE_BYTES });
    expect(b.maxSlots).toBe(98_304);
    expect(y.maxSlots).toBe(131_072);
    expect(b.handles().data.byteLength).toBe(0);
    expect(b.alloc()).toBe(0);
    expect(b.handles().data.byteLength).toBe(MiB);
    expect(y.alloc()).toBe(0);
  });

  test('a fresh pool is empty; the first alloc grows it by 1 MiB and pops slot 0', () => {
    for (const [p, perStep] of [[blockPool(), 128], [bytePool(), 256]] as const) {
      expect(p.slotCount()).toBe(0);
      expect(p.freeCount()).toBe(0);
      expect(p.alloc()).toBe(0);
      expect(p.refcount(0)).toBe(1);
      expect(p.slotCount()).toBe(perStep);
      expect(p.freeCount()).toBe(perStep - 1);
      expect(p.alloc()).toBe(1);
      expectConsistent(p);
    }
  });

  test('length-tracking views see growth without being rebuilt', () => {
    const p = blockPool();
    const bytes = p.bytes;
    const words = p.words;
    expect(bytes.length).toBe(0);
    p.alloc();
    expect(bytes.length).toBe(MiB);
    expect(words.length).toBe(MiB / 2);
    for (let i = 0; i < 128; i++) p.alloc();
    expect(p.slotCount()).toBe(256);
    expect(bytes.length).toBe(2 * MiB);
    expect(p.handles().stack.byteLength).toBe(4 * 256);
    expect(p.handles().refs.byteLength).toBe(4 * 256);
  });

  test('slot views cover exactly the slot', () => {
    const p = blockPool();
    const a = p.alloc();
    const b = p.alloc();
    const ua = p.u16(a);
    expect(ua.length).toBe(4096);
    expect(p.u8(b).length).toBe(BLOCK_SLOT_BYTES);
    expect(p.u8(b).byteOffset).toBe(b * BLOCK_SLOT_BYTES);
    ua.fill(0xffff);
    expect(p.u16(b).every((v) => v === 0)).toBe(true);
    expect(p.words[a * 4096 + 4095]).toBe(0xffff);
    expect(p.bytes[b * BLOCK_SLOT_BYTES]).toBe(0);
  });

  test('exhausting the stack grows again; ids stay unique', () => {
    const p = blockPool();
    const ids = Array.from({ length: 129 }, () => p.alloc());
    expect(new Set(ids).size).toBe(129);
    expect(ids).toEqual(Array.from({ length: 129 }, (_, i) => i));
    expect(p.slotCount()).toBe(256);
    expectConsistent(p);
  });

  test('free pushes the slot back (LIFO) and never zeroes it', () => {
    const p = bytePool();
    const a = p.alloc();
    p.alloc();
    p.u8(a).fill(7);
    const before = p.freeCount();
    p.free(a);
    expect(p.refcount(a)).toBe(0);
    expect(p.freeCount()).toBe(before + 1);
    expect(p.freeStack().at(-1)).toBe(a);
    expect(p.alloc()).toBe(a);
    expect(p.u8(a).every((v) => v === 7)).toBe(true);
    expect(p.refcount(a)).toBe(1);
  });

  test('retain: a slot retained n times is freed n + 1 times', () => {
    const p = bytePool();
    const a = p.alloc();
    p.retain(a);
    p.retain(a);
    expect(p.refcount(a)).toBe(3);
    const free0 = p.freeCount();
    p.free(a);
    p.free(a);
    expect(p.refcount(a)).toBe(1);
    expect(p.freeCount()).toBe(free0);
    expect(p.freeStack()).not.toContain(a);
    p.free(a);
    expect(p.refcount(a)).toBe(0);
    expect(p.freeCount()).toBe(free0 + 1);
    expectConsistent(p);
  });

  test('free or retain of a free slot, and ids out of range, throw', () => {
    const p = bytePool();
    const a = p.alloc();
    p.free(a);
    expect(() => p.free(a)).toThrow(/refcount/);
    expect(() => p.retain(a)).toThrow(/refcount/);
    expect(p.refcount(a)).toBe(0);
    expect(() => p.free(-1)).toThrow(RangeError);
    expect(() => p.free(p.slotCount())).toThrow(RangeError);
    expect(() => p.retain(1.5)).toThrow(RangeError);
    expect(() => p.u8(p.slotCount())).toThrow(RangeError);
    expectConsistent(p);
  });

  test('StoreFull at the maximum, with the lock released and the pool intact', () => {
    const p = blockPool(MiB);
    const ids = Array.from({ length: 128 }, () => p.alloc());
    expect(() => p.alloc()).toThrow(StoreFull);
    try {
      p.alloc();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreFull);
      expect((e as Error).name).toBe('StoreFull');
    }
    expect(p.slotCount()).toBe(128);
    expect(p.lockWord()).toBe(0);
    p.free(ids[5]!);
    expect(p.alloc()).toBe(ids[5]);
    expect(() => p.alloc()).toThrow(StoreFull);
    expectConsistent(p);
  });

  test('handles and attachPool rebuild the same pool', () => {
    const p = bytePool();
    const q = attachPool(p.handles());
    expect(q.slotBytes).toBe(p.slotBytes);
    expect(q.maxSlots).toBe(p.maxSlots);
    expect(q.shared).toBe(shared);
    const viewBefore = q.bytes;
    const a = p.alloc();
    expect(q.slotCount()).toBe(256);
    expect(viewBefore.length).toBe(MiB);
    expect(q.refcount(a)).toBe(1);
    q.retain(a);
    expect(p.refcount(a)).toBe(2);
    p.u8(a)[3] = 99;
    expect(q.u8(a)[3]).toBe(99);
    const b = q.alloc();
    expect(b).not.toBe(a);
    p.free(a);
    q.free(a);
    expect(p.freeStack().at(-1)).toBe(a);
    expectConsistent(p);
    expectConsistent(q);
  });

  test('random ops keep every slot accounted for', () => {
    const p = blockPool(2 * MiB);
    const rng = testRng(7);
    const refs: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const r = rng() % 10;
      if ((r < 4 && refs.length < 250) || refs.length === 0) refs.push(p.alloc());
      else if (r < 6) {
        const id = refs[rng() % refs.length]!;
        p.retain(id);
        refs.push(id);
      } else {
        const k = rng() % refs.length;
        p.free(refs[k]!);
        refs[k] = refs[refs.length - 1]!;
        refs.pop();
      }
    }
    const counts = new Map<number, number>();
    for (const id of refs) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (let id = 0; id < p.slotCount(); id++) expect(p.refcount(id)).toBe(counts.get(id) ?? 0);
    expectConsistent(p);
    for (const id of refs) p.free(id);
    expect(p.freeCount()).toBe(p.slotCount());
    expect(p.lockWord()).toBe(0);
    expectConsistent(p);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/pool.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/pool.test.ts [ test/unit/pool.test.ts ]
Error: Cannot find module '../../src/world/store/pool' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/pool.test.ts
Test Files  1 failed (1)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `src/world/store/pool.ts`:

```ts
/**
 * A slab pool over one growable buffer (SP3a spec §3.1): fixed-size slots, a lock-guarded Int32 free stack and
 * Int32 refcounts. The same code runs over a growable `SharedArrayBuffer` (`shared: true`, usable from several
 * threads through `handles()` / `attachPool`) and over a resizable `ArrayBuffer` (one thread). Atomics work on both.
 *
 * Buffers per pool:
 * - `data`: the slots, `slotBytes` each; slot id = the slot's index;
 * - `ctl`: Int32[4], fixed: the lock word, the stack top, the slot count;
 * - `stack`: the free stack, Int32 per slot; `refs`: the refcounts, Int32 per slot.
 * `data`, `stack` and `refs` start empty and grow together by `GROW_BYTES` of slots, under the lock, inside the
 * `alloc` that finds the stack empty (whichever thread that is). Every view is length-tracking, so growth made by
 * another thread is seen without rebuilding anything.
 */

/** Block pool slots: a u16 state per voxel of a 16³ section. */
export const BLOCK_SLOT_BYTES = 8192;
/** Byte pool slots: one byte per voxel (light, fluid) or an aux slot. */
export const BYTE_SLOT_BYTES = 4096;
/** A pool grows by 1 MiB of slots (128 block slots, 256 byte slots). */
export const GROW_BYTES = 1 << 20;
/** Default maxima: reserved address space, not committed memory. */
export const DEFAULT_MAX_BLOCK_BYTES = 768 * GROW_BYTES;
export const DEFAULT_MAX_BYTE_BYTES = 512 * GROW_BYTES;

const LOCK = 0;
const TOP = 1;
const COUNT = 2;
const CTL_INTS = 4;
const MAX_SPIN = 1024;

/** An alloc found the free stack empty and the pool at its maximum size. */
export class StoreFull extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreFull';
  }
}

export interface PoolOptions {
  readonly shared: boolean;
  /** A power of two dividing `GROW_BYTES`. */
  readonly slotBytes: number;
  /** A positive multiple of `GROW_BYTES`. */
  readonly maxBytes: number;
}

type Growable = SharedArrayBuffer | ArrayBuffer;

/** The buffers of a pool; `attachPool` rebuilds the pool from them (in another thread when `shared`). */
export interface PoolHandles {
  readonly shared: boolean;
  readonly slotBytes: number;
  readonly data: Growable;
  readonly ctl: Growable;
  readonly stack: Growable;
  readonly refs: Growable;
}

export interface SlabPool {
  readonly shared: boolean;
  readonly slotBytes: number;
  readonly maxSlots: number;
  /** The slot buffer. */
  readonly buffer: Growable;
  /** Length-tracking views over every slot; slot `id` starts at byte `id·slotBytes`. */
  readonly bytes: Uint8Array;
  readonly words: Uint16Array;
  /** Pops a slot with refcount 1, growing the pool when the free stack is empty. Throws `StoreFull` at the maximum. */
  alloc(): number;
  /** Adds a reference to a live slot. */
  retain(id: number): void;
  /** Drops a reference; the last one pushes the slot back. The slot is never zeroed. */
  free(id: number): void;
  refcount(id: number): number;
  slotCount(): number;
  freeCount(): number;
  /** A copy of the free stack, bottom first (taken under the lock). */
  freeStack(): Int32Array;
  /** The lock word (0 when free); for tests. */
  lockWord(): number;
  /** Fixed-length views over one slot. */
  u8(id: number): Uint8Array;
  u16(id: number): Uint16Array;
  handles(): PoolHandles;
}

function growable(shared: boolean, maxByteLength: number): Growable {
  return shared ? new SharedArrayBuffer(0, { maxByteLength }) : new ArrayBuffer(0, { maxByteLength });
}

function growTo(buf: Growable, byteLength: number): void {
  if (buf instanceof SharedArrayBuffer) buf.grow(byteLength);
  else buf.resize(byteLength);
}

export function createPool(opts: PoolOptions): SlabPool {
  const { shared, slotBytes, maxBytes } = opts;
  if (!Number.isInteger(slotBytes) || slotBytes < 2 || (slotBytes & (slotBytes - 1)) !== 0 || slotBytes > GROW_BYTES) {
    throw new RangeError(`pool: slotBytes ${slotBytes} is not a power of two in [2, ${GROW_BYTES}]`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes % GROW_BYTES !== 0) {
    throw new RangeError(`pool: maxBytes ${maxBytes} is not a positive multiple of ${GROW_BYTES}`);
  }
  const maxSlots = maxBytes / slotBytes;
  return attachPool({
    shared,
    slotBytes,
    data: growable(shared, maxBytes),
    ctl: shared ? new SharedArrayBuffer(4 * CTL_INTS) : new ArrayBuffer(4 * CTL_INTS),
    stack: growable(shared, 4 * maxSlots),
    refs: growable(shared, 4 * maxSlots),
  });
}

export function attachPool(h: PoolHandles): SlabPool {
  const { shared, slotBytes, data, stack: stackBuf, refs: refsBuf } = h;
  const maxSlots = data.maxByteLength / slotBytes;
  const slotsPerGrow = GROW_BYTES / slotBytes;
  const ctl = new Int32Array(h.ctl);
  const stack = new Int32Array(stackBuf);
  const refs = new Int32Array(refsBuf);
  const bytes = new Uint8Array(data);
  const words = new Uint16Array(data);

  /** Compare-exchange spin; the backoff re-reads the word (no `Atomics.wait`: the main thread may not block). */
  function lock(): void {
    let spins = 1;
    while (Atomics.compareExchange(ctl, LOCK, 0, 1) !== 0) {
      for (let i = 0; i < spins && Atomics.load(ctl, LOCK) !== 0; i++);
      if (spins < MAX_SPIN) spins <<= 1;
    }
  }

  function unlock(): void {
    Atomics.store(ctl, LOCK, 0);
  }

  function checkId(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= Atomics.load(ctl, COUNT)) {
      throw new RangeError(`pool: slot ${id} out of range`);
    }
  }

  /** Under the lock, with an empty stack: add up to GROW_BYTES of slots and push them, lowest id on top. */
  function grow(): void {
    const count = Atomics.load(ctl, COUNT);
    const n = Math.min(slotsPerGrow, maxSlots - count);
    if (n <= 0) throw new StoreFull(`pool of ${slotBytes}-byte slots is full (${count} slots)`);
    const total = count + n;
    growTo(data, total * slotBytes);
    growTo(stackBuf, 4 * total);
    growTo(refsBuf, 4 * total);
    for (let i = 0; i < n; i++) stack[i] = total - 1 - i;
    Atomics.store(ctl, TOP, n);
    Atomics.store(ctl, COUNT, total);
  }

  return {
    shared,
    slotBytes,
    maxSlots,
    buffer: data,
    bytes,
    words,
    alloc() {
      lock();
      try {
        if (Atomics.load(ctl, TOP) === 0) grow();
        const top = Atomics.load(ctl, TOP) - 1;
        const id = stack[top]!;
        Atomics.store(ctl, TOP, top);
        Atomics.store(refs, id, 1);
        return id;
      } finally {
        unlock();
      }
    },
    retain(id) {
      checkId(id);
      const old = Atomics.add(refs, id, 1);
      if (old <= 0) {
        Atomics.sub(refs, id, 1);
        throw new Error(`pool: retain of slot ${id} with refcount ${old}`);
      }
    },
    free(id) {
      checkId(id);
      const old = Atomics.sub(refs, id, 1);
      if (old <= 0) {
        Atomics.add(refs, id, 1);
        throw new Error(`pool: free of slot ${id} with refcount ${old}`);
      }
      if (old > 1) return;
      lock();
      try {
        const top = Atomics.load(ctl, TOP);
        stack[top] = id;
        Atomics.store(ctl, TOP, top + 1);
      } finally {
        unlock();
      }
    },
    refcount(id) {
      checkId(id);
      return Atomics.load(refs, id);
    },
    slotCount: () => Atomics.load(ctl, COUNT),
    freeCount: () => Atomics.load(ctl, TOP),
    freeStack() {
      lock();
      try {
        return stack.slice(0, Atomics.load(ctl, TOP));
      } finally {
        unlock();
      }
    },
    lockWord: () => Atomics.load(ctl, LOCK),
    u8(id) {
      checkId(id);
      return new Uint8Array(data, id * slotBytes, slotBytes);
    },
    u16(id) {
      checkId(id);
      return new Uint16Array(data, id * slotBytes, slotBytes >> 1);
    },
    handles: () => h,
  };
}
```

Modify `tsconfig.json` (apply with `git apply`):

```diff
diff --git a/tsconfig.json b/tsconfig.json
index 055a668..7e61b9d 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,6 +1,6 @@
 {
   "extends": "./tsconfig.base.json",
-  "compilerOptions": { "lib": ["ES2023", "DOM"], "types": ["vite/client"] },
+  "compilerOptions": { "lib": ["ES2024", "DOM"], "types": ["vite/client"] },
   "include": ["src/**/*.ts"],
   "exclude": ["src/workers/**"]
 }
```

Modify `tsconfig.test.json` (apply with `git apply`):

```diff
diff --git a/tsconfig.test.json b/tsconfig.test.json
index a8300c3..867ce0d 100644
--- a/tsconfig.test.json
+++ b/tsconfig.test.json
@@ -1,6 +1,6 @@
 {
   "extends": "./tsconfig.base.json",
-  "compilerOptions": { "lib": ["ES2023", "DOM"], "types": ["node", "vite/client"] },
+  "compilerOptions": { "lib": ["ES2024", "DOM"], "types": ["node", "vite/client"] },
   "include": ["test/**/*.ts", "vite.config.ts", "vitest.config.ts"],
   "exclude": ["test/arch/fixtures/**"]
 }
```

Modify `tsconfig.worker.json` (apply with `git apply`):

```diff
diff --git a/tsconfig.worker.json b/tsconfig.worker.json
index f66fe82..3bee740 100644
--- a/tsconfig.worker.json
+++ b/tsconfig.worker.json
@@ -1,5 +1,5 @@
 {
   "extends": "./tsconfig.base.json",
-  "compilerOptions": { "lib": ["ES2023", "WebWorker"], "types": [] },
+  "compilerOptions": { "lib": ["ES2024", "WebWorker"], "types": [] },
   "include": ["src/workers/**/*.ts"]
 }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/pool.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  26 passed (26)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  101 passed | 2 skipped (103)
Tests  1292 passed | 2 skipped (1294)
```

- [ ] **Step 6: Commit**

```bash
git add src/world/store/pool.ts test/unit/pool.test.ts tsconfig.json tsconfig.test.json tsconfig.worker.json
git commit -F - <<'EOF'
feat(store): slab pool over one growable buffer (SP3a §3.1)

createPool/attachPool over a growable SharedArrayBuffer or a resizable
ArrayBuffer: a compare-exchange spin lock, an Int32 free stack and Int32
refcounts in their own growable buffers, growth by 1 MiB of slots under
the lock by whichever thread finds the stack empty, StoreFull at the
maximum, retain/free (one free per reference, slots never zeroed),
length-tracking views and per-slot views. The tsconfig libs move to
ES2024 for the growable/resizable buffer types.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `e2bab59` on `dry/sp3a`; 5 files changed, 464 insertions(+), 3 deletions(-)):

RED replay (`test/**` over the parent): `test/unit/pool.test.ts` fails to import `src/world/store/pool` (1 file failed, no tests). GREEN: typecheck clean; `npm test` 94 files passed, 2 skipped / 1211 tests passed, 2 skipped (≈54 s); `pool.test.ts` 26 tests (13 per backend + 2 shared). A scratch 4-thread smoke (not committed; Task 8 owns it): 4 × 100k alloc/free on one shared 64 MiB block pool with ≤ 1,000 live slots per thread and a CAS owner table, run 3×: 0 double allocations, every slot back on the stack, lock 0, 0.8-1.0 s.

- Ruling: the three tsconfig `lib` entries move from ES2023 to ES2024 (target stays ES2023) — `new SharedArrayBuffer(n, {maxByteLength})`, `grow`, `ArrayBuffer#resize`, `growable`/`resizable`/`maxByteLength` are typed only from lib ES2024 (TS2550 under ES2023); runtime support: Node 24, Chrome 111+, Firefox 128+, Safari 16.4+ — cost if wrong: a one-line revert plus local `declare global` augmentations in `pool.ts`.
- Ruling: API `createPool({shared, slotBytes, maxBytes})` / `attachPool(handles)`; `SlabPool` = `alloc, retain, free, refcount, slotCount, freeCount, freeStack() (copy under the lock), lockWord(), u8(id), u16(id), handles()` plus `bytes`/`words` (length-tracking Uint8/Uint16 over the slot buffer), `buffer`, `slotBytes`, `maxSlots`, `shared`; `PoolHandles = {shared, slotBytes, data, ctl, stack, refs}` — Task 7's store builds its two pools and its handles from these; the fuzz (Task 8) needs freeStack/refcount/slotCount/freeCount for its checks — cost if wrong: renames in Tasks 6-8.
- Ruling: buffers per pool: `data` (slots, maxByteLength = maxBytes), `ctl` (fixed Int32[4]: lock, top, count, spare), `stack` and `refs` (growable, maxByteLength = 4·maxSlots); all three growable buffers start at 0 bytes and grow together inside the alloc that finds the stack empty; the first alloc of a fresh pool grows it — spec §3.1 says "own growable buffers" without fixing the split or the initial size — cost if wrong: none outside pool.ts.
- Ruling: new slots are pushed so that the lowest id is on top (a fresh pool hands out 0, 1, 2, …); free is LIFO — deterministic slot ids in single-threaded runs (tests can assert ids); `regionHash` does not depend on slot layout anyway — cost if wrong: none.
- Ruling: `slotBytes` must be a power of two ≤ 1 MiB and `maxBytes` a positive multiple of 1 MiB (RangeError otherwise), so growth is always whole 1 MiB steps and `maxSlots` is exact — every size the spec names (768/512 MiB defaults, fuzz 64/32 MiB, slice store 32/16 MiB) is a multiple — cost if wrong: relax to a final partial step (the grow already takes `min(slotsPerGrow, maxSlots − count)`).
- Ruling: `retain`/`free` of a slot whose refcount is ≤ 0, and any id outside `[0, slotCount)` or non-integer, throw (Error naming "refcount", RangeError), undoing the counter change — a double free is a store bug the fuzz must surface, not corrupt the stack silently — cost if wrong: one compare per call (measured by Task 15's `store.alloc` row).
- Ruling: lock = compare-exchange 0 → 1 with a test-and-test-and-set backoff (re-read `Atomics.load` up to 2^k times, k capped at 10), never `Atomics.wait`; `StoreFull` (class with `name = 'StoreFull'`, in `pool.ts`; Task 7 re-exports it from `store.ts` if wanted) is thrown inside try/finally so the lock is always released — cost if wrong: none.
- Ruling: the slot sizes, `GROW_BYTES` and the default maxima (`BLOCK_SLOT_BYTES` 8192, `BYTE_SLOT_BYTES` 4096, `DEFAULT_MAX_BLOCK_BYTES` 768 MiB, `DEFAULT_MAX_BYTE_BYTES` 512 MiB) are exported from `pool.ts` (§3.1 owns them; `world/` may export numeric constants) — cost if wrong: move them to `store.ts`.
- No spec defects found for Task 5.

---

### Task 6: world/store: column table, section descriptors, aux, epochs

**Spec:** §3.2, §3.3 (descriptor encodings, uniform↔dense per channel, meta word), §3.4

**Files:**
- Create: `src/world/store/api.ts`
- Create: `src/world/store/aux.ts`
- Create: `src/world/store/columnTable.ts`
- Create: `src/world/store/epochs.ts`
- Create: `src/world/store/section.ts`
- Create: `test/unit/aux.test.ts`
- Create: `test/unit/columnTable.test.ts`
- Create: `test/unit/epochs.test.ts`
- Create: `test/unit/section.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/store/pool.ts` (Task 5): `SlabPool`
- Produces (exports added by this task):
  - `src/world/store/api.ts`:
    - `export interface AuxView`
    - `export interface AuxBView`
  - `src/world/store/aux.ts`:
    - `export const AUX_BYTES = 4096;`
    - `export const AUX_A_OFFSETS =`
    - `export const AUX_B_OFFSETS = { caveBiomeQ: 0, surfaceBiomeQ: 1536 } as const;`
    - `export const HEIGHT_NONE = -64;`
    - `export function allocAux(pool: SlabPool): number`
    - `export function auxView(pool: SlabPool, slot: number): AuxView`
    - `export function auxBView(pool: SlabPool, slot: number): AuxBView`
  - `src/world/store/columnTable.ts`:
    - `export const TORUS = 64;`
    - `export const RECORD_INTS = 160;`
    - `export const RECORD_COUNT = TORUS * TORUS;`
    - `export const COLUMN_TABLE_BYTES = RECORD_COUNT * RECORD_INTS * 4;`
    - `export const SECTIONS = 24;`
    - `export const REC_CX = 0;`
    - `export const REC_CZ = 1;`
    - `export const REC_STATUS = 2;`
    - `export const REC_EPOCH = 3;`
    - `export const REC_BLOCK_VERSION = 4;`
    - `export const REC_LIGHT_VERSION = 5;`
    - `export const REC_PROTO_FLAGS = 6;`
    - `export const REC_AUX_A = 7;`
    - `export const REC_AUX_B = 8;`
    - `export const REC_UNSETTLED = 9;`
    - `export const REC_DIFF_FLAG = 10;`
    - `export const REC_CLAIMED = 11;`
    - `export const REC_FINAL = 16;`
    - `export const REC_PROTO = 112;`
    - `export const STATUS_ABSENT = 0;`
    - `export const STATUS_PROTO = 1;`
    - `export const STATUS_DECORATED = 2;`
    - `export const STATUS_PUBLISHED = 3;`
    - `export const NO_COLUMN = 0x7fffffff;`
    - `export class SlotBusy extends Error`
    - `export function recordBase(cx: number, cz: number): number`
    - `export function finalAt(base: number, sy: number): number`
    - `export function protoAt(base: number, sy: number): number`
    - `export interface ColumnTable`
    - `export function createColumnTable(shared: boolean): ColumnTable`
    - `export function attachColumnTable(buffer: SharedArrayBuffer | ArrayBuffer): ColumnTable`
  - `src/world/store/epochs.ts`:
    - `export const EPOCH_CELL = { terrain: 0, decorate: 1, light: 2, mesh: 3 } as const;`
    - `export const EPOCH_CELL_COUNT = 4;`
    - `export interface EpochCells`
    - `export function createEpochCells(shared: boolean): EpochCells`
    - `export function attachEpochCells(buffer: SharedArrayBuffer | ArrayBuffer): EpochCells`
  - `src/world/store/section.ts`:
    - `export const SECTION_VOXELS = 4096;`
    - `export const FINAL_BLOCKS = 0;`
    - `export const FINAL_LIGHT = 1;`
    - `export const FINAL_FLUID = 2;`
    - `export const FINAL_META = 3;`
    - `export const FINAL_INTS = 4;`
    - `export const PROTO_BLOCKS = 0;`
    - `export const PROTO_FLUID = 1;`
    - `export const PROTO_INTS = 2;`
    - `export const META_NON_AIR = 0x1fff;`
    - `export const META_OPAQUE = 1 << 13;`
    - `export const META_CUTOUT = 1 << 14;`
    - `export const META_TRANSLUCENT = 1 << 15;`
    - `export const META_FLUID = 1 << 16;`
    - `export function uniformCode(v: number): number`
    - `export function uniformValue(code: number): number`
    - `export function isDense(code: number): boolean`
    - `export function storeWords(pool: SlabPool, ints: Int32Array, at: number, src: Uint16Array): void`
    - `export function storeBytes(pool: SlabPool, ints: Int32Array, at: number, src: Uint8Array): void`
    - `export function releaseEntry(pool: SlabPool, ints: Int32Array, at: number): void`
    - `export function shareEntry(pool: SlabPool, ints: Int32Array, from: number, to: number): void`
    - `export function wordAt(pool: SlabPool, code: number, i: number): number`
    - `export function byteAt(pool: SlabPool, code: number, i: number): number`
    - `export function sectionWords(pool: SlabPool, code: number): Uint16Array | number`
    - `export function sectionBytes(pool: SlabPool, code: number): Uint8Array | number`
    - `export function computeMeta(blocks: Uint16Array | number, fluid: Uint8Array | number, pass: Uint8Array): number`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/aux.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { allocAux, AUX_A_OFFSETS, AUX_B_OFFSETS, AUX_BYTES, auxBView, auxView, HEIGHT_NONE } from '../../src/world/store/aux';
import { BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool } from '../../src/world/store/pool';

const MiB = 1 << 20;

test('aux A and aux B layouts (SP3a spec §3.4, master §2.3)', () => {
  expect(AUX_BYTES).toBe(4096);
  expect(AUX_A_OFFSETS).toEqual({
    worldSurfaceWG: 0, oceanFloorWG: 512, worldSurface: 1024, motionBlocking: 1536, oceanFloor: 2048,
    lightBlocking: 2560, surfaceBiome: 3072, tintTH: 3328,
  });
  // Six Int16[256] heightmaps, Uint8[256] surfaceBiome and Uint8[768] tintTH fill the slot exactly.
  expect(6 * 512 + 256 + 768).toBe(AUX_BYTES);
  expect(AUX_B_OFFSETS).toEqual({ caveBiomeQ: 0, surfaceBiomeQ: 1536 });
  expect(HEIGHT_NONE).toBe(-64);
});

describe.each([true, false])('shared %s', (shared) => {
  const bytePool = () => createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: 4 * MiB });

  test('views: named typed subarrays of the slot at the §3.4 offsets', () => {
    const pool = bytePool();
    pool.alloc();
    const slot = allocAux(pool);
    const a = auxView(pool, slot);
    const base = slot * AUX_BYTES;
    const heightmaps = ['worldSurfaceWG', 'oceanFloorWG', 'worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking'] as const;
    for (const k of heightmaps) {
      expect(a[k]).toBeInstanceOf(Int16Array);
      expect(a[k].length).toBe(256);
      expect(a[k].byteOffset).toBe(base + AUX_A_OFFSETS[k]);
      expect(a[k].buffer).toBe(pool.buffer);
    }
    expect(a.surfaceBiome).toBeInstanceOf(Uint8Array);
    expect(a.surfaceBiome.length).toBe(256);
    expect(a.surfaceBiome.byteOffset).toBe(base + 3072);
    expect(a.tintTH.length).toBe(768);
    expect(a.tintTH.byteOffset).toBe(base + 3328);
    const b = auxBView(pool, slot);
    expect(b.caveBiomeQ.length).toBe(1536);
    expect(b.caveBiomeQ.byteOffset).toBe(base);
    expect(b.surfaceBiomeQ.length).toBe(16);
    expect(b.surfaceBiomeQ.byteOffset).toBe(base + 1536);
  });

  test('Int16 values are little-endian at lz·16 + lx; the last tintTH byte is the last slot byte', () => {
    const pool = bytePool();
    const slot = allocAux(pool);
    const a = auxView(pool, slot);
    const base = slot * AUX_BYTES;
    const i = 3 * 16 + 5; // lx 5, lz 3
    a.oceanFloorWG[i] = -64;
    a.worldSurfaceWG[i] = 0x0102;
    expect(pool.bytes[base + 2 * i]).toBe(0x02);
    expect(pool.bytes[base + 2 * i + 1]).toBe(0x01);
    expect(new DataView(pool.buffer, base + 512 + 2 * i, 2).getInt16(0, true)).toBe(-64);
    a.tintTH[767] = 9;
    expect(pool.bytes[base + 4095]).toBe(9);
  });

  test('allocAux zero-fills the whole slot, a recycled dirty slot included', () => {
    const pool = bytePool();
    const slot = allocAux(pool);
    pool.u8(slot).fill(0xff);
    pool.free(slot);
    expect(pool.u8(slot)[0]).toBe(0xff); // the pool never zeroes on free
    const again = allocAux(pool);
    expect(again).toBe(slot);
    expect(pool.refcount(again)).toBe(1);
    expect(pool.u8(again).every((x) => x === 0)).toBe(true);
    const a = auxView(pool, again);
    expect(a.lightBlocking[255]).toBe(0);
    expect(auxBView(pool, again).surfaceBiomeQ[15]).toBe(0);
  });

  test('aux slots live in the byte pool only', () => {
    const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: 4 * MiB });
    expect(() => allocAux(blocks)).toThrow(RangeError);
    expect(blocks.slotCount()).toBe(0);
    expect(() => auxView(blocks, 0)).toThrow(RangeError);
  });
});
```

Create `test/unit/columnTable.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  attachColumnTable, COLUMN_TABLE_BYTES, createColumnTable, finalAt, NO_COLUMN, protoAt, RECORD_COUNT, RECORD_INTS, recordBase,
  REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED, REC_CX, REC_CZ, REC_DIFF_FLAG, REC_EPOCH, REC_FINAL,
  REC_LIGHT_VERSION, REC_PROTO, REC_PROTO_FLAGS, REC_STATUS, REC_UNSETTLED, SECTIONS, SlotBusy, STATUS_ABSENT,
  STATUS_DECORATED, STATUS_PROTO, STATUS_PUBLISHED, TORUS, type ColumnTable,
} from '../../src/world/store/columnTable';

/** Every record free, as `createStore` leaves it (SP3a spec §3.2). */
function expectFree(t: ColumnTable, base: number): void {
  const r = t.ints;
  expect(r[base + REC_CLAIMED]).toBe(0);
  expect([r[base + REC_CX], r[base + REC_CZ]]).toEqual([NO_COLUMN, NO_COLUMN]);
  expect(r[base + REC_STATUS]).toBe(STATUS_ABSENT);
  expect(r[base + REC_AUX_A]).toBe(-1);
  expect(r[base + REC_AUX_B]).toBe(-1);
  for (let sy = 0; sy < SECTIONS; sy++) {
    const f = finalAt(base, sy);
    expect([r[f], r[f + 1], r[f + 2], r[f + 3]]).toEqual([-1, -1, -1, 0]);
    const p = protoAt(base, sy);
    expect([r[p], r[p + 1]]).toEqual([-1, -1]);
  }
}

test('record layout (SP3a spec §3.2, master §2.3)', () => {
  expect(TORUS).toBe(64);
  expect(RECORD_INTS).toBe(160);
  expect(RECORD_COUNT).toBe(4096);
  expect(COLUMN_TABLE_BYTES).toBe(64 * 64 * 160 * 4);
  expect(SECTIONS).toBe(24);
  expect([REC_CX, REC_CZ, REC_STATUS, REC_EPOCH]).toEqual([0, 1, 2, 3]);
  expect([REC_BLOCK_VERSION, REC_LIGHT_VERSION, REC_PROTO_FLAGS]).toEqual([4, 5, 6]);
  expect([REC_AUX_A, REC_AUX_B, REC_UNSETTLED, REC_DIFF_FLAG, REC_CLAIMED]).toEqual([7, 8, 9, 10, 11]);
  expect([REC_FINAL, REC_PROTO]).toEqual([16, 112]);
  expect([STATUS_ABSENT, STATUS_PROTO, STATUS_DECORATED, STATUS_PUBLISHED]).toEqual([0, 1, 2, 3]);
  // 24 final descriptors of 4 ints fill 16-111, 24 proto descriptors of 2 ints fill 112-159.
  expect(finalAt(0, 0)).toBe(16);
  expect(finalAt(0, 23) + 4).toBe(112);
  expect(protoAt(0, 0)).toBe(112);
  expect(protoAt(0, 23) + 2).toBe(160);
  expect(finalAt(RECORD_INTS, 1)).toBe(RECORD_INTS + 20);
  expect(protoAt(RECORD_INTS, 1)).toBe(RECORD_INTS + 114);
});

test('record = torus slot (cx & 63) + 64·(cz & 63), negative coordinates included', () => {
  expect(recordBase(0, 0)).toBe(0);
  expect(recordBase(1, 0)).toBe(RECORD_INTS);
  expect(recordBase(0, 1)).toBe(64 * RECORD_INTS);
  expect(recordBase(-1, -1)).toBe((63 + 64 * 63) * RECORD_INTS);
  expect(recordBase(64, -64)).toBe(0);
  expect(recordBase(-32768, 32767)).toBe((0 + 64 * 63) * RECORD_INTS);
  const seen = new Set<number>();
  for (let cz = -32; cz < 32; cz++) for (let cx = 100; cx < 164; cx++) seen.add(recordBase(cx, cz));
  expect(seen.size).toBe(RECORD_COUNT);
});

describe.each([true, false])('shared %s', (shared) => {
  test('the buffer is fixed, of the requested kind, and every record starts free', () => {
    const t = createColumnTable(shared);
    expect(t.buffer instanceof SharedArrayBuffer).toBe(shared);
    expect(t.buffer.byteLength).toBe(COLUMN_TABLE_BYTES);
    if (t.buffer instanceof SharedArrayBuffer) expect(t.buffer.growable).toBe(false);
    else expect(t.buffer.resizable).toBe(false);
    for (let rec = 0; rec < RECORD_COUNT; rec++) expectFree(t, rec * RECORD_INTS);
    expect(t.find(0, 0)).toBe(-1);
  });

  test('claim writes cx, cz and epoch, leaves the rest initial; find sees only the holder', () => {
    const t = createColumnTable(shared);
    const base = t.claim(-3, 70, 9);
    expect(base).toBe(recordBase(-3, 70));
    expect(t.ints[base + REC_CLAIMED]).toBe(1);
    expect(t.ints[base + REC_CX]).toBe(-3);
    expect(t.ints[base + REC_CZ]).toBe(70);
    expect(t.epoch(base)).toBe(9);
    expect(t.status(base)).toBe(STATUS_ABSENT);
    expect(t.blockVersion(base)).toBe(0);
    expect(t.lightVersion(base)).toBe(0);
    expect(t.find(-3, 70)).toBe(base);
    // Same record, another column: absent (spec §3.2 "a read of a column whose record holds another column").
    expect(t.find(-3 + 64, 70)).toBe(-1);
    expect(t.find(-3, 70 - 64)).toBe(-1);
    expect(t.find(-2, 70)).toBe(-1);
  });

  test('claiming a held record throws SlotBusy, for another column and for the same one', () => {
    const t = createColumnTable(shared);
    const base = t.claim(5, 5, 1);
    for (const [cx, cz] of [[5, 5], [69, 5], [5, -59]] as const) {
      let err: unknown;
      try {
        t.claim(cx, cz, 2);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SlotBusy);
      expect((err as Error).name).toBe('SlotBusy');
    }
    // The failed claims changed nothing.
    expect(t.ints[base + REC_CX]).toBe(5);
    expect(t.epoch(base)).toBe(1);
    expect(t.find(5, 5)).toBe(base);
  });

  test('unclaim frees the record; a later claim of another column on it succeeds and starts initial', () => {
    const t = createColumnTable(shared);
    const base = t.claim(0, 0, 4);
    t.setStatus(base, STATUS_PROTO);
    t.bumpBlockVersion(base);
    t.bumpLightVersion(base);
    t.ints[base + REC_PROTO_FLAGS] = 7;
    t.ints[base + REC_UNSETTLED] = 3;
    t.ints[base + REC_DIFF_FLAG] = 1;
    t.setStatus(base, STATUS_ABSENT);
    t.clear(base);
    t.unclaim(base);
    expectFree(t, base);
    expect(t.find(0, 0)).toBe(-1);
    expect(t.claim(64, 64, 5)).toBe(base);
    expect(t.find(64, 64)).toBe(base);
    expect(t.status(base)).toBe(STATUS_ABSENT);
    expect(t.blockVersion(base)).toBe(0);
    expect(t.lightVersion(base)).toBe(0);
    expect(t.ints[base + REC_PROTO_FLAGS]).toBe(0);
    expect(t.ints[base + REC_UNSETTLED]).toBe(0);
    expect(t.ints[base + REC_DIFF_FLAG]).toBe(0);
  });

  test('claim resets a record left dirty by a holder (versions, descriptors, aux ids)', () => {
    const t = createColumnTable(shared);
    const base = t.claim(1, 2, 0);
    t.ints[finalAt(base, 3) + 3] = 99;
    t.ints[protoAt(base, 3)] = 12;
    t.ints[base + REC_AUX_A] = 4;
    t.bumpBlockVersion(base);
    t.unclaim(base);
    t.claim(1, 2, 1);
    t.unclaim(base);
    expectFree(t, base);
    expect(t.blockVersion(base)).toBe(0);
  });

  test('status, epoch and versions', () => {
    const t = createColumnTable(shared);
    const base = t.claim(-1, -1, 3);
    expect(t.bumpBlockVersion(base)).toBe(1);
    expect(t.bumpBlockVersion(base)).toBe(2);
    expect(t.bumpLightVersion(base)).toBe(1);
    expect(t.blockVersion(base)).toBe(2);
    expect(t.lightVersion(base)).toBe(1);
    t.setStatus(base, STATUS_PUBLISHED);
    expect(t.status(base)).toBe(STATUS_PUBLISHED);
    expect(t.status(recordBase(0, 0))).toBe(STATUS_ABSENT);
  });

  test('attachColumnTable over the same buffer sees the same records', () => {
    const t = createColumnTable(shared);
    const u = attachColumnTable(t.buffer);
    const base = t.claim(10, -10, 6);
    expect(u.find(10, -10)).toBe(base);
    expect(u.epoch(base)).toBe(6);
    expect(() => u.claim(74, -10, 0)).toThrow(SlotBusy);
    u.unclaim(base);
    expect(t.find(10, -10)).toBe(-1);
  });
});

test('a record being claimed never matches a lookup of its previous column', () => {
  const t = createColumnTable(false);
  const base = t.claim(5, 5, 0);
  t.unclaim(base);
  // Another column takes the record: between the compare-exchange and the cx/cz writes, cx/cz are NO_COLUMN.
  Atomics.store(t.ints, base + REC_CLAIMED, 1);
  expect(t.find(5, 5)).toBe(-1);
  expect(NO_COLUMN).toBeGreaterThan(1 << 20);
});

test('attachColumnTable refuses a buffer of another size', () => {
  expect(() => attachColumnTable(new ArrayBuffer(16))).toThrow(RangeError);
});
```

Create `test/unit/epochs.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { attachEpochCells, createEpochCells, EPOCH_CELL, EPOCH_CELL_COUNT } from '../../src/world/store/epochs';

test('one cell per pipeline phase (SP3a spec §3.4)', () => {
  expect(EPOCH_CELL).toEqual({ terrain: 0, decorate: 1, light: 2, mesh: 3 });
  expect(EPOCH_CELL_COUNT).toBe(4);
});

describe.each([true, false])('shared %s', (shared) => {
  test('the buffer is of the requested kind and every cell starts at 0', () => {
    const e = createEpochCells(shared);
    expect(e.buffer instanceof SharedArrayBuffer).toBe(shared);
    expect(e.buffer.byteLength).toBe(4 * EPOCH_CELL_COUNT);
    for (let c = 0; c < EPOCH_CELL_COUNT; c++) expect(e.get(c)).toBe(0);
  });

  test('set, get and bump per scope; scopes are independent', () => {
    const e = createEpochCells(shared);
    e.set(EPOCH_CELL.light, 7);
    expect(e.get(EPOCH_CELL.light)).toBe(7);
    expect(e.bump(EPOCH_CELL.light)).toBe(8);
    expect(e.bump(EPOCH_CELL.mesh)).toBe(1);
    expect(e.get(EPOCH_CELL.terrain)).toBe(0);
    expect(e.get(EPOCH_CELL.decorate)).toBe(0);
    expect(e.get(EPOCH_CELL.mesh)).toBe(1);
    expect(e.get(EPOCH_CELL.light)).toBe(8);
  });

  test('an unknown cell is refused', () => {
    const e = createEpochCells(shared);
    expect(() => e.get(4)).toThrow(RangeError);
    expect(() => e.set(-1, 0)).toThrow(RangeError);
    expect(() => e.bump(1.5)).toThrow(RangeError);
  });

  test('attachEpochCells over the same buffer sees the same cells', () => {
    const e = createEpochCells(shared);
    const f = attachEpochCells(e.buffer);
    e.set(EPOCH_CELL.decorate, 3);
    expect(f.get(EPOCH_CELL.decorate)).toBe(3);
    f.bump(EPOCH_CELL.terrain);
    expect(e.get(EPOCH_CELL.terrain)).toBe(1);
  });
});

test('attachEpochCells refuses a buffer of another size', () => {
  expect(() => attachEpochCells(new ArrayBuffer(8))).toThrow(RangeError);
});
```

Create `test/unit/section.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, type SlabPool } from '../../src/world/store/pool';
import {
  byteAt, computeMeta, FINAL_BLOCKS, FINAL_FLUID, FINAL_INTS, FINAL_LIGHT, FINAL_META, isDense, META_CUTOUT,
  META_FLUID, META_NON_AIR, META_OPAQUE, META_TRANSLUCENT, PROTO_BLOCKS, PROTO_FLUID, PROTO_INTS, releaseEntry,
  sectionBytes, sectionWords, SECTION_VOXELS, shareEntry, storeBytes, storeWords, uniformCode, uniformValue, wordAt,
} from '../../src/world/store/section';

const MiB = 1 << 20;
/** A PASS table as the registry builds it (codes of SP3a spec §2.1): air none, 1 opaque, 2 cutout, 3 translucent. */
const PASS = new Uint8Array(4096);
PASS[1] = 1;
PASS[2] = 1;
PASS[5] = 2;
PASS[6] = 3;
PASS[7] = 0; // a non-air state with PASS none counts in nonAir but sets no pass bit

const words = (v: number) => new Uint16Array(SECTION_VOXELS).fill(v);
const bytes = (v: number) => new Uint8Array(SECTION_VOXELS).fill(v);

/** Every refcount and the free-stack size, to compare before and after. */
function snapshot(p: SlabPool): { free: number; refs: number[] } {
  const refs: number[] = [];
  for (let id = 0; id < p.slotCount(); id++) refs.push(p.refcount(id));
  return { free: p.freeCount(), refs };
}

test('descriptor encodings and layout (SP3a spec §3.3)', () => {
  expect(SECTION_VOXELS).toBe(4096);
  expect([FINAL_BLOCKS, FINAL_LIGHT, FINAL_FLUID, FINAL_META, FINAL_INTS]).toEqual([0, 1, 2, 3, 4]);
  expect([PROTO_BLOCKS, PROTO_FLUID, PROTO_INTS]).toEqual([0, 1, 2]);
  // −1 is uniform 0: air, light 0, no fluid.
  expect(uniformCode(0)).toBe(-1);
  expect(uniformCode(2)).toBe(-3);
  expect(uniformCode(4095)).toBe(-4096);
  expect(uniformCode(0x11)).toBe(-18); // a water source byte
  for (const v of [0, 1, 255, 4095, 65535]) expect(uniformValue(uniformCode(v))).toBe(v);
  expect(isDense(-1)).toBe(false);
  expect(isDense(0)).toBe(true);
  expect(isDense(17)).toBe(true);
});

test('meta word bits (SP3a spec §3.3)', () => {
  expect(META_NON_AIR).toBe(0x1fff);
  expect([META_OPAQUE, META_CUTOUT, META_TRANSLUCENT, META_FLUID]).toEqual([1 << 13, 1 << 14, 1 << 15, 1 << 16]);
  expect(computeMeta(words(0), bytes(0), PASS)).toBe(0);
  expect(computeMeta(0, 0, PASS)).toBe(0);
  expect(computeMeta(words(1), bytes(0), PASS)).toBe(4096 | META_OPAQUE);
  expect(computeMeta(1, 0, PASS)).toBe(4096 | META_OPAQUE);
  expect(computeMeta(7, 0, PASS)).toBe(4096);
  // Fluid type in bits 4-5 (water 1, lava 2); level, falling and unsettled alone are not a fluid.
  expect(computeMeta(0, 0x10, PASS)).toBe(META_FLUID);
  expect(computeMeta(0, 0x27, PASS)).toBe(META_FLUID);
  expect(computeMeta(0, 0x4f, PASS)).toBe(0);
  const b = words(0);
  b[0] = 1;
  b[100] = 5;
  b[4095] = 6;
  b[200] = 7;
  const f = bytes(0);
  f[3] = 0x18; // water, falling
  expect(computeMeta(b, f, PASS)).toBe(4 | META_OPAQUE | META_CUTOUT | META_TRANSLUCENT | META_FLUID);
  expect(computeMeta(b, 0, PASS)).toBe(4 | META_OPAQUE | META_CUTOUT | META_TRANSLUCENT);
  expect(computeMeta(b, uniformValue(-1), PASS) & META_NON_AIR).toBe(4);
});

describe.each([true, false])('shared %s', (shared) => {
  const pools = () => ({
    blocks: createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: 4 * MiB }),
    bytes: createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: 4 * MiB }),
  });

  test('uniform blocks take no slot; reading returns the constant', () => {
    const { blocks } = pools();
    const ints = new Int32Array(4).fill(-1);
    storeWords(blocks, ints, 1, words(2));
    expect(ints[1]).toBe(-3);
    expect(blocks.slotCount()).toBe(0);
    expect(sectionWords(blocks, ints[1]!)).toBe(2);
    expect(wordAt(blocks, ints[1]!, 0)).toBe(2);
    expect(wordAt(blocks, ints[1]!, 4095)).toBe(2);
    storeWords(blocks, ints, 1, words(0));
    expect(ints[1]).toBe(-1);
  });

  test('blocks: uniform → dense → uniform (promotion allocates, demotion releases)', () => {
    const { blocks } = pools();
    const ints = new Int32Array(2).fill(-1);
    const src = words(1);
    src[4095] = 2;
    storeWords(blocks, ints, 0, src);
    const id = ints[0]!;
    expect(isDense(id)).toBe(true);
    expect(blocks.refcount(id)).toBe(1);
    src[4095] = 9; // the store copied the array: the caller may reuse its scratch buffer
    const view = sectionWords(blocks, id) as Uint16Array;
    expect(view.length).toBe(4096);
    expect(view[0]).toBe(1);
    expect(view[4095]).toBe(2);
    expect(wordAt(blocks, id, 4095)).toBe(2);
    expect(wordAt(blocks, id, 17)).toBe(1);
    const before = blocks.freeCount();
    storeWords(blocks, ints, 0, words(1));
    expect(ints[0]).toBe(-2);
    expect(blocks.refcount(id)).toBe(0);
    expect(blocks.freeCount()).toBe(before + 1);
  });

  test('a dense rewrite takes a new slot and releases the old one', () => {
    const { blocks } = pools();
    const ints = new Int32Array(1).fill(-1);
    const a = words(0);
    a[0] = 1;
    storeWords(blocks, ints, 0, a);
    const first = ints[0]!;
    const b = words(0);
    b[1] = 1;
    storeWords(blocks, ints, 0, b);
    const second = ints[0]!;
    expect(second).not.toBe(first);
    expect(blocks.refcount(first)).toBe(0);
    expect(blocks.refcount(second)).toBe(1);
    expect(wordAt(blocks, second, 0)).toBe(0);
    expect(wordAt(blocks, second, 1)).toBe(1);
  });

  test('light and fluid bytes: uniform (including -1-byte fluid) and dense, both ways', () => {
    const { bytes: bp } = pools();
    const d = new Int32Array(4).fill(-1);
    // A full water section of an ocean costs no slot (SP3a spec §3.3, §11).
    storeBytes(bp, d, FINAL_FLUID, bytes(0x10));
    expect(d[FINAL_FLUID]).toBe(-1 - 0x10);
    expect(sectionBytes(bp, d[FINAL_FLUID]!)).toBe(0x10);
    expect(byteAt(bp, d[FINAL_FLUID]!, 77)).toBe(0x10);
    storeBytes(bp, d, FINAL_LIGHT, bytes(0xf0));
    expect(d[FINAL_LIGHT]).toBe(-1 - 0xf0);
    expect(bp.slotCount()).toBe(0);
    const mixed = bytes(0x10);
    mixed.fill(0, 2048);
    storeBytes(bp, d, FINAL_FLUID, mixed);
    const id = d[FINAL_FLUID]!;
    expect(isDense(id)).toBe(true);
    expect(byteAt(bp, id, 0)).toBe(0x10);
    expect(byteAt(bp, id, 4095)).toBe(0);
    const v = sectionBytes(bp, id) as Uint8Array;
    expect(v.length).toBe(4096);
    expect(Array.from(v.subarray(2046, 2050))).toEqual([0x10, 0x10, 0, 0]);
    storeBytes(bp, d, FINAL_FLUID, bytes(0));
    expect(d[FINAL_FLUID]).toBe(-1);
    expect(bp.refcount(id)).toBe(0);
  });

  test('channels are independent: dense blocks with uniform fluid and the reverse', () => {
    const { blocks, bytes: bp } = pools();
    const p = new Int32Array(2).fill(-1);
    const b = words(1);
    b[5] = 0;
    storeWords(blocks, p, PROTO_BLOCKS, b);
    storeBytes(bp, p, PROTO_FLUID, bytes(0));
    expect(isDense(p[PROTO_BLOCKS]!)).toBe(true);
    expect(p[PROTO_FLUID]).toBe(-1);
    const f = bytes(0);
    f[5] = 0x10;
    storeWords(blocks, p, PROTO_BLOCKS, words(1));
    storeBytes(bp, p, PROTO_FLUID, f);
    expect(p[PROTO_BLOCKS]).toBe(-2);
    expect(isDense(p[PROTO_FLUID]!)).toBe(true);
    expect(blocks.freeCount()).toBe(blocks.slotCount());
  });

  test('a slot recycled dirty is overwritten whole by the next dense write', () => {
    const { bytes: bp } = pools();
    const d = new Int32Array(1).fill(-1);
    const dirty = bytes(0xaa);
    dirty[0] = 1;
    storeBytes(bp, d, 0, dirty);
    const id = d[0]!;
    storeBytes(bp, d, 0, bytes(0));
    const next = bytes(0);
    next[1] = 3;
    storeBytes(bp, d, 0, next);
    expect(d[0]).toBe(id); // LIFO: the same slot comes back, never zeroed on free
    expect(Array.from(sectionBytes(bp, id) as Uint8Array).every((x, i) => x === (i === 1 ? 3 : 0))).toBe(true);
  });

  test('wrong-length arrays and a pool of the wrong slot size are refused', () => {
    const { blocks, bytes: bp } = pools();
    const d = new Int32Array(1).fill(-1);
    expect(() => storeWords(blocks, d, 0, new Uint16Array(4095))).toThrow(RangeError);
    expect(() => storeBytes(bp, d, 0, new Uint8Array(4097))).toThrow(RangeError);
    expect(() => storeWords(bp, d, 0, words(1))).toThrow(RangeError);
    expect(() => storeBytes(blocks, d, 0, bytes(1))).toThrow(RangeError);
    expect(d[0]).toBe(-1);
  });

  test('sharing: a shared slot holds two references; each set releases once', () => {
    const { blocks, bytes: bp } = pools();
    blocks.alloc(); // grow first, so the snapshot covers every slot the test touches
    bp.alloc();
    const before = { b: snapshot(blocks), y: snapshot(bp) };
    // One column's sy 0: proto at 0-1, final at 2-5 (any int layout works; the record's is §3.2's).
    const r = new Int32Array(6).fill(-1);
    r[5] = 0;
    const b = words(1);
    b[0] = 0;
    const f = bytes(0);
    f[0] = 0x10;
    storeWords(blocks, r, 0, b);
    storeBytes(bp, r, 1, f);
    shareEntry(blocks, r, 0, 2);
    shareEntry(bp, r, 1, 4);
    storeBytes(bp, r, 3, bytes(0xf0));
    expect(r[2]).toBe(r[0]);
    expect(r[4]).toBe(r[1]);
    expect(blocks.refcount(r[0]!)).toBe(2);
    expect(bp.refcount(r[1]!)).toBe(2);
    const blockSlot = r[0]!;
    const fluidSlot = r[1]!;
    // Free the proto set: the final set still holds the slots.
    releaseEntry(blocks, r, 0);
    releaseEntry(bp, r, 1);
    expect([r[0], r[1]]).toEqual([-1, -1]);
    expect(blocks.refcount(blockSlot)).toBe(1);
    expect(bp.refcount(fluidSlot)).toBe(1);
    expect(wordAt(blocks, r[2]!, 1)).toBe(1);
    // Then the final set: everything is back as before the column.
    releaseEntry(blocks, r, 2);
    releaseEntry(bp, r, 3);
    releaseEntry(bp, r, 4);
    expect([r[2], r[3], r[4]]).toEqual([-1, -1, -1]);
    expect(snapshot(blocks)).toEqual(before.b);
    expect(snapshot(bp)).toEqual(before.y);
  });

  test('sharing a uniform entry copies the code and retains nothing; releasing it releases nothing', () => {
    const { blocks } = pools();
    const r = new Int32Array(2).fill(-1);
    storeWords(blocks, r, 0, words(2));
    shareEntry(blocks, r, 0, 1);
    expect(r[1]).toBe(-3);
    releaseEntry(blocks, r, 0);
    releaseEntry(blocks, r, 1);
    expect(blocks.slotCount()).toBe(0);
  });

  test('sharing over a dense entry releases what the target held', () => {
    const { blocks } = pools();
    const r = new Int32Array(2).fill(-1);
    const a = words(0);
    a[0] = 1;
    storeWords(blocks, r, 0, a);
    storeWords(blocks, r, 1, a);
    const old = r[1]!;
    shareEntry(blocks, r, 0, 1);
    expect(blocks.refcount(old)).toBe(0);
    expect(blocks.refcount(r[0]!)).toBe(2);
    shareEntry(blocks, r, 0, 1); // re-sharing the same slot keeps the count
    expect(blocks.refcount(r[0]!)).toBe(2);
  });

  test('a failed dense write (StoreFull) leaves the descriptor and its slot intact', () => {
    const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: MiB });
    const r = new Int32Array(1).fill(-1);
    const a = words(0);
    a[0] = 1;
    storeWords(blocks, r, 0, a);
    const held = r[0]!;
    while (blocks.freeCount() > 0) blocks.alloc();
    const b = words(0);
    b[1] = 1;
    expect(() => storeWords(blocks, r, 0, b)).toThrow(/full/);
    expect(r[0]).toBe(held);
    expect(blocks.refcount(held)).toBe(1);
    expect(wordAt(blocks, held, 0)).toBe(1);
    storeWords(blocks, r, 0, words(0)); // a uniform write needs no slot and releases the held one
    expect(r[0]).toBe(-1);
    expect(blocks.refcount(held)).toBe(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/aux.test.ts test/unit/columnTable.test.ts test/unit/epochs.test.ts test/unit/section.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/aux.test.ts [ test/unit/aux.test.ts ]
Error: Cannot find module '../../src/world/store/aux' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/aux.test.ts
FAIL  |unit| test/unit/columnTable.test.ts [ test/unit/columnTable.test.ts ]
Error: Cannot find module '../../src/world/store/columnTable' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/columnTable.test.ts
FAIL  |unit| test/unit/epochs.test.ts [ test/unit/epochs.test.ts ]
Error: Cannot find module '../../src/world/store/epochs' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/epochs.test.ts
FAIL  |unit| test/unit/section.test.ts [ test/unit/section.test.ts ]
Error: Cannot find module '../../src/world/store/section' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/section.test.ts
Test Files  4 failed (4)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `src/world/store/api.ts`:

```ts
/**
 * The store types `gen` may import (types only; SP3a spec §3.5). `store.ts` holds the implementation, which `gen`
 * never imports.
 */

/**
 * Aux A of a column (SP3a spec §3.4): named views over its 4096-byte slot. Per-position arrays are indexed by the
 * column index `lz·16 + lx`; heightmaps hold the absolute y of the highest qualifying voxel plus one (−64 when none).
 */
export interface AuxView {
  readonly worldSurfaceWG: Int16Array;
  readonly oceanFloorWG: Int16Array;
  readonly worldSurface: Int16Array;
  readonly motionBlocking: Int16Array;
  readonly oceanFloor: Int16Array;
  readonly lightBlocking: Int16Array;
  readonly surfaceBiome: Uint8Array;
  readonly tintTH: Uint8Array;
}

/** Aux B of a column (SP3a spec §3.4): the biome quarts. */
export interface AuxBView {
  readonly caveBiomeQ: Uint8Array;
  readonly surfaceBiomeQ: Uint8Array;
}
```

Create `src/world/store/aux.ts`:

```ts
/**
 * Aux slots (SP3a spec §3.4, master §2.3): one byte-pool slot of exactly 4096 bytes per kind and column.
 * - Aux A: six Int16[256] heightmaps (`WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WORLD_SURFACE` 1024,
 *   `MOTION_BLOCKING` 1536, `OCEAN_FLOOR` 2048, `LIGHT_BLOCKING` 2560), `surfaceBiome` Uint8[256] at 3072 and
 *   `tintTH` Uint8[768] at 3328. Int16 values are little-endian (native on every target).
 * - Aux B: `caveBiomeQ` Uint8[1536] at 0 and `surfaceBiomeQ` Uint8[16] at 1536; the rest of the slot is 0.
 * An aux slot is zero-filled when allocated, a recycled slot included, so a field no stage wrote reads 0.
 */
import type { AuxBView, AuxView } from './api';
import type { SlabPool } from './pool';

export const AUX_BYTES = 4096;

/** Byte offsets of the aux A fields in their slot. */
export const AUX_A_OFFSETS = {
  worldSurfaceWG: 0,
  oceanFloorWG: 512,
  worldSurface: 1024,
  motionBlocking: 1536,
  oceanFloor: 2048,
  lightBlocking: 2560,
  surfaceBiome: 3072,
  tintTH: 3328,
} as const;

/** Byte offsets of the aux B fields in their slot. */
export const AUX_B_OFFSETS = { caveBiomeQ: 0, surfaceBiomeQ: 1536 } as const;

/** A heightmap value when no voxel of the column qualifies: the bottom of the world. */
export const HEIGHT_NONE = -64;

const COLUMNS = 256;

function checkBytePool(pool: SlabPool): void {
  if (pool.slotBytes !== AUX_BYTES) throw new RangeError(`aux: a pool of ${pool.slotBytes}-byte slots, expected ${AUX_BYTES}`);
}

/** Allocates an aux slot in the byte pool and zero-fills all 4096 bytes. */
export function allocAux(pool: SlabPool): number {
  checkBytePool(pool);
  const slot = pool.alloc();
  pool.bytes.fill(0, slot * AUX_BYTES, (slot + 1) * AUX_BYTES);
  return slot;
}

/** Aux A views over `slot`. */
export function auxView(pool: SlabPool, slot: number): AuxView {
  checkBytePool(pool);
  const at = pool.u8(slot).byteOffset;
  const buf = pool.buffer;
  const o = AUX_A_OFFSETS;
  return {
    worldSurfaceWG: new Int16Array(buf, at + o.worldSurfaceWG, COLUMNS),
    oceanFloorWG: new Int16Array(buf, at + o.oceanFloorWG, COLUMNS),
    worldSurface: new Int16Array(buf, at + o.worldSurface, COLUMNS),
    motionBlocking: new Int16Array(buf, at + o.motionBlocking, COLUMNS),
    oceanFloor: new Int16Array(buf, at + o.oceanFloor, COLUMNS),
    lightBlocking: new Int16Array(buf, at + o.lightBlocking, COLUMNS),
    surfaceBiome: new Uint8Array(buf, at + o.surfaceBiome, COLUMNS),
    tintTH: new Uint8Array(buf, at + o.tintTH, 3 * COLUMNS),
  };
}

/** Aux B views over `slot`. */
export function auxBView(pool: SlabPool, slot: number): AuxBView {
  checkBytePool(pool);
  const at = pool.u8(slot).byteOffset;
  return {
    caveBiomeQ: new Uint8Array(pool.buffer, at + AUX_B_OFFSETS.caveBiomeQ, 1536),
    surfaceBiomeQ: new Uint8Array(pool.buffer, at + AUX_B_OFFSETS.surfaceBiomeQ, 16),
  };
}
```

Create `src/world/store/columnTable.ts`:

```ts
/**
 * The column table (SP3a spec §3.2, master §2.3): a fixed buffer of 64 × 64 records of 160 int32, one per torus
 * slot `(cx & 63) + 64·(cz & 63)`. A record holds at most one column; `claimed` (int 11) says whether it is held,
 * and cx, cz say by which column. `status`, `epoch`, `claimed` and the versions are read and written with Atomics.
 *
 * Record layout: 0-3 cx, cz, status, epoch; 4-5 blockVersion, lightVersion; 6 protoFlags; 7-8 aux A and aux B
 * slots (−1 when not allocated); 9-10 unsettledCount, diffFlag; 11 claimed; 12-15 unassigned; 16-111 the final
 * section descriptors (24 × 4: blocks, light, fluid, meta); 112-159 the proto descriptors (24 × 2: blocks, fluid).
 *
 * A free record has cx = cz = `NO_COLUMN`, and a claim writes cx and cz only after it holds the record, so `find`
 * never matches a record that is free or being taken by another column.
 *
 * The table only keeps records: releasing the slots a record references is the store's job (`section.ts`), done
 * before `unclaim`.
 */

export const TORUS = 64;
export const RECORD_INTS = 160;
export const RECORD_COUNT = TORUS * TORUS;
export const COLUMN_TABLE_BYTES = RECORD_COUNT * RECORD_INTS * 4;
/** Sections per column (y −64 … 319). */
export const SECTIONS = 24;

export const REC_CX = 0;
export const REC_CZ = 1;
export const REC_STATUS = 2;
export const REC_EPOCH = 3;
export const REC_BLOCK_VERSION = 4;
export const REC_LIGHT_VERSION = 5;
export const REC_PROTO_FLAGS = 6;
export const REC_AUX_A = 7;
export const REC_AUX_B = 8;
export const REC_UNSETTLED = 9;
export const REC_DIFF_FLAG = 10;
export const REC_CLAIMED = 11;
export const REC_FINAL = 16;
export const REC_PROTO = 112;

export const STATUS_ABSENT = 0;
export const STATUS_PROTO = 1;
export const STATUS_DECORATED = 2;
export const STATUS_PUBLISHED = 3;

/** cx and cz of a free record: outside every coordinate range, so a stale record never matches a lookup. */
export const NO_COLUMN = 0x7fffffff;

const FINAL_STRIDE = 4;
const PROTO_STRIDE = 2;

/** A claim found its record held (by another column or by the same one); free the holder first. */
export class SlotBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotBusy';
  }
}

/** Int offset of the record of (cx, cz): its torus slot times `RECORD_INTS`. */
export function recordBase(cx: number, cz: number): number {
  return ((cx & 63) + 64 * (cz & 63)) * RECORD_INTS;
}

/** Int offset of section `sy`'s final descriptor (blocks, light, fluid, meta) in the record at `base`. */
export function finalAt(base: number, sy: number): number {
  return base + REC_FINAL + FINAL_STRIDE * sy;
}

/** Int offset of section `sy`'s proto descriptor (blocks, fluid) in the record at `base`. */
export function protoAt(base: number, sy: number): number {
  return base + REC_PROTO + PROTO_STRIDE * sy;
}

export interface ColumnTable {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  /** Every record, `RECORD_INTS` per record; descriptors are plain ints published by `status` (Atomics). */
  readonly ints: Int32Array;
  /**
   * Takes the record of (cx, cz) (compare-exchange of `claimed` 0 → 1; `SlotBusy` if held) and writes cx, cz and
   * `epoch`; the rest of the record is reset to its initial values (status Absent, versions 0, descriptors −1,
   * meta 0, aux ids −1). Returns the record's base.
   */
  claim(cx: number, cz: number, epoch: number): number;
  /** The base of the record holding (cx, cz), or −1 when the record is free or holds another column. */
  find(cx: number, cz: number): number;
  /** Writes the initial values into every field but cx, cz, epoch and `claimed`; releases nothing. */
  clear(base: number): void;
  /** Stores cx and cz `NO_COLUMN`, then `claimed` 0. The caller has released every slot the record referenced. */
  unclaim(base: number): void;
  status(base: number): number;
  setStatus(base: number, status: number): void;
  epoch(base: number): number;
  blockVersion(base: number): number;
  lightVersion(base: number): number;
  /** `Atomics.add` of 1; returns the new version. */
  bumpBlockVersion(base: number): number;
  bumpLightVersion(base: number): number;
}

function clearRecord(ints: Int32Array, base: number): void {
  Atomics.store(ints, base + REC_STATUS, STATUS_ABSENT);
  Atomics.store(ints, base + REC_BLOCK_VERSION, 0);
  Atomics.store(ints, base + REC_LIGHT_VERSION, 0);
  ints[base + REC_PROTO_FLAGS] = 0;
  ints[base + REC_AUX_A] = -1;
  ints[base + REC_AUX_B] = -1;
  ints[base + REC_UNSETTLED] = 0;
  ints[base + REC_DIFF_FLAG] = 0;
  for (let sy = 0; sy < SECTIONS; sy++) {
    const f = finalAt(base, sy);
    ints[f] = -1;
    ints[f + 1] = -1;
    ints[f + 2] = -1;
    ints[f + 3] = 0;
    const p = protoAt(base, sy);
    ints[p] = -1;
    ints[p + 1] = -1;
  }
}

/** A new table, every record free. `shared` picks a `SharedArrayBuffer` (several threads) or an `ArrayBuffer`. */
export function createColumnTable(shared: boolean): ColumnTable {
  const buffer = shared ? new SharedArrayBuffer(COLUMN_TABLE_BYTES) : new ArrayBuffer(COLUMN_TABLE_BYTES);
  const ints = new Int32Array(buffer);
  for (let rec = 0; rec < RECORD_COUNT; rec++) {
    const base = rec * RECORD_INTS;
    ints[base + REC_CX] = NO_COLUMN;
    ints[base + REC_CZ] = NO_COLUMN;
    clearRecord(ints, base);
  }
  return attachColumnTable(buffer);
}

/** The table over an existing buffer (`createColumnTable(...).buffer`, possibly from another thread). */
export function attachColumnTable(buffer: SharedArrayBuffer | ArrayBuffer): ColumnTable {
  if (buffer.byteLength !== COLUMN_TABLE_BYTES) {
    throw new RangeError(`columnTable: buffer of ${buffer.byteLength} bytes, expected ${COLUMN_TABLE_BYTES}`);
  }
  const ints = new Int32Array(buffer);
  return {
    buffer,
    ints,
    claim(cx, cz, epoch) {
      const base = recordBase(cx, cz);
      if (Atomics.compareExchange(ints, base + REC_CLAIMED, 0, 1) !== 0) {
        throw new SlotBusy(`column (${cx}, ${cz}): record held by (${Atomics.load(ints, base + REC_CX)}, ${Atomics.load(ints, base + REC_CZ)})`);
      }
      clearRecord(ints, base);
      Atomics.store(ints, base + REC_CX, cx);
      Atomics.store(ints, base + REC_CZ, cz);
      Atomics.store(ints, base + REC_EPOCH, epoch);
      return base;
    },
    find(cx, cz) {
      const base = recordBase(cx, cz);
      if (Atomics.load(ints, base + REC_CLAIMED) !== 1) return -1;
      if (Atomics.load(ints, base + REC_CX) !== cx || Atomics.load(ints, base + REC_CZ) !== cz) return -1;
      return base;
    },
    clear: (base) => clearRecord(ints, base),
    unclaim(base) {
      Atomics.store(ints, base + REC_CX, NO_COLUMN);
      Atomics.store(ints, base + REC_CZ, NO_COLUMN);
      Atomics.store(ints, base + REC_CLAIMED, 0);
    },
    status: (base) => Atomics.load(ints, base + REC_STATUS),
    setStatus(base, status) {
      Atomics.store(ints, base + REC_STATUS, status);
    },
    epoch: (base) => Atomics.load(ints, base + REC_EPOCH),
    blockVersion: (base) => Atomics.load(ints, base + REC_BLOCK_VERSION),
    lightVersion: (base) => Atomics.load(ints, base + REC_LIGHT_VERSION),
    bumpBlockVersion: (base) => Atomics.add(ints, base + REC_BLOCK_VERSION, 1) + 1,
    bumpLightVersion: (base) => Atomics.add(ints, base + REC_LIGHT_VERSION, 1) + 1,
  };
}
```

Create `src/world/store/epochs.ts`:

```ts
/**
 * Per-scope epoch cells (SP3a spec §3.4, master §2.3, §4.3): one Int32 per pipeline phase in its own buffer (a
 * `SharedArrayBuffer` when `shared`, an `ArrayBuffer` otherwise), read and written with Atomics. Built in SP3a; SP4
 * wires them into the worker pool in place of the pool-wide abort cell.
 */

/** Cell index per pipeline phase. */
export const EPOCH_CELL = { terrain: 0, decorate: 1, light: 2, mesh: 3 } as const;
export const EPOCH_CELL_COUNT = 4;

export interface EpochCells {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  readonly cells: Int32Array;
  get(cell: number): number;
  set(cell: number, epoch: number): void;
  /** `Atomics.add` of 1; returns the new epoch. */
  bump(cell: number): number;
}

export function createEpochCells(shared: boolean): EpochCells {
  const bytes = 4 * EPOCH_CELL_COUNT;
  return attachEpochCells(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
}

/** The cells over an existing buffer (`createEpochCells(...).buffer`, possibly from another thread). */
export function attachEpochCells(buffer: SharedArrayBuffer | ArrayBuffer): EpochCells {
  if (buffer.byteLength !== 4 * EPOCH_CELL_COUNT) {
    throw new RangeError(`epochs: buffer of ${buffer.byteLength} bytes, expected ${4 * EPOCH_CELL_COUNT}`);
  }
  const cells = new Int32Array(buffer);
  const check = (cell: number): number => {
    if (!Number.isInteger(cell) || cell < 0 || cell >= EPOCH_CELL_COUNT) throw new RangeError(`epochs: no cell ${cell}`);
    return cell;
  };
  return {
    buffer,
    cells,
    get: (cell) => Atomics.load(cells, check(cell)),
    set(cell, epoch) {
      Atomics.store(cells, check(cell), epoch);
    },
    bump: (cell) => Atomics.add(cells, check(cell), 1) + 1,
  };
}
```

Create `src/world/store/section.ts`:

```ts
/**
 * Section descriptors (SP3a spec §3.3, master §2.3). A descriptor entry is one int32 per channel:
 * - a slot id (≥ 0) for a dense channel: blocks in the block pool (u16 per voxel), light and fluid in the byte pool;
 * - `-1-value` for a uniform channel (no slot): `-1-stateId`, `-1-lightByte`, `-1-fluidByte`. −1 is therefore
 *   air, light 0 and "no fluid" (fluid byte 0), which is what an unwritten descriptor reads as.
 * Final descriptors are 4 ints (blocks, light, fluid, meta), proto descriptors 2 (blocks, fluid).
 *
 * Every dense entry holds one reference to its slot. Rewriting an entry releases what it held; sharing an entry
 * retains the slot; releasing an entry frees it once. The functions here act on one entry of an Int32Array (the
 * column table's records, or any other array of entries) and leave set-level bookkeeping to the store.
 *
 * Meta word: bits 0-12 nonAir (voxels whose state is not air, state 0), bit 13 hasOpaque, 14 hasCutout,
 * 15 hasTranslucent (any voxel whose PASS is that pass), bit 16 hasFluid (any fluid type ≠ 0), bits 17-31 the
 * connectivity bits (0 until SP4).
 */
import type { SlabPool } from './pool';

/** Voxels per 16³ section, and entries per channel array. */
export const SECTION_VOXELS = 4096;

export const FINAL_BLOCKS = 0;
export const FINAL_LIGHT = 1;
export const FINAL_FLUID = 2;
export const FINAL_META = 3;
export const FINAL_INTS = 4;
export const PROTO_BLOCKS = 0;
export const PROTO_FLUID = 1;
export const PROTO_INTS = 2;

export const META_NON_AIR = 0x1fff;
export const META_OPAQUE = 1 << 13;
export const META_CUTOUT = 1 << 14;
export const META_TRANSLUCENT = 1 << 15;
export const META_FLUID = 1 << 16;

/** Fluid type, bits 4-5 of the fluid byte (SP3a spec §2.1). */
const FLUID_TYPE_MASK = 0x30;

/** The entry of a uniform channel of value `v`. */
export function uniformCode(v: number): number {
  return -1 - v;
}

/** The value of a uniform entry (`code` < 0). */
export function uniformValue(code: number): number {
  return -1 - code;
}

/** True when the entry is a slot id. */
export function isDense(code: number): boolean {
  return code >= 0;
}

function checkChannel(pool: SlabPool, src: Uint16Array | Uint8Array): void {
  if (src.length !== SECTION_VOXELS) throw new RangeError(`section: ${src.length} entries, expected ${SECTION_VOXELS}`);
  if (pool.slotBytes !== src.BYTES_PER_ELEMENT * SECTION_VOXELS) {
    throw new RangeError(`section: a ${src.BYTES_PER_ELEMENT}-byte channel in a pool of ${pool.slotBytes}-byte slots`);
  }
}

/** Index of the first entry that differs from entry 0, or `SECTION_VOXELS` when the array is uniform. */
function firstDiff(src: Uint16Array | Uint8Array): number {
  const v = src[0]!;
  let i = 1;
  while (i < SECTION_VOXELS && src[i] === v) i++;
  return i;
}

/** Copies `src` into a new slot, or encodes it uniform; stores the entry at `ints[at]` and releases the old one. */
function storeChannel(pool: SlabPool, ints: Int32Array, at: number, src: Uint16Array | Uint8Array, view: Uint16Array | Uint8Array): void {
  checkChannel(pool, src);
  let code: number;
  if (firstDiff(src) === SECTION_VOXELS) {
    code = uniformCode(src[0]!);
  } else {
    code = pool.alloc();
    view.set(src, code * SECTION_VOXELS);
  }
  const old = ints[at]!;
  ints[at] = code;
  if (old >= 0) pool.free(old);
}

/** Stores a block channel (4096 u16 states, copied) at `ints[at]`, uniform or dense; `pool` is the block pool. */
export function storeWords(pool: SlabPool, ints: Int32Array, at: number, src: Uint16Array): void {
  storeChannel(pool, ints, at, src, pool.words);
}

/** Stores a light or fluid channel (4096 bytes, copied) at `ints[at]`, uniform or dense; `pool` is the byte pool. */
export function storeBytes(pool: SlabPool, ints: Int32Array, at: number, src: Uint8Array): void {
  storeChannel(pool, ints, at, src, pool.bytes);
}

/** Releases the entry at `ints[at]` (frees its slot once when dense) and resets it to −1. */
export function releaseEntry(pool: SlabPool, ints: Int32Array, at: number): void {
  const old = ints[at]!;
  ints[at] = -1;
  if (old >= 0) pool.free(old);
}

/** Makes `ints[to]` share `ints[from]`: a dense slot is retained (one more reference); the old `ints[to]` is released. */
export function shareEntry(pool: SlabPool, ints: Int32Array, from: number, to: number): void {
  const code = ints[from]!;
  if (code >= 0) pool.retain(code);
  const old = ints[to]!;
  ints[to] = code;
  if (old >= 0) pool.free(old);
}

/** Voxel `i`'s state in a block entry. */
export function wordAt(pool: SlabPool, code: number, i: number): number {
  return code < 0 ? -1 - code : pool.words[code * SECTION_VOXELS + i]!;
}

/** Voxel `i`'s byte in a light or fluid entry. */
export function byteAt(pool: SlabPool, code: number, i: number): number {
  return code < 0 ? -1 - code : pool.bytes[code * SECTION_VOXELS + i]!;
}

/** A block entry as a view over its slot (4096 states), or its uniform state. */
export function sectionWords(pool: SlabPool, code: number): Uint16Array | number {
  return code < 0 ? -1 - code : pool.u16(code);
}

/** A light or fluid entry as a view over its slot (4096 bytes), or its uniform byte. */
export function sectionBytes(pool: SlabPool, code: number): Uint8Array | number {
  return code < 0 ? -1 - code : pool.u8(code);
}

/** The pass bit of a `PASS` code: none 0 → 0, opaque 1, cutout 2, translucent 3 → bits 13, 14, 15. */
function passBit(code: number): number {
  return code === 0 ? 0 : 1 << (12 + code);
}

/**
 * The meta word of a section from its blocks and fluid (arrays or uniform values, as `sectionWords` and
 * `sectionBytes` return them). `pass` is the registry's per-state `PASS` table; air is state 0.
 */
export function computeMeta(blocks: Uint16Array | number, fluid: Uint8Array | number, pass: Uint8Array): number {
  let meta = 0;
  if (typeof blocks === 'number') {
    if (blocks !== 0) meta = SECTION_VOXELS | passBit(pass[blocks]!);
  } else {
    let nonAir = 0;
    let passes = 0;
    for (let i = 0; i < SECTION_VOXELS; i++) {
      const s = blocks[i]!;
      if (s !== 0) {
        nonAir++;
        passes |= passBit(pass[s]!);
      }
    }
    meta = nonAir | passes;
  }
  if (typeof fluid === 'number') {
    if ((fluid & FLUID_TYPE_MASK) !== 0) meta |= META_FLUID;
  } else {
    for (let i = 0; i < SECTION_VOXELS; i++) {
      if ((fluid[i]! & FLUID_TYPE_MASK) !== 0) {
        meta |= META_FLUID;
        break;
      }
    }
  }
  return meta;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/aux.test.ts test/unit/columnTable.test.ts test/unit/epochs.test.ts test/unit/section.test.ts`

Expected: PASS (exit 0)

```
Test Files  4 passed (4)
Tests  61 passed (61)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  105 passed | 2 skipped (107)
Tests  1353 passed | 2 skipped (1355)
```

- [ ] **Step 6: Commit**

```bash
git add src/world/store/api.ts src/world/store/aux.ts src/world/store/columnTable.ts src/world/store/epochs.ts src/world/store/section.ts test/unit/aux.test.ts test/unit/columnTable.test.ts test/unit/epochs.test.ts test/unit/section.test.ts
git commit -F - <<'EOF'
feat(store): column table, section descriptors, aux slots and epoch cells (SP3a §3.2-3.4)

- columnTable.ts: the fixed 64 × 64 torus of 160-int32 records (§3.2 layout), claim by
  compare-exchange of `claimed` (SlotBusy when held), find (null for a free record or
  another column), clear/unclaim, status/epoch/versions through Atomics.
- section.ts: descriptor encodings (slot or -1-value per channel, uniform fluid included),
  uniform/dense per channel with release on rewrite, shareEntry/releaseEntry (one
  reference per dense entry), readers and section views, the meta word.
- aux.ts: aux A and aux B offsets and views, zero-filled allocation in the byte pool.
- epochs.ts: per-scope epoch cells (terrain, decorate, light, mesh).
- api.ts: AuxView and AuxBView (the rest of the gen-facing types arrive with the store).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `767ce0e` on `dry/sp3a`; 9 files changed, 1072 insertions(+)):

RED replay (the commit's `test/**` over the parent): 4 files fail to import `src/world/store/{columnTable,section,aux,epochs}` (4 failed, no tests). GREEN: typecheck clean; the 4 new files 61 tests; `npm test` 98 files passed, 2 skipped / 1272 passed, 2 skipped (≈35 s).

- Ruling: Task 6 builds the four modules as building blocks over plain Int32Array entries and `SlabPool`s; set-level operations (`setProto`/`setFinal`/`shareFinal`, `freeColumn`/`freeProto`, views) stay in Task 7's `store.ts`. `section.ts` acts on one entry `ints[at]`: `storeWords(blockPool, ints, at, src)` / `storeBytes(bytePool, ints, at, src)` (copy, uniform when every entry equals entry 0, else a new slot; the new entry is written before the old one is released), `releaseEntry` (free once if dense, reset to −1), `shareEntry(pool, ints, from, to)` (retain if dense, release the old `to`), `wordAt`/`byteAt`, `sectionWords`/`sectionBytes` (`Uint16Array | number`, `Uint8Array | number`), `uniformCode`/`uniformValue`/`isDense`, offsets `FINAL_BLOCKS/LIGHT/FLUID/META`, `PROTO_BLOCKS/FLUID`, `META_*` bits — the skeleton lists §3.3 encodings, uniform↔dense and meta for Task 6 and the API for Task 7 — cost if wrong: Task 7 composes them differently, no format change.
- Ruling: a dense rewrite always takes a new slot (alloc, copy, store the entry, then free the old slot), never reusing the old one even at refcount 1 — a shared slot (refcount 2) must never be overwritten in place, and a `StoreFull` on the alloc leaves the descriptor and its old slot intact (tested) — cost if wrong: one extra alloc/free per dense rewrite (rewrites are rare: T writes each proto section once).
- Ruling: `computeMeta(blocks, fluid, pass)` takes the registry's `PASS` table as a parameter and treats state 0 as air (§2.2: air id 0); it accepts arrays or uniform values, so `shareFinal` can compute meta from the proto entries without expanding them — `world/blocks` is on the other phase-1 chain and the store must not depend on it before the merge; Task 7 decides how the store gets `PASS` (an option, or `import { PASS }` from `world/blocks/index` once the chains are merged — `world` may import `world`) — cost if wrong: one parameter.
- Ruling: the fluid-type mask (0x30, bits 4-5) is a private constant in `section.ts`, not imported from `world/blocks/fluid.ts` (other chain) — cost if wrong: a later alias after the merge.
- Ruling: `columnTable.ts` API — `createColumnTable(shared)` / `attachColumnTable(buffer)` (RangeError on another size); constants `TORUS` 64, `RECORD_INTS` 160, `RECORD_COUNT` 4096, `COLUMN_TABLE_BYTES` 2,621,440, `SECTIONS` 24, `REC_*` field offsets, `STATUS_*`; pure `recordBase(cx, cz)` (torus slot × 160), `finalAt(base, sy)`, `protoAt(base, sy)`; methods `claim(cx, cz, epoch)` → base (`SlotBusy` class here, `name = 'SlotBusy'`), `find(cx, cz)` → base or −1, `clear(base)` (initial values, releases nothing), `unclaim(base)`, `status/setStatus/epoch/blockVersion/lightVersion/bumpBlockVersion/bumpLightVersion` (Atomics) — the store (Task 7) maps −1 to null — cost if wrong: renames in Task 7.
- Ruling: a free record has cx = cz = `NO_COLUMN` (0x7fffffff); `unclaim` stores them before `claimed` 0 and `claim` writes cx, cz only after its compare-exchange and a full reset of the record; `find` checks `claimed`, cx and cz — so a lookup never matches a record that is free or being taken over by another column (spec §3.6 "a lookup never returns another column's record"); §3.2 lists the initial values without cx/cz — cost if wrong: none (cx/cz of a free record are not read by anything else).
- Ruling: `claim` rewrites the whole record (status Absent, versions 0, protoFlags/unsettled/diff 0, aux −1, descriptors −1, meta 0) rather than trusting `freeColumn` to have left it initial — §3.5 "leaves status Absent, the versions 0, every descriptor −1" — 160 int writes per claim; it cannot leak because a record is only claimable after `unclaim`, which the store calls after releasing every entry — cost if wrong: none.
- Ruling: descriptor ints and aux ids are plain (non-Atomic) writes, published by the `Atomics.store` of `status` in `commit` (seq-cst Atomics order the earlier plain writes for a reader that `Atomics.load`s the status) — cost if wrong: Task 8's fuzz would show it; switch to Atomics.store per entry.
- Ruling: `AuxView` and `AuxBView` are declared now in `src/world/store/api.ts` (the spec puts them there, §3.5) and `aux.ts` imports them as types; Task 7 adds `ColumnWriter`, `ColumnView`, `NeighborhoodReader` to the same file — cost if wrong: none.
- Ruling: `aux.ts` exports `AUX_BYTES` 4096, `AUX_A_OFFSETS` / `AUX_B_OFFSETS` (objects keyed by the view field names), `HEIGHT_NONE` −64, `allocAux(bytePool)` (alloc + zero fill of all 4096 bytes), `auxView(pool, slot)`, `auxBView(pool, slot)` (fixed-length Int16/Uint8 subarrays over the slot; RangeError on a pool whose slots are not 4096 bytes) — the spec's names `WORLD_SURFACE_WG` … are the field offsets, spelled as the `AuxView` field names — cost if wrong: renames.
- Ruling: `epochs.ts`: `EPOCH_CELL = {terrain 0, decorate 1, light 2, mesh 3}`, `EPOCH_CELL_COUNT` 4, `createEpochCells(shared)` / `attachEpochCells(buffer)` → `{buffer, cells, get(cell), set(cell, epoch), bump(cell)}` (Atomics; RangeError for an unknown cell); a fixed 16-byte buffer — cost if wrong: SP4 reshapes it, nothing reads it in SP3a.
- Ruling: `SECTIONS` (columnTable.ts), `SECTION_VOXELS` (section.ts) and `recordBase`'s torus formula duplicate `core/coords.ts` (Task 2, chain blocks: `SECTIONS`, `SECTION_VOXELS`, `torusSlot`) because the chains are independent until phase 2; Task 7 or the phase-2 merge may alias them from `core/coords` (`world` may import `core`) — cost if wrong: a small cleanup after the merge.
- No spec defects found for Task 6.

---

### Task 7: world/store: the store and its API

**Spec:** §3.5, §3.6 unit list

**Files:**
- Modify: `src/world/store/api.ts`
- Create: `src/world/store/store.ts`
- Create: `test/unit/fixtures/storeWorker.mjs`
- Create: `test/unit/store.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/store/pool.ts` (Task 5): `BLOCK_SLOT_BYTES`, `BYTE_SLOT_BYTES`, `DEFAULT_MAX_BLOCK_BYTES`, `DEFAULT_MAX_BYTE_BYTES`, `attachPool`, `createPool`, `type PoolHandles`, `type SlabPool`
  - `src/world/store/api.ts` (Task 6): `AuxBView`, `AuxView`, `ColumnView`, `ColumnWriter`, `CommitStatus`, `NeighborhoodReader`
  - `src/world/store/aux.ts` (Task 6): `allocAux`, `auxBView`, `auxView`
  - `src/world/store/columnTable.ts` (Task 6): `REC_AUX_A`, `REC_AUX_B`, `REC_CLAIMED`, `REC_CX`, `REC_CZ`, `SECTIONS`, `STATUS_ABSENT`, `STATUS_DECORATED`, `STATUS_PROTO`, `attachColumnTable`, `createColumnTable`, `finalAt`, `protoAt`, `type ColumnTable`
  - `src/world/store/epochs.ts` (Task 6): `attachEpochCells`, `createEpochCells`, `type EpochCells`
  - `src/world/store/section.ts` (Task 6): `FINAL_BLOCKS`, `FINAL_FLUID`, `FINAL_LIGHT`, `FINAL_META`, `PROTO_BLOCKS`, `PROTO_FLUID`, `SECTION_VOXELS`, `byteAt`, `computeMeta`, `releaseEntry`, `sectionBytes`, `sectionWords`, `shareEntry`, `storeBytes`, `storeWords`, `wordAt`
- Produces (exports added by this task):
  - `src/world/store/api.ts`:
    - `export type CommitStatus = 1 | 2 | 3;`
    - `export interface ColumnWriter`
    - `export interface ColumnView`
    - `export interface NeighborhoodReader`
  - `src/world/store/store.ts`:
    - `export { SlotBusy } from './columnTable';`
    - `export { StoreFull } from './pool';`
    - `export type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, NeighborhoodReader } from './api';`
    - `export const DEFAULT_PASS: Uint8Array = new Uint8Array(STATE_TABLE_SIZE).fill(1);`
    - `export interface StoreOptions`
    - `export interface StoreHandles`
    - `export interface VoxelStore`
    - `export function createStore(opts: StoreOptions): VoxelStore`
    - `export function attachStore(h: StoreHandles): VoxelStore`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/fixtures/storeWorker.mjs`:

```js
// The worker side of store.test.ts "attachStore across two threads": attaches to the main thread's store, reads
// its column (2, 2), writes columns (3 … 7, 2) with 24 dense block sections each (growing the block pool), bumps
// the terrain epoch cell and replies with what it read.
import { parentPort, workerData } from 'node:worker_threads';

const { storeUrl, handles } = workerData;

async function main() {
  const { attachStore } = await import(storeUrl);
  const s = attachStore(handles);
  const v = s.proto(2, 2);
  if (v === null) return { ok: false, error: 'column (2, 2) absent in the worker' };
  const read = [];
  for (let sy = 0; sy < 24; sy++) read.push(v.block(1, sy * 16 - 64, 0));
  read.push(v.block(0, -64, 0), v.fluid(0, -64, 0), v.aux().worldSurfaceWG[3]);
  for (let cx = 3; cx <= 7; cx++) {
    const w = s.claimColumn(cx, 2, 0);
    for (let sy = 0; sy < 24; sy++) {
      const b = new Uint16Array(4096);
      b.fill(1, 0, 2048);
      b[1] = 1000 + cx * 100 + sy;
      w.setProto(sy, b, new Uint8Array(4096));
    }
    w.aux().oceanFloorWG[255] = cx;
    w.commit(1);
  }
  s.epochs.bump(0);
  return { ok: true, read, slotCount: s.blockPool.slotCount() };
}

main().then(
  (r) => parentPort.postMessage(r),
  (e) => parentPort.postMessage({ ok: false, error: String(e && e.stack ? e.stack : e) }),
);
```

Create `test/unit/store.test.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import { AUX_A_OFFSETS, AUX_B_OFFSETS } from '../../src/world/store/aux';
import {
  finalAt, NO_COLUMN, protoAt, RECORD_COUNT, RECORD_INTS, REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED,
  REC_CX, REC_CZ, REC_EPOCH, REC_LIGHT_VERSION, REC_STATUS, SECTIONS, STATUS_ABSENT,
} from '../../src/world/store/columnTable';
import { EPOCH_CELL } from '../../src/world/store/epochs';
import { DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES, type SlabPool } from '../../src/world/store/pool';
import {
  FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, FINAL_META, META_CUTOUT, META_FLUID, META_OPAQUE, PROTO_BLOCKS, PROTO_FLUID,
} from '../../src/world/store/section';
import {
  attachStore, createStore, DEFAULT_PASS, SlotBusy, StoreFull, type VoxelStore,
} from '../../src/world/store/store';

const MiB = 1 << 20;
const words = (v: number) => new Uint16Array(4096).fill(v);
const bytes = (v: number) => new Uint8Array(4096).fill(v);
/** Voxel index of (lx, ly, lz) in a section (SP3a spec §1). */
const vi = (lx: number, ly: number, lz: number) => (ly << 8) | (lz << 4) | lx;
const WATER = 0x10;

/** Every refcount and the free-stack size of a pool. */
function snap(p: SlabPool): { free: number; count: number; refs: number[] } {
  const refs: number[] = [];
  for (let id = 0; id < p.slotCount(); id++) refs.push(p.refcount(id));
  return { free: p.freeCount(), count: p.slotCount(), refs };
}
const snapStore = (s: VoxelStore) => ({ blocks: snap(s.blockPool), bytes: snap(s.bytePool) });

/** Grows both pools once, so that a test's snapshots cover every slot it touches. */
function warm(s: VoxelStore): void {
  s.blockPool.free(s.blockPool.alloc());
  s.bytePool.free(s.bytePool.alloc());
}

/** A section with stone below ly 8 and air above, plus one bedrock voxel: dense blocks. */
function mixedBlocks(): Uint16Array {
  const b = words(0);
  b.fill(1, 0, 8 << 8);
  b[0] = 2;
  return b;
}

/** Water sources in the bottom half, nothing above: dense fluid. */
function mixedFluid(): Uint8Array {
  const f = bytes(0);
  f.fill(WATER, 0, 8 << 8);
  return f;
}

describe.each([true, false])('shared %s', (shared) => {
  const newStore = (o: { maxBlockBytes?: number; maxByteBytes?: number } = {}) =>
    createStore({ shared, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB, ...o });

  test('defaults and backing (SP3a spec §3.5): two pools, a column table, epoch cells', () => {
    const s = createStore({ shared });
    expect(s.shared).toBe(shared);
    expect(s.blockPool.maxSlots).toBe(DEFAULT_MAX_BLOCK_BYTES / 8192);
    expect(s.bytePool.maxSlots).toBe(DEFAULT_MAX_BYTE_BYTES / 4096);
    expect(s.blockPool.slotBytes).toBe(8192);
    expect(s.bytePool.slotBytes).toBe(4096);
    const h = s.handles();
    expect(h.shared).toBe(shared);
    for (const buf of [h.table, h.epochs, h.blocks.data, h.bytes.data]) expect(buf instanceof SharedArrayBuffer).toBe(shared);
    expect(h.table.byteLength).toBe(RECORD_COUNT * RECORD_INTS * 4);
    expect(Array.from(h.pass)).toEqual(Array.from(DEFAULT_PASS));
  });

  test('every record starts free (SP3a spec §3.2)', () => {
    const s = newStore();
    const ints = s.table.ints;
    for (const rec of [0, 1, 63, 64, 4095]) {
      const base = rec * RECORD_INTS;
      expect(ints[base + REC_CLAIMED]).toBe(0);
      expect(ints[base + REC_STATUS]).toBe(STATUS_ABSENT);
      expect(ints[base + REC_AUX_A]).toBe(-1);
      expect(ints[base + REC_AUX_B]).toBe(-1);
      for (let sy = 0; sy < SECTIONS; sy++) {
        expect(Array.from(ints.subarray(finalAt(base, sy), finalAt(base, sy) + 4))).toEqual([-1, -1, -1, 0]);
        expect(Array.from(ints.subarray(protoAt(base, sy), protoAt(base, sy) + 2))).toEqual([-1, -1]);
      }
    }
    expect(s.proto(0, 0)).toBeNull();
    expect(s.final(0, 0)).toBeNull();
  });

  test('claimColumn: cx, cz, epoch written; status Absent, versions 0, descriptors −1, aux −1', () => {
    const s = newStore();
    const w = s.claimColumn(-3, 70, 9);
    expect([w.cx, w.cz]).toEqual([-3, 70]);
    const base = s.table.find(-3, 70);
    expect(base).toBeGreaterThanOrEqual(0);
    const ints = s.table.ints;
    expect([ints[base + REC_CX], ints[base + REC_CZ], ints[base + REC_STATUS], ints[base + REC_EPOCH]]).toEqual([-3, 70, 0, 9]);
    expect([ints[base + REC_BLOCK_VERSION], ints[base + REC_LIGHT_VERSION], ints[base + REC_CLAIMED]]).toEqual([0, 0, 1]);
    expect([ints[base + REC_AUX_A], ints[base + REC_AUX_B]]).toEqual([-1, -1]);
    // Not committed: no reader sees it yet (proto needs status ≥ Proto, final ≥ Decorated).
    expect(s.proto(-3, 70)).toBeNull();
    expect(s.final(-3, 70)).toBeNull();
  });

  test('commit: blockVersion + 1, then status; proto visible from Proto, final from Decorated', () => {
    const s = newStore();
    const w = s.claimColumn(1, 2, 0);
    const base = s.table.find(1, 2);
    w.commit(1);
    expect(s.table.blockVersion(base)).toBe(1);
    expect(s.table.status(base)).toBe(1);
    expect(s.proto(1, 2)).not.toBeNull();
    expect(s.final(1, 2)).toBeNull();
    w.commit(2);
    expect(s.table.blockVersion(base)).toBe(2);
    expect(s.final(1, 2)).not.toBeNull();
    w.commit(3);
    expect(s.table.status(base)).toBe(3);
    expect(() => w.commit(0 as 1)).toThrow(RangeError);
    expect(() => w.commit(4 as 1)).toThrow(RangeError);
  });

  test('unwritten sections read as air, light 0 and no fluid', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    w.commit(3);
    for (const v of [s.proto(0, 0)!, s.final(0, 0)!]) {
      for (const y of [-64, 0, 63, 319]) {
        expect(v.block(0, y, 0)).toBe(0);
        expect(v.fluid(15, y, 15)).toBe(0);
        expect(v.light(7, y, 3)).toBe(0);
      }
      expect(v.sectionBlocks(0)).toBe(0);
      expect(v.sectionFluid(23)).toBe(0);
      expect(v.aux()).toBeNull();
    }
    expect(s.blockPool.slotCount()).toBe(0);
    expect(s.bytePool.slotCount()).toBe(0);
  });

  test('setProto: per channel uniform or dense; reads by absolute y; copies its inputs', () => {
    const s = newStore();
    const w = s.claimColumn(5, -5, 0);
    const blocks = mixedBlocks();
    const fluid = mixedFluid();
    w.setProto(4, blocks, fluid); // y 0 … 15
    w.setProto(0, words(2), bytes(0)); // y −64 … −49: uniform bedrock, no fluid
    w.setProto(23, words(0), bytes(WATER)); // uniform air with uniform water: no slot
    blocks.fill(7);
    fluid.fill(0);
    w.commit(1);
    const base = s.table.find(5, -5);
    const ints = s.table.ints;
    expect(ints[protoAt(base, 4) + PROTO_BLOCKS]).toBeGreaterThanOrEqual(0);
    expect(ints[protoAt(base, 4) + PROTO_FLUID]).toBeGreaterThanOrEqual(0);
    expect([ints[protoAt(base, 0) + PROTO_BLOCKS], ints[protoAt(base, 0) + PROTO_FLUID]]).toEqual([-3, -1]);
    expect([ints[protoAt(base, 23) + PROTO_BLOCKS], ints[protoAt(base, 23) + PROTO_FLUID]]).toEqual([-1, -1 - WATER]);
    expect(s.blockPool.freeCount()).toBe(s.blockPool.slotCount() - 1);
    expect(s.bytePool.freeCount()).toBe(s.bytePool.slotCount() - 1);
    const v = s.proto(5, -5)!;
    expect([v.cx, v.cz]).toEqual([5, -5]);
    expect(v.block(0, 0, 0)).toBe(2);
    expect(v.block(1, 0, 0)).toBe(1);
    expect(v.block(15, 7, 15)).toBe(1);
    expect(v.block(15, 8, 15)).toBe(0);
    expect(v.fluid(3, 7, 3)).toBe(WATER);
    expect(v.fluid(3, 8, 3)).toBe(0);
    expect(v.block(9, -64, 9)).toBe(2);
    expect(v.block(9, 319, 9)).toBe(0);
    expect(v.fluid(9, 319, 9)).toBe(WATER);
    expect(v.light(9, 0, 9)).toBe(0); // a proto set has no light
    const sb = v.sectionBlocks(4) as Uint16Array;
    expect(sb).toBeInstanceOf(Uint16Array);
    expect(sb.length).toBe(4096);
    expect(sb[vi(0, 0, 0)]).toBe(2);
    expect(sb[vi(0, 9, 0)]).toBe(0);
    expect((v.sectionFluid(4) as Uint8Array)[vi(0, 0, 0)]).toBe(WATER);
    expect(v.sectionBlocks(0)).toBe(2);
    expect(v.sectionFluid(23)).toBe(WATER);
  });

  test('uniform ↔ dense per channel, both ways, releasing what a rewrite replaces', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(0, 0, 0);
    w.setProto(3, mixedBlocks(), bytes(0)); // blocks dense, fluid uniform
    expect(s.blockPool.freeCount()).toBe(before.blocks.free - 1);
    expect(s.bytePool.freeCount()).toBe(before.bytes.free);
    w.setProto(3, words(1), mixedFluid()); // blocks demoted, fluid promoted
    expect(s.blockPool.freeCount()).toBe(before.blocks.free);
    expect(s.bytePool.freeCount()).toBe(before.bytes.free - 1);
    w.setFinal(3, words(1), mixedFluid(), bytes(0)); // light dense, fluid uniform
    expect(s.bytePool.freeCount()).toBe(before.bytes.free - 2);
    w.setFinal(3, mixedBlocks(), bytes(0xf0), mixedFluid()); // blocks promoted, light demoted, fluid promoted
    expect(s.blockPool.freeCount()).toBe(before.blocks.free - 1);
    expect(s.bytePool.freeCount()).toBe(before.bytes.free - 2);
    w.setProto(3, words(0), bytes(0));
    w.setFinal(3, words(0), bytes(0), bytes(0));
    expect(snapStore(s)).toEqual(before);
    w.commit(2);
    const f = s.final(0, 0)!;
    expect(f.light(0, -16, 0)).toBe(0);
    s.freeColumn(0, 0);
    expect(snapStore(s)).toEqual(before);
  });

  test('setFinal: light reads; meta computed from blocks and fluid (SP3a spec §3.3)', () => {
    const s = newStore();
    const w = s.claimColumn(2, 3, 0);
    const light = bytes(0xf0);
    light[vi(4, 5, 6)] = 0x3a;
    w.setFinal(10, mixedBlocks(), light, mixedFluid());
    w.setFinal(11, words(1), bytes(0xf0), bytes(0));
    w.setFinal(12, words(0), bytes(0xf0), bytes(WATER));
    w.commit(2);
    const base = s.table.find(2, 3);
    const meta = (sy: number) => s.table.ints[finalAt(base, sy) + FINAL_META];
    expect(meta(10)).toBe((8 * 256) | META_OPAQUE | META_FLUID);
    expect(meta(11)).toBe(4096 | META_OPAQUE);
    expect(meta(12)).toBe(META_FLUID);
    expect(meta(13)).toBe(0);
    const v = s.final(2, 3)!;
    const y0 = 10 * 16 - 64;
    expect(v.light(4, y0 + 5, 6)).toBe(0x3a);
    expect(v.light(4, y0 + 5, 7)).toBe(0xf0);
    expect(v.block(0, y0, 0)).toBe(2);
    expect(v.fluid(0, y0, 0)).toBe(WATER);
    expect(v.fluid(0, y0 + 16, 0)).toBe(0);
    // The proto set is a separate set: untouched by setFinal.
    expect(s.proto(2, 3)!.block(0, y0, 0)).toBe(0);
  });

  test('meta uses the store\'s PASS table', () => {
    const pass = new Uint8Array(4096);
    pass[1] = 2; // stone as cutout, for the test
    const s = createStore({ shared, maxBlockBytes: MiB, maxByteBytes: MiB, pass });
    expect(Array.from(s.handles().pass.subarray(0, 3))).toEqual([0, 2, 0]);
    const w = s.claimColumn(0, 0, 0);
    w.setFinal(0, words(1), bytes(0), bytes(0));
    expect(s.table.ints[finalAt(s.table.find(0, 0), 0) + FINAL_META]).toBe(4096 | META_CUTOUT);
    expect(DEFAULT_PASS[0]).toBe(0);
    expect(DEFAULT_PASS[1]).toBe(1);
    expect(DEFAULT_PASS[2]).toBe(1);
    expect(() => createStore({ shared, pass: new Uint8Array(10) })).toThrow(RangeError);
  });

  test('shareFinal: final blocks and fluid share the proto slots (refcount 2); light and meta as setFinal', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    w.setProto(6, mixedBlocks(), mixedFluid());
    w.setProto(7, words(1), bytes(0));
    const base = s.table.find(0, 0);
    const ints = s.table.ints;
    const pb = ints[protoAt(base, 6) + PROTO_BLOCKS]!;
    const pf = ints[protoAt(base, 6) + PROTO_FLUID]!;
    const light = bytes(0xff);
    light[1] = 0;
    w.shareFinal(6, light);
    w.shareFinal(7, bytes(0xf0));
    expect(ints[finalAt(base, 6) + FINAL_BLOCKS]).toBe(pb);
    expect(ints[finalAt(base, 6) + FINAL_FLUID]).toBe(pf);
    expect(s.blockPool.refcount(pb)).toBe(2);
    expect(s.bytePool.refcount(pf)).toBe(2);
    expect(ints[finalAt(base, 6) + FINAL_LIGHT]).toBeGreaterThanOrEqual(0);
    expect(ints[finalAt(base, 6) + FINAL_META]).toBe((8 * 256) | META_OPAQUE | META_FLUID);
    expect([ints[finalAt(base, 7) + FINAL_BLOCKS], ints[finalAt(base, 7) + FINAL_LIGHT], ints[finalAt(base, 7) + FINAL_FLUID]])
      .toEqual([-2, -1 - 0xf0, -1]);
    expect(ints[finalAt(base, 7) + FINAL_META]).toBe(4096 | META_OPAQUE);
    w.commit(2);
    const f = s.final(0, 0)!;
    expect(f.light(1, 32, 0)).toBe(0);
    expect(f.light(2, 32, 0)).toBe(0xff);
    expect(f.block(0, 32, 0)).toBe(2);
  });

  test('sharing and release: free the proto set, then the final set; every refcount and the stack come back', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(4, 4, 0);
    w.setProto(6, mixedBlocks(), mixedFluid());
    w.shareFinal(6, mixedFluid());
    w.aux().worldSurfaceWG[0] = 12;
    w.commit(2);
    const base = s.table.find(4, 4);
    const pb = s.table.ints[protoAt(base, 6) + PROTO_BLOCKS]!;
    s.freeProto(4, 4);
    expect(s.blockPool.refcount(pb)).toBe(1);
    expect(s.table.ints[protoAt(base, 6) + PROTO_BLOCKS]).toBe(-1);
    expect(s.table.ints[protoAt(base, 6) + PROTO_FLUID]).toBe(-1);
    // The final set still reads its (formerly shared) slots.
    const f = s.final(4, 4)!;
    expect(f.block(0, 32, 0)).toBe(2);
    expect(f.fluid(0, 32, 0)).toBe(WATER);
    expect(f.aux()!.worldSurfaceWG[0]).toBe(12);
    s.freeColumn(4, 4);
    expect(snapStore(s)).toEqual(before);
    expect(s.final(4, 4)).toBeNull();
    expect(s.table.find(4, 4)).toBe(-1);
  });

  test('sharing and release: freeing the whole column releases each shared slot twice', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(4, 4, 0);
    for (let sy = 0; sy < 6; sy++) {
      w.setProto(sy, mixedBlocks(), mixedFluid());
      if (sy % 2 === 0) w.shareFinal(sy, mixedFluid());
      else w.setFinal(sy, mixedBlocks(), bytes(1), bytes(0));
    }
    w.aux();
    w.auxB();
    w.commit(3);
    expect(s.blockPool.freeCount()).toBe(before.blocks.free - 9);
    s.freeColumn(4, 4);
    expect(snapStore(s)).toEqual(before);
    // freeProto and freeColumn of a free record do nothing.
    s.freeProto(4, 4);
    s.freeColumn(4, 4);
    expect(snapStore(s)).toEqual(before);
  });

  test('freeColumn works on a half-written column (no commit)', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(-1, -1, 3);
    w.setProto(0, mixedBlocks(), mixedFluid());
    w.setProto(1, mixedBlocks(), bytes(0));
    w.aux();
    s.freeColumn(-1, -1);
    expect(snapStore(s)).toEqual(before);
    const base = (63 + 64 * 63) * RECORD_INTS;
    expect(s.table.ints[base + REC_CLAIMED]).toBe(0);
    expect(s.table.ints[base + REC_CX]).toBe(NO_COLUMN);
    expect(s.table.ints[base + REC_AUX_A]).toBe(-1);
    expect(s.table.ints[protoAt(base, 0)]).toBe(-1);
  });

  test('a writer whose column was freed refuses to write', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    s.freeColumn(0, 0);
    expect(() => w.setProto(0, words(1), bytes(0))).toThrow(/no longer holds/);
    expect(() => w.commit(1)).toThrow(/no longer holds/);
    expect(() => w.aux()).toThrow(/no longer holds/);
    s.claimColumn(64, 0, 0); // same record, another column
    expect(() => w.setFinal(0, words(1), bytes(0), bytes(0))).toThrow(/no longer holds/);
    expect(s.blockPool.slotCount()).toBe(0);
  });

  test('bad section indices and channel lengths are refused', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    expect(() => w.setProto(-1, words(0), bytes(0))).toThrow(RangeError);
    expect(() => w.setProto(24, words(0), bytes(0))).toThrow(RangeError);
    expect(() => w.setProto(1.5, words(0), bytes(0))).toThrow(RangeError);
    expect(() => w.setProto(0, new Uint16Array(10), bytes(0))).toThrow(RangeError);
    expect(() => w.shareFinal(0, new Uint8Array(10))).toThrow(RangeError);
    w.commit(2);
    const v = s.final(0, 0)!;
    expect(() => v.block(16, 0, 0)).toThrow(RangeError);
    expect(() => v.block(0, -65, 0)).toThrow(RangeError);
    expect(() => v.block(0, 320, 0)).toThrow(RangeError);
    expect(() => v.light(0, 0, -1)).toThrow(RangeError);
    expect(() => v.sectionBlocks(24)).toThrow(RangeError);
  });

  test('SlotBusy on a held record; freeColumn then claim succeeds with no leaked slot', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(3, 3, 0);
    w.setProto(2, mixedBlocks(), mixedFluid());
    w.commit(1);
    expect(() => s.claimColumn(3, 3, 0)).toThrow(SlotBusy);
    expect(() => s.claimColumn(3 + 64, 3, 0)).toThrow(SlotBusy);
    expect(() => s.claimColumn(3, 3 - 128, 0)).toThrow(SlotBusy);
    let err: unknown;
    try { s.claimColumn(67, 3, 0); } catch (e) { err = e; }
    expect((err as Error).name).toBe('SlotBusy');
    // The failed claims left the holder intact.
    expect(s.proto(3, 3)!.block(0, -32, 0)).toBe(2);
    s.freeColumn(3, 3);
    const w2 = s.claimColumn(67, 3, 1);
    w2.commit(1);
    expect(s.proto(67, 3)!.block(0, -32, 0)).toBe(0);
    s.freeColumn(67, 3);
    expect(snapStore(s)).toEqual(before);
  });

  test('a record holding another column reads as absent; freeing the wrong column does nothing', () => {
    const s = newStore();
    const w = s.claimColumn(10, 20, 0);
    w.setProto(0, mixedBlocks(), bytes(0));
    w.commit(3);
    for (const [cx, cz] of [[74, 20], [10, 84], [-54, -44]] as const) {
      expect(s.proto(cx, cz)).toBeNull();
      expect(s.final(cx, cz)).toBeNull();
      s.freeColumn(cx, cz);
      s.freeProto(cx, cz);
    }
    expect(s.proto(10, 20)!.block(0, -64, 0)).toBe(2);
    expect(s.blockPool.freeCount()).toBe(s.blockPool.slotCount() - 1);
  });

  test('aux A and aux B: offsets, one slot each, allocated on first call and zero-filled even when recycled dirty', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    const a = w.aux();
    expect(w.aux().worldSurfaceWG.byteOffset).toBe(a.worldSurfaceWG.byteOffset); // same slot on later calls
    const base = s.table.find(0, 0);
    const slotA = s.table.ints[base + REC_AUX_A]!;
    expect(slotA).toBeGreaterThanOrEqual(0);
    const at = slotA * 4096;
    for (const [k, off] of Object.entries(AUX_A_OFFSETS)) expect(a[k as keyof typeof a].byteOffset).toBe(at + off);
    expect(a.worldSurfaceWG.length).toBe(256);
    expect(a.tintTH.length).toBe(768);
    expect(s.table.ints[base + REC_AUX_B]).toBe(-1);
    const b = w.auxB();
    const slotB = s.table.ints[base + REC_AUX_B]!;
    expect(slotB).not.toBe(slotA);
    for (const [k, off] of Object.entries(AUX_B_OFFSETS)) expect(b[k as keyof typeof b].byteOffset).toBe(slotB * 4096 + off);
    // Dirty both slots, free the column; the next column gets the same slots back (LIFO) and reads zeros.
    s.bytePool.bytes.fill(0xab, slotA * 4096, slotA * 4096 + 4096);
    s.bytePool.bytes.fill(0xcd, slotB * 4096, slotB * 4096 + 4096);
    s.freeColumn(0, 0);
    const w2 = s.claimColumn(1, 0, 0);
    const a2 = w2.aux();
    const b2 = w2.auxB();
    const base2 = s.table.find(1, 0);
    expect(new Set([s.table.ints[base2 + REC_AUX_A], s.table.ints[base2 + REC_AUX_B]])).toEqual(new Set([slotA, slotB]));
    for (const v of [a2.worldSurfaceWG, a2.oceanFloorWG, a2.lightBlocking, a2.surfaceBiome, a2.tintTH, b2.caveBiomeQ, b2.surfaceBiomeQ]) {
      expect(v.every((x) => x === 0)).toBe(true);
    }
    expect(s.bytePool.u8(slotA).every((x) => x === 0)).toBe(true);
    expect(s.bytePool.u8(slotB).every((x) => x === 0)).toBe(true);
    // ColumnView.aux reads the same bytes.
    a2.oceanFloorWG[255] = -64;
    a2.surfaceBiome[17] = 9;
    w2.commit(1);
    const av = s.proto(1, 0)!.aux()!;
    expect(av.oceanFloorWG[255]).toBe(-64);
    expect(av.surfaceBiome[17]).toBe(9);
  });

  test('StoreFull at the maximum; the descriptor keeps its old value and freeColumn releases everything', () => {
    const s = newStore({ maxBlockBytes: MiB, maxByteBytes: MiB }); // 128 block slots, 256 byte slots
    const cols: [number, number][] = [];
    let thrown: unknown = null;
    outer: for (let c = 0; c < 8; c++) {
      const w = s.claimColumn(c, 0, 0);
      cols.push([c, 0]);
      for (let sy = 0; sy < SECTIONS; sy++) {
        try {
          w.setProto(sy, mixedBlocks(), bytes(0));
        } catch (e) {
          thrown = e;
          expect(s.table.ints[protoAt(s.table.find(c, 0), sy) + PROTO_BLOCKS]).toBe(-1);
          break outer;
        }
      }
    }
    expect(thrown).toBeInstanceOf(StoreFull);
    expect(s.blockPool.slotCount()).toBe(128);
    expect(s.blockPool.freeCount()).toBe(0);
    for (const [cx, cz] of cols) s.freeColumn(cx, cz);
    expect(s.blockPool.freeCount()).toBe(128);
  });

  test('epoch cells live in the store and travel with its handles', () => {
    const s = newStore();
    expect(s.epochs.get(EPOCH_CELL.terrain)).toBe(0);
    s.epochs.set(EPOCH_CELL.light, 7);
    expect(s.epochs.bump(EPOCH_CELL.light)).toBe(8);
    const t = attachStore(s.handles());
    expect(t.epochs.get(EPOCH_CELL.light)).toBe(8);
    t.epochs.bump(EPOCH_CELL.mesh);
    expect(s.epochs.get(EPOCH_CELL.mesh)).toBe(1);
  });

  test('neighborhood: proto/final over the 3 × 3, and versions() in (dz, dx) order, −1 when absent', () => {
    const s = newStore();
    const n = s.neighborhood(10, -10);
    expect([n.cx, n.cz]).toEqual([10, -10]);
    expect(Array.from(n.versions())).toEqual(new Array(18).fill(-1));
    const a = s.claimColumn(9, -11, 0); // (dx, dz) = (−1, −1): entry 0
    a.setProto(0, words(1), bytes(0));
    a.commit(1);
    a.commit(1);
    const b = s.claimColumn(11, -10, 0); // (1, 0): entry 5
    b.commit(2);
    const c = s.claimColumn(10, -9, 0); // (0, 1): entry 7, claimed but never committed: absent
    s.claimColumn(10 + 64, -10, 0); // the centre's record holds another column: absent
    const v = n.versions();
    expect(v).toBeInstanceOf(Int32Array);
    expect(v.length).toBe(18);
    const expected = new Array(18).fill(-1);
    expected[0] = 2;
    expected[1] = 0;
    expected[10] = 1;
    expected[11] = 0;
    expect(Array.from(v)).toEqual(expected);
    expect(n.proto(-1, -1)!.block(0, -64, 0)).toBe(1);
    expect(n.final(-1, -1)).toBeNull();
    expect(n.final(1, 0)).not.toBeNull();
    expect(n.proto(0, 1)).toBeNull();
    expect(n.proto(0, 0)).toBeNull();
    c.commit(1);
    expect(n.versions()[14]).toBe(1);
    expect(() => n.proto(2, 0)).toThrow(RangeError);
    expect(() => n.final(0, -2)).toThrow(RangeError);
  });

  test('attachStore in the same thread: one store, two handles; growth is seen without rebuilding', () => {
    const s = newStore();
    const t = attachStore(s.handles());
    expect(t.shared).toBe(shared);
    const w = s.claimColumn(0, 0, 0);
    for (let sy = 0; sy < SECTIONS; sy++) w.setProto(sy, mixedBlocks(), mixedFluid());
    w.commit(1);
    expect(t.proto(0, 0)!.block(0, 0, 0)).toBe(2);
    expect(s.blockPool.slotCount()).toBe(128);
    // t allocates past what s had grown to (6 × 24 dense sections > 128 slots); s reads the new slots through its
    // length-tracking views.
    for (let cx = 1; cx <= 5; cx++) {
      const w2 = t.claimColumn(cx, 0, 0);
      for (let sy = 0; sy < SECTIONS; sy++) {
        const b = mixedBlocks();
        b[1] = 100 * cx + sy;
        w2.setProto(sy, b, mixedFluid());
      }
      w2.commit(1);
    }
    expect(s.blockPool.slotCount()).toBe(256);
    for (let cx = 1; cx <= 5; cx++) {
      for (let sy = 0; sy < SECTIONS; sy++) expect(s.proto(cx, 0)!.block(1, sy * 16 - 64, 0)).toBe(100 * cx + sy);
    }
    expect(() => t.claimColumn(0, 0, 0)).toThrow(SlotBusy);
    s.freeColumn(1, 0);
    expect(t.proto(1, 0)).toBeNull();
  });
});

describe('attachStore across two threads (shared)', () => {
  const workers: Worker[] = [];
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.terminate()));
  });

  test('a worker attaches, reads the main thread\'s column and writes one the main thread reads', async () => {
    const out = fileURLToPath(new URL('../.cache/storeAttach/', import.meta.url));
    mkdirSync(out, { recursive: true });
    await build({
      configFile: false, logLevel: 'silent',
      build: {
        outDir: out, emptyOutDir: true, minify: false,
        lib: { entry: fileURLToPath(new URL('../../src/world/store/store.ts', import.meta.url)), formats: ['es'], fileName: () => 'store.mjs' },
      },
    });
    const s = createStore({ shared: true, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
    const w = s.claimColumn(2, 2, 5);
    for (let sy = 0; sy < SECTIONS; sy++) {
      const b = mixedBlocks();
      b[1] = sy;
      w.setProto(sy, b, mixedFluid());
    }
    w.aux().worldSurfaceWG[3] = 77;
    w.commit(1);
    const worker = new Worker(new URL('./fixtures/storeWorker.mjs', import.meta.url), {
      workerData: { storeUrl: pathToFileURL(`${out}store.mjs`).href, handles: s.handles() },
    });
    workers.push(worker);
    const reply = await new Promise<{ ok: boolean; error?: string; read?: number[]; slotCount?: number }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(reply.error).toBeUndefined();
    expect(reply.ok).toBe(true);
    // The worker read what this thread wrote: section index at voxel 1, bedrock at voxel 0, water, aux.
    expect(reply.read).toEqual([...Array.from({ length: SECTIONS }, (_, sy) => sy), 2, WATER, 77]);
    // The worker wrote 5 × 24 more dense block sections (it grew the pool past this thread's 128 slots) and
    // bumped an epoch cell.
    expect(reply.slotCount).toBe(256);
    expect(s.blockPool.slotCount()).toBe(256);
    for (const cx of [3, 4, 5, 6, 7]) {
      const v = s.proto(cx, 2)!;
      expect(v).not.toBeNull();
      for (let sy = 0; sy < SECTIONS; sy++) expect(v.block(1, sy * 16 - 64, 0)).toBe(1000 + cx * 100 + sy);
      expect(v.aux()!.oceanFloorWG[255]).toBe(cx);
    }
    expect(s.epochs.get(EPOCH_CELL.terrain)).toBe(1);
    expect(s.table.blockVersion(s.table.find(3, 2))).toBe(1);
    for (let cx = 2; cx <= 7; cx++) s.freeColumn(cx, 2);
    expect(s.blockPool.freeCount()).toBe(s.blockPool.slotCount());
    expect(s.bytePool.freeCount()).toBe(s.bytePool.slotCount());
  }, 60_000);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/store.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |unit| test/unit/store.test.ts [ test/unit/store.test.ts ]
Error: Cannot find module '../../src/world/store/store' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/store.test.ts
Test Files  1 failed (1)
Tests  no tests
```

- [ ] **Step 3: Implement**

Modify `src/world/store/api.ts` (apply with `git apply`):

```diff
diff --git a/src/world/store/api.ts b/src/world/store/api.ts
index dd09f07..01c10a6 100644
--- a/src/world/store/api.ts
+++ b/src/world/store/api.ts
@@ -23,3 +23,62 @@ export interface AuxBView {
   readonly caveBiomeQ: Uint8Array;
   readonly surfaceBiomeQ: Uint8Array;
 }
+
+/** A `commit` status: 1 Proto, 2 Decorated, 3 Published (SP3a spec §3.2). */
+export type CommitStatus = 1 | 2 | 3;
+
+/**
+ * Writes one claimed column (SP3a spec §3.5); obtained from `store.claimColumn` and owned by one thread. Every
+ * array argument is copied (callers reuse scratch buffers) and stored per channel: uniform when all 4096 values are
+ * equal (no slot), dense otherwise; rewriting a section releases what it held. A writer whose column has been freed
+ * throws on every call.
+ */
+export interface ColumnWriter {
+  readonly cx: number;
+  readonly cz: number;
+  /** Section `sy` (0 … 23) of the proto set: 4096 block states and 4096 fluid bytes, voxel index `ly<<8|lz<<4|lx`. */
+  setProto(sy: number, blocks: Uint16Array, fluid: Uint8Array): void;
+  /** Section `sy` of the final set, and its meta word. */
+  setFinal(sy: number, blocks: Uint16Array, light: Uint8Array, fluid: Uint8Array): void;
+  /** The final blocks and fluid of `sy` become its proto entries (dense slots retained); light and meta as `setFinal`. */
+  shareFinal(sy: number, light: Uint8Array): void;
+  /** Aux A, allocated and zero-filled on the first call; later calls view the same slot. */
+  aux(): AuxView;
+  /** Aux B, likewise. */
+  auxB(): AuxBView;
+  /** `blockVersion` + 1, then `status` (stored last, so a reader never sees a partial column). */
+  commit(status: CommitStatus): void;
+}
+
+/**
+ * Reads one set (proto or final) of a committed column (SP3a spec §3.5). `y` is absolute (−64 … 319); `lx`, `lz`
+ * are 0 … 15. A proto view has no light (reads 0). A view reads the record live: it is valid while its column stays
+ * in the store.
+ */
+export interface ColumnView {
+  readonly cx: number;
+  readonly cz: number;
+  block(lx: number, y: number, lz: number): number;
+  fluid(lx: number, y: number, lz: number): number;
+  light(lx: number, y: number, lz: number): number;
+  /** A view over the section's slot (4096 states), or its uniform state. */
+  sectionBlocks(sy: number): Uint16Array | number;
+  /** A view over the section's fluid slot (4096 bytes), or its uniform fluid byte. */
+  sectionFluid(sy: number): Uint8Array | number;
+  /** The column's aux A, or null when it has none. */
+  aux(): AuxView | null;
+}
+
+/** The 3 × 3 columns around (cx, cz) (SP3a spec §3.5); `dx`, `dz` ∈ {−1, 0, 1}. Consumed from SP4. */
+export interface NeighborhoodReader {
+  readonly cx: number;
+  readonly cz: number;
+  /** null for an absent column (not in the store, or not yet at the status the set needs). */
+  proto(dx: number, dz: number): ColumnView | null;
+  final(dx: number, dz: number): ColumnView | null;
+  /**
+   * A new Int32Array(18): the 3 × 3 in (dz, dx) order from (−1, −1), blockVersion then lightVersion per column,
+   * −1 for an absent column (record free, held by another column, or claimed and not yet committed).
+   */
+  versions(): Int32Array;
+}
```

Create `src/world/store/store.ts`:

```ts
/**
 * The voxel store (SP3a spec §3, master §2.3): a block pool and a byte pool (`pool.ts`), the 64 × 64 column torus
 * (`columnTable.ts`), section descriptors (`section.ts`), aux slots (`aux.ts`) and the epoch cells (`epochs.ts`).
 * `createStore({shared})` builds it over growable `SharedArrayBuffer`s (several threads, through `handles()` and
 * `attachStore`) or over resizable `ArrayBuffer`s (one thread), with the same code.
 *
 * Column lifecycle: `claimColumn` takes the record and returns a `ColumnWriter`; `commit` publishes it (status last);
 * `proto`/`final` read it once its status allows; `freeProto` releases the proto set; `freeColumn` releases every
 * reference the record holds and frees the record. `gen` imports only the types of `api.ts`, never this file.
 */
import type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, NeighborhoodReader } from './api';
import { allocAux, auxBView, auxView } from './aux';
import {
  attachColumnTable, createColumnTable, finalAt, protoAt, REC_AUX_A, REC_AUX_B, REC_CLAIMED, REC_CX, REC_CZ,
  SECTIONS, STATUS_ABSENT, STATUS_DECORATED, STATUS_PROTO, type ColumnTable,
} from './columnTable';
import { attachEpochCells, createEpochCells, type EpochCells } from './epochs';
import {
  attachPool, BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES,
  type PoolHandles, type SlabPool,
} from './pool';
import {
  byteAt, computeMeta, FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, FINAL_META, PROTO_BLOCKS, PROTO_FLUID, releaseEntry,
  sectionBytes, sectionWords, SECTION_VOXELS, shareEntry, storeBytes, storeWords, wordAt,
} from './section';

export { SlotBusy } from './columnTable';
export { StoreFull } from './pool';
export type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, NeighborhoodReader } from './api';

/** Entries of a per-state table (the registry's `MAX_STATES`). */
const STATE_TABLE_SIZE = 4096;

/**
 * The `PASS` table the store uses for meta when none is given: state 0 (air) none, every other state opaque — the
 * `PASS` column of the SP3a registry (air, stone, bedrock). The registry lives in `world/blocks`; once both are
 * on one branch, callers that append non-opaque states pass the registry's `PASS`.
 */
export const DEFAULT_PASS: Uint8Array = new Uint8Array(STATE_TABLE_SIZE).fill(1);
DEFAULT_PASS[0] = 0;

export interface StoreOptions {
  readonly shared: boolean;
  /** Maximum size of the block pool (default 768 MiB; a multiple of 1 MiB). */
  readonly maxBlockBytes?: number;
  /** Maximum size of the byte pool (default 512 MiB; a multiple of 1 MiB). */
  readonly maxByteBytes?: number;
  /** The per-state `PASS` table for the meta word (4096 entries; default `DEFAULT_PASS`). Copied. */
  readonly pass?: Uint8Array;
}

/** Everything `attachStore` needs to rebuild the store in another thread (structured-cloneable). */
export interface StoreHandles {
  readonly shared: boolean;
  readonly blocks: PoolHandles;
  readonly bytes: PoolHandles;
  readonly table: SharedArrayBuffer | ArrayBuffer;
  readonly epochs: SharedArrayBuffer | ArrayBuffer;
  readonly pass: Uint8Array;
}

export interface VoxelStore {
  readonly shared: boolean;
  readonly blockPool: SlabPool;
  readonly bytePool: SlabPool;
  readonly table: ColumnTable;
  readonly epochs: EpochCells;
  handles(): StoreHandles;
  /** Takes the record of (cx, cz) (`SlotBusy` if held) and returns its writer. */
  claimColumn(cx: number, cz: number, epoch: number): ColumnWriter;
  /** Releases every reference the record holds and frees it; nothing unless the record holds (cx, cz). */
  freeColumn(cx: number, cz: number): void;
  /** Releases the proto entries only (resets them to −1); nothing unless the record holds (cx, cz). */
  freeProto(cx: number, cz: number): void;
  /** The proto set, or null unless the record holds (cx, cz) at status ≥ Proto. */
  proto(cx: number, cz: number): ColumnView | null;
  /** The final set, or null unless the record holds (cx, cz) at status ≥ Decorated. */
  final(cx: number, cz: number): ColumnView | null;
  neighborhood(cx: number, cz: number): NeighborhoodReader;
}

function checkSy(sy: number): void {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`store: section ${sy} outside 0 … ${SECTIONS - 1}`);
}

function checkLength(a: Uint16Array | Uint8Array, what: string): void {
  if (a.length !== SECTION_VOXELS) throw new RangeError(`store: ${what} has ${a.length} entries, expected ${SECTION_VOXELS}`);
}

/** Voxel index in its section of (lx, y, lz), y absolute; the section is `index >> 12`. */
function voxelOf(lx: number, y: number, lz: number): number {
  const yy = y + 64;
  if ((lx & 15) !== lx || (lz & 15) !== lz || (yy | 0) !== yy || yy < 0 || yy >= 16 * SECTIONS) {
    throw new RangeError(`store: voxel (${lx}, ${y}, ${lz}) outside the column`);
  }
  return (yy << 8) | (lz << 4) | lx;
}

export function createStore(opts: StoreOptions): VoxelStore {
  const { shared } = opts;
  const pass = opts.pass ?? DEFAULT_PASS;
  if (pass.length !== STATE_TABLE_SIZE) throw new RangeError(`store: pass table of ${pass.length} entries, expected ${STATE_TABLE_SIZE}`);
  const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES });
  const bytes = createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: opts.maxByteBytes ?? DEFAULT_MAX_BYTE_BYTES });
  return attachStore({
    shared,
    blocks: blocks.handles(),
    bytes: bytes.handles(),
    table: createColumnTable(shared).buffer,
    epochs: createEpochCells(shared).buffer,
    pass: pass.slice(),
  });
}

/** The store over existing handles (`store.handles()`, possibly from another thread). */
export function attachStore(h: StoreHandles): VoxelStore {
  const blockPool = attachPool(h.blocks);
  const bytePool = attachPool(h.bytes);
  const table = attachColumnTable(h.table);
  const epochs = attachEpochCells(h.epochs);
  const { pass } = h;
  const ints = table.ints;

  /** The proto (`final` false) or final view of the record at `base`, holding (cx, cz). */
  function view(base: number, cx: number, cz: number, final: boolean): ColumnView {
    const blocksAt = (sy: number) => (final ? finalAt(base, sy) + FINAL_BLOCKS : protoAt(base, sy) + PROTO_BLOCKS);
    const fluidAt = (sy: number) => (final ? finalAt(base, sy) + FINAL_FLUID : protoAt(base, sy) + PROTO_FLUID);
    return {
      cx,
      cz,
      block(lx, y, lz) {
        const v = voxelOf(lx, y, lz);
        return wordAt(blockPool, ints[blocksAt(v >> 12)]!, v & 4095);
      },
      fluid(lx, y, lz) {
        const v = voxelOf(lx, y, lz);
        return byteAt(bytePool, ints[fluidAt(v >> 12)]!, v & 4095);
      },
      light(lx, y, lz) {
        const v = voxelOf(lx, y, lz);
        return final ? byteAt(bytePool, ints[finalAt(base, v >> 12) + FINAL_LIGHT]!, v & 4095) : 0;
      },
      sectionBlocks(sy) {
        checkSy(sy);
        return sectionWords(blockPool, ints[blocksAt(sy)]!);
      },
      sectionFluid(sy) {
        checkSy(sy);
        return sectionBytes(bytePool, ints[fluidAt(sy)]!);
      },
      aux() {
        const slot = ints[base + REC_AUX_A]!;
        return slot < 0 ? null : auxView(bytePool, slot);
      },
    };
  }

  /** The record base of (cx, cz) when it holds that column at status ≥ `min`, else −1. */
  function committed(cx: number, cz: number, min: number): number {
    const base = table.find(cx, cz);
    return base >= 0 && table.status(base) >= min ? base : -1;
  }

  function releaseProto(base: number): void {
    for (let sy = 0; sy < SECTIONS; sy++) {
      const p = protoAt(base, sy);
      releaseEntry(blockPool, ints, p + PROTO_BLOCKS);
      releaseEntry(bytePool, ints, p + PROTO_FLUID);
    }
  }

  const store: VoxelStore = {
    shared: h.shared,
    blockPool,
    bytePool,
    table,
    epochs,
    handles: () => h,

    claimColumn(cx, cz, epoch) {
      const base = table.claim(cx, cz, epoch);
      let auxA: AuxView | null = null;
      let auxB: AuxBView | null = null;
      /** The record still holds this writer's column (it has not been freed, nor taken by another column). */
      const check = (): void => {
        if (Atomics.load(ints, base + REC_CLAIMED) !== 1 || Atomics.load(ints, base + REC_CX) !== cx || Atomics.load(ints, base + REC_CZ) !== cz) {
          throw new Error(`store: the record no longer holds column (${cx}, ${cz})`);
        }
      };
      const setMeta = (sy: number): void => {
        const f = finalAt(base, sy);
        ints[f + FINAL_META] = computeMeta(sectionWords(blockPool, ints[f + FINAL_BLOCKS]!), sectionBytes(bytePool, ints[f + FINAL_FLUID]!), pass);
      };
      return {
        cx,
        cz,
        setProto(sy, blocks, fluid) {
          check();
          checkSy(sy);
          checkLength(blocks, 'blocks');
          checkLength(fluid, 'fluid');
          const p = protoAt(base, sy);
          storeWords(blockPool, ints, p + PROTO_BLOCKS, blocks);
          storeBytes(bytePool, ints, p + PROTO_FLUID, fluid);
        },
        setFinal(sy, blocks, light, fluid) {
          check();
          checkSy(sy);
          checkLength(blocks, 'blocks');
          checkLength(light, 'light');
          checkLength(fluid, 'fluid');
          const f = finalAt(base, sy);
          storeWords(blockPool, ints, f + FINAL_BLOCKS, blocks);
          storeBytes(bytePool, ints, f + FINAL_LIGHT, light);
          storeBytes(bytePool, ints, f + FINAL_FLUID, fluid);
          setMeta(sy);
        },
        shareFinal(sy, light) {
          check();
          checkSy(sy);
          checkLength(light, 'light');
          const p = protoAt(base, sy);
          const f = finalAt(base, sy);
          shareEntry(blockPool, ints, p + PROTO_BLOCKS, f + FINAL_BLOCKS);
          shareEntry(bytePool, ints, p + PROTO_FLUID, f + FINAL_FLUID);
          storeBytes(bytePool, ints, f + FINAL_LIGHT, light);
          setMeta(sy);
        },
        aux() {
          check();
          if (auxA === null) {
            const slot = allocAux(bytePool);
            ints[base + REC_AUX_A] = slot;
            auxA = auxView(bytePool, slot);
          }
          return auxA;
        },
        auxB() {
          check();
          if (auxB === null) {
            const slot = allocAux(bytePool);
            ints[base + REC_AUX_B] = slot;
            auxB = auxBView(bytePool, slot);
          }
          return auxB;
        },
        commit(status: CommitStatus) {
          check();
          if (status !== 1 && status !== 2 && status !== 3) throw new RangeError(`store: commit status ${String(status)}`);
          table.bumpBlockVersion(base);
          table.setStatus(base, status);
        },
      };
    },

    freeColumn(cx, cz) {
      const base = table.find(cx, cz);
      if (base < 0) return;
      table.setStatus(base, STATUS_ABSENT);
      releaseProto(base);
      for (let sy = 0; sy < SECTIONS; sy++) {
        const f = finalAt(base, sy);
        releaseEntry(blockPool, ints, f + FINAL_BLOCKS);
        releaseEntry(bytePool, ints, f + FINAL_LIGHT);
        releaseEntry(bytePool, ints, f + FINAL_FLUID);
      }
      for (const at of [base + REC_AUX_A, base + REC_AUX_B]) releaseEntry(bytePool, ints, at);
      table.clear(base);
      table.unclaim(base);
    },

    freeProto(cx, cz) {
      const base = table.find(cx, cz);
      if (base >= 0) releaseProto(base);
    },

    proto(cx, cz) {
      const base = committed(cx, cz, STATUS_PROTO);
      return base < 0 ? null : view(base, cx, cz, false);
    },

    final(cx, cz) {
      const base = committed(cx, cz, STATUS_DECORATED);
      return base < 0 ? null : view(base, cx, cz, true);
    },

    neighborhood(cx, cz) {
      const check = (dx: number, dz: number): void => {
        if ((dx !== -1 && dx !== 0 && dx !== 1) || (dz !== -1 && dz !== 0 && dz !== 1)) {
          throw new RangeError(`store: neighbour (${dx}, ${dz}) outside the 3 × 3`);
        }
      };
      return {
        cx,
        cz,
        proto(dx, dz) {
          check(dx, dz);
          return store.proto(cx + dx, cz + dz);
        },
        final(dx, dz) {
          check(dx, dz);
          return store.final(cx + dx, cz + dz);
        },
        versions() {
          const out = new Int32Array(18).fill(-1);
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const base = committed(cx + dx, cz + dz, STATUS_PROTO);
              if (base < 0) continue;
              const k = 2 * (3 * (dz + 1) + (dx + 1));
              out[k] = table.blockVersion(base);
              out[k + 1] = table.lightVersion(base);
            }
          }
          return out;
        },
      };
    },
  };
  return store;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/store.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  45 passed (45)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  106 passed | 2 skipped (108)
Tests  1398 passed | 2 skipped (1400)
```

- [ ] **Step 6: Commit**

```bash
git add src/world/store/api.ts src/world/store/store.ts test/unit/fixtures/storeWorker.mjs test/unit/store.test.ts
git commit -F - <<'EOF'
feat(store): the voxel store and its API (SP3a §3.5, §3.6 unit list)

world/store/store.ts: createStore({shared, maxBlockBytes?, maxByteBytes?,
pass?}) and attachStore(handles) over the two slab pools, the column
torus and the epoch cells. claimColumn returns a ColumnWriter (setProto,
setFinal, shareFinal, aux, auxB, commit); freeColumn and freeProto release
every reference a set holds; proto/final return a ColumnView once the
status allows; neighborhood returns a NeighborhoodReader with versions().
api.ts gains ColumnWriter, ColumnView, NeighborhoodReader and CommitStatus.

The unit tests run on both backends: uniform <-> dense per channel, meta,
sharing and release back to the snapshot, SlotBusy and collisions, aux
offsets and zero fill, StoreFull, epoch cells, versions(), attachStore in
one thread and across two worker threads.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `c292045` on `dry/sp3a`; 4 files changed, 1016 insertions(+)):

RED replay (`test/**` over the parent): `test/unit/store.test.ts` fails to import `src/world/store/store` (1 file failed, no tests). GREEN: typecheck clean; `store.test.ts` 45 tests (22 per backend + 1 two-thread); `npm test` 99 files passed, 2 skipped / 1317 passed, 2 skipped (≈29 s).

- Ruling: API — `createStore({shared, maxBlockBytes?, maxByteBytes?, pass?})`, `attachStore(handles)`; `VoxelStore` = `shared, blockPool, bytePool, table (ColumnTable), epochs (EpochCells), handles(), claimColumn, freeColumn, freeProto, proto, final, neighborhood`; `StoreHandles = {shared, blocks: PoolHandles, bytes: PoolHandles, table, epochs, pass}` (structured-cloneable; a growable SAB posts to a worker fine on Node 24); `store.ts` re-exports `StoreFull`, `SlotBusy` and the api types — the pools and the table are exposed for the fuzz (Task 8), the region cache dump (Task 11: record ints 0-15 and descriptors through `table.ints`/`table.find`) and the tests — cost if wrong: renames in Tasks 8-13.
- Ruling: the store takes the `PASS` table for the meta word as an optional `pass` option (4096 entries, copied, RangeError otherwise, carried in the handles) defaulting to `DEFAULT_PASS` = state 0 none, every other state opaque, which equals the SP3a registry's PASS (air, stone, bedrock) — `world/blocks` is on the other phase-1 chain, so `store.ts` cannot import `PASS` yet; after the phase-2 merge, Task 9 (or the merge) should make the default `PASS` from `world/blocks/index` (`world` may import `world`; `world/store` is not under the alias rule) and SP3b, which appends cutout/translucent states, must not rely on the stand-in — cost if wrong: wrong meta pass bits for SP3b's non-opaque states if nobody swaps the default (no SP3a code reads meta; SP4 meshing would).
- Ruling: `api.ts` adds `CommitStatus = 1 | 2 | 3`, `ColumnWriter` (+ readonly `cx`, `cz`), `ColumnView` (+ `cx`, `cz`), `NeighborhoodReader` (+ `cx`, `cz`); `commit` rejects any other status with RangeError — the spec types `commit(status: 1 | 2 | 3)` — cost if wrong: none.
- Ruling: a writer re-checks on every call that its record still holds its column (`claimed` 1, cx, cz; Atomics loads) and throws "the record no longer holds column (cx, cz)" otherwise, before any allocation — a writer used after `freeColumn` (e.g. the slice LRU evicting a column, or an abort path) would otherwise write into a free record or another column's — cost if wrong: three Atomics loads per call (24 setProto calls per column); a free-then-reclaim of the same (cx, cz) is not detected.
- Ruling: argument checks: `sy` integer in 0 … 23, every channel array exactly 4096 entries (all checked before the first store, so `shareFinal` with a bad light shares nothing), `lx`, `lz` 0 … 15 and y −64 … 319 integers in the views (RangeError) — cost if wrong: a few compares per voxel read (the slice job reads 196,608 per job).
- Ruling: `ColumnView` reads the record live (not a snapshot): valid while its column stays in the store; a proto view's `light` is 0 (proto sets have no light); `sectionBlocks`/`sectionFluid` return `Uint16Array | number` / `Uint8Array | number` as `section.ts` does; `aux()` builds new subarrays per call — cost if wrong: SP4 may add `sectionLight` and a cached aux.
- Ruling: "absent" for `proto`/`final` and `versions()` is: the record does not hold (cx, cz), or holds it below the status the set needs; `versions()` gives −1 −1 for a column claimed but never committed (status Absent) — spec §3.5 says "−1 for an absent column" and status 0 is named Absent — cost if wrong: SP4 changes one comparison.
- Ruling: `versions()` returns a new Int32Array(18) per call — simplest safe contract; SP4 may switch to a caller-owned buffer — cost if wrong: one 72-byte allocation per call.
- Ruling: meta is computed from the stored entries (`sectionWords`/`sectionBytes`), so a uniform section's meta costs no scan, and `shareFinal` computes it from the shared proto entries — cost if wrong: none.
- Ruling: `freeColumn` stores status Absent first, releases every proto, final and aux entry, then `table.clear` and `table.unclaim` (cx, cz `NO_COLUMN`, then `claimed` 0); `freeProto` only releases proto entries (status unchanged) — spec §3.5 order — cost if wrong: none.
- Ruling: "`attachStore` across two threads" is a unit test that bundles `src/world/store/store.ts` with Vite into `test/.cache/storeAttach/store.mjs` (as `buildNodeTaskWorker` does for the task handler) and runs `test/unit/fixtures/storeWorker.mjs` (plain .mjs, like `sabWorker.mjs`), which dynamic-imports it: the worker reads the main thread's column, writes 5 × 24 dense sections (growing the block pool past the main thread's 128 slots) and bumps an epoch cell; the main thread reads them through its length-tracking views — Task 8 generalises `buildNodeTaskWorker`; this test does not depend on it — cost if wrong: switch to `buildNodeTaskWorker(dir, {entry})` after Task 8 (≈0.2 s build per run either way).
- No spec defects found for Task 7.

---

### Task 8: Slab fuzz

**Spec:** §3.6 slab fuzz, §6.1 (`buildNodeTaskWorker(dir, {entry?, stamp?})` generalised)

**Files:**
- Create: `test/harness/fuzzWorker.ts`
- Modify: `test/harness/nodeWorker.ts`
- Create: `test/integration/slabFuzz.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/store/pool.ts` (Task 5): `SlabPool`
  - `src/world/store/columnTable.ts` (Task 6): `REC_AUX_A`, `REC_AUX_B`, `SECTIONS`, `finalAt`, `protoAt`, `recordBase`
  - `src/world/store/section.ts` (Task 6): `FINAL_BLOCKS`, `FINAL_FLUID`, `FINAL_LIGHT`, `PROTO_BLOCKS`, `PROTO_FLUID`, `SECTION_VOXELS`
  - `src/world/store/store.ts` (Task 7): `SlotBusy`, `attachStore`, `type ColumnWriter`, `type StoreHandles`, `type VoxelStore`
- Produces (exports added by this task):
  - `test/harness/fuzzWorker.ts`:
    - `export const FUZZ_LIMITS = { rawRefs: 1000, columns: 8 } as const;`
    - `export const FUZZ_COUNTS = [`
    - `export type FuzzCount = (typeof FUZZ_COUNTS)[number];`
    - `export interface FuzzStats`
    - `export type FuzzReply = { type: 'ready' | 'phase' | 'done'; stats: FuzzStats } | { type: 'error'; message: string };`
    - `export function createTaskHandler(): { handle(raw: unknown): Reply }`
  - `test/harness/nodeWorker.ts`:
    - `export interface NodeWorkerOptions`
    - `export async function buildNodeTaskWorker(dir: string, opts: NodeWorkerOptions = {}): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `test/integration/slabFuzz.test.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { finalAt, protoAt, RECORD_COUNT, RECORD_INTS, REC_AUX_A, REC_AUX_B, REC_CLAIMED, SECTIONS } from '../../src/world/store/columnTable';
import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import type { SlabPool } from '../../src/world/store/pool';
import { FUZZ_LIMITS, type FuzzReply, type FuzzStats } from '../harness/fuzzWorker';
import { buildNodeTaskWorker } from '../harness/nodeWorker';

/**
 * Slab fuzz (SP3a spec §3.6, §9): 4 worker threads × 100k random ops on one shared store (64 MiB block pool,
 * 32 MiB byte pool): raw alloc/retain/free, uniform ↔ dense section rewrites, proto and final sets (shared or
 * not), freeProto, freeColumn, aux slots, and claims with torus collisions. The pools start empty and grow while
 * the threads race. Between phases every thread is idle and this thread checks the whole store; the limits are
 * hard assertions (no threshold row, §9).
 */
const THREADS = 4;
const OPS = 100_000;
const PHASES = 10;
const MiB = 1 << 20;
const SEED = Number(process.env['SLAB_FUZZ_SEED'] ?? '1');

let script = '';
const workers: Worker[] = [];

beforeAll(async () => {
  script = await buildNodeTaskWorker('slabFuzz', { entry: 'test/harness/fuzzWorker.ts' });
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

const ask = (w: Worker, msg: unknown): Promise<FuzzReply> =>
  new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    w.once('message', (r: FuzzReply) => {
      w.off('error', onError);
      resolve(r);
    });
    w.once('error', onError);
    w.postMessage(msg);
  });

/** Every reply of a phase (`msg` per thread), failing with the worker's message and the seed on an error reply. */
async function all(msg: (thread: number) => unknown): Promise<FuzzStats[]> {
  const replies = await Promise.all(workers.map((w, t) => ask(w, msg(t))));
  return replies.map((r, t) => {
    if (r.type === 'error') throw new Error(`fuzz thread ${t} (SLAB_FUZZ_SEED=${SEED}): ${r.message}`);
    return r.stats;
  });
}

interface PoolCheck {
  slots: number;
  /** Slots whose refcount differs from their raw references plus the entries that reference them. */
  refMismatches: number;
  /** slot count − (free-stack size + slots with refcount > 0). */
  lost: number;
  /** Free-stack entries that repeat, or whose slot has refcount ≠ 0. */
  badStack: number;
  /** Slots whose owner cell disagrees with their holder (0 for a free slot, the referencing thread otherwise). */
  ownerMismatches: number;
  live: number;
  lock: number;
}

/** The whole-store check made while every thread is idle (SP3a spec §3.6). */
function check(s: VoxelStore, raw: { blocks: Int32Array; bytes: Int32Array }, owners: { blocks: Int32Array; bytes: Int32Array }) {
  const expected = { blocks: new Int32Array(s.blockPool.maxSlots), bytes: new Int32Array(s.bytePool.maxSlots) };
  const holder = { blocks: new Int32Array(s.blockPool.maxSlots), bytes: new Int32Array(s.bytePool.maxSlots) };
  for (let i = 0; i < expected.blocks.length; i++) expected.blocks[i] = Atomics.load(raw.blocks, i);
  for (let i = 0; i < expected.bytes.length; i++) expected.bytes[i] = Atomics.load(raw.bytes, i);
  const ints = s.table.ints;
  let claimed = 0;
  for (let rec = 0; rec < RECORD_COUNT; rec++) {
    const base = rec * RECORD_INTS;
    if (Atomics.load(ints, base + REC_CLAIMED) !== 1) continue;
    claimed++;
    const thread = 1 + (rec % THREADS);
    const add = (pool: 'blocks' | 'bytes', code: number) => {
      if (code < 0) return;
      expected[pool][code]!++;
      holder[pool][code] = thread;
    };
    for (let sy = 0; sy < SECTIONS; sy++) {
      const p = protoAt(base, sy);
      const f = finalAt(base, sy);
      add('blocks', ints[p + PROTO_BLOCKS]!);
      add('bytes', ints[p + PROTO_FLUID]!);
      add('blocks', ints[f + FINAL_BLOCKS]!);
      add('bytes', ints[f + FINAL_LIGHT]!);
      add('bytes', ints[f + FINAL_FLUID]!);
    }
    add('bytes', ints[base + REC_AUX_A]!);
    add('bytes', ints[base + REC_AUX_B]!);
  }
  const pool = (p: SlabPool, name: 'blocks' | 'bytes'): PoolCheck => {
    const slots = p.slotCount();
    let refMismatches = 0;
    let live = 0;
    let ownerMismatches = 0;
    for (let id = 0; id < slots; id++) {
      const rc = p.refcount(id);
      if (rc !== expected[name][id]) refMismatches++;
      if (rc > 0) live++;
      const owner = Atomics.load(owners[name], id);
      if (rc === 0 ? owner !== 0 : owner === 0 || (holder[name][id] !== 0 && owner !== holder[name][id])) ownerMismatches++;
    }
    for (let id = slots; id < expected[name].length; id++) if (expected[name][id] !== 0) refMismatches++;
    const stack = p.freeStack();
    const seen = new Uint8Array(slots);
    let badStack = 0;
    for (const id of stack) {
      if (id < 0 || id >= slots || seen[id] === 1 || p.refcount(id) !== 0) badStack++;
      else seen[id] = 1;
    }
    return { slots, refMismatches, lost: slots - (stack.length + live), badStack, ownerMismatches, live, lock: p.lockWord() };
  };
  return { blocks: pool(s.blockPool, 'blocks'), bytes: pool(s.bytePool, 'bytes'), claimed };
}

const clean = (c: PoolCheck) => ({ refMismatches: c.refMismatches, lost: c.lost, badStack: c.badStack, ownerMismatches: c.ownerMismatches, lock: c.lock });
const ZERO = { refMismatches: 0, lost: 0, badStack: 0, ownerMismatches: 0, lock: 0 };

test('slab fuzz: 4 threads × 100k ops, both pools, growth, promotion, sharing, torus collisions', async () => {
  const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 32 * MiB });
  const sab = (slots: number) => new Int32Array(new SharedArrayBuffer(4 * slots));
  const raw = { blocks: sab(store.blockPool.maxSlots), bytes: sab(store.bytePool.maxSlots) };
  const owners = { blocks: sab(store.blockPool.maxSlots), bytes: sab(store.bytePool.maxSlots) };
  expect(store.blockPool.maxSlots).toBe(8192);
  expect(store.bytePool.maxSlots).toBe(8192);
  expect(store.blockPool.slotCount() + store.bytePool.slotCount()).toBe(0);

  for (let t = 0; t < THREADS; t++) workers.push(new Worker(script));
  await all((thread) => ({
    type: 'attach', thread, threads: THREADS, seed: SEED, handles: store.handles(),
    raw: { blocks: raw.blocks.buffer, bytes: raw.bytes.buffer },
    owners: { blocks: owners.blocks.buffer, bytes: owners.bytes.buffer },
  }));
  for (let phase = 0; phase < PHASES; phase++) {
    const stats = await all(() => ({ type: 'run', ops: OPS / PHASES }));
    for (const st of stats) {
      expect(st.doubleAllocs, 'double allocations').toBe(0);
      expect(st.wrongLookups, 'lookups returning another column').toBe(0);
      expect(st.busyFailures, 'claims of a held record that did not throw SlotBusy').toBe(0);
      expect(st.dataMismatches, 'slot contents changed under a reference').toBe(0);
      expect(st.ownerMismatches, 'owner cells').toBe(0);
      expect(st.maxRaw.blocks).toBeLessThanOrEqual(FUZZ_LIMITS.rawRefs);
      expect(st.maxRaw.bytes).toBeLessThanOrEqual(FUZZ_LIMITS.rawRefs);
      expect(st.maxColumns).toBeLessThanOrEqual(FUZZ_LIMITS.columns);
    }
    const c = check(store, raw, owners);
    expect(clean(c.blocks), `block pool after phase ${phase}`).toEqual(ZERO);
    expect(clean(c.bytes), `byte pool after phase ${phase}`).toEqual(ZERO);
  }

  const before = check(store, raw, owners);
  const final = await all(() => ({ type: 'teardown' }));
  const ops = final.reduce((n, st) => n + st.ops, 0);
  expect(ops).toBe(THREADS * OPS);
  // Every kind of op ran, on every thread.
  for (const st of final) {
    for (const [kind, n] of Object.entries(st.counts)) expect(n, `${kind} ops`).toBeGreaterThan(0);
    expect(st.doubleAllocs + st.wrongLookups + st.busyFailures + st.dataMismatches + st.ownerMismatches).toBe(0);
  }
  // Growth happened many times while the threads raced (128 block or 256 byte slots per step).
  expect(before.blocks.slots / 128).toBeGreaterThanOrEqual(16);
  expect(before.bytes.slots / 256).toBeGreaterThanOrEqual(8);

  // Teardown: every refcount 0, every slot on the free stack, every record free, every owner and raw cell 0.
  const after = check(store, raw, owners);
  expect(clean(after.blocks)).toEqual(ZERO);
  expect(clean(after.bytes)).toEqual(ZERO);
  expect(after.blocks.live + after.bytes.live).toBe(0);
  expect(store.blockPool.freeCount()).toBe(store.blockPool.slotCount());
  expect(store.bytePool.freeCount()).toBe(store.bytePool.slotCount());
  expect(after.claimed).toBe(0);
  expect(raw.blocks.some((v) => v !== 0) || raw.bytes.some((v) => v !== 0)).toBe(false);
  expect(owners.blocks.some((v) => v !== 0) || owners.bytes.some((v) => v !== 0)).toBe(false);
  console.log(`slab fuzz (SLAB_FUZZ_SEED=${SEED}): pools grew to ${before.blocks.slots} block and ${before.bytes.slots} byte slots`);
}, 300_000);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project integration test/integration/slabFuzz.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |integration| test/integration/slabFuzz.test.ts [ test/integration/slabFuzz.test.ts ]
Error: Cannot find module '../harness/fuzzWorker' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/integration/slabFuzz.test.ts
Test Files  1 failed (1)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `test/harness/fuzzWorker.ts`:

```ts
/**
 * The slab-fuzz worker (SP3a spec §3.6), bundled by `buildNodeTaskWorker(dir, {entry: 'test/harness/fuzzWorker.ts'})`
 * and driven by `test/integration/slabFuzz.test.ts`. Never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', thread, threads, seed, handles, raw, owners}` once (`attachStore`), then
 * `{type: 'run', ops}` per phase and `{type: 'teardown'}` at the end; each is answered with the thread's
 * cumulative `FuzzStats` (`ready`, `phase`, `done`), or `{type: 'error', message}` when anything throws (`StoreFull`
 * included: the limits below keep every pool under half its slots).
 *
 * Bookkeeping, per pool:
 * - `held[slot]`: the references this thread holds (its raw references plus the entries of its records);
 * - `raw[slot]` (shared, Atomics): this thread's raw references, which the main thread adds to the entries it finds
 *   in the column table to get every slot's expected refcount;
 * - `owner[slot]` (shared, Atomics): the thread (index + 1) that holds the slot, 0 when none. A thread claims the
 *   cell by compare-exchange 0 → me when it gets a slot it held no reference to, and clears it before it lets go of
 *   its last reference; a failed claim is a double allocation (the slot came back while another thread, or this
 *   one, still held it).
 * Raw slots carry a stamp (thread, counter) in their first two words, checked before every retain and free.
 *
 * Torus: thread t owns the records whose slot ≡ t (mod 4), i.e. cx ≡ t (mod 4); it uses 12 of them, records
 * (t + 4i, j) for i < 3, j < 4, and claims columns 64 apart on each (cx − 64, cx, cx + 64, each at cz and cz + 64),
 * at most 8 held at once.
 */
import { Xoshiro128 } from '../../src/core/rng';
import { finalAt, protoAt, recordBase, REC_AUX_A, REC_AUX_B, SECTIONS } from '../../src/world/store/columnTable';
import type { SlabPool } from '../../src/world/store/pool';
import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, PROTO_BLOCKS, PROTO_FLUID, SECTION_VOXELS } from '../../src/world/store/section';
import { attachStore, SlotBusy, type ColumnWriter, type StoreHandles, type VoxelStore } from '../../src/world/store/store';

/** Per thread: live raw references per pool, and claimed columns (SP3a spec §3.6). */
export const FUZZ_LIMITS = { rawRefs: 1000, columns: 8 } as const;

/** Every kind of op and section transition the fuzz counts; each must happen on every thread. */
export const FUZZ_COUNTS = [
  'alloc', 'retain', 'free', 'claim', 'busy', 'collide', 'protoSection', 'promote', 'demote', 'protoSet', 'finalSet',
  'finalSection', 'share', 'freeProto', 'freeColumn', 'aux', 'auxB', 'lookup',
] as const;
export type FuzzCount = (typeof FUZZ_COUNTS)[number];

export interface FuzzStats {
  ops: number;
  counts: Record<FuzzCount, number>;
  /** An alloc (raw or inside the store) returned a slot that a reference still held. */
  doubleAllocs: number;
  /** A lookup returned another column's record, or none for a held column. */
  wrongLookups: number;
  /** A claim on a held record did not throw `SlotBusy`. */
  busyFailures: number;
  /** A stamp or a section's contents changed under a reference, or a new aux slot was not zero. */
  dataMismatches: number;
  /** An owner cell held another thread (or nothing) when this thread let go of the slot. */
  ownerMismatches: number;
  maxRaw: { blocks: number; bytes: number };
  maxColumns: number;
}

export type FuzzReply = { type: 'ready' | 'phase' | 'done'; stats: FuzzStats } | { type: 'error'; message: string };

interface Reply {
  msg: FuzzReply;
  transfer: Transferable[];
}

interface AttachMsg {
  type: 'attach';
  thread: number;
  threads: number;
  seed: number;
  handles: StoreHandles;
  raw: { blocks: SharedArrayBuffer; bytes: SharedArrayBuffer };
  owners: { blocks: SharedArrayBuffer; bytes: SharedArrayBuffer };
}

/** Block pool 0, byte pool 1. */
type PoolIx = 0 | 1;

interface Pos {
  at: number;
  pool: PoolIx;
}

interface Col {
  cx: number;
  cz: number;
  base: number;
  w: ColumnWriter;
  /** The last committed status (0 before the first commit) and the number of commits (= blockVersion). */
  status: number;
  commits: number;
  /** Expected block state at voxel 0 of each proto and final section. */
  proto: Int32Array;
  final: Int32Array;
}

const RECORDS_X = 3;
const RECORDS_Z = 4;
/** Columns per record: cx − 64, cx, cx + 64 at cz and at cz + 64. */
const VARIANTS = 6;
const PATTERNS = 8;
/** Dense block sections carry a tag at voxel 0, in [TAG_MIN, 4096): states the 4096-entry PASS table covers. */
const TAG_MIN = 3;

function newStats(): FuzzStats {
  const counts = {} as Record<FuzzCount, number>;
  for (const k of FUZZ_COUNTS) counts[k] = 0;
  return {
    ops: 0, counts, doubleAllocs: 0, wrongLookups: 0, busyFailures: 0, dataMismatches: 0, ownerMismatches: 0,
    maxRaw: { blocks: 0, bytes: 0 }, maxColumns: 0,
  };
}

/** One fuzz thread over an attached store. */
function createFuzzer(m: AttachMsg) {
  const store: VoxelStore = attachStore(m.handles);
  const ints = store.table.ints;
  const me = m.thread + 1;
  const rng = new Xoshiro128((m.seed * 1000 + m.thread) | 0);
  const pools: readonly [SlabPool, SlabPool] = [store.blockPool, store.bytePool];
  const raw = [new Int32Array(m.raw.blocks), new Int32Array(m.raw.bytes)] as const;
  const owner = [new Int32Array(m.owners.blocks), new Int32Array(m.owners.bytes)] as const;
  const held = [new Int32Array(pools[0].maxSlots), new Int32Array(pools[1].maxSlots)] as const;
  const stampOf = [new Int32Array(pools[0].maxSlots), new Int32Array(pools[1].maxSlots)] as const;
  const refs: [number[], number[]] = [[], []];
  const cols: (Col | null)[] = new Array<Col | null>(RECORDS_X * RECORDS_Z).fill(null);
  const st = newStats();
  let stamp = 0;
  let tag = 0;

  // Dense patterns: block states 0-2, light and fluid bytes (random, never uniform).
  const blockPatterns: Uint16Array[] = [];
  const bytePatterns: Uint8Array[] = [];
  for (let k = 0; k < PATTERNS; k++) {
    const b = new Uint16Array(SECTION_VOXELS);
    const y = new Uint8Array(SECTION_VOXELS);
    for (let i = 0; i < SECTION_VOXELS; i++) {
      b[i] = rng.nextInt(3);
      y[i] = rng.nextU32() & 0xff;
    }
    blockPatterns.push(b);
    bytePatterns.push(y);
  }
  const blocks = new Uint16Array(SECTION_VOXELS);
  const light = new Uint8Array(SECTION_VOXELS);
  const fluid = new Uint8Array(SECTION_VOXELS);
  const UNIFORM_FLUID = [0, 0x10, 0x21];
  const UNIFORM_LIGHT = [0, 0xf0, 0x0f];

  /** Fills `blocks` dense (a tagged pattern) or uniform (state 0-2); returns the state at voxel 0. */
  function fillBlocks(dense: boolean): number {
    if (dense) {
      blocks.set(blockPatterns[rng.nextInt(PATTERNS)]!);
      blocks[0] = TAG_MIN + (tag++ % (4096 - TAG_MIN));
    } else {
      blocks.fill(rng.nextInt(3));
    }
    return blocks[0]!;
  }
  function fillBytes(a: Uint8Array, dense: boolean, uniform: readonly number[]): void {
    if (dense) a.set(bytePatterns[rng.nextInt(PATTERNS)]!);
    else a.fill(uniform[rng.nextInt(uniform.length)]!);
  }

  function claimOwner(pool: PoolIx, slot: number): void {
    if (Atomics.compareExchange(owner[pool], slot, 0, me) !== 0) st.doubleAllocs++;
  }
  function dropOwner(pool: PoolIx, slot: number): void {
    if (Atomics.compareExchange(owner[pool], slot, me, 0) !== me) st.ownerMismatches++;
  }

  /**
   * Runs a store op that rewrites the entries at `pos`, keeping `held` and the owner cells right: the slots whose
   * last reference goes are released from their owner cell first; a new dense entry this thread held no reference
   * to is claimed; a new entry it already held is a double allocation unless its position shares (`shares`).
   */
  function tracked(pos: readonly Pos[], op: () => void, shares: readonly number[] = []): void {
    const old = pos.map((p) => ints[p.at]!);
    const going: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
    pos.forEach((p, i) => {
      const c = old[i]!;
      if (c >= 0) going[p.pool].set(c, (going[p.pool].get(c) ?? 0) + 1);
    });
    for (const pool of [0, 1] as const) {
      for (const [slot, k] of going[pool]) if (held[pool][slot] === k) dropOwner(pool, slot);
    }
    op();
    pos.forEach((p, i) => {
      const c = old[i]!;
      if (c >= 0) held[p.pool][c]!--;
    });
    for (const p of pos) {
      const c = ints[p.at]!;
      if (c < 0) continue;
      if (held[p.pool][c] === 0) claimOwner(p.pool, c);
      else if (!shares.includes(p.at)) st.doubleAllocs++;
      held[p.pool][c]!++;
    }
  }

  const protoPos = (base: number, sy: number): Pos[] => {
    const p = protoAt(base, sy);
    return [{ at: p + PROTO_BLOCKS, pool: 0 }, { at: p + PROTO_FLUID, pool: 1 }];
  };
  const finalPos = (base: number, sy: number): Pos[] => {
    const f = finalAt(base, sy);
    return [{ at: f + FINAL_BLOCKS, pool: 0 }, { at: f + FINAL_LIGHT, pool: 1 }, { at: f + FINAL_FLUID, pool: 1 }];
  };
  const allProtoPos = (base: number): Pos[] => {
    const out: Pos[] = [];
    for (let sy = 0; sy < SECTIONS; sy++) out.push(...protoPos(base, sy));
    return out;
  };
  const allPos = (base: number): Pos[] => {
    const out = allProtoPos(base);
    for (let sy = 0; sy < SECTIONS; sy++) out.push(...finalPos(base, sy));
    out.push({ at: base + REC_AUX_A, pool: 1 }, { at: base + REC_AUX_B, pool: 1 });
    return out;
  };

  // ---- raw slots ----

  const wordsPerSlot = (pool: PoolIx) => pools[pool].slotBytes >> 1;
  function checkStamp(pool: PoolIx, slot: number): void {
    const w = pools[pool].words;
    const at = slot * wordsPerSlot(pool);
    if (w[at] !== me || w[at + 1] !== stampOf[pool][slot]) st.dataMismatches++;
  }

  function rawAlloc(pool: PoolIx): void {
    const s = pools[pool].alloc();
    if (held[pool][s] !== 0) st.doubleAllocs++;
    else claimOwner(pool, s);
    held[pool][s]!++;
    Atomics.add(raw[pool], s, 1);
    refs[pool].push(s);
    const at = s * wordsPerSlot(pool);
    stampOf[pool][s] = stamp = (stamp + 1) & 0xffff;
    pools[pool].words[at] = me;
    pools[pool].words[at + 1] = stamp;
    st.counts.alloc++;
  }

  function rawRetain(pool: PoolIx): void {
    const s = refs[pool][rng.nextInt(refs[pool].length)]!;
    checkStamp(pool, s);
    pools[pool].retain(s);
    held[pool][s]!++;
    Atomics.add(raw[pool], s, 1);
    refs[pool].push(s);
    st.counts.retain++;
  }

  function rawFree(pool: PoolIx, i: number): void {
    const list = refs[pool];
    const s = list[i]!;
    list[i] = list[list.length - 1]!;
    list.pop();
    checkStamp(pool, s);
    if (held[pool][s] === 1) dropOwner(pool, s);
    held[pool][s]!--;
    Atomics.sub(raw[pool], s, 1);
    pools[pool].free(s);
    st.counts.free++;
  }

  function rawOp(kind: number): void {
    const pool = rng.nextInt(2) as PoolIx;
    const n = refs[pool].length;
    if (n === 0 || (kind === 0 && n < FUZZ_LIMITS.rawRefs)) rawAlloc(pool);
    else if (kind === 1 && n < FUZZ_LIMITS.rawRefs) rawRetain(pool);
    else rawFree(pool, rng.nextInt(n));
    st.maxRaw.blocks = Math.max(st.maxRaw.blocks, refs[0].length);
    st.maxRaw.bytes = Math.max(st.maxRaw.bytes, refs[1].length);
  }

  // ---- columns ----

  const recordCx = (r: number) => m.thread + m.threads * (r % RECORDS_X);
  const recordCz = (r: number) => Math.floor(r / RECORDS_X);
  const variantCx = (r: number, k: number) => recordCx(r) + 64 * ((k % 3) - 1);
  const variantCz = (r: number, k: number) => recordCz(r) + 64 * Math.floor(k / 3);
  const heldCount = () => cols.reduce((n, c) => n + (c === null ? 0 : 1), 0);

  function expectBusy(cx: number, cz: number): void {
    try {
      store.claimColumn(cx, cz, 0);
      st.busyFailures++;
    } catch (e) {
      if (!(e instanceof SlotBusy)) throw e;
    }
  }

  function freeCol(r: number): void {
    const c = cols[r]!;
    tracked(allPos(c.base), () => store.freeColumn(c.cx, c.cz));
    cols[r] = null;
    if (store.table.find(c.cx, c.cz) !== -1 || store.proto(c.cx, c.cz) !== null) st.wrongLookups++;
    st.counts.freeColumn++;
  }

  function claimOp(): void {
    const r = rng.nextInt(cols.length);
    const k = rng.nextInt(VARIANTS);
    const cx = variantCx(r, k);
    const cz = variantCz(r, k);
    const holder = cols[r];
    if (holder !== null) {
      expectBusy(cx, cz);
      if (holder.cx === cx && holder.cz === cz) {
        st.counts.busy++;
        return;
      }
      st.counts.collide++;
      freeCol(r);
    } else if (heldCount() >= FUZZ_LIMITS.columns) {
      const live = cols.flatMap((c, i) => (c === null ? [] : [i]));
      freeCol(live[rng.nextInt(live.length)]!);
    }
    const w = store.claimColumn(cx, cz, rng.nextInt(1000));
    cols[r] = { cx, cz, base: recordBase(cx, cz), w, status: 0, commits: 0, proto: new Int32Array(SECTIONS), final: new Int32Array(SECTIONS) };
    if (store.table.find(cx, cz) !== recordBase(cx, cz) || store.proto(cx, cz) !== null) st.wrongLookups++;
    st.maxColumns = Math.max(st.maxColumns, heldCount());
    st.counts.claim++;
  }

  function writeProto(c: Col, sy: number): void {
    const p = protoAt(c.base, sy);
    const wasDense = [ints[p + PROTO_BLOCKS]! >= 0, ints[p + PROTO_FLUID]! >= 0];
    const v = fillBlocks(rng.nextInt(2) === 0);
    fillBytes(fluid, rng.nextInt(3) === 0, UNIFORM_FLUID);
    tracked(protoPos(c.base, sy), () => c.w.setProto(sy, blocks, fluid));
    c.proto[sy] = v;
    const isDense = [ints[p + PROTO_BLOCKS]! >= 0, ints[p + PROTO_FLUID]! >= 0];
    for (let ch = 0; ch < 2; ch++) {
      if (!wasDense[ch] && isDense[ch]) st.counts.promote++;
      if (wasDense[ch] && !isDense[ch]) st.counts.demote++;
    }
  }

  function writeFinal(c: Col, sy: number): void {
    fillBytes(light, rng.nextInt(3) === 0, UNIFORM_LIGHT);
    if (rng.nextInt(2) === 0) {
      const f = finalAt(c.base, sy);
      tracked(finalPos(c.base, sy), () => c.w.shareFinal(sy, light), [f + FINAL_BLOCKS, f + FINAL_FLUID]);
      c.final[sy] = c.proto[sy]!;
      if (ints[f + FINAL_BLOCKS]! >= 0 || ints[f + FINAL_FLUID]! >= 0) st.counts.share++;
    } else {
      const v = fillBlocks(rng.nextInt(2) === 0);
      fillBytes(fluid, rng.nextInt(3) === 0, UNIFORM_FLUID);
      tracked(finalPos(c.base, sy), () => c.w.setFinal(sy, blocks, light, fluid));
      c.final[sy] = v;
    }
  }

  function commit(c: Col, status: 1 | 2): void {
    c.w.commit(status);
    c.status = status;
    c.commits++;
  }

  function auxOp(c: Col): void {
    const b = rng.nextInt(2) === 1;
    const at = c.base + (b ? REC_AUX_B : REC_AUX_A);
    if (ints[at]! < 0) {
      tracked([{ at, pool: 1 }], () => (b ? c.w.auxB() : c.w.aux()));
      const slot = pools[1].u8(ints[at]!);
      if (slot.some((v) => v !== 0)) st.dataMismatches++;
    }
    // Dirty the slot, so that a recycled aux slot must be zero-filled again.
    if (b) c.w.auxB().caveBiomeQ.fill(rng.nextInt(255) + 1);
    else c.w.aux().tintTH.fill(rng.nextInt(255) + 1);
    st.counts[b ? 'auxB' : 'aux']++;
  }

  function lookupOp(): void {
    const r = rng.nextInt(cols.length);
    const c = cols[r];
    for (let k = 0; k < VARIANTS; k++) {
      const cx = variantCx(r, k);
      const cz = variantCz(r, k);
      const mine = c !== null && c.cx === cx && c.cz === cz ? c : null;
      if (store.table.find(cx, cz) !== (mine === null ? -1 : mine.base)) st.wrongLookups++;
      const sy = rng.nextInt(SECTIONS);
      const pv = store.proto(cx, cz);
      if (mine === null || mine.status < 1) {
        if (pv !== null) st.wrongLookups++;
      } else if (pv === null || pv.cx !== cx || pv.cz !== cz) {
        st.wrongLookups++;
      } else if (pv.block(0, sy * 16 - 64, 0) !== mine.proto[sy]) {
        st.dataMismatches++;
      }
      const fv = store.final(cx, cz);
      if (mine === null || mine.status < 2) {
        if (fv !== null) st.wrongLookups++;
      } else if (fv === null || fv.cx !== cx || fv.cz !== cz) {
        st.wrongLookups++;
      } else if (fv.block(0, sy * 16 - 64, 0) !== mine.final[sy]) {
        st.dataMismatches++;
      }
      const v = store.neighborhood(cx, cz).versions();
      if (v[8] !== (mine === null || mine.status < 1 ? -1 : mine.commits)) st.wrongLookups++;
    }
    st.counts.lookup++;
  }

  /** A random held column, or null (the op then claims one). */
  function someCol(): Col | null {
    const live = cols.filter((c): c is Col => c !== null);
    return live.length === 0 ? null : live[rng.nextInt(live.length)]!;
  }

  function step(): void {
    const k = rng.nextInt(100);
    if (k < 18) return rawOp(0);
    if (k < 24) return rawOp(1);
    if (k < 40) return rawOp(2);
    if (k < 48) return claimOp();
    if (k >= 83) return lookupOp();
    const c = someCol();
    if (c === null) return claimOp();
    if (k < 60) {
      writeProto(c, rng.nextInt(SECTIONS));
      st.counts.protoSection++;
    } else if (k < 64) {
      for (let sy = 0; sy < SECTIONS; sy++) writeProto(c, sy);
      commit(c, 1);
      st.counts.protoSet++;
    } else if (k < 67) {
      for (let sy = 0; sy < SECTIONS; sy++) writeFinal(c, sy);
      commit(c, 2);
      st.counts.finalSet++;
    } else if (k < 73) {
      writeFinal(c, rng.nextInt(SECTIONS));
      st.counts.finalSection++;
    } else if (k < 76) {
      tracked(allProtoPos(c.base), () => store.freeProto(c.cx, c.cz));
      c.proto.fill(0);
      st.counts.freeProto++;
    } else if (k < 80) {
      freeCol(cols.indexOf(c));
    } else {
      auxOp(c);
    }
  }

  return {
    stats: () => st,
    run(ops: number): void {
      for (let i = 0; i < ops; i++) {
        step();
        st.ops++;
      }
    },
    teardown(): void {
      for (const pool of [0, 1] as const) while (refs[pool].length > 0) rawFree(pool, refs[pool].length - 1);
      for (let r = 0; r < cols.length; r++) if (cols[r] !== null) freeCol(r);
    },
  };
}

/** The worker contract of `buildNodeTaskWorker`: `handle(message)` → `{msg, transfer}`. */
export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let fuzzer: ReturnType<typeof createFuzzer> | null = null;
  const reply = (msg: FuzzReply): Reply => ({ msg, transfer: [] });
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown; ops?: unknown };
        if (m.type === 'attach') {
          fuzzer = createFuzzer(raw as AttachMsg);
          return reply({ type: 'ready', stats: fuzzer.stats() });
        }
        if (fuzzer === null) throw new Error(`fuzz: '${String(m.type)}' before 'attach'`);
        if (m.type === 'run') {
          fuzzer.run(Number(m.ops));
          return reply({ type: 'phase', stats: fuzzer.stats() });
        }
        if (m.type === 'teardown') {
          fuzzer.teardown();
          return reply({ type: 'done', stats: fuzzer.stats() });
        }
        throw new Error(`fuzz: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}
```

Modify `test/harness/nodeWorker.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/nodeWorker.ts b/test/harness/nodeWorker.ts
index 68138b1..1d4e434 100644
--- a/test/harness/nodeWorker.ts
+++ b/test/harness/nodeWorker.ts
@@ -1,13 +1,24 @@
 /**
- * Bundles the pure task handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2), so
- * integration tests run the handler as a real worker. Each test file builds into its own directory under
- * test/.cache/ because vitest runs test files in parallel.
+ * Bundles a pure task handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2, SP3a §6.1), so
+ * integration tests run the handler as a real worker. The default entry is `src/workers/taskHandler.ts`; harness
+ * entries (`test/harness/fuzzWorker.ts`, `regionWorker.ts`) follow the same contract: the module exports
+ * `createTaskHandler()`, whose `handle(message)` returns `{msg, transfer}`, and never imports `node:` modules
+ * (the wrapper owns `parentPort`). Each test file builds into its own directory under test/.cache/ because
+ * vitest runs test files in parallel.
  */
-import { mkdirSync, writeFileSync } from 'node:fs';
+import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
+import { basename } from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { build } from 'vite';
 
-const ENTRY = fileURLToPath(new URL('../../src/workers/taskHandler.ts', import.meta.url));
+/** The default entry, relative to the repository root. */
+const DEFAULT_ENTRY = 'src/workers/taskHandler.ts';
+
+export interface NodeWorkerOptions {
+  /** The module to bundle, relative to the repository root (default `src/workers/taskHandler.ts`). */
+  readonly entry?: string;
+  readonly stamp?: boolean;
+}
 
 /**
  * Builds into test/.cache/<dir>/ and returns the path of the worker script. With `stamp`, each reply also carries
@@ -15,16 +26,19 @@ const ENTRY = fileURLToPath(new URL('../../src/workers/taskHandler.ts', import.m
  * process shares, so the main thread compares it with its own reading). A test can then time the handler itself,
  * without the delivery of the reply to its own event loop.
  */
-export async function buildNodeTaskWorker(dir: string, opts: { readonly stamp?: boolean } = {}): Promise<string> {
+export async function buildNodeTaskWorker(dir: string, opts: NodeWorkerOptions = {}): Promise<string> {
   const out = fileURLToPath(new URL(`../.cache/${dir}/`, import.meta.url));
+  const entry = fileURLToPath(new URL(`../../${opts.entry ?? DEFAULT_ENTRY}`, import.meta.url));
+  if (!existsSync(entry)) throw new Error(`buildNodeTaskWorker: no entry ${opts.entry ?? DEFAULT_ENTRY}`);
+  const bundle = `${basename(entry).replace(/\.ts$/, '')}.mjs`;
   mkdirSync(out, { recursive: true });
   await build({
     configFile: false, logLevel: 'silent',
-    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: ENTRY, formats: ['es'], fileName: () => 'taskHandler.mjs' } },
+    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry, formats: ['es'], fileName: () => bundle } },
   });
   writeFileSync(`${out}node-worker.mjs`, [
     "import { parentPort } from 'node:worker_threads';",
-    "import { createTaskHandler } from './taskHandler.mjs';",
+    `import { createTaskHandler } from './${bundle}';`,
     'const h = createTaskHandler();',
     opts.stamp === true
       ? "parentPort.on('message', (m) => { const r = h.handle(m); const handledAt = Number(process.hrtime.bigint()) / 1e6; parentPort.postMessage({ ...r.msg, handledAt }, r.transfer); });"
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project integration test/integration/slabFuzz.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  1 passed (1)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  107 passed | 2 skipped (109)
Tests  1399 passed | 2 skipped (1401)
```

- [ ] **Step 6: Commit**

```bash
git add test/harness/fuzzWorker.ts test/harness/nodeWorker.ts test/integration/slabFuzz.test.ts
git commit -F - <<'EOF'
test(store): slab fuzz, 4 threads x 100k ops on one shared store (SP3a §3.6)

buildNodeTaskWorker(dir, {entry?, stamp?}) bundles any entry that exports
createTaskHandler() (default src/workers/taskHandler.ts, SP3a §6.1).
test/harness/fuzzWorker.ts runs raw alloc/retain/free, uniform <-> dense
section rewrites, proto and final sets (shared or not), freeProto,
freeColumn, aux slots and torus claims with collisions; the main thread
checks refcounts, lost slots, the free stack and the owner table at every
barrier and after teardown.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `8c9fa34` on `dry/sp3a`; 3 files changed, 691 insertions(+), 8 deletions(-)):

Test-only task: every file is under `test/` (`test/harness/nodeWorker.ts`, `test/harness/fuzzWorker.ts`, `test/integration/slabFuzz.test.ts`), so the plan's RED replay of the commit's `test/**` over the parent PASSES (the store it fuzzes is already on the parent). RED as watched during TDD: `slabFuzz.test.ts` written first, over the old harness, fails to import `../harness/fuzzWorker` (1 file failed, no tests). GREEN: typecheck clean; `npm test` 100 files passed, 2 skipped / 1318 passed, 2 skipped (≈47 s). The integration project run 3×: slab fuzz 2470 / 2475 / 2531 ms (whole integration project 17.6 / 18.3 / 19.0 s, load average ≈ 3 on 20 cores, another agent's tests running alongside); in isolation 1.6-1.9 s (seeds 1-5), 2.8 s (seed 6). Pools grew to 3840 block slots (30 growth steps) and 3840 byte slots (15 steps) with seed 1; per thread ≈ 15.8k raw allocs, 5.3k retains, 21k frees, 7.2k claims (870 SlotBusy on the same column, 2.8k collisions), 12k section rewrites (≈ 78k promotions, 15k demotions counted per channel), 4k proto sets, 3k final sets, 8k real shares, 3k freeProto, 7.2k freeColumn, 1.5k aux A, 1.5k aux B, 17k lookups; peak 1,000 raw references per pool and 8 columns.

- Ruling: `buildNodeTaskWorker(dir, {entry?, stamp?})` — `entry` is a path relative to the repository root (default `src/workers/taskHandler.ts`); the entry must export `createTaskHandler()` whose `handle(msg)` returns `{msg, transfer}` (the existing task-handler contract) and must not import `node:` modules: the generated `node-worker.mjs` wrapper keeps owning `parentPort`; the bundle is named `<entry basename>.mjs` (the default stays `taskHandler.mjs`); a missing entry throws — Vite's library build targets the browser, so a harness entry importing `node:worker_threads` would need `ssr`/externals config, and one contract lets Task 11's `regionWorker.ts` (attach/column/done) reuse the wrapper unchanged — cost if wrong: Task 11 adds a raw-entry mode.
- Ruling: barriers are main-thread phases, not `Atomics.wait` barriers: 10 `run` messages of 10k ops per thread, then `teardown`; between phases every thread is idle and the main thread (attached to the same store) checks the whole store — §3.6 says "at each barrier" without fixing the mechanism; the threads still race inside each phase (growth, the pool locks, the shared owner table) — cost if wrong: none (more phases = more checks).
- Ruling: double-allocation detection covers every slot a thread holds, not only raw slots: an Int32 owner table per pool (shared) holds thread + 1; a thread claims the cell by compare-exchange 0 → me when it gets a slot it held no reference to (a raw alloc, or a new dense entry after `setProto`/`setFinal`/`shareFinal`'s light/`aux()`/`auxB()`), and clears it (compare-exchange me → 0, else `ownerMismatches`) before the store call or raw free that drops its last reference; a new dense entry whose slot the thread already held is a double allocation unless the position is a `shareFinal` blocks/fluid share. The thread computes these drops by reading its record's entries before and after each store call (`tracked`) — §3.6's owner table is described for "the slot" of a raw alloc; extending it to descriptor slots catches a store alloc that hands out a held slot (mutation M7 below) — cost if wrong: none (test only).
- Ruling: the expected refcount per slot = the shared per-pool raw-reference counts (Atomics, written by the owning thread) + the entries found by scanning every claimed record of the column table (24 proto blocks/fluid, 24 final blocks/light/fluid, aux A, aux B); the main thread also checks free-stack entries unique with refcount 0, `slotCount − (freeStack + live) = 0`, the lock words 0, and that every live slot's owner cell is set (and equals the record's thread for descriptor slots) — cost if wrong: none.
- Ruling: extra checks beyond §3.6: raw slots carry a stamp (thread, counter) in their first two u16, verified before every retain and free; lookups check the voxel-0 block of a random proto/final section against the value the thread wrote (`dataMismatches`), `neighborhood().versions()` centre = number of commits (−1 before the first), and a fresh aux slot reads all zero (aux slots are dirtied after each use, so recycled slots are tested) — cheap, and they catch a slot reused under a live reference even when the refcounts balance — cost if wrong: none.
- Ruling: torus: thread t uses 12 records (cx ≡ t mod 4: cx = t + 4i, i < 3; cz = j < 4) and 6 columns per record (cx − 64, cx, cx + 64, each at cz and cz + 64); the spec's "cx, cx + 64, …" alone let a mutated `find` that ignored cz pass (mutation M4), so the fuzz varies cz too — cost if wrong: none.
- Ruling: op mix per step (100-way draw): raw ops 40 % (alloc 18, retain 6, free 16; alloc/retain turn into a free at 1,000 live references, a free into an alloc at 0), claim 8 % (with `expectBusy` on a held record: same column → `busy`, other column → `collide`, then `freeColumn` of the holder; at 8 held columns a random one is freed first), single proto-section rewrite 12 %, proto set + `commit(1)` 4 %, final set (per section `shareFinal` or `setFinal`, random) + `commit(2)` 3 %, single final-section rewrite 6 %, `freeProto` 3 %, `freeColumn` 4 %, aux A/B 3 %, lookups of all 6 columns of a record 17 %; dense channels come from 8 pre-drawn random patterns (blocks 0-2, block voxel 0 carries a tag in [3, 4096)), uniform ones from {0, 1, 2} / fluid {0, 0x10, 0x21} / light {0, 0xf0, 0x0f}. The test asserts every counted kind (incl. promote, demote, share, busy, collide, aux B) > 0 on every thread and ≥ 16 block and ≥ 8 byte growth steps — cost if wrong: weights only.
- Ruling: seeds: `Xoshiro128(seed·1000 + thread)`, `seed` from `SLAB_FUZZ_SEED` (default 1), printed in every failure message and in the log line; the interleaving is not reproducible anyway — cost if wrong: none.
- Ruling: verified that the fuzz catches store bugs (scratch mutations, never committed, `git checkout src` after each): M1 `free` pushing without the lock → fails (free of a slot with refcount 0); M2 `shareEntry` without retain → fails; M3 `freeColumn` not releasing aux B → refMismatches 470 after phase 0; M4 `find` ignoring cz → 1,533 wrong lookups (only after the cz variants were added); M5 a lock-free pop fast path in `alloc` → fails; M6 `claim` without the `claimed` compare-exchange → fails; M7 a dense rewrite in place (reusing the old slot) → 103 double allocations — cost if wrong: none.
- Spec defect: §3.6 "at most 5,536 block and 6,336 byte slots are live" → the per-column worst case is 48 block slots (24 proto + 24 final) and 74 byte slots (24 proto fluid, 24 final light, 24 final fluid, aux A, aux B), plus 1 transient slot per thread per pool during a dense rewrite (a new slot is allocated before the old one is freed, Task 6 ruling): 4,000 + 4·(8·48 + 1) = 5,540 block and 4,000 + 4·(8·74 + 1) = 6,372 byte slots, still under 8,192; the 6,336 figure counts 73 byte slots per column (no aux B, which SP3a's T never allocates but the fuzz does). Fix: "at most 5,540 block and 6,372 byte slots".

---

### Task 9: The provisional T stage and the region core

**Spec:** §4, §6.1 core, §6.2

**Files:**
- Create: `src/gen/pipeline/terrainStage.ts`
- Create: `src/metrics/region.ts`
- Modify: `src/world/store/store.ts`
- Modify: `test/arch/banned.test.ts`
- Create: `test/arch/fixtures/banned/bad/src/metrics/region.ts`
- Modify: `test/arch/rules/banned.ts`
- Create: `test/unit/region.test.ts`
- Modify: `test/unit/store.test.ts`
- Create: `test/unit/terrainStage.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/blocks/fluid.ts` (Task 3): `WATER_SOURCE`
  - `src/world/blocks/index.ts` (Task 4): `AIR`, `BEDROCK`, `PASS`, `STONE`
  - `src/world/store/api.ts` (Task 6): `ColumnWriter as ColumnWriterT`
  - `src/world/store/store.ts` (Task 7): `VoxelStore`
- Produces (exports added by this task):
  - `src/gen/pipeline/terrainStage.ts`:
    - `export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriterT, stop: () => boolean): boolean`
  - `src/metrics/region.ts`:
    - `export function fillColumnT(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean, epoch = 0): boolean`
    - `export function genRegionInProcess(store: VoxelStore, ctx: GenContext, cx0: number, cz0: number, w: number, h: number): void`
    - `export function regionHash(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): Hash64`
  - `src/world/store/store.ts`:
    - `export const DEFAULT_PASS: Uint8Array = PASS;`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/banned.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/banned.test.ts b/test/arch/banned.test.ts
index 2cefb66..e57ea60 100644
--- a/test/arch/banned.test.ts
+++ b/test/arch/banned.test.ts
@@ -46,6 +46,9 @@ test('bad fixture tree reports every banned use', () => {
     'src/metrics/crossSection.ts:2 math-member',
     'src/metrics/direct.ts:2 hot-import-reference',
     'src/metrics/liveness.ts:1 math-pow-operator',
+    'src/metrics/region.ts:1 nondeterministic',
+    'src/metrics/region.ts:2 math-member',
+    'src/metrics/region.ts:3 math-pow-operator',
     'src/metrics/sp1Goldens.ts:1 nondeterministic',
     'src/metrics/sp1Goldens.ts:2 math-pow-operator',
     'src/metrics/sp2aGoldens.ts:1 nondeterministic',
```

Create `test/arch/fixtures/banned/bad/src/metrics/region.ts`:

```ts
export const stamp = (): number => performance.now();
export const length = (dx: number, dz: number): number => Math.hypot(dx, dz);
export const cube = (v: number): number => v ** 3;
```

Create `test/unit/region.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
import type { GenContext } from '../../src/gen/context';
import { fillColumnT, genRegionInProcess, regionHash } from '../../src/metrics/region';
import { torusSlot as torusSlotOf } from '../../src/core/coords';
import { protoAt, REC_AUX_A, REC_BLOCK_VERSION, REC_CLAIMED, REC_EPOCH, STATUS_PROTO } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, SlotBusy, StoreFull, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;
const ctx = ctxFor('42');
const newStore = (shared = false): VoxelStore => createStore({ shared, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });

/** Free-stack size and slot count of both pools. */
const slots = (s: VoxelStore) => [s.blockPool.freeCount(), s.blockPool.slotCount(), s.bytePool.freeCount(), s.bytePool.slotCount()];

/**
 * The §6.2 byte stream built by hand from the voxel and aux reads (no section views), then hashed in one go:
 * pins the order, the little-endian u16s, the uniform expansion and the aux bytes.
 */
function referenceHash(s: VoxelStore, cx0: number, cz0: number, w: number, h: number): string {
  const per = 24 * (8192 + 4096) + 4096;
  const out = new Uint8Array(w * h * per);
  let o = 0;
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = s.proto(cx, cz)!;
      for (let sy = 0; sy < 24; sy++) {
        for (let i = 0; i < 4096; i++) {
          const b = v.block(i & 15, -64 + 16 * sy + (i >> 8), (i >> 4) & 15);
          out[o++] = b & 255;
          out[o++] = b >> 8;
        }
        for (let i = 0; i < 4096; i++) out[o++] = v.fluid(i & 15, -64 + 16 * sy + (i >> 8), (i >> 4) & 15);
      }
      const a = v.aux()!;
      const i16 = (arr: Int16Array) => { for (const x of arr) { out[o++] = x & 255; out[o++] = (x >> 8) & 255; } };
      i16(a.worldSurfaceWG); i16(a.oceanFloorWG); i16(a.worldSurface); i16(a.motionBlocking); i16(a.oceanFloor); i16(a.lightBlocking);
      for (const x of a.surfaceBiome) out[o++] = x;
      for (const x of a.tintTH) out[o++] = x;
    }
  }
  expect(o).toBe(out.length);
  return hex64(fnv1a64Bytes(out));
}

/** Generates the region's columns in the given order (cx, cz pairs). */
function genInOrder(s: VoxelStore, c: GenContext, cols: ReadonlyArray<readonly [number, number]>): void {
  for (const [cx, cz] of cols) expect(fillColumnT(s, c, cx, cz, NEVER)).toBe(true);
}

const rowMajor = (cx0: number, cz0: number, w: number, h: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let cz = cz0; cz < cz0 + h; cz++) for (let cx = cx0; cx < cx0 + w; cx++) out.push([cx, cz]);
  return out;
};

describe('fillColumnT (§4, §6.1)', () => {
  test('claims with the epoch, commits at status Proto (blockVersion 1)', () => {
    const s = newStore();
    expect(fillColumnT(s, ctx, 5, -7, NEVER, 9)).toBe(true);
    const base = s.table.find(5, -7);
    expect([s.table.status(base), s.table.ints[base + REC_EPOCH], s.table.ints[base + REC_BLOCK_VERSION]]).toEqual([STATUS_PROTO, 9, 1]);
    expect(s.proto(5, -7)).not.toBeNull();
    expect(s.final(5, -7)).toBeNull();
  });

  test('epoch defaults to 0; a held record throws SlotBusy', () => {
    const s = newStore();
    fillColumnT(s, ctx, 0, 0, NEVER);
    expect(s.table.ints[s.table.find(0, 0) + REC_EPOCH]).toBe(0);
    expect(() => fillColumnT(s, ctx, 0, 0, NEVER)).toThrow(SlotBusy);
    expect(() => fillColumnT(s, ctx, 64, 0, NEVER)).toThrow(SlotBusy);
  });

  test.each([0, 3, 12, 23])('abort before section %i: false, the record is free and no slot leaks', (k) => {
    const s = newStore();
    // Warm both pools with a whole column, so the snapshot covers the slots the aborted column takes.
    fillColumnT(s, ctx, 2, 2, NEVER);
    s.freeColumn(2, 2);
    const before = slots(s);
    expect(before[0]).toBe(before[1]);
    let polls = 0;
    expect(fillColumnT(s, ctx, 2, 2, () => ++polls > k, 4)).toBe(false);
    expect(slots(s)).toEqual(before);
    expect(s.table.find(2, 2)).toBe(-1);
    expect(s.proto(2, 2)).toBeNull();
    const rec = (2 + 64 * 2) * 160;
    expect(s.table.ints[rec + REC_CLAIMED]).toBe(0);
    // The record can be claimed again.
    expect(fillColumnT(s, ctx, 2, 2, NEVER)).toBe(true);
  });

  test('a stage that throws frees the column and rethrows', () => {
    const s = newStore();
    fillColumnT(s, ctx, 1, 1, NEVER);
    s.freeColumn(1, 1);
    const before = slots(s);
    let polls = 0;
    expect(() => fillColumnT(s, ctx, 1, 1, () => { if (++polls > 5) throw new Error('boom'); return false; })).toThrow('boom');
    expect(slots(s)).toEqual(before);
    expect(s.table.find(1, 1)).toBe(-1);
  });

  test.each([
    ['block', MiB, 16 * MiB],
    ['byte', 16 * MiB, MiB],
  ] as const)('the %s pool full in the middle of a column: StoreFull surfaces, the column is freed, no slot leaks', (_pool, maxBlockBytes, maxByteBytes) => {
    const s = createStore({ shared: false, maxBlockBytes, maxByteBytes });
    // Fill a 64 × 64 window column by column (one column per torus record) until a pool runs out.
    const filled: Array<[number, number]> = [];
    let failed: [number, number] | null = null;
    let error: unknown = null;
    outer: for (let cz = -2000; cz < -1936; cz++) {
      for (let cx = -2000; cx < -1936; cx++) {
        try {
          expect(fillColumnT(s, ctx, cx, cz, NEVER)).toBe(true);
          filled.push([cx, cz]);
        } catch (e) {
          failed = [cx, cz];
          error = e;
          break outer;
        }
      }
    }
    expect(error).toBeInstanceOf(StoreFull);
    expect(filled.length).toBeGreaterThan(0);
    const [fx, fz] = failed!;
    // The failed column is gone and its record free; the committed columns are intact.
    expect([s.table.find(fx, fz), s.proto(fx, fz)]).toEqual([-1, null]);
    expect(s.table.ints[torusSlotOf(fx, fz) * 160 + REC_CLAIMED]).toBe(0);
    // Live slots are exactly the committed columns' dense entries and aux slots: the half-written column left none.
    let blocks = 0;
    let bytes = 0;
    for (const [cx, cz] of filled) {
      const base = s.table.find(cx, cz);
      for (let sy = 0; sy < 24; sy++) {
        if (s.table.ints[protoAt(base, sy) + PROTO_BLOCKS]! >= 0) blocks++;
        if (s.table.ints[protoAt(base, sy) + PROTO_FLUID]! >= 0) bytes++;
      }
      if (s.table.ints[base + REC_AUX_A]! >= 0) bytes++;
    }
    expect([s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()]).toEqual([blocks, bytes]);
    // The store stays usable: once columns are freed, the failed column fills and equals a fresh fill.
    for (const [cx, cz] of filled) s.freeColumn(cx, cz);
    expect([s.blockPool.freeCount(), s.bytePool.freeCount()]).toEqual([s.blockPool.slotCount(), s.bytePool.slotCount()]);
    expect(fillColumnT(s, ctx, fx, fz, NEVER)).toBe(true);
    const fresh = newStore();
    fillColumnT(fresh, ctx, fx, fz, NEVER);
    expect(regionHash(s, fx, fz, 1, 1)).toEqual(regionHash(fresh, fx, fz, 1, 1));
  });
});

describe('genRegionInProcess (§6.1)', () => {
  test('fills every column of the region at status Proto', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, -2, 3, 3, 2);
    for (const [cx, cz] of rowMajor(-2, 3, 3, 2)) expect(s.table.status(s.table.find(cx, cz))).toBe(STATUS_PROTO);
    expect(s.proto(1, 3)).toBeNull();
    expect(s.proto(-2, 5)).toBeNull();
  });

  test.each([[0, 1], [1, 0], [65, 1], [1, 65], [1.5, 1], [-1, 2]])('w = %s, h = %s is refused', (w, h) => {
    expect(() => genRegionInProcess(newStore(), ctx, 0, 0, w, h)).toThrow(RangeError);
  });

  test('64 columns wide fit the torus', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, -32, 0, 64, 1);
    expect(s.proto(31, 0)).not.toBeNull();
  });
});

describe('regionHash (§6.2)', () => {
  // Across a coast: sea, land and uniform water sections (see terrainStage.test.ts).
  const CX0 = -1668, CZ0 = -2001;

  // The deep-sea window holds uniform water sections (fluid −1 − 16) as well as dense and uniform-air ones.
  test.each([
    ['coast', CX0, CZ0, 3, 2], ['deep sea', -2000, -2000, 2, 1],
  ] as const)('%s: equals FNV-1a 64 over the §6.2 byte stream', (_name, cx0, cz0, w, h) => {
    const s = newStore();
    genRegionInProcess(s, ctx, cx0, cz0, w, h);
    expect(hex64(regionHash(s, cx0, cz0, w, h))).toBe(referenceHash(s, cx0, cz0, w, h));
  });

  test('independent of backend, generation order and slot layout', () => {
    const a = newStore(false);
    genRegionInProcess(a, ctx, CX0, CZ0, 3, 3);
    const want = regionHash(a, CX0, CZ0, 3, 3);
    const b = newStore(true);
    genRegionInProcess(b, ctx, CX0, CZ0, 3, 3);
    expect(regionHash(b, CX0, CZ0, 3, 3)).toEqual(want);
    // Reversed order on a store whose pools hold scattered live slots first.
    const c = newStore(false);
    const held = [] as number[];
    for (let i = 0; i < 200; i++) held.push(c.blockPool.alloc(), c.bytePool.alloc());
    for (let i = 0; i < held.length; i += 3) (i % 2 === 0 ? c.blockPool : c.bytePool).free(held[i]!);
    genInOrder(c, ctx, rowMajor(CX0, CZ0, 3, 3).reverse());
    expect(regionHash(c, CX0, CZ0, 3, 3)).toEqual(want);
  });

  test('a sub-window hashes as the same window generated alone', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, CX0, CZ0, 4, 4);
    const alone = newStore();
    genRegionInProcess(alone, ctx, CX0 + 1, CZ0 + 2, 2, 2);
    expect(regionHash(s, CX0 + 1, CZ0 + 2, 2, 2)).toEqual(regionHash(alone, CX0 + 1, CZ0 + 2, 2, 2));
    expect(regionHash(s, CX0, CZ0, 1, 1)).toEqual(regionHash(s, CX0, CZ0, 1, 1));
    expect(regionHash(s, CX0, CZ0, 4, 4)).not.toEqual(regionHash(s, CX0 + 1, CZ0 + 2, 2, 2));
  });

  test('depends on the world: another seed gives another hash', () => {
    const a = newStore();
    genRegionInProcess(a, ctx, 0, 0, 2, 2);
    const b = newStore();
    genRegionInProcess(b, ctxFor('43'), 0, 0, 2, 2);
    expect(regionHash(a, 0, 0, 2, 2)).not.toEqual(regionHash(b, 0, 0, 2, 2));
  });

  test('a column outside the generated region throws; bad sizes are refused', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, 0, 0, 2, 2);
    expect(() => regionHash(s, 0, 0, 3, 2)).toThrow(/column \(2, 0\)/);
    expect(() => regionHash(s, 0, 0, 0, 2)).toThrow(RangeError);
  });
});
```

Modify `test/unit/store.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/store.test.ts b/test/unit/store.test.ts
index f75c5f6..4037158 100644
--- a/test/unit/store.test.ts
+++ b/test/unit/store.test.ts
@@ -3,6 +3,7 @@ import { fileURLToPath, pathToFileURL } from 'node:url';
 import { mkdirSync } from 'node:fs';
 import { build } from 'vite';
 import { afterAll, describe, expect, test } from 'vitest';
+import { PASS } from '../../src/world/blocks/index';
 import { AUX_A_OFFSETS, AUX_B_OFFSETS } from '../../src/world/store/aux';
 import {
   finalAt, NO_COLUMN, protoAt, RECORD_COUNT, RECORD_INTS, REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED,
@@ -244,6 +245,8 @@ describe.each([true, false])('shared %s', (shared) => {
     expect(DEFAULT_PASS[0]).toBe(0);
     expect(DEFAULT_PASS[1]).toBe(1);
     expect(DEFAULT_PASS[2]).toBe(1);
+    // The default is the registry's own PASS table, so appended states (SP3b) get their pass bits.
+    expect(DEFAULT_PASS).toBe(PASS);
     expect(() => createStore({ shared, pass: new Uint8Array(10) })).toThrow(RangeError);
   });
 
```

Create `test/unit/terrainStage.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, readLevel, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, COLLIDE, STONE } from '../../src/world/blocks/index';
import type { AuxBView, AuxView, ColumnView, ColumnWriter } from '../../src/world/store/api';
import { protoAt, REC_AUX_B } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;

/**
 * Columns of world seed '42' (default profile) found by a scan: every position of LAND is dry, every position of
 * SEA is open ocean, LAKE lies inside one lake, RIVER crosses a wet river channel next to dry land, COAST mixes sea
 * and land. The category tests below re-derive the categories, so a world change fails loudly here.
 */
const LAND = [-1963, -2000] as const;
const SEA = [-2000, -2000] as const;
const LAKE = [-1001, -2000] as const;
const RIVER = [-742, -2000] as const;
const COAST = [-1667, -2000] as const;

type Kind = 'land' | 'sea' | 'lake' | 'river';

interface Expected { top: Int32Array; swl: Float64Array; kinds: Kind[]; biome: Uint8Array }

/** The §4 inputs per position `lz·16 + lx`, read from the ColumnSample independently of the stage. */
function expectedOf(ctx: GenContext, cx: number, cz: number): Expected {
  const s: ColumnSample = buildColumnSample(ctx, cx, cz, newColumnSample());
  const top = new Int32Array(256);
  const swl = new Float64Array(256);
  const biome = new Uint8Array(256);
  const kinds: Kind[] = [];
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = 16 * cx + lx;
      const z = 16 * cz + lz;
      const p = lz * 16 + lx;
      top[p] = Math.floor(readField(s, 'surfaceEst', x, z));
      swl[p] = readLevel(s, 'surfaceWaterLevel', x, z);
      biome[p] = readBiome(s, ctx, x, z);
      // The nearest quart corner, as readLevel picks it.
      const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
      const wet = (s.flags[k]! & 1) !== 0;
      if (swl[p] === -Infinity) kinds.push('land');
      else if (s.f.lakeMask[k] === 1) kinds.push('lake');
      else if (wet) kinds.push('river');
      else kinds.push('sea');
    }
  }
  return { top, swl, kinds, biome };
}

/** §4's fill rule. */
const blockAt = (top: number, y: number): number => (y === -64 ? BEDROCK : y <= top ? STONE : AIR);
const fluidAt = (top: number, swl: number, y: number): number => (y !== -64 && y > top && y <= swl ? WATER_SOURCE : 0);

function generate(ctx: GenContext, cx: number, cz: number, store: VoxelStore = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB })): { store: VoxelStore; view: ColumnView } {
  const w = store.claimColumn(cx, cz, 0);
  expect(terrainStage(ctx, cx, cz, w, NEVER)).toBe(true);
  w.commit(1);
  return { store, view: store.proto(cx, cz)! };
}

const ctx = ctxFor('42');

describe('fill rule (§4)', () => {
  test.each([
    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST],
  ] as const)('%s column: every voxel follows the rule', (_name, [cx, cz]) => {
    const e = expectedOf(ctx, cx, cz);
    const { view } = generate(ctx, cx, cz);
    let bad = 0;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const p = lz * 16 + lx;
        for (let y = -64; y <= 319; y++) {
          if (view.block(lx, y, lz) !== blockAt(e.top[p]!, y) || view.fluid(lx, y, lz) !== fluidAt(e.top[p]!, e.swl[p]!, y)) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  test('land: dry everywhere, stone up to ⌊surfaceEst⌋, air above', () => {
    const [cx, cz] = LAND;
    const e = expectedOf(ctx, cx, cz);
    expect(new Set(e.kinds)).toEqual(new Set(['land']));
    const { view } = generate(ctx, cx, cz);
    for (const p of [0, 17, 255]) {
      const lx = p & 15, lz = p >> 4, t = e.top[p]!;
      expect([view.block(lx, -64, lz), view.block(lx, t, lz), view.block(lx, t + 1, lz)]).toEqual([BEDROCK, STONE, AIR]);
      expect(view.fluid(lx, t + 1, lz)).toBe(0);
    }
  });

  test('sea: water sources from ⌊surfaceEst⌋ + 1 up to sea level 63, air above', () => {
    const [cx, cz] = SEA;
    const e = expectedOf(ctx, cx, cz);
    expect(new Set(e.kinds)).toEqual(new Set(['sea']));
    const { view } = generate(ctx, cx, cz);
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4, t = e.top[p]!;
      expect(e.swl[p]).toBe(63);
      expect(t).toBeLessThan(63);
      expect([view.block(lx, t, lz), view.fluid(lx, t, lz)]).toEqual([t === -64 ? BEDROCK : STONE, 0]);
      expect([view.block(lx, t + 1, lz), view.fluid(lx, t + 1, lz)]).toEqual([AIR, WATER_SOURCE]);
      expect([view.block(lx, 63, lz), view.fluid(lx, 63, lz)]).toEqual([AIR, WATER_SOURCE]);
      expect([view.block(lx, 64, lz), view.fluid(lx, 64, lz)]).toEqual([AIR, 0]);
    }
  });

  test('lake: water up to the lake level (not sea level), dry land outside', () => {
    const [cx, cz] = LAKE;
    const e = expectedOf(ctx, cx, cz);
    expect(e.kinds.every((k) => k === 'lake')).toBe(true);
    const { view } = generate(ctx, cx, cz);
    let wetCells = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4, t = e.top[p]!, w = Math.floor(e.swl[p]!);
      expect(w).not.toBe(63);
      if (w <= t) continue;
      wetCells++;
      expect(view.fluid(lx, w, lz)).toBe(WATER_SOURCE);
      expect(view.fluid(lx, w + 1, lz)).toBe(0);
    }
    expect(wetCells).toBeGreaterThan(0);
  });

  test('river: wet channel positions hold water up to 63, beside dry land', () => {
    const [cx, cz] = RIVER;
    const e = expectedOf(ctx, cx, cz);
    expect(e.kinds).toContain('land');
    const { view } = generate(ctx, cx, cz);
    let channel = 0;
    for (let p = 0; p < 256; p++) {
      if (e.kinds[p] !== 'river' || e.top[p]! >= 63) continue;
      channel++;
      const lx = p & 15, lz = p >> 4;
      expect([view.fluid(lx, 63, lz), view.fluid(lx, 64, lz), view.fluid(lx, e.top[p]!, lz)]).toEqual([WATER_SOURCE, 0, 0]);
    }
    expect(channel).toBeGreaterThan(0);
  });
});

describe('aux A (§3.4, §4)', () => {
  test.each([
    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST],
  ] as const)('%s: heightmaps by the §3.4 predicates, surfaceBiome = the zoomed biome, other fields 0', (_name, [cx, cz]) => {
    const e = expectedOf(ctx, cx, cz);
    const { store, view } = generate(ctx, cx, cz);
    const aux = view.aux()!;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      let ws = -64, of = -64;
      for (let y = 319; y >= -64 && (ws === -64 || of === -64); y--) {
        const b = view.block(lx, y, lz);
        if (ws === -64 && (b !== AIR || fluidType(view.fluid(lx, y, lz)) !== 0)) ws = y + 1;
        if (of === -64 && COLLIDE[b] !== 0) of = y + 1;
      }
      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([ws, of]);
      // §4: land both ⌊surfaceEst⌋ + 1; under water the top water y + 1 and ⌊surfaceEst⌋ + 1.
      const t = e.top[p]!;
      const wet = Math.floor(e.swl[p]!) > t;
      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([wet ? Math.floor(e.swl[p]!) + 1 : t + 1, t + 1]);
      expect(aux.surfaceBiome[p]).toBe(e.biome[p]);
    }
    for (const f of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking', 'tintTH'] as const) {
      expect(aux[f].every((v) => v === 0)).toBe(true);
    }
    expect(store.table.ints[store.table.find(cx, cz) + REC_AUX_B]).toBe(-1);
  });
});

describe('sections (§4: each channel uniform or dense)', () => {
  test.each([
    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['coast', COAST],
  ] as const)('%s: a channel is uniform exactly when all its 4096 values are equal', (_name, [cx, cz]) => {
    const e = expectedOf(ctx, cx, cz);
    const { store } = generate(ctx, cx, cz);
    const base = store.table.find(cx, cz);
    const ints = store.table.ints;
    let uniformBlocks = 0, uniformFluid = 0;
    for (let sy = 0; sy < 24; sy++) {
      const blocks = new Set<number>();
      const fluid = new Set<number>();
      for (let ly = 0; ly < 16; ly++) {
        const y = -64 + 16 * sy + ly;
        for (let p = 0; p < 256; p++) {
          blocks.add(blockAt(e.top[p]!, y));
          fluid.add(fluidAt(e.top[p]!, e.swl[p]!, y));
        }
      }
      const b = ints[protoAt(base, sy) + PROTO_BLOCKS]!;
      const f = ints[protoAt(base, sy) + PROTO_FLUID]!;
      if (blocks.size === 1) { uniformBlocks++; expect(b).toBe(-1 - [...blocks][0]!); } else expect(b).toBeGreaterThanOrEqual(0);
      if (fluid.size === 1) { uniformFluid++; expect(f).toBe(-1 - [...fluid][0]!); } else expect(f).toBeGreaterThanOrEqual(0);
    }
    // Section 0 holds bedrock and stone (dense); the top section is uniform air without fluid.
    expect(ints[protoAt(base, 0) + PROTO_BLOCKS]).toBeGreaterThanOrEqual(0);
    expect([ints[protoAt(base, 23) + PROTO_BLOCKS], ints[protoAt(base, 23) + PROTO_FLUID]]).toEqual([-1, -1]);
    expect(uniformBlocks).toBeGreaterThan(10);
    expect(uniformFluid).toBeGreaterThan(10);
  });

  test('a full stone section costs no slot (uniform stone, −1 − STONE)', () => {
    const [cx, cz] = LAND;
    const { store } = generate(ctx, cx, cz);
    expect(store.table.ints[protoAt(store.table.find(cx, cz), 1) + PROTO_BLOCKS]).toBe(-1 - STONE);
  });

  test('a full water section of the deep sea costs no slot (air, uniform fluid −1 − WATER_SOURCE)', () => {
    const [cx, cz] = SEA;
    const { store } = generate(ctx, cx, cz);
    const at = protoAt(store.table.find(cx, cz), 7);
    expect([store.table.ints[at + PROTO_BLOCKS], store.table.ints[at + PROTO_FLUID]]).toEqual([-1 - AIR, -1 - WATER_SOURCE]);
  });
});

/** A writer that records the calls (no store). */
function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; commits: number } {
  const log = { sections: [] as number[], aux: 0, commits: 0 };
  const auxView: AuxView = {
    worldSurfaceWG: new Int16Array(256), oceanFloorWG: new Int16Array(256), worldSurface: new Int16Array(256),
    motionBlocking: new Int16Array(256), oceanFloor: new Int16Array(256), lightBlocking: new Int16Array(256),
    surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
  };
  const w: ColumnWriter = {
    cx: 0, cz: 0,
    setProto(sy, blocks, fluid) {
      expect([blocks.length, fluid.length]).toEqual([4096, 4096]);
      log.sections.push(sy);
    },
    setFinal() { throw new Error('the T stage writes no final set'); },
    shareFinal() { throw new Error('the T stage writes no final set'); },
    aux() { log.aux++; return auxView; },
    auxB(): AuxBView { throw new Error('SP3a allocates no aux B'); },
    commit() { log.commits++; },
  };
  return { w, get sections() { return log.sections; }, get aux() { return log.aux; }, get commits() { return log.commits; } };
}

describe('order and abort (§4)', () => {
  test('sections 0 … 23 in order, stop polled once before each, then aux; the stage never commits', () => {
    const spy = spyWriter();
    let polls = 0;
    expect(terrainStage(ctx, 3, -2, spy.w, () => { polls++; return false; })).toBe(true);
    expect(spy.sections).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(polls).toBe(24);
    expect([spy.aux, spy.commits]).toEqual([1, 0]);
  });

  test.each([0, 1, 7, 23])('stop true before section %i: returns false at once, no aux, no commit', (k) => {
    const spy = spyWriter();
    let polls = 0;
    expect(terrainStage(ctx, 3, -2, spy.w, () => ++polls > k)).toBe(false);
    expect(spy.sections).toEqual(Array.from({ length: k }, (_, i) => i));
    expect(polls).toBe(k + 1);
    expect([spy.aux, spy.commits]).toEqual([0, 0]);
  });

  test('deterministic: the same column twice gives the same voxels and aux', () => {
    const a = generate(ctx, ...COAST).view;
    const b = generate(ctx, ...COAST).view;
    for (let sy = 0; sy < 24; sy++) {
      expect(a.sectionBlocks(sy)).toEqual(b.sectionBlocks(sy));
      expect(a.sectionFluid(sy)).toEqual(b.sectionFluid(sy));
    }
    expect(Array.from(a.aux()!.worldSurfaceWG)).toEqual(Array.from(b.aux()!.worldSurfaceWG));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/banned.test.ts test/unit/region.test.ts test/unit/store.test.ts test/unit/terrainStage.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× bad fixture tree reports every banned use 25ms
× meta uses the store's PASS table 180ms
FAIL  |unit| test/unit/region.test.ts [ test/unit/region.test.ts ]
Error: Cannot find module '../../src/metrics/region' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/region.test.ts
FAIL  |unit| test/unit/terrainStage.test.ts [ test/unit/terrainStage.test.ts ]
Error: Cannot find module '../../src/gen/pipeline/terrainStage' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/terrainStage.test.ts
FAIL  |unit| test/unit/store.test.ts > shared true > meta uses the store's PASS table
FAIL  |unit| test/unit/store.test.ts > shared false > meta uses the store's PASS table
AssertionError: expected Uint8Array[ 0, 1, 1, 1, 1, 1, 1, …(4096) ] to be Uint8Array[ 0, 1, 1, 0, 0, 0, 0, …(4097) ] // Object.is equality
FAIL  |arch| test/arch/banned.test.ts > bad fixture tree reports every banned use
AssertionError: expected [ …(55) ] to deeply equal [ …(58) ]
Test Files  4 failed (4)
Tests  3 failed | 68 passed (71)
```

- [ ] **Step 3: Implement**

Create `src/gen/pipeline/terrainStage.ts`:

```ts
/**
 * The provisional T stage (SP3a spec §4): fills a column's proto set from today's 2D world, through the store API.
 * Per block position, from the column's ColumnSample: `surfaceEst` (still `offset`, bilinear readout) and
 * `surfaceWaterLevel` (nearest-corner readout). From the bottom: y = −64 bedrock; y ≤ ⌊surfaceEst⌋ stone;
 * ⌊surfaceEst⌋ < y ≤ surfaceWaterLevel air with a water source; above, air. This is master §10's v0 water rule in
 * a world without overhangs. Sections 0 … 23 go to `setProto` in order (the store keeps each channel uniform or
 * dense); `stop()` is polled before each section and on true the stage returns false at once, without aux.
 * Then aux A: `worldSurfaceWG`, `oceanFloorWG` (§3.4 predicates) and `surfaceBiome` (the zoomed biome). SP3b
 * replaces this fill with the density terrain.
 */
import { MIN_Y } from '../../core/constants';
import { WATER_SOURCE } from '../../world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../world/blocks/index';
import type { ColumnWriter as ColumnWriterT } from '../../world/store/api';
import { buildColumnSample, newColumnSample, readBiome, readField, readLevel } from '../column/columnStage';
import type { GenContext } from '../context';

const Y0 = MIN_Y;
const WATER = WATER_SOURCE;
const AIR_ = AIR;
const STONE_ = STONE;
const BEDROCK_ = BEDROCK;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const FIELD = readField;
const LEVEL = readLevel;
const BIOME = readBiome;

/** Highest y of the world (MIN_Y + 384 − 1); tops are clamped to [Y0 − 1, TOP_Y], which changes no comparison. */
const TOP_Y = Y0 + 383;

const SAMPLE = NEW_SAMPLE();
/** Per column index `lz·16 + lx`: ⌊surfaceEst⌋ and ⌊surfaceWaterLevel⌋, clamped (−∞ becomes Y0 − 1). */
const SOLID_TOP = new Int32Array(256);
const WATER_TOP = new Int32Array(256);
const BLOCKS = new Uint16Array(4096);
const FLUID = new Uint8Array(4096);

const clampY = (v: number): number => Math.min(TOP_Y, Math.max(Y0 - 1, v));

/**
 * Writes column (cx, cz)'s proto sections and aux A through `w`; false (nothing more written) as soon as `stop()`
 * returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
 */
export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriterT, stop: () => boolean): boolean {
  const s = BUILD(ctx, cx, cz, SAMPLE);
  const x0 = 16 * cx;
  const z0 = 16 * cz;
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const p = (lz << 4) | lx;
      SOLID_TOP[p] = clampY(Math.floor(FIELD(s, 'surfaceEst', x0 + lx, z0 + lz)));
      WATER_TOP[p] = clampY(Math.floor(LEVEL(s, 'surfaceWaterLevel', x0 + lx, z0 + lz)));
    }
  }
  for (let sy = 0; sy < 24; sy++) {
    if (stop()) return false;
    const yBase = Y0 + 16 * sy;
    for (let ly = 0; ly < 16; ly++) {
      const y = yBase + ly;
      const row = ly << 8;
      for (let p = 0; p < 256; p++) {
        const i = row | p;
        if (y === Y0) {
          BLOCKS[i] = BEDROCK_;
          FLUID[i] = 0;
        } else if (y <= SOLID_TOP[p]!) {
          BLOCKS[i] = STONE_;
          FLUID[i] = 0;
        } else {
          BLOCKS[i] = AIR_;
          FLUID[i] = y <= WATER_TOP[p]! ? WATER : 0;
        }
      }
    }
    w.setProto(sy, BLOCKS, FLUID);
  }
  const aux = w.aux();
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const p = (lz << 4) | lx;
      // Bedrock at Y0 is non-air and collides, so neither map is ever below Y0 + 1.
      const floor = Math.max(Y0, SOLID_TOP[p]!);
      aux.oceanFloorWG[p] = floor + 1;
      aux.worldSurfaceWG[p] = Math.max(floor, WATER_TOP[p]!) + 1;
      aux.surfaceBiome[p] = BIOME(s, ctx, x0 + lx, z0 + lz);
    }
  }
  return true;
}
```

Create `src/metrics/region.ts`:

```ts
/**
 * The region core (SP3a spec §6.1, §6.2), shared by the goldens, the slice job and the test harness (`src` never
 * imports `test/`): `fillColumnT` runs the provisional T stage on one claimed column, `genRegionInProcess` fills a
 * region in process, and `regionHash` digests any generated window. Follows the core determinism rules
 * (in `DET_FILES`, arch-tested).
 */
import { createFnv64, type Fnv64 as Fnv64T, type Hash64 } from '../core/hash';
import type { GenContext } from '../gen/context';
import { terrainStage } from '../gen/pipeline/terrainStage';
import type { VoxelStore } from '../world/store/store';

const CREATE_FNV = createFnv64;
const TERRAIN = terrainStage;

const NEVER = (): boolean => false;
/** Dense block sections are hashed through a byte view of their slot when the platform is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** A region (or window) is 1 … 64 columns per side: a larger one would collide on the 64 × 64 torus. */
function checkRegion(what: string, w: number, h: number): void {
  for (const [name, v] of [['w', w], ['h', h]] as const) {
    if ((v | 0) !== v || v < 1 || v > 64) throw new RangeError(`${what}: ${name} = ${v} outside 1 … 64`);
  }
}

/**
 * Claims (cx, cz) with `epoch`, runs the provisional T stage and commits it at status Proto; when `stop()` fires
 * (or the stage throws) it frees the column instead, which releases the sections already written and leaves the
 * record free. True when the column was committed. Throws `SlotBusy` when the record is held.
 */
export function fillColumnT(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean, epoch = 0): boolean {
  const w = store.claimColumn(cx, cz, epoch);
  let done: boolean;
  try {
    done = TERRAIN(ctx, cx, cz, w, stop);
  } catch (e) {
    store.freeColumn(cx, cz);
    throw e;
  }
  if (done) w.commit(1);
  else store.freeColumn(cx, cz);
  return done;
}

/** `fillColumnT` (never stopped, epoch 0) for every column of the w × h region at (cx0, cz0), cz outer, cx inner. */
export function genRegionInProcess(store: VoxelStore, ctx: GenContext, cx0: number, cz0: number, w: number, h: number): void {
  checkRegion('genRegionInProcess', w, h);
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) fillColumnT(store, ctx, cx, cz, NEVER);
  }
}

function hashWords(fnv: Fnv64T, a: Uint16Array): void {
  if (LITTLE_ENDIAN) {
    fnv.update(new Uint8Array(a.buffer, a.byteOffset, 2 * a.length));
    return;
  }
  for (let i = 0; i < a.length; i++) fnv.updateU16LE(a[i]!);
}

/**
 * FNV-1a 64 of the w × h window at (cx0, cz0) (SP3a spec §6.2): cz outer, cx inner; per column, for sy 0 … 23 the
 * 4096 proto block states (u16 little-endian, voxel-index order) then the 4096 proto fluid bytes (uniform sections
 * expanded, "no fluid" as 0), then the column's 4096 aux A bytes (zeros when it has none). Independent of
 * generation order, thread count, backend and slot layout. Throws when a column of the window is not at
 * status ≥ Proto.
 */
export function regionHash(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): Hash64 {
  checkRegion('regionHash', w, h);
  const fnv = CREATE_FNV();
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = store.proto(cx, cz);
      if (v === null) throw new Error(`regionHash: column (${cx}, ${cz}) has no proto set in the store`);
      for (let sy = 0; sy < 24; sy++) {
        const b = v.sectionBlocks(sy);
        if (typeof b === 'number') fnv.updateRepeatU16LE(b, 4096);
        else hashWords(fnv, b);
        const f = v.sectionFluid(sy);
        if (typeof f === 'number') fnv.updateRepeatU8(f, 4096);
        else fnv.update(f);
      }
      const a = v.aux();
      // The aux A fields tile the 4096-byte slot from worldSurfaceWG (offset 0) on; Int16 values are native LE.
      if (a === null) fnv.updateRepeatU8(0, 4096);
      else fnv.update(new Uint8Array(a.worldSurfaceWG.buffer, a.worldSurfaceWG.byteOffset, 4096));
    }
  }
  return fnv.digest();
}
```

Modify `src/world/store/store.ts` (apply with `git apply`):

```diff
diff --git a/src/world/store/store.ts b/src/world/store/store.ts
index 3b324cc..a785717 100644
--- a/src/world/store/store.ts
+++ b/src/world/store/store.ts
@@ -8,6 +8,7 @@
  * `proto`/`final` read it once its status allows; `freeProto` releases the proto set; `freeColumn` releases every
  * reference the record holds and frees the record. `gen` imports only the types of `api.ts`, never this file.
  */
+import { PASS } from '../blocks/index';
 import type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, NeighborhoodReader } from './api';
 import { allocAux, auxBView, auxView } from './aux';
 import {
@@ -32,12 +33,10 @@ export type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, Neighbo
 const STATE_TABLE_SIZE = 4096;
 
 /**
- * The `PASS` table the store uses for meta when none is given: state 0 (air) none, every other state opaque — the
- * `PASS` column of the SP3a registry (air, stone, bedrock). The registry lives in `world/blocks`; once both are
- * on one branch, callers that append non-opaque states pass the registry's `PASS`.
+ * The `PASS` table the store uses for meta when none is given: the block registry's own (`world/blocks`), so states
+ * appended later (SP3b's terrain palette) get their pass bits without a store change. Never written.
  */
-export const DEFAULT_PASS: Uint8Array = new Uint8Array(STATE_TABLE_SIZE).fill(1);
-DEFAULT_PASS[0] = 0;
+export const DEFAULT_PASS: Uint8Array = PASS;
 
 export interface StoreOptions {
   readonly shared: boolean;
```

Modify `test/arch/rules/banned.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/rules/banned.ts b/test/arch/rules/banned.ts
index 72a7fce..0a21136 100644
--- a/test/arch/rules/banned.ts
+++ b/test/arch/rules/banned.ts
@@ -10,10 +10,11 @@ const PURE_LAYERS = new Set(['core', 'world', 'gen', 'textures', 'audio', 'light
 const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'imul', 'clz32', 'sqrt',
   'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
 /**
- * Files outside core/ and gen/ that follow the core determinism rules: the golden digests (SP1 spec §1.8) and the
- * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4).
+ * Files outside core/ and gen/ that follow the core determinism rules: the golden digests (SP1 spec §1.8), the
+ * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4) and the SP3a region core (SP3a spec §6.1).
  */
-const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts', 'metrics/biomeShares.ts', 'metrics/liveness.ts', 'metrics/splineStats.ts', 'metrics/crossSection.ts']);
+const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts', 'metrics/biomeShares.ts', 'metrics/liveness.ts', 'metrics/splineStats.ts', 'metrics/crossSection.ts',
+  'metrics/region.ts']);
 /**
  * Directories outside core/ and gen/ that follow the core determinism rules: the block registry, whose ids and tables
  * are hashed into goldens (SP3a spec §2.5). The rest of world/ (the store) keeps the ND bans only.
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/banned.test.ts test/unit/region.test.ts test/unit/store.test.ts test/unit/terrainStage.test.ts`

Expected: PASS (exit 0)

```
Test Files  4 passed (4)
Tests  120 passed (120)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  109 passed | 2 skipped (111)
Tests  1448 passed | 2 skipped (1450)
```

- [ ] **Step 6: Commit**

```bash
git add src/gen/pipeline/terrainStage.ts src/metrics/region.ts src/world/store/store.ts test/arch/banned.test.ts test/arch/fixtures/banned/bad/src/metrics/region.ts test/arch/rules/banned.ts test/unit/region.test.ts test/unit/store.test.ts test/unit/terrainStage.test.ts
git commit -F - <<'EOF'
feat(gen,metrics): the provisional T stage and the region core (SP3a §4, §6.1, §6.2)

- src/gen/pipeline/terrainStage.ts: terrainStage(ctx, cx, cz, w, stop) fills the
  proto set from the ColumnSample (bedrock at -64, stone to floor(surfaceEst),
  water sources up to surfaceWaterLevel, air), polls stop before each section,
  then writes aux A (WORLD_SURFACE_WG, OCEAN_FLOOR_WG, surfaceBiome).
- src/metrics/region.ts (DET_FILES): fillColumnT (claim, stage, commit(1) or
  freeColumn; also frees on a throw), genRegionInProcess (1..64 per side, cz
  outer) and regionHash (streaming FNV-1a 64 over proto blocks, fluid, aux A).
- world/store: the default PASS table is the registry's own (was a stand-in
  equal to it for air, stone and bedrock).
- Unit tests: fill rule at sea, land, lake, river and coast; heightmaps by the
  section 3.4 predicates; uniform/dense per channel; abort with no leak; region
  hash against a hand-built byte stream, backend/order/slot-layout invariance
  and sub-windows. Arch: metrics/region.ts under the determinism rules.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `ecc70f8` on `dry/sp3a`; 9 files changed, 703 insertions(+), 8 deletions(-)):

RED replay (the commit's `test/**` over the parent, throwaway worktree): `test/unit/terrainStage.test.ts` and `test/unit/region.test.ts` fail to import `src/gen/pipeline/terrainStage` / `src/metrics/region` (2 files failed, no tests); `test/unit/store.test.ts` 2 failed ("meta uses the store's PASS table", both backends: `DEFAULT_PASS` is not the registry's `PASS`); `test/arch/banned.test.ts` passes in the replay because the DET_FILES change lives in `test/arch/rules/banned.ts` (as in Task 3). GREEN: typecheck clean; the two new files 47 tests (≈0.9 s); `npm test` 109 files passed, 2 skipped / 1446 passed, 2 skipped (≈48 s); `npm run build` green. One provisional column (ColumnSample + fill + aux) ≈ 0.7 ms (64 columns in 47 ms in the unit run). Mutations checked (scratch, reverted): water `<` instead of `≤` (12 fail), `worldSurfaceWG` ignoring water (4), no `stop()` before section 0 (6), `fillColumnT` not freeing on abort (4), uniform fluid hashed as 0 (1, after adding the deep-sea window), uniform blocks hashed as 0 (2), `surfaceBiome` not zoomed (3).

- Ruling: the stage polls `stop()` exactly 24 times (before each section), after building the ColumnSample; a stop that fires before section 0 still pays for the sample (≈ 0.3 ms) — §4 says "called before each section"; an extra poll before the sample would make it 25 — cost if wrong: one extra poll.
- Ruling: per position the stage keeps `⌊surfaceEst⌋` and `⌊surfaceWaterLevel⌋` clamped to [−65, 319] in Int32 scratch (−∞ → −65); the clamp changes no comparison for y ∈ [−64, 319]; heightmaps are computed from them, not by scanning: `OCEAN_FLOOR_WG = max(−64, top) + 1`, `WORLD_SURFACE_WG = max(−64, top, waterTop) + 1` (bedrock at −64 makes −63 the minimum, so −64 "none" never occurs); the tests check both against a scan of the stored voxels by the §3.4 predicates (`COLLIDE`, fluid type) and against §4's wording — cost if wrong: none.
- Ruling: scratch buffers (ColumnSample, 2 × Int32Array(256), the 4096-entry blocks/fluid section) are module-level in `terrainStage.ts`, like `columnStage.ts`'s; `setProto` copies them (§3.5) — one stage call at a time per thread — cost if wrong: none (the stage is synchronous).
- Ruling: `fillColumnT` also frees the column and rethrows when the stage throws (a `stop` that throws, `StoreFull`), so a failed column never stays claimed half-written — §4 names only the false path — cost if wrong: none.
- Ruling: `genRegionInProcess` and `regionHash` take `VoxelStore` (type import from `world/store/store.ts`; metrics may import world: `L2_CORE` already lists it, so no arch-rule change was needed) and check 1 ≤ w, h ≤ 64 integers (RangeError) — the same bound for a hash window, which can only be a sub-window of a ≤ 64 region; `regionHash` throws (Error naming the column) when a column of the window has no proto set — cost if wrong: none.
- Ruling: `regionHash` hashes dense block sections through a byte view of the slot when the platform is little-endian (checked once at module load) and per voxel with `updateU16LE` otherwise; aux A is hashed as the raw 4096-byte slot from `worldSurfaceWG` (offset 0), Int16 in native order, which §3.4 declares little-endian on every target; a column without aux hashes 4096 zeros — a unit test rebuilds the §6.2 byte stream by hand from `block`/`fluid`/aux field reads (explicit LE) and compares — cost if wrong: a big-endian target would hash aux differently (none exists).
- Ruling: the store's `DEFAULT_PASS` is now the registry's `PASS` table itself (`world/store/store.ts` imports `world/blocks/index`; `world` → `world` is allowed) — resolves the Task 7 / integration stand-in so SP3b's appended cutout/translucent states get their meta bits; the store copies it per store as before — cost if wrong: none (values identical for SP3a's states).
- Ruling: the other two integration stand-ins stay: `section.ts`'s private fluid-type mask 0x30 (a per-voxel call to `hasFluid` in `computeMeta`'s loop would cost more and the fluid byte is frozen by §2.1) and the `SECTIONS`/`SECTION_VOXELS`/torus duplicates in `columnTable.ts`/`section.ts` (frozen geometry, equal to `core/coords.ts`; aliasing them is a pure cleanup with no behaviour to test) — cost if wrong: a cleanup commit later.
- Ruling: the fill-rule tests use five hard-coded seed-'42' default-profile columns found by a scan (land (−1963, −2000), sea (−2000, −2000) with a uniform water section 7, lake (−1001, −2000), river (−742, −2000), coast (−1667, −2000)), and re-derive each column's categories from the ColumnSample (nearest-corner `lakeMask`, wet flag, level), so a world change fails loudly instead of silently testing nothing — cost if wrong: if SP3b changes the 2D world the columns may need re-picking (GENERATOR_VERSION bump anyway).
- Ruling: arch — `DET_FILES` gains `metrics/region.ts` with a bad fixture (`performance.now`, `Math.hypot`, `**` → nondeterministic, math-member, math-pow-operator); `metrics/sp3aGoldens.ts` is left for Task 10, which creates it — cost if wrong: none.
- No spec defects found for Task 9.

---

### Task 10: sp3a goldens

**Spec:** §6.4

**Files:**
- Modify: `src/metrics/sp2aGoldens.ts`
- Create: `src/metrics/sp3aGoldens.ts`
- Modify: `src/ui/selftest/selftestPage.ts`
- Modify: `test/arch/banned.test.ts`
- Create: `test/arch/fixtures/banned/bad/src/metrics/sp3aGoldens.ts`
- Modify: `test/arch/rules/banned.ts`
- Modify: `test/goldens.json`
- Modify: `test/tools/goldensJsc.ts`
- Modify: `test/tools/uiSmoke.ts`
- Modify: `test/unit/goldens.sp2a.test.ts`
- Create: `test/unit/goldens.sp3a.test.ts`
- Modify: `test/unit/uiSmoke.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/blocks/registry.ts` (Task 3): `BlockRegistry as BlockRegistryT`
  - `src/world/blocks/index.ts` (Task 4): `REGISTRY`
  - `src/world/store/store.ts` (Task 7): `createStore`
  - `src/metrics/region.ts` (Task 9): `genRegionInProcess`, `regionHash`
- Produces (exports added by this task):
  - `src/metrics/sp3aGoldens.ts`:
    - `export function registryDigest(reg: BlockRegistryT = REG): string`
    - `export function regionDigest(profile: ProfileIdT): string`
    - `export function sp3aGoldenKeys(): string[]`
    - `export function computeSp3aGolden(key: string): string`
  - `test/tools/uiSmoke.ts`:
    - `export function goldenCount(goldensJson: string): number`
    - `export function selftestAllMatch(summary: string, count: number): boolean`

- [ ] **Step 1: Write the failing tests**

Modify `test/arch/banned.test.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/banned.test.ts b/test/arch/banned.test.ts
index e57ea60..206f470 100644
--- a/test/arch/banned.test.ts
+++ b/test/arch/banned.test.ts
@@ -52,6 +52,10 @@ test('bad fixture tree reports every banned use', () => {
     'src/metrics/sp1Goldens.ts:1 nondeterministic',
     'src/metrics/sp1Goldens.ts:2 math-pow-operator',
     'src/metrics/sp2aGoldens.ts:1 nondeterministic',
+    'src/metrics/sp3aGoldens.ts:1 nondeterministic',
+    'src/metrics/sp3aGoldens.ts:2 math-member',
+    'src/metrics/sp3aGoldens.ts:3 engine-dependent-api',
+    'src/metrics/sp3aGoldens.ts:4 math-pow-operator',
     'src/metrics/splineStats.ts:1 nondeterministic',
     'src/metrics/splineStats.ts:2 math-member',
     'src/render/materials/raw.glsl:1 raw-shader-file',
```

Create `test/arch/fixtures/banned/bad/src/metrics/sp3aGoldens.ts`:

```ts
export const stamp = (): number => Date.now();
export const angle = (z: number, x: number): number => Math.atan2(z, x);
export const sort = (a: string, b: string): number => a.localeCompare(b);
export const square = (v: number): number => v ** 2;
```

Modify `test/unit/goldens.sp2a.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/goldens.sp2a.test.ts b/test/unit/goldens.sp2a.test.ts
index 4d763ac..50c07df 100644
--- a/test/unit/goldens.sp2a.test.ts
+++ b/test/unit/goldens.sp2a.test.ts
@@ -7,7 +7,7 @@ test('20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn', () =>
   expect(keys.length).toBe(20);
   expect(new Set(keys).size).toBe(20);
   expect(keys.filter((k) => k.startsWith('sp2a.tile.')).length).toBe(16);
-  expect(allGoldenKeys().length).toBe(47);
+  expect(allGoldenKeys().length).toBe(50); // 27 SP1 + 20 SP2a + 3 SP3a (SP3a spec §6.4)
   expect(() => computeSp2aGolden('sp2a.tile.biome.32')).toThrow(/unknown golden/);
   expect(() => computeSp2aGolden('sp2a.spawn.x')).toThrow(/unknown golden/);
   expect(computeAnyGolden('sp1.params')).toMatch(/^[0-9a-f]{16}$/);
```

Create `test/unit/goldens.sp3a.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { computeSp3aGolden, regionDigest, registryDigest, sp3aGoldenKeys } from '../../src/metrics/sp3aGoldens';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockDef } from '../../src/world/blocks/registry';
import { createStore } from '../../src/world/store/store';
import { SOLID_TABLES } from '../harness/blockFixtures';
import { expectGolden } from '../harness/goldens';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16 = (v: number): number[] => [v & 255, v >> 8];

/**
 * The §6.4 registry byte stream written out from the §2.2 table and the §2.1 codes, not from the registry's tables:
 * key bytes and a 0, STATE_TYPE (u16 LE), OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE,
 * FLUID_MODE, TINT, SOUND (u8), then six FACE_TEX (u16 LE).
 */
const SP3A_REGISTRY_BYTES = new Uint8Array([
  ...ascii('air'), 0, ...u16(0), 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, ...Array<number>(12).fill(0),
  ...ascii('stone'), 0, ...u16(1), 15, 1, 1, 63, 0, 1, 0, 1, 0, 0, 1, ...Array<number>(12).fill(0),
  ...ascii('bedrock'), 0, ...u16(2), 15, 1, 1, 63, 0, 0, 0, 1, 0, 0, 1, ...Array<number>(12).fill(0),
]);

test('3 unique SP3a keys: the registry and one 8 × 8 region per profile, chained into allGoldenKeys', () => {
  const keys = sp3aGoldenKeys();
  expect(keys).toEqual(['sp3a.registry', 'sp3a.region.T.default', 'sp3a.region.T.large_biomes']);
  expect(sp3aGoldenKeys().length).toBe(3);
  expect(allGoldenKeys().slice(-3)).toEqual(keys);
  expect(new Set(allGoldenKeys()).size).toBe(allGoldenKeys().length);
  expect(computeAnyGolden('sp3a.registry')).toBe(computeSp3aGolden('sp3a.registry'));
  for (const bad of ['sp3a.region.T.amplified', 'sp3a.region.T', 'sp3a.region.D.default', 'sp3a.registry.x', 'sp3a.nope']) {
    expect(() => computeSp3aGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp3a.registry (§6.4)', () => {
  test('is the FNV-1a 64 of the byte stream written from the §2.2 table', () => {
    expect(registryDigest()).toBe(hex64(fnv1a64Bytes(SP3A_REGISTRY_BYTES)));
  });

  test('covers ids 0-2 only: appending a type does not change it, a changed SP3a value does', () => {
    const appended: BlockDef = { name: 'granite', ...SOLID_TABLES };
    expect(registryDigest(buildRegistry([...BLOCK_DEFS, appended]))).toBe(registryDigest(REGISTRY));
    const louder: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'bedrock' ? { ...d, sound: 'metal' } : d));
    expect(registryDigest(buildRegistry(louder))).not.toBe(registryDigest(REGISTRY));
    const renamed: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'stone' ? { ...d, name: 'rock' } : d));
    expect(registryDigest(buildRegistry(renamed))).not.toBe(registryDigest(REGISTRY));
  });

  test('a registry with fewer than 3 states is refused', () => {
    expect(() => registryDigest(buildRegistry(BLOCK_DEFS.slice(0, 2)))).toThrow(RangeError);
  });
});

describe('sp3a.region.T.<profile> (§6.4)', () => {
  test('is hex64 of regionHash of the 8 × 8 region at (−4, −4), seed 42, on a shared store too', () => {
    const store = createStore({ shared: true, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('large_biomes'));
    genRegionInProcess(store, ctx, -4, -4, 8, 8);
    expect(regionDigest('large_biomes')).toBe(hex64(regionHash(store, -4, -4, 8, 8)));
  });

  test('the two profiles differ and each digest is repeatable', () => {
    const d = regionDigest('default');
    expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(regionDigest('default')).toBe(d);
    expect(regionDigest('large_biomes')).not.toBe(d);
  });
});

describe('SP3a goldens', () => {
  test.each(sp3aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp3aGolden(key));
  }, 60_000);
});
```

Modify `test/unit/uiSmoke.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/uiSmoke.test.ts b/test/unit/uiSmoke.test.ts
index 8cb0d56..11facb0 100644
--- a/test/unit/uiSmoke.test.ts
+++ b/test/unit/uiSmoke.test.ts
@@ -1,12 +1,16 @@
+import { readFileSync } from 'node:fs';
 import { describe, expect, test } from 'vitest';
 import { canonicalJSON } from '../../src/core/params/canonical';
 import { applyPatch } from '../../src/core/params/kit';
 import { resolveProfile } from '../../src/core/params/profiles';
 import { SCHEMA } from '../../src/core/params/schema';
+import { allGoldenKeys } from '../../src/metrics/sp2aGoldens';
 import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
 import { DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
 import { presetText } from '../../src/ui/presets/presetFile';
-import { canonicalJson, ignoredLog, mapHash, parseArgs, presetProblems, readMapHash, sameJson, SIZE_8, VIEWPORT, type MapUrlState } from '../tools/uiSmoke';
+import {
+  canonicalJson, goldenCount, ignoredLog, mapHash, parseArgs, presetProblems, readMapHash, sameJson, selftestAllMatch, SIZE_8, VIEWPORT, type MapUrlState,
+} from '../tools/uiSmoke';
 
 const EDITED: MapState = {
   v: 1, seed: '42', profile: 'default',
@@ -59,6 +63,21 @@ describe('UI smoke test: pure parts (SP2b spec §8 Tools, §12)', () => {
     expect(presetProblems('{', { name: 'a', profile: 'default', patch: {} })[0]).toMatch(/^not JSON: /);
   });
 
+  // Skipped while `npm run test:goldens` records: test/goldens.json gains the new keys only after the run.
+  test.skipIf(process.env.UPDATE_GOLDENS === '1')('test/goldens.json holds every golden key of the build, the count the selftest step expects', () => {
+    const text = readFileSync(new URL('../goldens.json', import.meta.url), 'utf8');
+    expect(goldenCount(text)).toBe(allGoldenKeys().length);
+  });
+
+  test('the selftest step counts the goldens of test/goldens.json and matches the page summary against it', () => {
+    expect(goldenCount('{"generatorVersion":3,"entries":{"a":"1","b":"2"}}')).toBe(2);
+    expect(() => goldenCount('{"generatorVersion":3}')).toThrow(/entries/);
+    expect(selftestAllMatch('✓ all 50 goldens match (3.2 s)', 50)).toBe(true);
+    expect(selftestAllMatch('✓ all 47 goldens match (3.2 s)', 50)).toBe(false);
+    expect(selftestAllMatch('✗ 1 of 50 goldens differ (3.2 s)', 50)).toBe(false);
+    expect(selftestAllMatch('computing 50/50…', 50)).toBe(false);
+  });
+
   test('arguments: build, the OS temp directory and no screenshots by default', () => {
     expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
     expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/banned.test.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/uiSmoke.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× bad fixture tree reports every banned use 24ms
× test/goldens.json holds every golden key of the build, the count the selftest step expects 3ms
× the selftest step counts the goldens of test/goldens.json and matches the page summary against it 1ms
× 20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn 7ms
FAIL  |unit| test/unit/goldens.sp3a.test.ts [ test/unit/goldens.sp3a.test.ts ]
Error: Cannot find module '../../src/metrics/sp3aGoldens' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/goldens.sp3a.test.ts
FAIL  |unit| test/unit/goldens.sp2a.test.ts > 20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn
AssertionError: expected 47 to be 50 // Object.is equality
FAIL  |unit| test/unit/uiSmoke.test.ts > UI smoke test: pure parts (SP2b spec §8 Tools, §12) > test/goldens.json holds every golden key of the build, the count the selftest step expects
TypeError: goldenCount is not a function
FAIL  |unit| test/unit/uiSmoke.test.ts > UI smoke test: pure parts (SP2b spec §8 Tools, §12) > the selftest step counts the goldens of test/goldens.json and matches the page summary against it
FAIL  |arch| test/arch/banned.test.ts > bad fixture tree reports every banned use
AssertionError: expected [ …(58) ] to deeply equal [ …(62) ]
Test Files  4 failed (4)
Tests  4 failed | 52 passed (56)
```

- [ ] **Step 3: Implement**

Modify `src/metrics/sp2aGoldens.ts` (apply with `git apply`):

```diff
diff --git a/src/metrics/sp2aGoldens.ts b/src/metrics/sp2aGoldens.ts
index d3794de..053de5f 100644
--- a/src/metrics/sp2aGoldens.ts
+++ b/src/metrics/sp2aGoldens.ts
@@ -1,6 +1,7 @@
 /**
  * SP2a golden digests (SP2a spec §7.4), shared by test/unit/goldens.sp2a.test.ts, the ?selftest=1 worker
- * and test/tools/goldensJsc.ts. Follows the core determinism rules (arch-tested). Every value is hex64.
+ * and test/tools/goldensJsc.ts, and the chain of every golden of the build (`allGoldenKeys`/`computeAnyGolden`:
+ * SP1, SP2a, then SP3a, SP3a spec §6.4). Follows the core determinism rules (arch-tested). Every value is hex64.
  */
 import { MAP_LEVELS, type MapLevel } from '../core/constants';
 import { fnv1a32, fnv1a64Bytes, hashF64, hex64 } from '../core/hash';
@@ -14,6 +15,7 @@ import { findSpawn } from '../gen/column/spawn';
 import type { LayerId } from '../gen/map/layers';
 import { paintTile } from '../gen/map/tile';
 import { computeGolden as computeSp1, goldenKeys as sp1Keys } from './sp1Goldens';
+import { computeSp3aGolden, sp3aGoldenKeys } from './sp3aGoldens';
 
 const FNV32 = fnv1a32;
 const FNV_BYTES = fnv1a64Bytes;
@@ -33,6 +35,8 @@ const FIELDS = SAMPLE_FIELDS;
 const LEVEL_F = LEVEL_FIELDS;
 const SP1 = computeSp1;
 const SP1_KEYS = sp1Keys;
+const SP3A = computeSp3aGolden;
+const SP3A_KEYS = sp3aGoldenKeys;
 
 const POINT_PROFILES: readonly ProfileId[] = ['default', 'large_biomes'];
 const TILE_LAYERS: readonly LayerId[] = ['biome', 'relief', 'rivers', 'C'];
@@ -116,11 +120,12 @@ export function computeSp2aGolden(key: string): string {
   throw new Error(`unknown golden ${key}`);
 }
 
-/** Every golden key of the build (SP1 then SP2a). */
+/** Every golden key of the build (SP1, SP2a, then SP3a). */
 export function allGoldenKeys(): string[] {
-  return [...SP1_KEYS(), ...sp2aGoldenKeys()];
+  return [...SP1_KEYS(), ...sp2aGoldenKeys(), ...SP3A_KEYS()];
 }
 
 export function computeAnyGolden(key: string): string {
+  if (key.startsWith('sp3a.')) return SP3A(key);
   return key.startsWith('sp2a.') ? computeSp2aGolden(key) : SP1(key);
 }
```

Create `src/metrics/sp3aGoldens.ts`:

```ts
/**
 * SP3a golden digests (SP3a spec §6.4): the block registry's first states and the provisional T region per profile.
 * Chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`), so the unit tests, `?selftest=1` and
 * `test/tools/goldensJsc.ts` all check them. Follows the core determinism rules (in `DET_FILES`, arch-tested).
 * Every value is hex64.
 */
import { createFnv64, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import type { ProfileId as ProfileIdT } from '../core/params/profiles';
import { seedFromInput } from '../core/seed';
import { createGenContext } from '../gen/context';
import { REGISTRY } from '../world/blocks/index';
import type { BlockRegistry as BlockRegistryT } from '../world/blocks/registry';
import { createStore } from '../world/store/store';
import { genRegionInProcess, regionHash } from './region';

const CREATE_FNV = createFnv64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const REG = REGISTRY;
const CREATE_STORE = createStore;
const GEN_REGION = genRegionInProcess;
const REGION_HASH = regionHash;

/** The states SP3a registers (air, stone, bedrock): a fixed count, so appended states never change the digest. */
const SP3A_STATES = 3;
const REGION_PROFILES: readonly ProfileIdT[] = ['default', 'large_biomes'];
/** 64 proto columns need at most 1,536 block and 1,600 byte slots (12 and 6.25 MiB). */
const MiB = 1048576;

/**
 * FNV-1a 64 over states 0 … 2 of `reg`: per state, its canonical key's ASCII bytes and a 0 byte, then `STATE_TYPE`
 * (u16 LE), `OPACITY`, `PASS`, `SHAPE`, `FULL_FACES`, `EMIT`, `CARVABLE`, `REPLACEABLE`, `COLLIDE`, `FLUID_MODE`,
 * `TINT`, `SOUND` (u8 each) and the six `FACE_TEX` entries (u16 LE). Throws when `reg` has fewer states.
 */
export function registryDigest(reg: BlockRegistryT = REG): string {
  if (reg.stateCount < SP3A_STATES) throw new RangeError(`registryDigest: the registry has ${reg.stateCount} states, fewer than ${SP3A_STATES}`);
  const fnv = CREATE_FNV();
  for (let s = 0; s < SP3A_STATES; s++) {
    const key = reg.stateKey(s);
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c > 127) throw new Error(`registryDigest: state key ${key} is not ASCII`);
      fnv.updateU8(c);
    }
    fnv.updateU8(0);
    fnv.updateU16LE(reg.STATE_TYPE[s]!);
    for (const t of [reg.OPACITY, reg.PASS, reg.SHAPE, reg.FULL_FACES, reg.EMIT, reg.CARVABLE, reg.REPLACEABLE, reg.COLLIDE, reg.FLUID_MODE, reg.TINT, reg.SOUND]) {
      fnv.updateU8(t[s]!);
    }
    for (let f = 0; f < 6; f++) fnv.updateU16LE(reg.FACE_TEX[6 * s + f]!);
  }
  return HEX64(fnv.digest());
}

/**
 * `regionHash` of the 8 × 8 region at (−4, −4), world seed '42', `profile`, generated in process on a fresh
 * `ArrayBuffer` store (never the region cache).
 */
export function regionDigest(profile: ProfileIdT): string {
  const store = CREATE_STORE({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  GEN_REGION(store, CREATE_CTX(SEED('42'), RESOLVE(profile)), -4, -4, 8, 8);
  return HEX64(REGION_HASH(store, -4, -4, 8, 8));
}

export function sp3aGoldenKeys(): string[] {
  return ['sp3a.registry', ...REGION_PROFILES.map((p) => `sp3a.region.T.${p}`)];
}

export function computeSp3aGolden(key: string): string {
  if (key === 'sp3a.registry') return registryDigest();
  const m = /^sp3a\.region\.T\.(.+)$/.exec(key);
  if (m !== null && (REGION_PROFILES as readonly string[]).includes(m[1]!)) return regionDigest(m[1] as ProfileIdT);
  throw new Error(`unknown golden ${key}`);
}
```

Modify `src/ui/selftest/selftestPage.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/selftest/selftestPage.ts b/src/ui/selftest/selftestPage.ts
index a5810d4..93a2e4c 100644
--- a/src/ui/selftest/selftestPage.ts
+++ b/src/ui/selftest/selftestPage.ts
@@ -1,5 +1,5 @@
 /**
- * ?selftest=1 (SP2a spec §6.4): recomputes every golden (SP1 and SP2a) in one real module worker and
+ * ?selftest=1 (SP2a spec §6.4): recomputes every golden (SP1, SP2a and SP3a) in one real module worker and
  * compares with the bundled test/goldens.json. A key whose computation throws shows its error, and a job
  * the pool rejects (a failed worker) counts as a failed key, so the summary always completes (SP2a minor 9).
  */
```

Modify `test/arch/rules/banned.ts` (apply with `git apply`):

```diff
diff --git a/test/arch/rules/banned.ts b/test/arch/rules/banned.ts
index 0a21136..f93304b 100644
--- a/test/arch/rules/banned.ts
+++ b/test/arch/rules/banned.ts
@@ -11,10 +11,11 @@ const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign',
   'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
 /**
  * Files outside core/ and gen/ that follow the core determinism rules: the golden digests (SP1 spec §1.8), the
- * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4) and the SP3a region core (SP3a spec §6.1).
+ * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4), the SP3a region core (SP3a spec §6.1) and
+ * the SP3a golden digests (SP3a spec §6.4).
  */
 const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts', 'metrics/biomeShares.ts', 'metrics/liveness.ts', 'metrics/splineStats.ts', 'metrics/crossSection.ts',
-  'metrics/region.ts']);
+  'metrics/region.ts', 'metrics/sp3aGoldens.ts']);
 /**
  * Directories outside core/ and gen/ that follow the core determinism rules: the block registry, whose ids and tables
  * are hashed into goldens (SP3a spec §2.5). The rest of world/ (the store) keeps the ND bans only.
```

Modify `test/tools/goldensJsc.ts` (apply with `git apply`):

```diff
diff --git a/test/tools/goldensJsc.ts b/test/tools/goldensJsc.ts
index 023795a..f75bb99 100644
--- a/test/tools/goldensJsc.ts
+++ b/test/tools/goldensJsc.ts
@@ -1,5 +1,5 @@
 /**
- * JavaScriptCore check of every golden, SP1 and SP2a (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
+ * JavaScriptCore check of every golden, SP1, SP2a and SP3a (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
  * (Bun runs JavaScriptCore and resolves the repository's extensionless imports; no dependency is added).
  */
 import goldens from '../goldens.json';
```

Modify `test/tools/uiSmoke.ts` (apply with `git apply`):

```diff
diff --git a/test/tools/uiSmoke.ts b/test/tools/uiSmoke.ts
index 7a1632f..2a17ffd 100644
--- a/test/tools/uiSmoke.ts
+++ b/test/tools/uiSmoke.ts
@@ -74,6 +74,22 @@ export function readMapHash(hash: string): MapUrlState | null {
   }
 }
 
+/**
+ * The number of goldens in test/goldens.json: every key of the build, which `?selftest=1` recomputes (SP3a spec §6.4;
+ * this tool runs under plain Node and cannot import `src/` to count `allGoldenKeys()`).
+ */
+export function goldenCount(goldensJson: string): number {
+  const entries = (JSON.parse(goldensJson) as { entries?: unknown }).entries;
+  if (entries === null || typeof entries !== 'object') throw new Error('goldens.json has no entries object');
+  return Object.keys(entries).length;
+}
+
+/** True when the selftest page's summary reports all `count` goldens matching. */
+export function selftestAllMatch(summary: string, count: number): boolean {
+  const m = /^✓ all (\d+) goldens match/.exec(summary);
+  return m !== null && Number(m[1]) === count;
+}
+
 /** A page log entry the smoke test does not count: the favicon.ico 404 (index.html declares no icon). */
 export function ignoredLog(text: string, url: string | undefined): boolean {
   return url !== undefined && /\/favicon\.ico(\?|$)/.test(url) && text.includes('404');
@@ -494,7 +510,8 @@ async function runSmoke(t: Smoke): Promise<void> {
   await p.goto(`${p.base}?selftest=1`, `document.querySelector('h2 + div') !== null`);
   await p.until(`/^[✓✗]/.test(document.querySelector('h2 + div').textContent)`, 'selftest summary', 180000);
   const summary = await p.eval<string>(`document.querySelector('h2 + div').textContent`);
-  t.check(/^✓ all 47 goldens match/.test(summary), `selftest: ${summary}`, summary);
+  const goldens = goldenCount(readFileSync(join(ROOT, 'test/goldens.json'), 'utf8'));
+  t.check(selftestAllMatch(summary, goldens), `selftest: ${summary} (test/goldens.json holds ${goldens})`, summary);
 
   t.step('load: ?map at seed 42, default profile, view (0, 0, 64 blocks/px)');
   await p.goto(`${p.base}?map#${mapHash(START)}`, MAP_READY);
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:goldens`

The command writes `test/goldens.json`; the dry run's result:

Modify `test/goldens.json` (apply with `git apply`):

```diff
diff --git a/test/goldens.json b/test/goldens.json
index 103d766..5584f5f 100644
--- a/test/goldens.json
+++ b/test/goldens.json
@@ -47,6 +47,9 @@
     "sp2a.tile.rivers.16": "8fc6e210afdfed8c",
     "sp2a.tile.rivers.256": "95bd582b209aa855",
     "sp2a.tile.rivers.4": "72f6d6c446d76cb2",
-    "sp2a.tile.rivers.64": "6da7f75d7a9bfcaf"
+    "sp2a.tile.rivers.64": "6da7f75d7a9bfcaf",
+    "sp3a.region.T.default": "943479d09e0e89e3",
+    "sp3a.region.T.large_biomes": "e20fb4ebf0a5e9fc",
+    "sp3a.registry": "5e1febd88b449b63"
   }
 }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/banned.test.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/uiSmoke.test.ts`

Expected: PASS (exit 0)

```
Test Files  4 passed (4)
Tests  65 passed (65)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  110 passed | 2 skipped (112)
Tests  1459 passed | 2 skipped (1461)
```

- [ ] **Step 7: Commit**

```bash
git add src/metrics/sp2aGoldens.ts src/metrics/sp3aGoldens.ts src/ui/selftest/selftestPage.ts test/arch/banned.test.ts test/arch/fixtures/banned/bad/src/metrics/sp3aGoldens.ts test/arch/rules/banned.ts test/goldens.json test/tools/goldensJsc.ts test/tools/uiSmoke.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/uiSmoke.test.ts
git commit -F - <<'EOF'
feat(metrics): sp3a goldens, the registry and the provisional T region (SP3a §6.4)

- src/metrics/sp3aGoldens.ts (DET_FILES): sp3a.registry (FNV-1a 64 over states
  0-2: canonical key bytes and a 0, then STATE_TYPE, the eleven u8 tables and
  FACE_TEX) and sp3a.region.T.{default,large_biomes} (regionHash of the 8 x 8
  region at (-4, -4), seed 42, generated in process on an ArrayBuffer store).
- Chained into allGoldenKeys/computeAnyGolden, so the unit tests, ?selftest=1
  and the Bun tool check all 50 keys; goldens.sp2a asserts 50 instead of 47.
- test/goldens.json: adds the 3 sp3a keys only (npm run test:goldens); no
  existing golden changes, GENERATOR_VERSION stays 3.
- uiSmoke.ts: the selftest step expects the number of entries of
  test/goldens.json instead of a hard-coded 47.
- Unit: the registry digest against the byte stream written from the 2.2 table,
  unchanged by an appended type; region digests against regionHash on a shared
  store. Arch: metrics/sp3aGoldens.ts under the determinism rules.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `eedb50e` on `dry/sp3a`; 12 files changed, 223 insertions(+), 11 deletions(-)):

RED replay (the commit's `test/**` over the parent, throwaway detached worktree, unit + arch): 3 files failed — `test/unit/goldens.sp3a.test.ts` fails to import `src/metrics/sp3aGoldens`, `goldens.sp2a.test.ts` (expected 47 to be 50), `uiSmoke.test.ts` "test/goldens.json holds every golden key of the build" (50 entries vs 47 keys); `test/arch/banned.test.ts` passes in the replay because the DET_FILES change lives in `test/arch/rules/banned.ts` (as in Tasks 3 and 9; during TDD it was watched failing with the 4 `sp3aGoldens.ts` violations missing). During TDD the three golden tests failed with "missing golden sp3a.…: run npm run test:goldens" before recording. `npm run test:goldens` added exactly `sp3a.registry` 5e1febd88b449b63, `sp3a.region.T.default` 943479d09e0e89e3, `sp3a.region.T.large_biomes` e20fb4ebf0a5e9fc (`git diff test/goldens.json`: 3 added lines, nothing else). GREEN: typecheck clean; `npm test` 110 files passed, 2 skipped / 1457 passed, 2 skipped (≈49 s); `npm run build` green; Bun `npx --yes bun@1 test/tools/goldensJsc.ts`: 50/50 match on Bun 1.4.2 (JavaScriptCore). Each region golden ≈ 0.4 s in the V8 unit run (context + 64 columns); `?selftest=1` in Chrome was not run here (Task 16).

- Ruling: the chain stays in `sp2aGoldens.ts` — `allGoldenKeys()` = SP1, SP2a, then `sp3aGoldenKeys()`; `computeAnyGolden` routes `sp3a.` to `computeSp3aGolden` — `sp2aGoldens.ts` imports `sp3aGoldens.ts` (as it imports `sp1Goldens.ts`), so the consumers (`taskHandler.ts`, `selftestPage.ts`, `goldensJsc.ts`, `protocol.test.ts`) are unchanged and §6.4's "goldens.sp2a.test.ts asserts 50" holds against the same function; `sp3aGoldens.ts` does not import `sp2aGoldens.ts` (no cycle) — cost if wrong: SP3b moves the chain to the newest goldens file and updates four importers.
- Ruling: `sp3aGoldens.ts` exports `registryDigest(reg = REGISTRY)`, `regionDigest(profile)`, `sp3aGoldenKeys()` (`['sp3a.registry', 'sp3a.region.T.default', 'sp3a.region.T.large_biomes']`, in that order) and `computeSp3aGolden(key)` (throws `unknown golden …` for anything else) — `registryDigest` takes a registry so a test can show an appended type leaves it unchanged (§6.4) and that a changed SP3a value or name changes it; it throws `RangeError` for a registry with fewer than 3 states and `Error` for a non-ASCII key byte (keys are ASCII by the §2.2 grammar; `TextEncoder` is banned) — cost if wrong: none.
- Ruling: the region goldens' store is `createStore({shared: false, maxBlockBytes: 32 MiB, maxByteBytes: 16 MiB})`, not the 768/512 MiB defaults — 64 proto columns need at most 1,536 block and 1,600 byte slots (12 and 6.25 MiB), the same maxima as the slice store (§5.1), and a smaller reserved `maxByteLength` is kinder to the `?selftest=1` worker and to JSC; the maxima do not enter the hash (slot layout independence, §6.2) — cost if wrong: none.
- Ruling: the unit test pins `sp3a.registry` against the §6.4 byte stream written out literally from the §2.2 table and the §2.1 codes (not read from the registry tables), so a wrong code (e.g. `FLUID_MODE` displace ≠ 2) fails as a test, not only as a golden diff; it also checks `regionDigest('large_biomes')` equals `hex64(regionHash)` of the same region generated on a shared (SAB) store — cost if wrong: none.
- Ruling: `uiSmoke.ts` gains two pure, unit-tested exports, `goldenCount(goldensJsonText)` (entries of `test/goldens.json`; throws without an entries object) and `selftestAllMatch(summary, count)` (`/^✓ all (\d+) goldens match/` and the count equal); the selftest step reads `test/goldens.json` from ROOT — §6.4 — cost if wrong: none.
- Ruling: the unit test "test/goldens.json holds every golden key of the build" (entries count = `allGoldenKeys().length`) is `test.skipIf(process.env.UPDATE_GOLDENS === '1')` — `npm run test:goldens` runs the unit project in record mode before merging, so without the skip the new keys can never be recorded (the run fails on the old 47 and stops before the merge); in check mode it guards that the file and the build agree, which is what uiSmoke's count relies on — cost if wrong: none (only the record run skips it).
- Ruling: doc comments of `selftestPage.ts` and `goldensJsc.ts` now say "SP1, SP2a and SP3a"; `determinismPanel.ts` (the lab's sp1-only panel) is untouched — cost if wrong: none.
- No spec defects found for Task 10.

---

### Task 11: Region harness: genRegion, 4 threads, cache, PNG

**Spec:** §6.1

**Files:**
- Create: `test/harness/cache.ts`
- Create: `test/harness/png.ts`
- Create: `test/harness/region.ts`
- Create: `test/harness/regionWorker.ts`
- Create: `test/integration/region.test.ts`
- Create: `test/unit/png.test.ts`
- Create: `test/unit/regionCache.test.ts`
- Create: `test/unit/regionHarness.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/blocks/fluid.ts` (Task 3): `fluidType`
  - `src/world/blocks/index.ts` (Task 4): `AIR`, `BEDROCK`, `STONE`
  - `src/world/store/columnTable.ts` (Task 6): `REC_AUX_A`, `REC_CLAIMED`, `REC_CX`, `REC_CZ`, `REC_STATUS`, `STATUS_PROTO`, `protoAt`
  - `src/world/store/store.ts` (Task 7): `VoxelStore`, `attachStore`, `createStore`, `type ColumnView`, `type StoreHandles`, `type VoxelStore`
  - `src/metrics/region.ts` (Task 9): `fillColumnT`, `regionHash`
- Produces (exports added by this task):
  - `test/harness/cache.ts`:
    - `export const REGION_CACHE_FORMAT = 1;`
    - `export const REGION_CACHE_PRUNE_MS = 15 * 60 * 1000;`
    - `export const REGION_CACHE_DIR = fileURLToPath(new URL('../.cache/regions/', import.meta.url));`
    - `export const SRC_KEY_SCOPE: readonly string[] = Object.freeze(['src/core/', 'src/world/', 'src/gen/', 'src/metrics/region.ts', 'test/harness/cache.ts']);`
    - `export type RegionUpTo = 'T';`
    - `export interface RegionCacheHeader`
    - `export function srcKeyOf(root: string, scope: readonly string[] = SRC_KEY_SCOPE): Hash64`
    - `export function srcKey(): Hash64`
    - `export function regionCacheKey(h: RegionCacheHeader): Hash64`
    - `export function regionCachePath(h: RegionCacheHeader, dir: string = REGION_CACHE_DIR): string`
    - `export function encodeRegionDump(store: VoxelStore, h: RegionCacheHeader): Uint8Array`
    - `export function parseRegionDump(bytes: Uint8Array, h: RegionCacheHeader): DumpColumn[] | null`
    - `export function rebuildRegion(store: VoxelStore, cols: readonly DumpColumn[]): Float64Array`
    - `export function readRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): Float64Array | null`
    - `export function pruneRegionDumps(dir: string, src: Hash64, now: number = Date.now()): string[]`
    - `export function writeRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): void`
  - `test/harness/png.ts`:
    - `export interface RgbaImage`
    - `export const VOXEL_COLORS =`
    - `export const SEA_LEVEL_Y = 63;`
    - `export function voxelRgb(state: number, fluid: number, depth: number): Rgb`
    - `export function encodePng(img: RgbaImage): Uint8Array`
    - `export function writePng(path: string, img: RgbaImage): void`
    - `export interface VerticalSliceOptions`
    - `export function sliceX(view: RegionView, x: number, opts: VerticalSliceOptions = {}): RgbaImage`
    - `export function sliceZ(view: RegionView, z: number, opts: VerticalSliceOptions = {}): RgbaImage`
    - `export function sliceY(view: RegionView, y: number): RgbaImage`
  - `test/harness/region.ts`:
    - `export type RegionOrder = 'spiral' | 'shuffled';`
    - `export interface GenRegionOptions`
    - `export interface RegionView`
    - `export interface RegionResult`
    - `export function regionColumns(order: RegionOrder, cx0: number, cz0: number, w: number, h: number, shuffleSeed = 1): Array<[number, number]>`
    - `export function regionView(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): RegionView`
    - `export function regionDiff(a: RegionView, b: RegionView): string | null`
    - `export async function genRegion(o: GenRegionOptions): Promise<RegionResult>`
  - `test/harness/regionWorker.ts`:
    - `export interface RegionAttachMsg`
    - `export interface RegionColumnMsg`
    - `export type RegionWorkerReply =`
    - `export function createTaskHandler(): { handle(raw: unknown): Reply }`

- [ ] **Step 1: Write the failing tests**

Create `test/integration/region.test.ts`:

```ts
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { GOLDENS_PATH, type GoldensFile } from '../harness/goldens';
import { genRegion, regionDiff, type GenRegionOptions, type RegionResult } from '../harness/region';

/**
 * The region harness with 4 worker threads against 1 thread (SP3a spec §6.1, §8): a growable SharedArrayBuffer
 * store written by 4 `worker_threads` running `test/harness/regionWorker.ts` from a dynamic queue gives the same
 * region, byte for byte (region hash and per-channel uniform/dense layout), as the in-process plain ArrayBuffer
 * store, in every dispatch order; its 8 × 8 window at (−4, −4) is the recorded `sp3a.region.T.<profile>` golden.
 * The runs are compared byte for byte (`regionDiff`); hashing a 16 × 16 region costs seconds (≈ 300 KB per column
 * through a byte-wise FNV), so only the golden windows are hashed.
 */
const DIR = fileURLToPath(new URL('../.cache/regionIntegration/', import.meta.url));
const GOLDENS = (JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldensFile).entries;

/** Live slots of both pools, and the dense entries plus aux slots the region's records hold. */
function accounting(r: RegionResult) {
  const { store, cx0, cz0, w, h } = r.view;
  let blocks = 0;
  let bytes = 0;
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const d = r.view.descriptors(cx, cz);
      for (let sy = 0; sy < 24; sy++) {
        if (d[2 * sy]! >= 0) blocks++;
        if (d[2 * sy + 1]! >= 0) bytes++;
      }
      bytes++; // aux A
    }
  }
  return {
    live: [store.blockPool.slotCount() - store.blockPool.freeCount(), store.bytePool.slotCount() - store.bytePool.freeCount()],
    held: [blocks, bytes],
  };
}

describe.each(['default', 'large_biomes'] as const)('genRegion, profile %s', (profile) => {
  const base: GenRegionOptions = {
    seed: '42', params: resolveProfile(profile), cx0: -8, cz0: -8, w: 16, h: 16, upTo: 'T', order: 'spiral', threads: 1,
  };

  test('4 threads equal 1 thread in every order; the 8 × 8 window at (−4, −4) is the golden', async () => {
    const runs: Array<[string, RegionResult]> = [];
    for (const [order, threads, shuffleSeed] of [['spiral', 1, undefined], ['shuffled', 4, 3], ['spiral', 4, undefined], ['shuffled', 1, 9]] as const) {
      const r = await genRegion({ ...base, order, threads, ...(shuffleSeed === undefined ? {} : { shuffleSeed }) });
      runs.push([`${order}/${threads}`, r]);
    }
    const [, ref] = runs[0]!;
    expect(ref.view.hash(-4, -4, 8, 8)).toBe(GOLDENS[`sp3a.region.T.${profile}`]);
    expect(runs[1]![1].view.hash(-4, -4, 8, 8), 'shuffled/4').toBe(GOLDENS[`sp3a.region.T.${profile}`]);
    for (const [what, r] of runs) {
      expect(regionDiff(r.view, ref.view), what).toBeNull();
      expect(r.cacheHit).toBe(false);
      expect(r.view.store.shared, what).toBe(what.endsWith('/4'));
      const a = accounting(r);
      expect(a.live, what).toEqual(a.held);
      expect(r.timings.perColumnMs.length).toBe(256);
      for (const ms of r.timings.perColumnMs) expect(ms).toBeGreaterThan(0);
      // Every column written exactly once, and with 4 threads by all four of them.
      expect(r.columnsPerThread.reduce((s, n) => s + n, 0), what).toBe(256);
      expect(r.columnsPerThread.length, what).toBe(what.endsWith('/4') ? 4 : 1);
      for (const n of r.columnsPerThread) expect(n, what).toBeGreaterThan(0);
    }
  }, 120_000);
});

test('4 threads with the cache: a miss writes the dump, a hit rebuilds it into a shared store', async () => {
  rmSync(DIR, { recursive: true, force: true });
  const o: GenRegionOptions = {
    seed: '7', params: resolveProfile('default'), cx0: 30, cz0: -12, w: 6, h: 5, upTo: 'T', order: 'shuffled', threads: 4,
    cache: true, cacheDir: DIR,
  };
  const cold = await genRegion({ ...o, threads: 1, order: 'spiral', cache: false });
  const a = await genRegion(o);
  const b = await genRegion(o);
  expect([a.cacheHit, b.cacheHit]).toEqual([false, true]);
  expect(b.view.store.shared).toBe(true);
  expect(regionDiff(a.view, cold.view)).toBeNull();
  expect(regionDiff(b.view, cold.view)).toBeNull();
  expect(b.view.hash()).toBe(cold.view.hash());
  rmSync(DIR, { recursive: true, force: true });
}, 120_000);
```

Create `test/unit/png.test.ts`:

```ts
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { encodePng, sliceX, sliceY, sliceZ, SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb, type RgbaImage } from '../harness/png';
import { regionView } from '../harness/region';

const MiB = 1 << 20;

interface Chunk {
  type: string;
  data: Buffer;
  crc: number;
}

/** Splits a PNG into its chunks after checking the signature. */
function chunks(png: Uint8Array): Chunk[] {
  const b = Buffer.from(png);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out: Chunk[] = [];
  let o = 8;
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    out.push({ type: b.toString('latin1', o + 4, o + 8), data: b.subarray(o + 8, o + 8 + len), crc: b.readUInt32BE(o + 8 + len) });
    o += 12 + len;
  }
  expect(o).toBe(b.length);
  return out;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG whose rows all use filter 0 (what `encodePng` writes). */
function decode(png: Uint8Array): RgbaImage {
  const cs = chunks(png);
  for (const c of cs) expect(c.crc, `${c.type} CRC`).toBe(crc32(Buffer.concat([Buffer.from(c.type, 'latin1'), c.data])));
  expect(cs[0]!.type).toBe('IHDR');
  expect(cs.at(-1)!.type).toBe('IEND');
  expect(cs.at(-1)!.data.length).toBe(0);
  const ihdr = cs[0]!.data;
  expect(ihdr.length).toBe(13);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  // bit depth 8, colour type 6 (RGBA), compression 0, filter 0, interlace 0
  expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  const raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  expect(raw.length).toBe(height * (1 + 4 * width));
  const rgba = new Uint8Array(4 * width * height);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + 4 * width);
    expect(raw[row]).toBe(0);
    rgba.set(raw.subarray(row + 1, row + 1 + 4 * width), 4 * width * y);
  }
  return { width, height, rgba };
}

describe('encodePng (§6.1)', () => {
  test('signature, IHDR, chunk CRCs, IEND; the pixels decode back exactly', () => {
    const width = 7;
    const height = 5;
    const rgba = new Uint8Array(4 * width * height);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 255;
    const img = decode(encodePng({ width, height, rgba }));
    expect([img.width, img.height]).toEqual([width, height]);
    expect(Buffer.from(img.rgba).equals(Buffer.from(rgba))).toBe(true);
  });

  test('a 1 × 1 image and a wide one round-trip', () => {
    for (const [width, height] of [[1, 1], [600, 2]] as const) {
      const rgba = new Uint8Array(4 * width * height).map((_, i) => (i * 13) & 255);
      expect(Buffer.from(decode(encodePng({ width, height, rgba })).rgba).equals(Buffer.from(rgba))).toBe(true);
    }
  });

  test('rejects empty sizes and a pixel buffer of the wrong length', () => {
    expect(() => encodePng({ width: 0, height: 1, rgba: new Uint8Array(0) })).toThrow(RangeError);
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => encodePng({ width: 1.5, height: 2, rgba: new Uint8Array(12) })).toThrow(RangeError);
  });
});

describe('the Voxels palette (§5.2, §6.1)', () => {
  test('air is sky, stone grey, bedrock near black; unknown states are flagged', () => {
    expect(voxelRgb(AIR, 0, 0)).toEqual(VOXEL_COLORS.sky);
    expect(voxelRgb(STONE, 0, 0)).toEqual(VOXEL_COLORS.stone);
    expect(voxelRgb(BEDROCK, 0, 0)).toEqual(VOXEL_COLORS.bedrock);
    expect(voxelRgb(999, 0, 0)).toEqual(VOXEL_COLORS.unknown);
    const [r, g, b] = VOXEL_COLORS.bedrock;
    expect(Math.max(r, g, b)).toBeLessThan(48);
  });

  test('water is blue and darkens with depth below the water surface, down to a floor', () => {
    const at = (d: number) => voxelRgb(AIR, WATER_SOURCE, d);
    expect(at(0)).toEqual(VOXEL_COLORS.water);
    const [r, g, b] = VOXEL_COLORS.water;
    expect(b).toBeGreaterThan(Math.max(r, g));
    for (let d = 0; d < 80; d++) {
      const [, , b0] = at(d);
      const [, , b1] = at(d + 1);
      expect(b1).toBeLessThanOrEqual(b0);
    }
    expect(at(10)[2]).toBeLessThan(at(0)[2]);
    expect(at(1000)[2]).toBeGreaterThan(0);
    expect(at(1000)).toEqual(at(2000));
  });
});

/**
 * A hand-written 2 × 1 region at (0, 0): column (0, 0) is a lake (bedrock, stone to y 10, water sources to y 20,
 * air), column (1, 0) is land (stone to y 30).
 */
function handRegion(): VoxelStore {
  const s = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
  const blocks = new Uint16Array(4096);
  const fluid = new Uint8Array(4096);
  for (const [cx, solidTop, waterTop] of [[0, 10, 20], [1, 30, 30]] as const) {
    const w = s.claimColumn(cx, 0, 0);
    for (let sy = 0; sy < 24; sy++) {
      for (let i = 0; i < 4096; i++) {
        const y = -64 + 16 * sy + (i >> 8);
        blocks[i] = y === -64 ? BEDROCK : y <= solidTop ? STONE : AIR;
        fluid[i] = y > solidTop && y <= waterTop ? WATER_SOURCE : 0;
      }
      w.setProto(sy, blocks, fluid);
    }
    const a = w.aux();
    a.worldSurfaceWG.fill(waterTop + 1);
    a.oceanFloorWG.fill(solidTop + 1);
    a.surfaceBiome.fill(7 + cx);
    w.commit(1);
  }
  return s;
}

const px = (img: RgbaImage, i: number, row: number) => [...img.rgba.subarray(4 * (row * img.width + i), 4 * (row * img.width + i) + 4)];
const rgb = (c: readonly [number, number, number]) => [...c, 255];

describe('PNG slices (§6.1)', () => {
  const view = regionView(handRegion(), 0, 0, 2, 1);
  const water = (depth: number) => rgb(voxelRgb(AIR, WATER_SOURCE, depth));

  test('sliceZ: a z plane, x across, row 0 at y 319; water depth from the column surface; sea-level line on air', () => {
    const img = sliceZ(view, 3);
    expect([img.width, img.height]).toEqual([32, 384]);
    const row = (y: number) => 319 - y;
    expect(px(img, 5, row(-64))).toEqual(rgb(VOXEL_COLORS.bedrock));
    expect(px(img, 5, row(0))).toEqual(rgb(VOXEL_COLORS.stone));
    expect(px(img, 5, row(10))).toEqual(rgb(VOXEL_COLORS.stone));
    expect(px(img, 5, row(11))).toEqual(water(9));
    expect(px(img, 5, row(15))).toEqual(water(5));
    expect(px(img, 5, row(20))).toEqual(water(0));
    expect(px(img, 5, row(21))).toEqual(rgb(VOXEL_COLORS.sky));
    expect(SEA_LEVEL_Y).toBe(63);
    expect(px(img, 5, row(SEA_LEVEL_Y))).toEqual(rgb(VOXEL_COLORS.seaLevel));
    expect(px(img, 20, row(30))).toEqual(rgb(VOXEL_COLORS.stone));
    expect(px(img, 20, row(31))).toEqual(rgb(VOXEL_COLORS.sky));
    expect(px(img, 20, row(319))).toEqual(rgb(VOXEL_COLORS.sky));
  });

  test('sliceX: an x plane, z across, cropped to [yMin, yMax]', () => {
    const img = sliceX(view, 20, { yMin: 0, yMax: 63 });
    expect([img.width, img.height]).toEqual([16, 64]);
    for (let i = 0; i < 16; i++) {
      expect(px(img, i, 0)).toEqual(rgb(VOXEL_COLORS.seaLevel));
      expect(px(img, i, 63 - 30)).toEqual(rgb(VOXEL_COLORS.stone));
      expect(px(img, i, 63 - 31)).toEqual(rgb(VOXEL_COLORS.sky));
    }
    expect(decode(encodePng(img)).rgba).toEqual(img.rgba);
  });

  test('sliceY: a y plane, x across and z down', () => {
    const img = sliceY(view, 15);
    expect([img.width, img.height]).toEqual([32, 16]);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 32; x++) expect(px(img, x, z)).toEqual(x < 16 ? water(5) : rgb(VOXEL_COLORS.stone));
    }
    expect(px(sliceY(view, 63), 0, 0)).toEqual(rgb(VOXEL_COLORS.sky));
  });

  test('planes and y ranges outside the region throw', () => {
    expect(() => sliceX(view, 32)).toThrow(RangeError);
    expect(() => sliceX(view, -1)).toThrow(RangeError);
    expect(() => sliceZ(view, 16)).toThrow(RangeError);
    expect(() => sliceY(view, 320)).toThrow(RangeError);
    expect(() => sliceZ(view, 0, { yMin: 10, yMax: 9 })).toThrow(RangeError);
    expect(() => sliceZ(view, 0, { yMin: -65 })).toThrow(RangeError);
  });
});
```

Create `test/unit/regionCache.test.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { fnv1a64, fnv1a64Bytes, hex64, type Hash64 } from '../../src/core/hash';
import { seedFromInput } from '../../src/core/seed';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import {
  REGION_CACHE_DIR, REGION_CACHE_FORMAT, REGION_CACHE_PRUNE_MS, regionCacheKey, regionCachePath, SRC_KEY_SCOPE, srcKey, srcKeyOf,
  type RegionCacheHeader,
} from '../harness/cache';
import { paramsWith } from '../harness/gen';
import { genRegion, type GenRegionOptions } from '../harness/region';

const DIR = fileURLToPath(new URL('../.cache/regionCacheUnit/', import.meta.url));
const SCRATCH = fileURLToPath(new URL('../.cache/regionCacheUnitSrc/', import.meta.url));

/** Byte offset and size of the first dense slot (a block slot at an even descriptor, else fluid) of the dump's first column. */
function firstDenseSlot(b: Buffer): [number, number] {
  const d0 = 44 + 4 * 16;
  for (let i = 0; i < 48; i++) if (b.readInt32LE(d0 + 4 * i) >= 0) return [d0 + 4 * 48, i % 2 === 0 ? 8192 : 4096];
  throw new Error('the first column has no dense slot');
}

const header = (over: Partial<RegionCacheHeader> = {}): RegionCacheHeader => ({
  genKey: [1, 2], srcKey: [3, 4], cx0: -2, cz0: 5, w: 3, h: 2, upTo: 'T', ...over,
});

describe('the cache key (§6.1)', () => {
  test('REGION_CACHE_FORMAT starts at 1; the dumps live in test/.cache/regions/<hex64 of the key>.bin', () => {
    expect(REGION_CACHE_FORMAT).toBe(1);
    expect(REGION_CACHE_DIR).toBe(fileURLToPath(new URL('../.cache/regions/', import.meta.url)));
    const h = header();
    expect(regionCachePath(h)).toBe(join(REGION_CACHE_DIR, `${hex64(regionCacheKey(h))}.bin`));
    expect(regionCachePath(h, '/x/y')).toBe(join('/x/y', `${hex64(regionCacheKey(h))}.bin`));
  });

  test('the key is genKey + srcKey + format + region + upTo', () => {
    const h = header();
    expect(regionCacheKey(h)).toEqual(fnv1a64(`${hex64([1, 2])}|${hex64([3, 4])}|${REGION_CACHE_FORMAT}|-2|5|3|2|T`));
    const others: Array<Partial<RegionCacheHeader>> = [
      { genKey: [1, 3] }, { srcKey: [4, 4] }, { cx0: -1 }, { cz0: 6 }, { w: 2 }, { h: 3 },
    ];
    const all = new Set([hex64(regionCacheKey(h)), ...others.map((o) => hex64(regionCacheKey(header(o))))]);
    expect(all.size).toBe(others.length + 1);
  });
});

describe('srcKey (§6.1)', () => {
  test('the scope is src/core, src/world, src/gen, src/metrics/region.ts and test/harness/cache.ts', () => {
    expect([...SRC_KEY_SCOPE]).toEqual(['src/core/', 'src/world/', 'src/gen/', 'src/metrics/region.ts', 'test/harness/cache.ts']);
  });

  test('FNV-1a 64 of the sorted paths and bytes: any change in scope is a new key, outside scope none', () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    const put = (rel: string, text: string) => {
      mkdirSync(join(SCRATCH, rel, '..'), { recursive: true });
      writeFileSync(join(SCRATCH, rel), text);
    };
    put('src/core/a.ts', 'export const A = 1;\n');
    put('src/core/deep/b.ts', 'export const B = 2;\n');
    put('src/world/w.ts', 'w');
    put('src/gen/g.ts', 'g');
    put('src/metrics/region.ts', 'r');
    put('src/metrics/other.ts', 'o');
    put('src/ui/u.ts', 'u');
    put('test/harness/cache.ts', 'c');
    const k0 = hex64(srcKeyOf(SCRATCH));
    expect(hex64(srcKeyOf(SCRATCH))).toBe(k0);
    const changes: Array<[string, () => void, () => void, boolean]> = [
      ['a byte in src/core', () => put('src/core/deep/b.ts', 'export const B = 3;\n'), () => put('src/core/deep/b.ts', 'export const B = 2;\n'), true],
      ['a new file in src/gen', () => put('src/gen/h.ts', ''), () => rmSync(join(SCRATCH, 'src/gen/h.ts')), true],
      ['a renamed file', () => renameSync(join(SCRATCH, 'src/world/w.ts'), join(SCRATCH, 'src/world/v.ts')), () => renameSync(join(SCRATCH, 'src/world/v.ts'), join(SCRATCH, 'src/world/w.ts')), true],
      ['metrics/region.ts', () => put('src/metrics/region.ts', 'r2'), () => put('src/metrics/region.ts', 'r'), true],
      ['test/harness/cache.ts', () => put('test/harness/cache.ts', 'c2'), () => put('test/harness/cache.ts', 'c'), true],
      ['bytes moved across a file boundary', () => { put('src/core/a.ts', 'export const A = 1;\nx'); put('src/core/deep/b.ts', 'export const B = 2;'); },
        () => { put('src/core/a.ts', 'export const A = 1;\n'); put('src/core/deep/b.ts', 'export const B = 2;\n'); }, true],
      ['another metrics file', () => put('src/metrics/other.ts', 'o2'), () => put('src/metrics/other.ts', 'o'), false],
      ['src/ui', () => put('src/ui/u.ts', 'u2'), () => put('src/ui/u.ts', 'u'), false],
    ];
    for (const [what, change, undo, differs] of changes) {
      change();
      expect(hex64(srcKeyOf(SCRATCH)) !== k0, what).toBe(differs);
      undo();
      expect(hex64(srcKeyOf(SCRATCH)), `${what} undone`).toBe(k0);
    }
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  test('srcKey() is the repository key', () => {
    expect(srcKey()).toEqual(srcKeyOf(fileURLToPath(new URL('../../', import.meta.url))));
  });
});

describe('genRegion with the cache (§6.1)', () => {
  const params = paramsWith();
  const base: GenRegionOptions = {
    seed: '42', params, cx0: 3, cz0: -1, w: 2, h: 2, upTo: 'T', order: 'spiral', threads: 1, cache: true, cacheDir: DIR,
  };
  const keyOf = (o: GenRegionOptions, src: Hash64 = srcKey()): RegionCacheHeader => ({
    genKey: genKey(seedFromInput(o.seed), stageHashes(o.params)), srcKey: src, cx0: o.cx0, cz0: o.cz0, w: o.w, h: o.h, upTo: 'T',
  });
  const files = () => (existsSync(DIR) ? readdirSync(DIR).sort() : []);

  beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  test('cache: false (the default) never reads or writes a dump', async () => {
    const r = await genRegion({ ...base, cache: false });
    expect(r.cacheHit).toBe(false);
    const { cache: _c, ...noCache } = base;
    expect((await genRegion(noCache)).cacheHit).toBe(false);
    expect(files()).toEqual([]);
  });

  test('a miss generates and writes the dump; a hit rebuilds the same region through the writer API', async () => {
    const cold = await genRegion({ ...base, cache: false });
    const a = await genRegion(base);
    expect(a.cacheHit).toBe(false);
    expect(files()).toEqual([`${hex64(regionCacheKey(keyOf(base)))}.bin`]);
    const b = await genRegion(base);
    expect(b.cacheHit).toBe(true);
    expect(b.view.hash()).toBe(cold.view.hash());
    expect(b.columnsPerThread).toEqual([0]);
    expect(b.timings.perColumnMs.length).toBe(4);
    for (let cz = -1; cz < 1; cz++) {
      for (let cx = 3; cx < 5; cx++) {
        const dense = (d: Int32Array) => [...d].map((x) => (x >= 0 ? 'dense' : x));
        expect(dense(b.view.descriptors(cx, cz))).toEqual(dense(cold.view.descriptors(cx, cz)));
        const base2 = b.view.store.table.find(cx, cz);
        expect(b.view.store.table.status(base2)).toBe(1);
        expect(b.view.store.table.blockVersion(base2)).toBe(1);
      }
    }
    for (const [x, z] of [[48, -16], [79, 15], [60, -3]] as const) {
      for (let y = -64; y < 320; y += 7) expect(b.view.block(x, y, z)).toBe(cold.view.block(x, y, z));
      expect(b.view.biome(x, z)).toBe(cold.view.biome(x, z));
      expect(b.view.worldSurfaceWG(x, z)).toBe(cold.view.worldSurfaceWG(x, z));
    }
    // The live slots are exactly the dense entries plus the aux slots (nothing leaked by the rebuild).
    let dense = 0;
    let denseBytes = 0;
    for (let cz = -1; cz < 1; cz++) {
      for (let cx = 3; cx < 5; cx++) {
        const d = b.view.descriptors(cx, cz);
        for (let sy = 0; sy < 24; sy++) {
          if (d[2 * sy]! >= 0) dense++;
          if (d[2 * sy + 1]! >= 0) denseBytes++;
        }
      }
    }
    const s = b.view.store;
    expect(s.blockPool.slotCount() - s.blockPool.freeCount()).toBe(dense);
    expect(s.bytePool.slotCount() - s.bytePool.freeCount()).toBe(denseBytes + 4);
  });

  test('a changed srcKey is a miss and writes its own dump', async () => {
    await genRegion(base);
    const other: Hash64 = [0x12345678, 0x9abcdef0];
    const r = await genRegion({ ...base, srcKey: other });
    expect(r.cacheHit).toBe(false);
    expect(files()).toEqual([`${hex64(regionCacheKey(keyOf(base)))}.bin`, `${hex64(regionCacheKey(keyOf(base, other)))}.bin`].sort());
    expect((await genRegion({ ...base, srcKey: other })).cacheHit).toBe(true);
    expect((await genRegion(base)).cacheHit).toBe(true);
  });

  test('a header that disagrees with the key is a miss and the file is overwritten', async () => {
    const shifted = { ...base, cx0: 4 };
    await genRegion(shifted);
    const right = regionCachePath(keyOf(base), DIR);
    // The dump of another region under this key's name.
    copyFileSync(regionCachePath(keyOf(shifted), DIR), right);
    const wrong = readFileSync(right);
    const r = await genRegion(base);
    expect(r.cacheHit).toBe(false);
    expect(readFileSync(right).equals(wrong)).toBe(false);
    const again = await genRegion(base);
    expect(again.cacheHit).toBe(true);
    expect(again.view.hash()).toBe(r.view.hash());
  });

  test.each([
    ['a changed header field (format)', (b: Buffer) => { b.writeUInt32LE(b.readUInt32LE(4) + 1, 4); return b; }],
    ['a changed header field (w)', (b: Buffer) => { b.writeUInt32LE(3, 32); return b; }],
    ['a truncated file', (b: Buffer) => b.subarray(0, b.length - 1)],
    ['an empty file', () => Buffer.alloc(0)],
    ['a column record of another column', (b: Buffer) => { b.writeInt32LE(b.readInt32LE(44) + 64, 44); return b; }],
    ['a dense slot overwritten with one value (same length)', (b: Buffer) => { const [o, n] = firstDenseSlot(b); b.fill(0, o, o + n); return b; }],
    ['one flipped bit in a dense slot (same length)', (b: Buffer) => { b[firstDenseSlot(b)[0] + 100]! ^= 1; return b; }],
    ['one flipped bit in the last column\'s aux bytes (same length)', (b: Buffer) => { b[b.length - 2048]! ^= 4; return b; }],
    ['a trailing byte appended', (b: Buffer) => Buffer.concat([b, Buffer.alloc(1)])],
  ] as const)('%s is a miss and the file is rewritten', async (_what, damage) => {
    const first = await genRegion(base);
    const path = regionCachePath(keyOf(base), DIR);
    const good = readFileSync(path);
    const out = damage(Buffer.from(good));
    writeFileSync(path, out);
    const r = await genRegion(base);
    expect(r.cacheHit).toBe(false);
    expect(r.view.hash()).toBe(first.view.hash());
    expect(readFileSync(path).equals(good)).toBe(true);
    expect(statSync(path).size).toBe(good.length);
  });

  test('the header: magic, format, genKey, srcKey, cx0, cz0, w, h, upTo; then the first record', async () => {
    await genRegion(base);
    const b = readFileSync(regionCachePath(keyOf(base), DIR));
    const k = keyOf(base);
    expect(b.toString('latin1', 0, 4)).toBe('WIRC');
    expect([b.readUInt32LE(4), b.readUInt32LE(8), b.readUInt32LE(12), b.readUInt32LE(16), b.readUInt32LE(20)])
      .toEqual([REGION_CACHE_FORMAT, k.genKey[0], k.genKey[1], k.srcKey[0], k.srcKey[1]]);
    expect([b.readInt32LE(24), b.readInt32LE(28), b.readUInt32LE(32), b.readUInt32LE(36), b.toString('latin1', 40, 44)]).toEqual([3, -1, 2, 2, 'T\0\0\0']);
    // Column (3, −1) first: record ints 0-3 are cx, cz, status Proto, epoch 0.
    expect([b.readInt32LE(44), b.readInt32LE(48), b.readInt32LE(52), b.readInt32LE(56)]).toEqual([3, -1, 1, 0]);
    // The last 8 bytes are the FNV-1a 64 (lo, hi) of everything before them.
    expect([b.readUInt32LE(b.length - 8), b.readUInt32LE(b.length - 4)]).toEqual([...fnv1a64Bytes(b.subarray(0, b.length - 8))]);
  });

  test('writing a dump deletes the dumps of other srcKeys untouched for REGION_CACHE_PRUNE_MS; this srcKey\'s and recent ones stay', async () => {
    expect(REGION_CACHE_PRUNE_MS).toBe(15 * 60 * 1000);
    const k1: Hash64 = [1, 1];
    const k2: Hash64 = [2, 2];
    const at = (o: Partial<GenRegionOptions>, src: Hash64) => regionCachePath(keyOf({ ...base, ...o }, src), DIR);
    const age = (path: string) => { const t = new Date(Date.now() - 2 * REGION_CACHE_PRUNE_MS); utimesSync(path, t, t); };
    await genRegion({ ...base, srcKey: k1 });
    await genRegion({ ...base, cx0: 4, srcKey: k1 });
    await genRegion({ ...base, srcKey: k2 });
    // Every dump is recent: nothing is deleted, whatever its srcKey.
    expect(files()).toHaveLength(3);
    // An old dump of k1, an old dump of k2, an old file that is no dump, a foreign file and a temporary file.
    age(at({}, k1));
    age(at({}, k2));
    writeFileSync(join(DIR, 'junk.bin'), 'not a dump');
    age(join(DIR, 'junk.bin'));
    writeFileSync(join(DIR, 'notes.txt'), 'kept');
    age(join(DIR, 'notes.txt'));
    writeFileSync(join(DIR, 'x.bin.1.2.tmp'), 'in flight');
    age(join(DIR, 'x.bin.1.2.tmp'));
    // A miss of k2 writes its dump and deletes what can never hit again: the old k1 dump and the junk.
    expect((await genRegion({ ...base, cz0: 0, srcKey: k2 })).cacheHit).toBe(false);
    const left = [at({}, k2), at({ cx0: 4 }, k1), at({ cz0: 0 }, k2)].map((p) => p.slice(DIR.length)).concat(['notes.txt', 'x.bin.1.2.tmp']);
    expect(files()).toEqual(left.sort());
    // The old dump of k2 (this srcKey) stayed and still hits; k1's recent dump goes once it is old too.
    expect((await genRegion({ ...base, srcKey: k2 })).cacheHit).toBe(true);
    age(at({ cx0: 4 }, k1));
    await genRegion({ ...base, cx0: 5, srcKey: k2 });
    expect(existsSync(at({ cx0: 4 }, k1))).toBe(false);
    expect(existsSync(at({}, k2))).toBe(true);
  });
});
```

Create `test/unit/regionHarness.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { protoAt, REC_AUX_A } from '../../src/world/store/columnTable';
import { createStore } from '../../src/world/store/store';
import { ctxFor, paramsWith } from '../harness/gen';
import { genRegion, regionColumns, regionDiff, regionView, type GenRegionOptions } from '../harness/region';

const MiB = 1 << 20;

const rowMajor = (cx0: number, cz0: number, w: number, h: number): string[] => {
  const out: string[] = [];
  for (let cz = cz0; cz < cz0 + h; cz++) for (let cx = cx0; cx < cx0 + w; cx++) out.push(`${cx},${cz}`);
  return out;
};
const keys = (cols: ReadonlyArray<readonly [number, number]>) => cols.map(([cx, cz]) => `${cx},${cz}`);

describe('regionColumns (§6.1)', () => {
  test('spiral: the centre (cx0 + ⌊w/2⌋, cz0 + ⌊h/2⌋), then square rings clockwise from their north-west corner', () => {
    expect(regionColumns('spiral', 0, 0, 3, 3)).toEqual([[1, 1], [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]);
    expect(regionColumns('spiral', 0, 0, 2, 2)).toEqual([[1, 1], [0, 0], [1, 0], [0, 1]]);
    expect(regionColumns('spiral', 5, -3, 1, 1)).toEqual([[5, -3]]);
    expect(regionColumns('spiral', 0, 0, 4, 1)).toEqual([[2, 0], [3, 0], [1, 0], [0, 0]]);
  });

  test.each([[8, 8], [5, 3], [1, 7], [64, 64], [13, 2]])('spiral %i × %i: every column once, rings never shrink', (w, h) => {
    const cols = regionColumns('spiral', -4, 9, w, h);
    expect([...keys(cols)].sort()).toEqual(rowMajor(-4, 9, w, h).sort());
    const c = [-4 + Math.floor(w / 2), 9 + Math.floor(h / 2)];
    const ring = cols.map(([cx, cz]) => Math.max(Math.abs(cx - c[0]!), Math.abs(cz - c[1]!)));
    for (let i = 1; i < ring.length; i++) expect(ring[i]).toBeGreaterThanOrEqual(ring[i - 1]!);
  });

  test('shuffled: a Fisher-Yates permutation of the row-major list from Xoshiro128(shuffleSeed ?? 1)', () => {
    const a = regionColumns('shuffled', 0, 0, 4, 4);
    expect([...keys(a)].sort()).toEqual(rowMajor(0, 0, 4, 4).sort());
    expect(keys(a)).not.toEqual(rowMajor(0, 0, 4, 4));
    expect(regionColumns('shuffled', 0, 0, 4, 4, 1)).toEqual(a);
    expect(regionColumns('shuffled', 0, 0, 4, 4, 2)).not.toEqual(a);
    expect(regionColumns('shuffled', 0, 0, 4, 4, 2)).toEqual(regionColumns('shuffled', 0, 0, 4, 4, 2));
    // Pinned: a change of the draw (direction, nextInt) shows here, not as an unexplained DT1 difference.
    expect(keys(a)).toEqual(SHUFFLED_4X4_SEED_1);
    // Shifting the region shifts the permutation.
    expect(regionColumns('shuffled', 10, -20, 4, 4)).toEqual(a.map(([cx, cz]) => [cx + 10, cz - 20]));
  });

  test('rejects regions outside 1 … 64 per side and unknown orders', () => {
    expect(() => regionColumns('spiral', 0, 0, 0, 1)).toThrow(RangeError);
    expect(() => regionColumns('spiral', 0, 0, 65, 1)).toThrow(RangeError);
    expect(() => regionColumns('shuffled', 0, 0, 2, 1.5)).toThrow(RangeError);
    expect(() => regionColumns('zigzag' as 'spiral', 0, 0, 2, 2)).toThrow(/order/);
  });
});

const SHUFFLED_4X4_SEED_1 = ['1,1', '2,0', '2,2', '1,2', '1,0', '3,2', '3,1', '2,3', '3,3', '0,0', '0,2', '2,1', '0,3', '3,0', '1,3', '0,1'];

describe('regionView (§6.1)', () => {
  const store = createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
  genRegionInProcess(store, ctxFor('42'), -2, 3, 2, 2);
  const view = regionView(store, -2, 3, 2, 2);

  test('reads proto voxels, biome and the _WG heightmaps at world x, z through the store', () => {
    for (const [x, z] of [[-32, 48], [-1, 79], [-17, 60]] as const) {
      const v = store.proto(x >> 4, z >> 4)!;
      const lx = x & 15;
      const lz = z & 15;
      for (const y of [-64, -10, 40, 62, 63, 64, 100, 319]) {
        expect(view.block(x, y, z)).toBe(v.block(lx, y, lz));
        expect(view.fluid(x, y, z)).toBe(v.fluid(lx, y, lz));
      }
      const a = v.aux()!;
      expect(view.biome(x, z)).toBe(a.surfaceBiome[lz * 16 + lx]);
      expect(view.worldSurfaceWG(x, z)).toBe(a.worldSurfaceWG[lz * 16 + lx]);
      expect(view.oceanFloorWG(x, z)).toBe(a.oceanFloorWG[lz * 16 + lx]);
    }
  });

  test('descriptors(cx, cz): a copy of the 24 proto descriptors (blocks, fluid per section)', () => {
    const d = view.descriptors(-1, 4);
    expect(d.length).toBe(48);
    const base = store.table.find(-1, 4);
    for (let sy = 0; sy < 24; sy++) expect([d[2 * sy], d[2 * sy + 1]]).toEqual([...store.table.ints.subarray(protoAt(base, sy), protoAt(base, sy) + 2)]);
    d[0] = 12345;
    expect(view.descriptors(-1, 4)[0]).not.toBe(12345);
    expect(store.table.ints[base + REC_AUX_A]).toBeGreaterThanOrEqual(0);
  });

  test('hash(): regionHash of the region or of a sub-window, as hex64', () => {
    expect(view.hash()).toBe(hex64(regionHash(store, -2, 3, 2, 2)));
    expect(view.hash(-1, 3, 1, 2)).toBe(hex64(regionHash(store, -1, 3, 1, 2)));
    expect(() => view.hash(-3, 3, 2, 2)).toThrow(RangeError);
    expect(() => view.hash(-2, 3, 3, 1)).toThrow(RangeError);
  });

  test('reads outside the region, or at y outside −64 … 319, throw', () => {
    expect(() => view.block(-33, 0, 48)).toThrow(RangeError);
    expect(() => view.block(0, 0, 48)).toThrow(RangeError);
    expect(() => view.fluid(-32, 0, 80)).toThrow(RangeError);
    expect(() => view.biome(-32, 47)).toThrow(RangeError);
    expect(() => view.block(-32, 320, 48)).toThrow(RangeError);
    expect(() => view.descriptors(0, 3)).toThrow(RangeError);
    expect(() => regionView(store, -2, 3, 3, 2)).toThrow(/no proto set/);
  });
});

describe('regionDiff (§6.1)', () => {
  const twin = () => {
    const s = createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
    genRegionInProcess(s, ctxFor('42'), 0, 0, 2, 2);
    return regionView(s, 0, 0, 2, 2);
  };

  test('null for the same proto data; names the first column and section that differ', () => {
    const a = twin();
    const b = twin();
    expect(regionDiff(a, b)).toBeNull();
    const base = b.store.table.find(1, 1);
    const sy = [...Array(24).keys()].find((k) => b.store.table.ints[protoAt(base, k)]! >= 0)!;
    const words = b.store.blockPool.u16(b.store.table.ints[protoAt(base, sy)]!);
    words[100] = words[100]! ^ 1;
    expect(regionDiff(a, b)).toBe(`column (1, 1) section ${sy}: blocks differ`);
    words[100] = words[100]! ^ 1;
    expect(regionDiff(a, b)).toBeNull();
    const aux = b.store.proto(0, 1)!.aux()!;
    aux.tintTH[5] = 1;
    expect(regionDiff(a, b)).toBe('column (0, 1): aux A differs');
    aux.tintTH[5] = 0;
    expect(regionDiff(a, regionView(b.store, 0, 0, 2, 1))).toBe('the views cover other regions');
  });

  test('uniform sections compare by value; a uniform section never equals a dense one with the same values', () => {
    const one = (dense: boolean, state5 = 1) => {
      const s = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
      const w = s.claimColumn(0, 0, 0);
      for (let sy = 0; sy < 24; sy++) w.setProto(sy, new Uint16Array(4096).fill(sy === 5 ? state5 : 1), new Uint8Array(4096));
      w.commit(1);
      if (dense) {
        // Rewrite section 3's fluid as a dense slot holding all zeros (as a stale layout would).
        const base = s.table.find(0, 0);
        const slot = s.bytePool.alloc();
        s.bytePool.u8(slot).fill(0);
        s.table.ints[protoAt(base, 3) + 1] = slot;
      }
      return regionView(s, 0, 0, 1, 1);
    };
    expect(regionDiff(one(false), one(false))).toBeNull();
    expect(regionDiff(one(false), one(false, 2))).toBe('column (0, 0) section 5: blocks differ');
    expect(regionDiff(one(false), one(true))).toBe('column (0, 0) section 3: fluid differs');
  });
});

describe('genRegion with 1 thread (§6.1)', () => {
  const base: GenRegionOptions = { seed: '42', params: paramsWith(), cx0: -2, cz0: -2, w: 4, h: 4, upTo: 'T', order: 'spiral', threads: 1 };

  test('spiral and shuffled give the in-process region; a plain ArrayBuffer store; per-column timings', async () => {
    const ref = createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
    genRegionInProcess(ref, ctxFor('42'), -2, -2, 4, 4);
    const want = hex64(regionHash(ref, -2, -2, 4, 4));
    for (const order of ['spiral', 'shuffled'] as const) {
      const r = await genRegion({ ...base, order, shuffleSeed: 5 });
      expect(r.view.hash(), order).toBe(want);
      expect(r.cacheHit).toBe(false);
      expect(r.view.store.shared).toBe(false);
      expect(r.columnsPerThread).toEqual([16]);
      expect(r.timings.perColumnMs.length).toBe(16);
      for (const ms of r.timings.perColumnMs) expect(ms).toBeGreaterThan(0);
      expect(r.timings.totalMs).toBeGreaterThan(0);
      for (let cz = -2; cz < 2; cz++) {
        for (let cx = -2; cx < 2; cx++) expect(layout([...r.view.descriptors(cx, cz)])).toEqual(layout(descriptorsOf(ref, cx, cz)));
      }
    }
  });

  test('the profile params reach the stage', async () => {
    const a = await genRegion(base);
    const b = await genRegion({ ...base, params: paramsWith({ climate: { scaleMul: 4 } }) });
    expect(b.view.hash()).not.toBe(a.view.hash());
  });

  test('rejects bad options before generating', async () => {
    await expect(genRegion({ ...base, w: 0 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, h: 65 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, threads: 2 as 1 })).rejects.toThrow(/threads/);
    await expect(genRegion({ ...base, upTo: 'S' as 'T' })).rejects.toThrow(/upTo/);
    await expect(genRegion({ ...base, order: 'zigzag' as 'spiral' })).rejects.toThrow(/order/);
  });
});

/** Descriptors with every dense slot id replaced by 'dense': slot ids depend on the generation order. */
const layout = (d: number[]) => d.map((x) => (x >= 0 ? 'dense' : x));

/** The 24 proto descriptors of a column, read from the record. */
function descriptorsOf(store: ReturnType<typeof createStore>, cx: number, cz: number): number[] {
  const base = store.table.find(cx, cz);
  return [...store.table.ints.subarray(protoAt(base, 0), protoAt(base, 0) + 48)];
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project integration --project unit test/integration/region.test.ts test/unit/png.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts`

Expected: FAIL (the dry run printed, in part):

```
FAIL  |integration| test/integration/region.test.ts [ test/integration/region.test.ts ]
Error: Cannot find module '../harness/region' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/integration/region.test.ts
FAIL  |unit| test/unit/png.test.ts [ test/unit/png.test.ts ]
Error: Cannot find module '../harness/png' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/png.test.ts
FAIL  |unit| test/unit/regionCache.test.ts [ test/unit/regionCache.test.ts ]
Error: Cannot find module '../harness/cache' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/regionCache.test.ts
FAIL  |unit| test/unit/regionHarness.test.ts [ test/unit/regionHarness.test.ts ]
Error: Cannot find module '../harness/region' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/regionHarness.test.ts
Test Files  4 failed (4)
Tests  no tests
```

- [ ] **Step 3: Implement**

Create `test/harness/cache.ts`:

```ts
/**
 * The region cache (SP3a spec §6.1): a dump of a generated region's proto columns under
 * `test/.cache/regions/<hex64 of the key>.bin`, keyed by `genKey + srcKey + REGION_CACHE_FORMAT + (cx0, cz0, w, h)
 * + upTo`. `srcKey` is the FNV-1a 64 of the sorted paths and bytes of the code the dump depends on, read at test
 * time, so any code change is a miss without a hand-bumped constant; `REGION_CACHE_FORMAT` changes with the dump
 * layout. A hit rebuilds each column through the writer API (`claimColumn`, `setProto` per section with the
 * expanded data, the aux bytes, `commit(1)`), so uniform and dense decisions are made again by the same code.
 *
 * Dump layout (little-endian): a 44-byte header (magic `WIRC`, format u32, genKey lo/hi u32, srcKey lo/hi u32,
 * cx0, cz0 i32, w, h u32, upTo as 4 ASCII bytes padded with 0), then per column, cz outer and cx inner: record ints
 * 0-15 (i32), the 24 proto descriptors (blocks, fluid: 48 i32), the dense slots they reference in descriptor order
 * (8192 bytes per block slot, 4096 per fluid slot), and the 4096 aux A bytes (zeros when the column has none); last,
 * the FNV-1a 64 (lo, hi u32) of every byte before it. Anything that disagrees with the expected header, the layout or
 * the checksum is a miss (a damaged dump is never rebuilt); the caller regenerates and overwrites.
 *
 * Every code change is a new `srcKey`, so the dumps of earlier code can never hit again: writing a dump deletes the
 * `.bin` files of its directory that are not dumps of this format and `srcKey` and were not modified for
 * `REGION_CACHE_PRUNE_MS` (the grace keeps a concurrent run of other code from losing the dump it just wrote).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { createFnv64, fnv1a64, hex64, type Hash64 } from '../../src/core/hash';
import { protoAt, REC_AUX_A, REC_CLAIMED, REC_CX, REC_CZ, REC_STATUS, STATUS_PROTO } from '../../src/world/store/columnTable';
import type { VoxelStore } from '../../src/world/store/store';

/** Bumped whenever the dump layout changes. */
export const REGION_CACHE_FORMAT = 1;
/** A dump that cannot hit for the current code is deleted once it has not been modified for this long (15 min). */
export const REGION_CACHE_PRUNE_MS = 15 * 60 * 1000;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REGION_CACHE_DIR = fileURLToPath(new URL('../.cache/regions/', import.meta.url));

/** What `srcKey` hashes, relative to the repository root: directories end with '/'. */
export const SRC_KEY_SCOPE: readonly string[] = Object.freeze(['src/core/', 'src/world/', 'src/gen/', 'src/metrics/region.ts', 'test/harness/cache.ts']);

export type RegionUpTo = 'T';

export interface RegionCacheHeader {
  readonly genKey: Hash64;
  readonly srcKey: Hash64;
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
  readonly upTo: RegionUpTo;
}

const MAGIC = 'WIRC';
const HEADER_BYTES = 44;
const RECORD_HEAD = 16;
const DESCRIPTORS = 48;
const COLUMN_HEAD_BYTES = 4 * (RECORD_HEAD + DESCRIPTORS);
const BLOCK_SLOT = 8192;
const FLUID_SLOT = 4096;
const AUX_BYTES = 4096;
/** The trailing FNV-1a 64 of the dump. */
const CHECKSUM_BYTES = 8;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * FNV-1a 64 over the files of `scope` under `root` (directories recursively), sorted by their '/'-separated path
 * relative to `root`: per file its path (UTF-8), a 0 byte, its length (u32 LE) and its bytes. Missing entries are
 * skipped.
 */
export function srcKeyOf(root: string, scope: readonly string[] = SRC_KEY_SCOPE): Hash64 {
  const files: string[] = [];
  for (const entry of scope) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    if (!entry.endsWith('/')) {
      files.push(entry);
      continue;
    }
    for (const rel of readdirSync(abs, { recursive: true, encoding: 'utf8' })) {
      if (statSync(join(abs, rel)).isFile()) files.push(entry + rel.split(sep).join('/'));
    }
  }
  files.sort();
  const fnv = createFnv64();
  for (const path of files) {
    const bytes = readFileSync(join(root, path));
    fnv.update(Buffer.from(path, 'utf8')).updateU8(0).updateU32LE(bytes.length).update(bytes);
  }
  return fnv.digest();
}

let repoSrcKey: Hash64 | null = null;

/** `srcKeyOf` the repository, computed once per process. */
export function srcKey(): Hash64 {
  repoSrcKey ??= srcKeyOf(ROOT);
  return repoSrcKey;
}

export function regionCacheKey(h: RegionCacheHeader): Hash64 {
  return fnv1a64(`${hex64(h.genKey)}|${hex64(h.srcKey)}|${REGION_CACHE_FORMAT}|${h.cx0}|${h.cz0}|${h.w}|${h.h}|${h.upTo}`);
}

export function regionCachePath(h: RegionCacheHeader, dir: string = REGION_CACHE_DIR): string {
  return join(dir, `${hex64(regionCacheKey(h))}.bin`);
}

function checkHost(): void {
  if (!LITTLE_ENDIAN) throw new Error('region cache: block slots are dumped as native u16, which needs a little-endian host');
}

function writeHeader(b: Buffer, h: RegionCacheHeader): void {
  b.write(MAGIC, 0, 'latin1');
  b.writeUInt32LE(REGION_CACHE_FORMAT, 4);
  b.writeUInt32LE(h.genKey[0], 8);
  b.writeUInt32LE(h.genKey[1], 12);
  b.writeUInt32LE(h.srcKey[0], 16);
  b.writeUInt32LE(h.srcKey[1], 20);
  b.writeInt32LE(h.cx0, 24);
  b.writeInt32LE(h.cz0, 28);
  b.writeUInt32LE(h.w, 32);
  b.writeUInt32LE(h.h, 36);
  b.write(h.upTo.padEnd(4, '\0'), 40, 'latin1');
}

/** The record base of (cx, cz), which must hold it at status Proto (what `upTo: 'T'` leaves). */
function protoBase(store: VoxelStore, cx: number, cz: number): number {
  const base = store.table.find(cx, cz);
  if (base < 0 || store.table.status(base) !== STATUS_PROTO) throw new Error(`region cache: column (${cx}, ${cz}) is not at status Proto`);
  return base;
}

/** The dump of the region `h` describes, read from `store`. */
export function encodeRegionDump(store: VoxelStore, h: RegionCacheHeader): Uint8Array {
  checkHost();
  const ints = store.table.ints;
  let size = HEADER_BYTES + CHECKSUM_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      const base = protoBase(store, cx, cz);
      size += COLUMN_HEAD_BYTES + AUX_BYTES;
      for (let sy = 0; sy < 24; sy++) {
        const p = protoAt(base, sy);
        if (ints[p]! >= 0) size += BLOCK_SLOT;
        if (ints[p + 1]! >= 0) size += FLUID_SLOT;
      }
    }
  }
  const b = Buffer.alloc(size);
  writeHeader(b, h);
  let o = HEADER_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      const base = protoBase(store, cx, cz);
      for (let i = 0; i < RECORD_HEAD; i++, o += 4) b.writeInt32LE(Atomics.load(ints, base + i), o);
      const d0 = protoAt(base, 0);
      for (let i = 0; i < DESCRIPTORS; i++, o += 4) b.writeInt32LE(ints[d0 + i]!, o);
      for (let sy = 0; sy < 24; sy++) {
        const p = protoAt(base, sy);
        if (ints[p]! >= 0) {
          const v = store.blockPool.u16(ints[p]!);
          b.set(new Uint8Array(v.buffer, v.byteOffset, BLOCK_SLOT), o);
          o += BLOCK_SLOT;
        }
        if (ints[p + 1]! >= 0) {
          b.set(store.bytePool.u8(ints[p + 1]!), o);
          o += FLUID_SLOT;
        }
      }
      if (ints[base + REC_AUX_A]! >= 0) {
        const a = store.proto(cx, cz)!.aux()!.worldSurfaceWG;
        b.set(new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES), o);
      }
      o += AUX_BYTES;
    }
  }
  const sum = checksum(b.subarray(0, o));
  b.writeUInt32LE(sum[0], o);
  b.writeUInt32LE(sum[1], o + 4);
  o += CHECKSUM_BYTES;
  if (o !== size) throw new Error(`region cache: wrote ${o} of ${size} bytes`);
  return b;
}

const checksum = (bytes: Uint8Array): Hash64 => createFnv64().update(bytes).digest();

interface DumpColumn {
  readonly cx: number;
  readonly cz: number;
  readonly record: Int32Array;
  readonly descriptors: Int32Array;
  /** Per section: the dense slot's bytes, or null for a uniform entry. */
  readonly blocks: Array<Uint8Array | null>;
  readonly fluid: Array<Uint8Array | null>;
  readonly aux: Uint8Array;
}

/** The columns of a dump whose header and layout agree with `h`, or null (a miss). Reads nothing into a store. */
export function parseRegionDump(bytes: Uint8Array, h: RegionCacheHeader): DumpColumn[] | null {
  const all = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (all.length < HEADER_BYTES + CHECKSUM_BYTES) return null;
  const want = Buffer.alloc(HEADER_BYTES);
  writeHeader(want, h);
  if (!all.subarray(0, HEADER_BYTES).equals(want)) return null;
  // The payload must be the bytes the writer summed: a damaged slot or aux byte of the right length is a miss too.
  const b = all.subarray(0, all.length - CHECKSUM_BYTES);
  const sum = checksum(b);
  if (all.readUInt32LE(b.length) !== sum[0] || all.readUInt32LE(b.length + 4) !== sum[1]) return null;
  const out: DumpColumn[] = [];
  let o = HEADER_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      if (o + COLUMN_HEAD_BYTES > b.length) return null;
      const record = new Int32Array(RECORD_HEAD);
      for (let i = 0; i < RECORD_HEAD; i++, o += 4) record[i] = b.readInt32LE(o);
      const descriptors = new Int32Array(DESCRIPTORS);
      for (let i = 0; i < DESCRIPTORS; i++, o += 4) descriptors[i] = b.readInt32LE(o);
      if (record[REC_CX] !== cx || record[REC_CZ] !== cz || record[REC_STATUS] !== STATUS_PROTO || record[REC_CLAIMED] !== 1) return null;
      const blocks: Array<Uint8Array | null> = [];
      const fluid: Array<Uint8Array | null> = [];
      for (let sy = 0; sy < 24; sy++) {
        const bc = descriptors[2 * sy]!;
        const fc = descriptors[2 * sy + 1]!;
        if (bc < -0x10000 || fc < -0x100) return null;
        if (bc >= 0) {
          if (o + BLOCK_SLOT > b.length) return null;
          blocks.push(b.subarray(o, o + BLOCK_SLOT));
          o += BLOCK_SLOT;
        } else blocks.push(null);
        if (fc >= 0) {
          if (o + FLUID_SLOT > b.length) return null;
          fluid.push(b.subarray(o, o + FLUID_SLOT));
          o += FLUID_SLOT;
        } else fluid.push(null);
      }
      if (o + AUX_BYTES > b.length) return null;
      out.push({ cx, cz, record, descriptors, blocks, fluid, aux: b.subarray(o, o + AUX_BYTES) });
      o += AUX_BYTES;
    }
  }
  return o === b.length ? out : null;
}

/**
 * Rebuilds the parsed columns into `store` through the writer API (epoch from the dump, `commit(1)`); returns the
 * milliseconds per column, in dump order (row-major). Throws when the store decides another uniform/dense layout
 * than the dump records (a store change the format did not track).
 */
export function rebuildRegion(store: VoxelStore, cols: readonly DumpColumn[]): Float64Array {
  checkHost();
  const ms = new Float64Array(cols.length);
  const blocks = new Uint16Array(4096);
  const blockBytes = new Uint8Array(blocks.buffer);
  const fluid = new Uint8Array(4096);
  const ints = store.table.ints;
  cols.forEach((c, k) => {
    const t0 = performance.now();
    const w = store.claimColumn(c.cx, c.cz, c.record[3]!);
    for (let sy = 0; sy < 24; sy++) {
      const bs = c.blocks[sy]!;
      const fs = c.fluid[sy]!;
      if (bs === null) blocks.fill(-1 - c.descriptors[2 * sy]!);
      else blockBytes.set(bs);
      if (fs === null) fluid.fill(-1 - c.descriptors[2 * sy + 1]!);
      else fluid.set(fs);
      w.setProto(sy, blocks, fluid);
    }
    if (c.record[REC_AUX_A]! >= 0) {
      const a = w.aux().worldSurfaceWG;
      new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES).set(c.aux);
    }
    w.commit(1);
    ms[k] = performance.now() - t0;
    const d0 = protoAt(store.table.find(c.cx, c.cz), 0);
    for (let i = 0; i < DESCRIPTORS; i++) {
      const was = c.descriptors[i]!;
      const now = ints[d0 + i]!;
      if ((was >= 0) !== (now >= 0) || (was < 0 && was !== now)) {
        throw new Error(`region cache: column (${c.cx}, ${c.cz}) rebuilt descriptor ${i} as ${now}, the dump has ${was}`);
      }
    }
  });
  return ms;
}

/**
 * On a hit, rebuilds the dump at `path` into `store` and returns the milliseconds per column (row-major); null on a
 * miss (no file or one that cannot be read, another header, a malformed layout, a wrong checksum), in which case
 * `store` is untouched.
 */
export function readRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): Float64Array | null {
  if (!existsSync(path)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null; // deleted or replaced under us: a miss
  }
  const cols = parseRegionDump(bytes, h);
  return cols === null ? null : rebuildRegion(store, cols);
}

/** The first HEADER_BYTES of a file, or null when it is shorter or cannot be read. */
function readHead(path: string): Buffer | null {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(HEADER_BYTES);
    return readSync(fd, head, 0, HEADER_BYTES, 0) === HEADER_BYTES ? head : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/**
 * Deletes the `.bin` files of `dir` that can never hit for code whose srcKey is `src` (not a dump of this format, or a
 * dump of another srcKey: an earlier version of the code) and that were last modified at least `REGION_CACHE_PRUNE_MS`
 * before `now`. Dumps of `src` (other regions, seeds or params) and every other file are kept. Returns the deleted
 * names, sorted.
 */
export function pruneRegionDumps(dir: string, src: Hash64, now: number = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.bin')) continue;
    const path = join(dir, name);
    const head = readHead(path);
    const live = head !== null && head.toString('latin1', 0, 4) === MAGIC && head.readUInt32LE(4) === REGION_CACHE_FORMAT
      && head.readUInt32LE(16) === src[0] && head.readUInt32LE(20) === src[1];
    if (live) continue;
    try {
      if (now - statSync(path).mtimeMs < REGION_CACHE_PRUNE_MS) continue;
      unlinkSync(path);
      out.push(name);
    } catch {
      // already gone (another process pruned it)
    }
  }
  return out.sort();
}

/**
 * Writes the dump of the region `h` describes to `path`, atomically (a temporary file, then a rename), then prunes the
 * dumps of its directory that can never hit again (`pruneRegionDumps`).
 */
export function writeRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): void {
  const bytes = encodeRegionDump(store, h);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${threadId}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  pruneRegionDumps(dirname(path), h.srcKey);
}
```

Create `test/harness/png.ts`:

```ts
/**
 * PNG slices of a generated region (SP3a spec §6.1): a small PNG encoder over `node:zlib` (8-bit RGBA, one IDAT,
 * filter 0 on every row) and vertical (an x or a z plane) and horizontal (a y plane) slices drawn with the Voxels
 * palette of the cut line (§5.2): air in a sky colour, stone grey, bedrock near black, water blue darkening with
 * depth below the water surface, and the sea-level line at y 63 on the air of vertical slices.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fluidType } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import type { RegionView } from './region';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** 4 bytes per pixel, row-major from the top-left pixel. */
  readonly rgba: Uint8Array;
}

type Rgb = readonly [number, number, number];

/** The Voxels palette (§5.2). `unknown` marks a state the palette does not know (none in SP3a). */
export const VOXEL_COLORS = {
  sky: [168, 204, 255],
  seaLevel: [112, 150, 206],
  stone: [125, 125, 125],
  bedrock: [28, 28, 30],
  water: [40, 92, 222],
  unknown: [255, 0, 255],
} as const satisfies Record<string, Rgb>;

export const SEA_LEVEL_Y = 63;
/** Water loses this share of its brightness per block of depth, down to `WATER_FLOOR`. */
const WATER_FADE = 1 / 48;
const WATER_FLOOR = 0.3;
const MIN_Y = -64;
const MAX_Y = 319;

/**
 * The colour of a voxel: its block state's, or water's when the fluid byte holds a fluid on air, darkened with
 * `depth` (blocks below the water surface of its column, 0 at the surface).
 */
export function voxelRgb(state: number, fluid: number, depth: number): Rgb {
  if (state === AIR && fluidType(fluid) !== 0) {
    const f = Math.max(WATER_FLOOR, 1 - Math.max(0, depth) * WATER_FADE);
    const [r, g, b] = VOXEL_COLORS.water;
    return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
  }
  if (state === AIR) return VOXEL_COLORS.sky;
  if (state === STONE) return VOXEL_COLORS.stone;
  if (state === BEDROCK) return VOXEL_COLORS.bedrock;
  return VOXEL_COLORS.unknown;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes an RGBA image as a PNG file (colour type 6, bit depth 8, no interlace). */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, rgba } = img;
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 0x7fffffff) throw new RangeError(`encodePng: ${name} ${v}`);
  }
  if (rgba.length !== 4 * width * height) throw new RangeError(`encodePng: ${rgba.length} bytes for ${width} × ${height} RGBA`);
  const raw = Buffer.alloc(height * (1 + 4 * width));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(4 * width * y, 4 * width * (y + 1)), y * (1 + 4 * width) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export function writePng(path: string, img: RgbaImage): void {
  writeFileSync(path, encodePng(img));
}

export interface VerticalSliceOptions {
  /** Lowest y drawn (default −64); the bottom row. */
  readonly yMin?: number;
  /** Highest y drawn (default 319); row 0. */
  readonly yMax?: number;
}

function yRange(opts: VerticalSliceOptions): [number, number] {
  const yMin = opts.yMin ?? MIN_Y;
  const yMax = opts.yMax ?? MAX_Y;
  if (!Number.isInteger(yMin) || !Number.isInteger(yMax) || yMin < MIN_Y || yMax > MAX_Y || yMin > yMax) {
    throw new RangeError(`slice: y range ${yMin} … ${yMax} outside ${MIN_Y} … ${MAX_Y}`);
  }
  return [yMin, yMax];
}

function setPx(rgba: Uint8Array, at: number, c: Rgb): void {
  rgba[at] = c[0];
  rgba[at + 1] = c[1];
  rgba[at + 2] = c[2];
  rgba[at + 3] = 255;
}

/** One voxel's colour; the water surface of its column is `worldSurfaceWG − 1` (§3.4: water counts). */
function colorAt(view: RegionView, x: number, y: number, z: number, line: boolean): Rgb {
  const state = view.block(x, y, z);
  const fluid = view.fluid(x, y, z);
  if (line && y === SEA_LEVEL_Y && state === AIR && fluidType(fluid) === 0) return VOXEL_COLORS.seaLevel;
  return voxelRgb(state, fluid, view.worldSurfaceWG(x, z) - 1 - y);
}

function vertical(view: RegionView, at: (i: number) => [number, number], width: number, opts: VerticalSliceOptions): RgbaImage {
  const [yMin, yMax] = yRange(opts);
  const height = yMax - yMin + 1;
  const rgba = new Uint8Array(4 * width * height);
  for (let i = 0; i < width; i++) {
    const [x, z] = at(i);
    for (let y = yMax; y >= yMin; y--) setPx(rgba, 4 * ((yMax - y) * width + i), colorAt(view, x, y, z, true));
  }
  return { width, height, rgba };
}

function checkPlane(what: string, v: number, lo: number, n: number): void {
  if (!Number.isInteger(v) || v < lo || v >= lo + n) throw new RangeError(`${what} = ${v} outside the region (${lo} … ${lo + n - 1})`);
}

/** The x plane at `x`: z across (the region's z extent, increasing), y down from `yMax`. */
export function sliceX(view: RegionView, x: number, opts: VerticalSliceOptions = {}): RgbaImage {
  checkPlane('sliceX: x', x, 16 * view.cx0, 16 * view.w);
  const z0 = 16 * view.cz0;
  return vertical(view, (i) => [x, z0 + i], 16 * view.h, opts);
}

/** The z plane at `z`: x across (the region's x extent, increasing), y down from `yMax`. */
export function sliceZ(view: RegionView, z: number, opts: VerticalSliceOptions = {}): RgbaImage {
  checkPlane('sliceZ: z', z, 16 * view.cz0, 16 * view.h);
  const x0 = 16 * view.cx0;
  return vertical(view, (i) => [x0 + i, z], 16 * view.w, opts);
}

/** The y plane at `y`: x across, z down (north at the top); no sea-level line. */
export function sliceY(view: RegionView, y: number): RgbaImage {
  checkPlane('sliceY: y', y, MIN_Y, MAX_Y - MIN_Y + 1);
  const width = 16 * view.w;
  const height = 16 * view.h;
  const x0 = 16 * view.cx0;
  const z0 = 16 * view.cz0;
  const rgba = new Uint8Array(4 * width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) setPx(rgba, 4 * (j * width + i), colorAt(view, x0 + i, y, z0 + j, false));
  }
  return { width, height, rgba };
}
```

Create `test/harness/region.ts`:

```ts
/**
 * The region harness `genRegion` (SP3a spec §6.1): generates a w × h region of columns up to the provisional T
 * stage, in a chosen order, on 1 thread (a plain `ArrayBuffer` store, `fillColumnT` in process) or on 4
 * `worker_threads` (a growable `SharedArrayBuffer` store; each worker runs `regionWorker.ts`, and the main thread
 * hands the next column of the list to whichever worker is idle, so every column is written by exactly one thread),
 * optionally through the region cache (`cache.ts`). The result is read through a `RegionView`, which reads the
 * store per column and never stitches the region into one array.
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { hex64 } from '../../src/core/hash';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { createGenContext } from '../../src/gen/context';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { protoAt } from '../../src/world/store/columnTable';
import { createStore, type ColumnView, type VoxelStore } from '../../src/world/store/store';
import { readRegionDump, regionCachePath, srcKey, writeRegionDump, type RegionCacheHeader, type RegionUpTo } from './cache';
import { buildNodeTaskWorker } from './nodeWorker';
import type { RegionAttachMsg, RegionColumnMsg, RegionWorkerReply } from './regionWorker';

export type RegionOrder = 'spiral' | 'shuffled';

export interface GenRegionOptions {
  /** World seed text, as typed in the UI ('42'). */
  readonly seed: string;
  readonly params: Params;
  readonly cx0: number;
  readonly cz0: number;
  /** 1 … 64 columns per side (a larger region would collide on the 64 × 64 torus). */
  readonly w: number;
  readonly h: number;
  readonly upTo: RegionUpTo;
  readonly order: RegionOrder;
  readonly threads: 1 | 4;
  /** Read the dump on a hit, write it on a miss (default false: never touch a dump). */
  readonly cache?: boolean;
  /** Seed of the `shuffled` permutation (default 1). */
  readonly shuffleSeed?: number;
  /** Test seam: the directory of the dumps (default `test/.cache/regions/`). */
  readonly cacheDir?: string;
  /** Test seam: the source key to use instead of the repository's (`srcKey()`). */
  readonly srcKey?: RegionCacheHeader['srcKey'];
  /** Where the 4-thread worker bundle is built, under test/.cache/ (default `regionWorker`; one per test file). */
  readonly workerDir?: string;
}

/** Proto data of a generated region, read through the store. x, z are world block coordinates inside the region. */
export interface RegionView {
  readonly store: VoxelStore;
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
  block(x: number, y: number, z: number): number;
  fluid(x: number, y: number, z: number): number;
  /** The zoomed surface biome (aux A `surfaceBiome`). */
  biome(x: number, z: number): number;
  worldSurfaceWG(x: number, z: number): number;
  oceanFloorWG(x: number, z: number): number;
  /** A copy of column (cx, cz)'s 24 proto descriptors: blocks then fluid per section (slot id, or −1 − value). */
  descriptors(cx: number, cz: number): Int32Array;
  /** hex64 of `regionHash` over the region, or over a sub-window of it. */
  hash(cx0?: number, cz0?: number, w?: number, h?: number): string;
}

export interface RegionResult {
  readonly view: RegionView;
  /** `perColumnMs` is indexed row-major in the region, `(cz − cz0)·w + (cx − cx0)`; on a hit it holds the rebuild. */
  readonly timings: { readonly perColumnMs: Float64Array; readonly totalMs: number };
  readonly cacheHit: boolean;
  /** Columns generated by each thread (one entry per thread; `[0]` on a cache hit). */
  readonly columnsPerThread: number[];
}

function checkSize(what: string, w: number, h: number): void {
  for (const [name, v] of [['w', w], ['h', h]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 64) throw new RangeError(`${what}: ${name} = ${v} outside 1 … 64`);
  }
}

/**
 * The column list (§6.1). `spiral`: the centre (cx0 + ⌊w/2⌋, cz0 + ⌊h/2⌋), then square rings of growing radius r,
 * each walked clockwise seen from +y from its north-west corner (cx − r, cz − r): east along the north edge, south
 * along the east edge, west along the south edge, north along the west edge; columns outside the region are
 * skipped. `shuffled`: a Fisher-Yates permutation of the row-major list (cz outer), i from n − 1 down to 1 swapping
 * with j = `nextInt(i + 1)` of `Xoshiro128(shuffleSeed)`.
 */
export function regionColumns(order: RegionOrder, cx0: number, cz0: number, w: number, h: number, shuffleSeed = 1): Array<[number, number]> {
  checkSize('regionColumns', w, h);
  const out: Array<[number, number]> = [];
  if (order === 'shuffled') {
    for (let cz = cz0; cz < cz0 + h; cz++) for (let cx = cx0; cx < cx0 + w; cx++) out.push([cx, cz]);
    const rng = new Xoshiro128(shuffleSeed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  if (order !== 'spiral') throw new Error(`regionColumns: unknown order '${String(order)}'`);
  const cx = cx0 + Math.floor(w / 2);
  const cz = cz0 + Math.floor(h / 2);
  const inside = (x: number, z: number) => x >= cx0 && x < cx0 + w && z >= cz0 && z < cz0 + h;
  const add = (x: number, z: number) => {
    if (inside(x, z)) out.push([x, z]);
  };
  add(cx, cz);
  const rMax = Math.max(cx - cx0, cx0 + w - 1 - cx, cz - cz0, cz0 + h - 1 - cz);
  for (let r = 1; r <= rMax; r++) {
    for (let x = cx - r; x <= cx + r; x++) add(x, cz - r);
    for (let z = cz - r + 1; z <= cz + r; z++) add(cx + r, z);
    for (let x = cx + r - 1; x >= cx - r; x--) add(x, cz + r);
    for (let z = cz + r - 1; z > cz - r; z--) add(cx - r, z);
  }
  return out;
}

/** A `RegionView` over the w × h region at (cx0, cz0) of `store`; every column must hold its proto set. */
export function regionView(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): RegionView {
  checkSize('regionView', w, h);
  const views: ColumnView[] = [];
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = store.proto(cx, cz);
      if (v === null) throw new Error(`regionView: column (${cx}, ${cz}) has no proto set in the store`);
      views.push(v);
    }
  }
  const columnAt = (cx: number, cz: number): number => {
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || cx < cx0 || cx >= cx0 + w || cz < cz0 || cz >= cz0 + h) {
      throw new RangeError(`regionView: column (${cx}, ${cz}) outside the region`);
    }
    return (cz - cz0) * w + (cx - cx0);
  };
  const col = (x: number, z: number): ColumnView => views[columnAt(x >> 4, z >> 4)]!;
  const aux = (x: number, z: number) => {
    const a = col(x, z).aux();
    if (a === null) throw new Error(`regionView: column (${x >> 4}, ${z >> 4}) has no aux A`);
    return { a, i: ((z & 15) << 4) | (x & 15) };
  };
  return {
    store, cx0, cz0, w, h,
    block: (x, y, z) => col(x, z).block(x & 15, y, z & 15),
    fluid: (x, y, z) => col(x, z).fluid(x & 15, y, z & 15),
    biome: (x, z) => { const { a, i } = aux(x, z); return a.surfaceBiome[i]!; },
    worldSurfaceWG: (x, z) => { const { a, i } = aux(x, z); return a.worldSurfaceWG[i]!; },
    oceanFloorWG: (x, z) => { const { a, i } = aux(x, z); return a.oceanFloorWG[i]!; },
    descriptors(cx, cz) {
      columnAt(cx, cz);
      const d0 = protoAt(store.table.find(cx, cz), 0);
      return store.table.ints.slice(d0, d0 + 48);
    },
    hash(hx = cx0, hz = cz0, hw = w, hh = h) {
      checkSize('regionView.hash', hw, hh);
      columnAt(hx, hz);
      columnAt(hx + hw - 1, hz + hh - 1);
      return hex64(regionHash(store, hx, hz, hw, hh));
    },
  };
}

const sameChannel = (a: Uint16Array | Uint8Array | number, b: Uint16Array | Uint8Array | number): boolean => {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
};

/**
 * The first difference between two views of the same region, or null when they hold the same proto data: per
 * column, each section's blocks and fluid (uniform against uniform by value, dense against dense by bytes; a
 * uniform section never equals a dense one, so the per-channel layout must match too) and the 4096 aux A bytes.
 * Byte comparison, much faster than hashing both regions.
 */
export function regionDiff(a: RegionView, b: RegionView): string | null {
  if (a.cx0 !== b.cx0 || a.cz0 !== b.cz0 || a.w !== b.w || a.h !== b.h) return 'the views cover other regions';
  for (let cz = a.cz0; cz < a.cz0 + a.h; cz++) {
    for (let cx = a.cx0; cx < a.cx0 + a.w; cx++) {
      const va = a.store.proto(cx, cz)!;
      const vb = b.store.proto(cx, cz)!;
      for (let sy = 0; sy < 24; sy++) {
        if (!sameChannel(va.sectionBlocks(sy), vb.sectionBlocks(sy))) return `column (${cx}, ${cz}) section ${sy}: blocks differ`;
        if (!sameChannel(va.sectionFluid(sy), vb.sectionFluid(sy))) return `column (${cx}, ${cz}) section ${sy}: fluid differs`;
      }
      const xa = va.aux();
      const xb = vb.aux();
      const bytes = (x: typeof xa) => (x === null ? Buffer.alloc(4096) : Buffer.from(x.worldSurfaceWG.buffer, x.worldSurfaceWG.byteOffset, 4096));
      if (!bytes(xa).equals(bytes(xb))) return `column (${cx}, ${cz}): aux A differs`;
    }
  }
  return null;
}

const workerScripts = new Map<string, Promise<string>>();

function regionWorkerScript(dir: string): Promise<string> {
  let p = workerScripts.get(dir);
  if (p === undefined) {
    p = buildNodeTaskWorker(dir, { entry: 'test/harness/regionWorker.ts' });
    workerScripts.set(dir, p);
  }
  return p;
}

/** Sends one message and waits for the worker's single reply; rejects if the worker fails or exits first. */
function ask(w: Worker, msg: RegionAttachMsg | RegionColumnMsg): Promise<RegionWorkerReply> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => { off(); reject(e); };
    const onExit = (code: number) => { off(); reject(new Error(`region worker exited (${code})`)); };
    const onMessage = (r: RegionWorkerReply) => { off(); resolve(r); };
    const off = () => { w.off('error', onError); w.off('exit', onExit); w.off('message', onMessage); };
    w.on('error', onError);
    w.on('exit', onExit);
    w.on('message', onMessage);
    w.postMessage(msg);
  });
}

/** Generates `cols` on 4 worker threads over `store` (shared); fills `ms` (row-major) and returns columns per thread. */
async function generateThreaded(store: VoxelStore, o: GenRegionOptions, cols: ReadonlyArray<[number, number]>, ms: Float64Array): Promise<number[]> {
  const script = await regionWorkerScript(o.workerDir ?? 'regionWorker');
  const workers = Array.from({ length: 4 }, () => new Worker(script));
  const written = new Uint8Array(cols.length);
  const perThread = [0, 0, 0, 0];
  try {
    const ready = await Promise.all(workers.map((w) => ask(w, { type: 'attach', handles: store.handles(), seedText: o.seed, params: o.params })));
    for (const r of ready) if (r.type !== 'ready') throw new Error(`region worker: ${r.type === 'error' ? r.message : r.type}`);
    let next = 0;
    const drain = async (t: number): Promise<void> => {
      while (next < cols.length) {
        const [cx, cz] = cols[next++]!;
        const r = await ask(workers[t]!, { type: 'column', cx, cz });
        if (r.type !== 'done') throw new Error(`region worker ${t}, column (${cx}, ${cz}): ${r.type === 'error' ? r.message : r.type}`);
        if (r.cx !== cx || r.cz !== cz) throw new Error(`region worker ${t}: asked (${cx}, ${cz}), done (${r.cx}, ${r.cz})`);
        const k = (cz - o.cz0) * o.w + (cx - o.cx0);
        written[k]!++;
        ms[k] = r.ms;
        perThread[t]!++;
      }
    };
    await Promise.all(workers.map((_, t) => drain(t)));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  const wrong = written.findIndex((n) => n !== 1);
  if (wrong >= 0) throw new Error(`genRegion: column ${wrong} (row-major) written ${written[wrong]} times`);
  return perThread;
}

/**
 * Generates the region (§6.1). The store is fresh per call: a plain `ArrayBuffer` one for 1 thread, a growable
 * `SharedArrayBuffer` one for 4 (and for a cache hit with `threads: 4`, rebuilt in this thread).
 */
export async function genRegion(o: GenRegionOptions): Promise<RegionResult> {
  checkSize('genRegion', o.w, o.h);
  if (o.threads !== 1 && o.threads !== 4) throw new Error(`genRegion: threads ${String(o.threads)} (1 or 4)`);
  if (o.upTo !== 'T') throw new Error(`genRegion: upTo '${String(o.upTo)}' (SP3a has 'T' only)`);
  const cols = regionColumns(o.order, o.cx0, o.cz0, o.w, o.h, o.shuffleSeed ?? 1);
  const t0 = performance.now();
  const store = createStore({ shared: o.threads === 4 });
  const header: RegionCacheHeader | null = o.cache === true
    ? {
        genKey: genKey(seedFromInput(o.seed), stageHashes(o.params)), srcKey: o.srcKey ?? srcKey(),
        cx0: o.cx0, cz0: o.cz0, w: o.w, h: o.h, upTo: o.upTo,
      }
    : null;
  const path = header === null ? '' : regionCachePath(header, o.cacheDir);
  if (header !== null) {
    const ms = readRegionDump(store, header, path);
    if (ms !== null) {
      return {
        view: regionView(store, o.cx0, o.cz0, o.w, o.h), timings: { perColumnMs: ms, totalMs: performance.now() - t0 },
        cacheHit: true, columnsPerThread: [0],
      };
    }
  }
  const ms = new Float64Array(o.w * o.h);
  let columnsPerThread: number[];
  if (o.threads === 1) {
    const ctx = createGenContext(seedFromInput(o.seed), o.params);
    const never = () => false;
    for (const [cx, cz] of cols) {
      const c0 = performance.now();
      fillColumnT(store, ctx, cx, cz, never);
      ms[(cz - o.cz0) * o.w + (cx - o.cx0)] = performance.now() - c0;
    }
    columnsPerThread = [cols.length];
  } else {
    columnsPerThread = await generateThreaded(store, o, cols, ms);
  }
  if (header !== null) writeRegionDump(store, header, path);
  return {
    view: regionView(store, o.cx0, o.cz0, o.w, o.h), timings: { perColumnMs: ms, totalMs: performance.now() - t0 },
    cacheHit: false, columnsPerThread,
  };
}
```

Create `test/harness/regionWorker.ts`:

```ts
/**
 * The region worker (SP3a spec §6.1), bundled by `buildNodeTaskWorker(dir, {entry: 'test/harness/regionWorker.ts'})`
 * and driven by `genRegion` (`test/harness/region.ts`) with `threads: 4`. Never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', handles, seedText, params}` once (`attachStore` and `createGenContext`), answered
 * `{type: 'ready'}`; then `{type: 'column', cx, cz}`, answered `{type: 'done', cx, cz, ms}` after `fillColumnT`
 * (never stopped, epoch 0). Anything that throws is answered `{type: 'error', message}`.
 */
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { fillColumnT } from '../../src/metrics/region';
import { attachStore, type StoreHandles, type VoxelStore } from '../../src/world/store/store';

export interface RegionAttachMsg {
  readonly type: 'attach';
  readonly handles: StoreHandles;
  readonly seedText: string;
  readonly params: Params;
}

export interface RegionColumnMsg {
  readonly type: 'column';
  readonly cx: number;
  readonly cz: number;
}

export type RegionWorkerReply =
  | { type: 'ready' }
  | { type: 'done'; cx: number; cz: number; ms: number }
  | { type: 'error'; message: string };

interface Reply {
  msg: RegionWorkerReply;
  transfer: Transferable[];
}

const NEVER = (): boolean => false;

export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let store: VoxelStore | null = null;
  let ctx: GenContext | null = null;
  const reply = (msg: RegionWorkerReply): Reply => ({ msg, transfer: [] });
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown };
        if (m.type === 'attach') {
          const a = raw as RegionAttachMsg;
          store = attachStore(a.handles);
          ctx = createGenContext(seedFromInput(a.seedText), a.params);
          return reply({ type: 'ready' });
        }
        if (m.type === 'column') {
          if (store === null || ctx === null) throw new Error("region worker: 'column' before 'attach'");
          const { cx, cz } = raw as RegionColumnMsg;
          const t0 = performance.now();
          fillColumnT(store, ctx, cx, cz, NEVER);
          return reply({ type: 'done', cx, cz, ms: performance.now() - t0 });
        }
        throw new Error(`region worker: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project integration --project unit test/integration/region.test.ts test/unit/png.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts`

Expected: PASS (exit 0)

```
Test Files  4 passed (4)
Tests  49 passed (49)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  114 passed | 2 skipped (116)
Tests  1508 passed | 2 skipped (1510)
```

- [ ] **Step 6: Commit**

```bash
git add test/harness/cache.ts test/harness/png.ts test/harness/region.ts test/harness/regionWorker.ts test/integration/region.test.ts test/unit/png.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts
git commit -F - <<'EOF'
test(harness): region harness genRegion, 4 threads, cache, PNG slices (SP3a §6.1)

genRegion({seed, params, cx0, cz0, w, h, upTo: 'T', order, threads, cache?,
shuffleSeed?}) builds the spiral or shuffled column list, fills the region
in process on a plain ArrayBuffer store (1 thread) or on a growable
SharedArrayBuffer store from 4 worker_threads running regionWorker.ts off
a dynamic queue (every column written exactly once), and returns a
RegionView that reads the store per column (voxels, biome, _WG heightmaps,
descriptors, hash of any sub-window) plus per-column timings.

The region cache (cache.ts) keys dumps by genKey + srcKey + format +
region + upTo; srcKey hashes the sorted paths and bytes of src/core,
src/world, src/gen, src/metrics/region.ts and cache.ts. A hit rebuilds
every column through the writer API; a header or layout that disagrees is
a miss and the dump is rewritten. png.ts encodes RGBA PNGs over node:zlib
and draws x, z and y slices with the Voxels palette.

Tests: column orders, RegionView, regionDiff, cache hit/miss/srcKey/
header mismatch, PNG decode with node:zlib, and the 4-thread harness
against the 1-thread one in every order (integration), matching the
sp3a.region.T goldens.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `93b277c` on `dry/sp3a`; 8 files changed, 1612 insertions(+)):

Test-only task, as Task 8: every file is under `test/` (`test/harness/{region,regionWorker,cache,png}.ts`, `test/unit/{png,regionCache,regionHarness}.test.ts`, `test/integration/region.test.ts`), so the plan's RED replay of the commit's `test/**` over the parent PASSES. RED as watched during TDD: the four test files written first fail to import `../harness/{png,region,cache}` (4 files failed, no tests); then the spiral 4 × 1 expectation and the unpinned shuffle failed until fixed/pinned. GREEN: typecheck clean; the new files 44 tests (unit 41 in ≈3 s, integration 3 in ≈10 s); `npm test` 114 files passed, 2 skipped / 1501 passed, 2 skipped (≈103 s with load average ≈ 8 from other agents; Task 10 measured ≈49 s). Mutations checked (scratch, reverted): the worker's seed changed → 3 integration failures (golden window and `regionDiff`); `regionDiff` comparing uniform sections by type only → caught after adding a uniform-vs-uniform case.

- Ruling: `genRegion(o)` options are the §6.1 ones plus three test seams: `cacheDir` (default `test/.cache/regions/`), `srcKey` (overrides the repository key, for the "changed srcKey" test) and `workerDir` (bundle dir under `test/.cache/`, default `regionWorker`; the bundle is built once per process and dir) — the unit tests must not write into the real cache dir, and a srcKey change cannot be provoked without editing `src/` — cost if wrong: none (optional fields).
- Ruling: the result is `{view, timings: {perColumnMs, totalMs}, cacheHit, columnsPerThread}`; `perColumnMs` is indexed row-major in the region (`(cz − cz0)·w + (cx − cx0)`), not in dispatch order; on a hit it holds the per-column rebuild time and `columnsPerThread` is `[0]`; with 4 threads `ms` is measured in the worker around `fillColumnT` — §6.1 gives the fields without their indexing — cost if wrong: DT1/bench readers re-index.
- Ruling: `RegionView` = `store, cx0, cz0, w, h, block, fluid, biome, worldSurfaceWG, oceanFloorWG` (world block x, z; RangeError outside the region), `descriptors(cx, cz)` (a copy of the 48 proto descriptor ints) and `hash(cx0?, cz0?, w?, h?)` (hex64 of `regionHash`, any sub-window); `regionView(store, cx0, cz0, w, h)` is exported (tests and PNGs over hand-built stores) and throws when a column has no proto set — §6.1 lists the reads; DT1 (Task 12) needs the hash of the region and of the 8 × 8 window — cost if wrong: none.
- Ruling: spiral = centre (cx0 + ⌊w/2⌋, cz0 + ⌊h/2⌋), then rings r = 1 … rMax, each walked clockwise seen from +y from its north-west corner (east along z = cz − r, south along x = cx + r, west along z = cz + r, north along x = cx − r), skipping columns outside; shuffled = Fisher-Yates over the row-major list with i from n − 1 down to 1 and j = `nextInt(i + 1)` of `Xoshiro128(shuffleSeed ?? 1)`, pinned for 4 × 4 seed 1 in the unit test — §6.1 fixes neither the ring walk nor the draw direction — cost if wrong: none for hashes (order-independent); the printed DT1 seed reproduces only with this draw.
- Ruling: 4-thread dispatch: 4 `Worker`s per `genRegion` call, attach `{type: 'attach', handles, seedText, params}` → `{type: 'ready'}`, then each worker loops "take the next list entry, `{type: 'column', cx, cz}`, await `{type: 'done', cx, cz, ms}`" (a shared index = a dynamic queue); the main thread checks every column is reported exactly once and the reply's (cx, cz); workers are terminated in `finally`; a worker error reply, `error` or `exit` rejects — the region worker follows Task 8's `buildNodeTaskWorker` contract (`createTaskHandler().handle → {msg, transfer}`, no `node:` imports) — cost if wrong: none.
- Ruling: a cache hit with `threads: 4` rebuilds into a fresh shared store in the main thread (no workers); every call gets a fresh store (`createStore({shared: threads === 4})`, default maxima) — §6.1 does not say which backend a hit uses; DT1's second cached run then still exercises the requested backend — cost if wrong: none.
- Ruling: dump format 1 (little-endian): header 44 bytes = magic `WIRC`, format u32, genKey lo/hi, srcKey lo/hi (u32), cx0, cz0 (i32), w, h (u32), upTo as 4 ASCII bytes padded with 0; per column (cz outer, cx inner) record ints 0-15, the 48 proto descriptor ints, the dense slots in descriptor order (8192 / 4096 bytes), 4096 aux A bytes (zeros when the record has no aux). A miss = no file, a header ≠ the expected one byte for byte, a column record that is not (cx, cz) at status Proto and claimed, a uniform code out of range, or a length that does not match; the whole dump is validated before anything is written into the store, and the miss path regenerates and overwrites. Block slots are copied as native u16 and the cache throws on a big-endian host — §6.1 lists the dump's contents but not the encoding — cost if wrong: bump `REGION_CACHE_FORMAT`.
- Ruling: the hit rebuild restores `epoch` from record int 3, writes aux bytes only when the dumped record had an aux A slot, commits at status 1, and then checks that the store chose the same uniform/dense layout per entry as the dump (throws otherwise: a store change the format did not track) — §6.1 "uniform and dense decisions are made again by the same code" — cost if wrong: none.
- Ruling: the key is `fnv1a64("<hex64 genKey>|<hex64 srcKey>|<format>|<cx0>|<cz0>|<w>|<h>|<upTo>")`, `genKey = genKey(seedFromInput(seed), stageHashes(params))`; `srcKeyOf(root, scope)` hashes, per file in sorted '/'-path order, its path (UTF-8), a 0 byte, its length (u32 LE) and its bytes (so moving bytes across a file boundary or renaming changes the key; tested on a scratch tree); `srcKey()` memoises it per process — §6.1 "FNV-1a 64 of the sorted paths and bytes" without a separator rule — cost if wrong: none (a format change only invalidates local dumps).
- Ruling: dumps are written atomically (`<path>.<pid>.<threadId>.tmp`, then `rename`) so two test processes writing the same key never leave a torn file — cost if wrong: none.
- Ruling: the Voxels palette lives in `test/harness/png.ts` for now (`VOXEL_COLORS` sky, seaLevel, stone, bedrock, water, unknown; `voxelRgb(state, fluid, depth)`: water on air darkens by 1/48 per block below the surface down to 0.3; depth = `worldSurfaceWG − 1 − y`; the sea-level line at y 63 is drawn on dry air of vertical slices only) — Task 14 owns `src/ui/crossSection/*` and the UI palette; it should move the palette there and make `png.ts` import it (tests may import `src/ui`), so the PNGs and the Voxels mode share one palette — cost if wrong: the review PNGs and the UI differ slightly in colour.
- Ruling: slices are `sliceX(view, x, {yMin?, yMax?})` (z across), `sliceZ(view, z, …)` (x across), both with row 0 at `yMax` (default 319), and `sliceY(view, y)` (x across, z down, north at the top), RGBA images for `encodePng`/`writePng`; the PNG is colour type 6, bit depth 8, filter 0 on every row, one IDAT from `deflateSync`, with its own CRC table (the test checks CRCs with `zlib.crc32` and decodes with `inflateSync`) — cost if wrong: none.
- Ruling: the integration test compares runs byte for byte with a new `regionDiff(a, b)` (per section: uniform by value, dense by bytes, uniform never equals dense; aux A bytes) instead of hashing every run, and hashes only the golden 8 × 8 windows (reference and shuffled/4) against `sp3a.region.T.<profile>` from `test/goldens.json`; regions 16 × 16 at (−8, −8), runs spiral/1, shuffled/4 (seed 3), spiral/4, shuffled/1 (seed 9), both profiles; plus slot accounting (live slots = dense entries + aux) and all 4 threads used; and a 4-thread cache miss/hit — cost if wrong: none.
- Ruling (handed to Task 12): `regionHash` costs ≈ 11-16 ms per column under load (≈ 300 KB per column through a byte-wise FNV; 256 columns 2.8 s on an ArrayBuffer store, 3.7-4.1 s on a shared one, load average ≈ 8): a 32 × 32 hash would be ≈ 12-16 s, and DT1's 5 runs × 2 profiles per seed ≈ 2-3 min per seed before generation. Most of it is `createFnv64().updateRepeatU8/U16LE` calling the `step` closure per byte for uniform sections (22 of 24 sections): a scratch micro-bench of 50 MB took 1.9 s that way and 0.58 s with the loop inlined (same digest). Task 12 should either inline the two repeat loops in `core/hash.ts` (behaviour-neutral, covered by the existing equality tests) or hash a run once and compare the other runs with `regionDiff` — cost if wrong: DT1 full tier too slow.
- No spec defects found for Task 11.

---

### Task 12: Metrics DT1 and M1

**Spec:** §6.3, §2.4 M1, §9 threshold rows

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md`
- Modify: `src/core/hash.ts`
- Create: `test/harness/registryChecks.ts`
- Modify: `test/integration/region.test.ts`
- Create: `test/metrics/blocks.metric.ts`
- Create: `test/metrics/region.metric.ts`
- Modify: `test/thresholds.lock.json`
- Modify: `test/thresholds.ts`
- Modify: `test/unit/fnvStream.test.ts`
- Create: `test/unit/registryChecks.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/blocks/kinds.ts` (Task 3): `KIND_VALUES`
  - `src/world/blocks/registry.ts` (Task 3): `MAX_STATES`, `type BlockRegistry`
- Produces (exports added by this task):
  - `test/harness/registryChecks.ts`:
    - `export function registryRoundTripFailures(reg: BlockRegistry): string[]`

- [ ] **Step 1: Write the failing tests**

Modify `test/integration/region.test.ts` (apply with `git apply`):

```diff
diff --git a/test/integration/region.test.ts b/test/integration/region.test.ts
index 5a70d86..5a72b9d 100644
--- a/test/integration/region.test.ts
+++ b/test/integration/region.test.ts
@@ -10,8 +10,8 @@ import { genRegion, regionDiff, type GenRegionOptions, type RegionResult } from
  * store written by 4 `worker_threads` running `test/harness/regionWorker.ts` from a dynamic queue gives the same
  * region, byte for byte (region hash and per-channel uniform/dense layout), as the in-process plain ArrayBuffer
  * store, in every dispatch order; its 8 × 8 window at (−4, −4) is the recorded `sp3a.region.T.<profile>` golden.
- * The runs are compared byte for byte (`regionDiff`); hashing a 16 × 16 region costs seconds (≈ 300 KB per column
- * through a byte-wise FNV), so only the golden windows are hashed.
+ * The runs are compared byte for byte (`regionDiff`, which also checks the uniform/dense layout); only the golden
+ * windows are hashed. DT1 (`test/metrics/region.metric.ts`) compares whole-region hashes.
  */
 const DIR = fileURLToPath(new URL('../.cache/regionIntegration/', import.meta.url));
 const GOLDENS = (JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldensFile).entries;
```

Create `test/metrics/blocks.metric.ts`:

```ts
import { expect } from 'vitest';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry } from '../../src/world/blocks/registry';
import { FIXTURE_DEFS } from '../harness/blockFixtures';
import { metricTest } from '../harness/metric';
import { registryRoundTripFailures } from '../harness/registryChecks';
import { readStateLock, stateLockViolations } from '../harness/stateLock';

/**
 * M1, registry parts (SP3a spec §2.4, §9; master §6.4), the same on every tier: the used block states fit in
 * `MAX_STATES`; rotations, mirrors and round trips are exact over the real registry and the fixture registry; the
 * entries of `test/stateIds.lock.json` are unchanged. The shape-grid part arrives with SP8a.
 */
metricTest('M1', ['states', 'roundTripFailures', 'lockChanges'], () => {
  const roundTrips = [
    ...registryRoundTripFailures(REGISTRY).map((m) => `real: ${m}`),
    ...registryRoundTripFailures(buildRegistry(FIXTURE_DEFS)).map((m) => `fixture: ${m}`),
  ];
  const lock = stateLockViolations(readStateLock(), REGISTRY);
  expect.soft(roundTrips, 'rotation, mirror and round-trip failures').toEqual([]);
  expect.soft(lock, 'stateIds.lock.json violations').toEqual([]);
  return { states: REGISTRY.stateCount, roundTripFailures: roundTrips.length, lockChanges: lock.length };
});
```

Create `test/metrics/region.metric.ts`:

```ts
import { expect } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { expectGolden } from '../harness/goldens';
import { metricTest } from '../harness/metric';
import { genRegion, type GenRegionOptions, type RegionResult } from '../harness/region';

/**
 * DT1 on the provisional T stage (SP3a spec §6.3), threshold exact (0 mismatches), on every tier:
 * 1. Invariance: per profile (default, large_biomes) and tier seed, five runs of the tier's region give equal region
 *    hashes: spiral / 1 thread / cold, shuffled / 4 threads / cold, a second spiral / 1 thread / cold, and two
 *    `cache: true` runs (shuffled / 4 threads, then spiral / 1 thread), the second of which must be a cache hit.
 * 2. Golden: in the seed '42' cold spiral run of each profile, the hash of the 8 × 8 window at (−4, −4) is
 *    `sp3a.region.T.<profile>` (in `npm run test:goldens` it is recorded as an observation instead, so it must agree
 *    with the unit test's `genRegionInProcess` value).
 * `DT1_SHUFFLE_SEED` (default 1) seeds the shuffled order; it is printed with every mismatch.
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const PROFILES = ['default', 'large_biomes'] as const;
/** Fast: the 8 × 8 golden region itself; quick and full: 32 × 32 around it. */
const REGION = pick({ cx0: -4, cz0: -4, w: 8, h: 8 }, { cx0: -16, cz0: -16, w: 32, h: 32 }, { cx0: -16, cz0: -16, w: 32, h: 32 });
/** The spec allows the full tier to drop to two seeds if four are too slow (measured in the plan's dry run). */
const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const SHUFFLE_SEED = Number(process.env.DT1_SHUFFLE_SEED ?? 1);
const GOLDEN_WINDOW = [-4, -4, 8, 8] as const;

interface Run {
  readonly label: string;
  readonly order: GenRegionOptions['order'];
  readonly threads: GenRegionOptions['threads'];
  readonly cache: boolean;
}

const RUNS: readonly Run[] = [
  { label: 'spiral/1/cold', order: 'spiral', threads: 1, cache: false },
  { label: 'shuffled/4/cold', order: 'shuffled', threads: 4, cache: false },
  { label: 'spiral/1/cold again', order: 'spiral', threads: 1, cache: false },
  { label: 'shuffled/4/cache', order: 'shuffled', threads: 4, cache: true },
  { label: 'spiral/1/cache (must hit)', order: 'spiral', threads: 1, cache: true },
];

metricTest('DT1', ['mismatches'], async () => {
  if (!Number.isInteger(SHUFFLE_SEED)) throw new Error(`DT1_SHUFFLE_SEED must be an integer, got ${process.env.DT1_SHUFFLE_SEED}`);
  const problems: string[] = [];
  let invariance = 0;
  let golden = 0;
  let firstCacheHits = 0;
  let genMs = 0;
  for (const profile of PROFILES) {
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const at = `profile ${profile}, seed '${seed}', shuffleSeed ${SHUFFLE_SEED}`;
      let ref = '';
      for (const [i, run] of RUNS.entries()) {
        const r: RegionResult = await genRegion({
          seed, params, ...REGION, upTo: 'T', order: run.order, threads: run.threads, cache: run.cache,
          shuffleSeed: SHUFFLE_SEED, workerDir: 'dt1RegionWorker',
        });
        genMs += r.timings.totalMs;
        const hash = r.view.hash();
        if (i === 0) {
          ref = hash;
          if (seed === '42') {
            try {
              expectGolden(`sp3a.region.T.${profile}`, r.view.hash(...GOLDEN_WINDOW));
            } catch (e) {
              golden++;
              problems.push(`${at}: golden window (−4, −4) 8 × 8: ${(e as Error).message}`);
            }
          }
        } else if (hash !== ref) {
          invariance++;
          problems.push(`${at}: ${run.label} hash ${hash} ≠ ${RUNS[0]!.label} ${ref}`);
        }
        if (i === 3 && r.cacheHit) firstCacheHits++;
        if (i === 4 && !r.cacheHit) {
          invariance++;
          problems.push(`${at}: ${run.label} was not a cache hit`);
        }
      }
    }
  }
  expect.soft(problems, `DT1 mismatches (tier ${TIER}, DT1_SHUFFLE_SEED=${SHUFFLE_SEED})`).toEqual([]);
  return {
    mismatches: invariance + golden, invarianceMismatches: invariance, goldenMismatches: golden,
    firstCacheHits, regions: PROFILES.length * SEEDS.length * RUNS.length, genSeconds: Math.round(genMs) / 1000,
  };
});
```

Modify `test/unit/fnvStream.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/fnvStream.test.ts b/test/unit/fnvStream.test.ts
index 7c19c65..f31afd6 100644
--- a/test/unit/fnvStream.test.ts
+++ b/test/unit/fnvStream.test.ts
@@ -72,6 +72,27 @@ test('updateRepeatU8 and updateRepeatU16LE equal the expanded bytes (a uniform s
   expect(h.digest()).toEqual(fnv1a64Bytes(concat));
 });
 
+test('every update kind, mixed at random, equals fnv1a64Bytes over the expanded bytes (300 streams)', () => {
+  const next = testRng(205);
+  for (let k = 0; k < 300; k++) {
+    const h = createFnv64();
+    const bytes: number[] = [];
+    for (let op = next() % 12; op > 0; op--) {
+      const v = next();
+      const n = next() % 70;
+      switch (next() % 6) {
+        case 0: { const b = randomBytes(next, n); h.update(b); bytes.push(...b); break; }
+        case 1: h.updateU8(v); bytes.push(v & 255); break;
+        case 2: h.updateU16LE(v); bytes.push(v & 255, (v >>> 8) & 255); break;
+        case 3: h.updateU32LE(v); bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24); break;
+        case 4: h.updateRepeatU8(v, n); for (let i = 0; i < n; i++) bytes.push(v & 255); break;
+        default: h.updateRepeatU16LE(v, n); for (let i = 0; i < n; i++) bytes.push(v & 255, (v >>> 8) & 255);
+      }
+    }
+    expect(h.digest()).toEqual(fnv1a64Bytes(Uint8Array.from(bytes)));
+  }
+});
+
 test('digest does not finish the stream: later updates continue it', () => {
   const next = testRng(203);
   const a = randomBytes(next, 100), b = randomBytes(next, 57);
```

Create `test/unit/registryChecks.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockRegistry } from '../../src/world/blocks/registry';
import { FIXTURE_BASE, FIXTURE_DEFS } from '../harness/blockFixtures';
import { registryRoundTripFailures } from '../harness/registryChecks';

/**
 * The M1 registry checks (SP3a spec §2.4, master §6.4 M1): every state survives four quarter turns, two mirrors per
 * axis, `stateOf(propsOf)`, `parseStateKey(stateKey)` and a `withProp` round trip through every value of every
 * property. A registry that breaks any of them is reported, state by state.
 */
const FIXTURE = buildRegistry(FIXTURE_DEFS);

/** `reg` with one method replaced: the M1 checks must see the broken behaviour. */
const broken = (reg: BlockRegistry, patch: Partial<BlockRegistry>): BlockRegistry => ({ ...reg, ...patch });

describe('registryRoundTripFailures', () => {
  test('the real registry and the fixture registry have none', () => {
    expect(registryRoundTripFailures(REGISTRY)).toEqual([]);
    expect(registryRoundTripFailures(FIXTURE)).toEqual([]);
  });

  test('a rotation that is not the identity after four quarter turns is reported', () => {
    const chestNorth = FIXTURE_BASE.chest;
    // One quarter turn of a north chest gives east, but the second turn sticks at east.
    const reg = broken(FIXTURE, {
      rotateState: (s, q) => (s === chestNorth + 1 && ((q % 4) + 4) % 4 === 1 ? s : FIXTURE.rotateState(s, q)),
    });
    const f = registryRoundTripFailures(reg);
    expect(f.some((m) => m.includes('chest[facing=north]') && m.includes('rotateState'))).toBe(true);
  });

  test('a mirror that is not an involution is reported', () => {
    const reg = broken(FIXTURE, { mirrorState: (s, a) => (a === 'z' && s === FIXTURE_BASE.door ? s + 1 : FIXTURE.mirrorState(s, a)) });
    const f = registryRoundTripFailures(reg);
    expect(f.some((m) => m.includes('mirrorState') && m.includes("'z'"))).toBe(true);
  });

  test('broken stateOf/propsOf, key and withProp round trips are reported', () => {
    const log = FIXTURE_BASE.log;
    const keys = registryRoundTripFailures(broken(FIXTURE, { parseStateKey: (k) => (k === 'log[axis=x]' ? log : FIXTURE.parseStateKey(k)) }));
    expect(keys).toEqual(['log[axis=x] (id 2): parseStateKey(stateKey) = 1']);
    const props = registryRoundTripFailures(broken(FIXTURE, { stateOf: (t, p) => (t === FIXTURE.typeId('slab') ? FIXTURE_BASE.slab : FIXTURE.stateOf(t, p)) }));
    expect(props.filter((m) => m.includes('stateOf(propsOf)'))).toHaveLength(2);
    const withProp = registryRoundTripFailures(broken(FIXTURE, {
      withProp: (s, p, v) => (p === 'hinge' && v === 'right' ? s : FIXTURE.withProp(s, p, v)),
    }));
    expect(withProp.length).toBeGreaterThan(0);
    expect(withProp.every((m) => m.includes('withProp') && m.includes('hinge'))).toBe(true);
  });

  test('a method that throws is a failure, not a crash', () => {
    const f = registryRoundTripFailures(broken(FIXTURE, {
      stateKey: (s) => {
        if (s === FIXTURE_BASE.gate) throw new Error('boom');
        return FIXTURE.stateKey(s);
      },
    }));
    expect(f).toEqual([`state ${FIXTURE_BASE.gate}: threw Error: boom`]);
  });

  test('a state count over MAX_STATES or a non-contiguous type is reported', () => {
    expect(registryRoundTripFailures(broken(FIXTURE, { stateCount: 4097 }))[0]).toMatch(/stateCount 4097/);
    const types = FIXTURE.STATE_TYPE.slice();
    types[FIXTURE_BASE.chest + 2] = FIXTURE.typeId('log');
    const f = registryRoundTripFailures(broken(FIXTURE, { STATE_TYPE: types }));
    expect(f.some((m) => m.includes('not contiguous'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project integration --project metrics-fast --project unit test/integration/region.test.ts test/metrics/blocks.metric.ts test/metrics/region.metric.ts test/unit/fnvStream.test.ts test/unit/registryChecks.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× DT1 5570ms
FAIL  |unit| test/unit/registryChecks.test.ts [ test/unit/registryChecks.test.ts ]
Error: Cannot find module '../harness/registryChecks' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/registryChecks.test.ts
FAIL  |metrics-fast| test/metrics/blocks.metric.ts [ test/metrics/blocks.metric.ts ]
Error: Cannot find module '../harness/registryChecks' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/metrics/blocks.metric.ts
FAIL  |metrics-fast| test/metrics/region.metric.ts > DT1
AssertionError: DT1.mismatches: not in THRESHOLDS: expected [ 'DT1.mismatches: not in THRESHOLDS' ] to deeply equal []
Test Files  3 failed | 2 passed (5)
Tests  1 failed | 13 passed (14)
```

- [ ] **Step 3: Implement**

Modify `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
index c7af50e..ed75a24 100644
--- a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
+++ b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
@@ -376,3 +376,4 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
 (One line per commit that changes `test/thresholds.lock.json`.)
 
 - Task 1: `STARTED_SPS` gains `SP3a` (SP3 split into SP3a, SP3b and SP3c); no threshold rows change.
+- Task 12: new rows `DT1.mismatches` max 0 (§6.3) and M1 registry parts `M1.states` max 4096, `M1.roundTripFailures` max 0, `M1.lockChanges` max 0 (§2.4), active from SP3a, the same on every tier.
```

Modify `src/core/hash.ts` (apply with `git apply`):

```diff
diff --git a/src/core/hash.ts b/src/core/hash.ts
index dba500a..3d7f7d4 100644
--- a/src/core/hash.ts
+++ b/src/core/hash.ts
@@ -100,26 +100,32 @@ export interface Fnv64 {
   digest(): Hash64;
 }
 
-/** The step of `fnv1a64Bytes`, byte by byte over a running [lo, hi]. */
+/**
+ * The step of `fnv1a64Bytes`, byte by byte over a running [lo, hi], in 16-bit limbs: lo·0x1b3 is split as
+ * (lo & 0xffff)·0x1b3 + (lo >>> 16)·0x1b3·2^16, so the low word and its carry into hi come from integer operations
+ * only (no float multiply and division per byte, ≈ 2.4× faster; every loop inlines it, a closure call per byte cost
+ * another ≈ 3× in the repeat loops). The result is bit-identical to `fnv1a64Bytes` (unit-tested), which keeps its
+ * own arithmetic. `regionHash` writes ≈ 300 KB per column through this stream.
+ */
 export function createFnv64(): Fnv64 {
   let lo = 0x84222325;
   let hi = 0xcbf29ce4;
   const step = (b: number): void => {
-    lo = (lo ^ b) >>> 0;
-    const p = lo * 0x1b3;
-    const nlo = p >>> 0;
-    hi = (Math.imul(hi, 0x1b3) + (p - nlo) / 4294967296 + (lo << 8)) >>> 0;
-    lo = nlo;
+    const l = (lo ^ b) >>> 0;
+    const a = (l & 0xffff) * 0x1b3;
+    const c = (l >>> 16) * 0x1b3 + (a >>> 16);
+    hi = (Math.imul(hi, 0x1b3) + (c >>> 16) + (l << 8)) >>> 0;
+    lo = ((c << 16) | (a & 0xffff)) >>> 0;
   };
   const stream: Fnv64 = {
     update(bytes) {
       let l = lo, h = hi;
       for (let i = 0; i < bytes.length; i++) {
         l = (l ^ bytes[i]!) >>> 0;
-        const p = l * 0x1b3;
-        const nl = p >>> 0;
-        h = (Math.imul(h, 0x1b3) + (p - nl) / 4294967296 + (l << 8)) >>> 0;
-        l = nl;
+        const a = (l & 0xffff) * 0x1b3;
+        const c = (l >>> 16) * 0x1b3 + (a >>> 16);
+        h = (Math.imul(h, 0x1b3) + (c >>> 16) + (l << 8)) >>> 0;
+        l = ((c << 16) | (a & 0xffff)) >>> 0;
       }
       lo = l;
       hi = h;
@@ -143,15 +149,34 @@ export function createFnv64(): Fnv64 {
     },
     updateRepeatU8(v, n) {
       const b = v & 255;
-      for (let i = 0; i < n; i++) step(b);
+      let l = lo, h = hi;
+      for (let i = 0; i < n; i++) {
+        l = (l ^ b) >>> 0;
+        const a = (l & 0xffff) * 0x1b3;
+        const c = (l >>> 16) * 0x1b3 + (a >>> 16);
+        h = (Math.imul(h, 0x1b3) + (c >>> 16) + (l << 8)) >>> 0;
+        l = ((c << 16) | (a & 0xffff)) >>> 0;
+      }
+      lo = l;
+      hi = h;
       return stream;
     },
     updateRepeatU16LE(v, n) {
       const b0 = v & 255, b1 = (v >>> 8) & 255;
+      let l = lo, h = hi;
       for (let i = 0; i < n; i++) {
-        step(b0);
-        step(b1);
+        l = (l ^ b0) >>> 0;
+        let a = (l & 0xffff) * 0x1b3;
+        let c = (l >>> 16) * 0x1b3 + (a >>> 16);
+        h = (Math.imul(h, 0x1b3) + (c >>> 16) + (l << 8)) >>> 0;
+        l = ((((c << 16) | (a & 0xffff)) >>> 0) ^ b1) >>> 0;
+        a = (l & 0xffff) * 0x1b3;
+        c = (l >>> 16) * 0x1b3 + (a >>> 16);
+        h = (Math.imul(h, 0x1b3) + (c >>> 16) + (l << 8)) >>> 0;
+        l = ((c << 16) | (a & 0xffff)) >>> 0;
       }
+      lo = l;
+      hi = h;
       return stream;
     },
     digest() {
```

Create `test/harness/registryChecks.ts`:

```ts
/**
 * The round-trip part of metric M1 (SP3a spec §2.4, master §6.4 M1): over every state of a registry, four quarter
 * turns and two mirrors per axis are the identity, `stateOf(propsOf(s))`, `parseStateKey(stateKey(s))` and a
 * `withProp` round trip through every value of every property give the state back, and each type's states are
 * contiguous from its default. One message per failure; a method that throws counts as one failure of that state.
 */
import { KIND_VALUES } from '../../src/world/blocks/kinds';
import { MAX_STATES, type BlockRegistry } from '../../src/world/blocks/registry';

function stateFailures(reg: BlockRegistry, s: number): string[] {
  const out: string[] = [];
  const key = reg.stateKey(s);
  const at = `${key} (id ${s})`;
  let r = s;
  for (let i = 0; i < 4; i++) r = reg.rotateState(r, 1);
  if (r !== s) out.push(`${at}: rotateState(·, 1) four times = ${r}`);
  for (const axis of ['x', 'z'] as const) {
    const m = reg.mirrorState(reg.mirrorState(s, axis), axis);
    if (m !== s) out.push(`${at}: mirrorState(·, '${axis}') twice = ${m}`);
  }
  const type = reg.STATE_TYPE[s]!;
  const props = reg.propsOf(s);
  const back = reg.stateOf(type, props);
  if (back !== s) out.push(`${at}: stateOf(propsOf) = ${back}`);
  const parsed = reg.parseStateKey(key);
  if (parsed !== s) out.push(`${at}: parseStateKey(stateKey) = ${parsed}`);
  for (const p of reg.typeProperties(type)) {
    for (const v of KIND_VALUES[p.kind]) {
      const t = reg.withProp(s, p.name, v);
      const tp = reg.propsOf(t);
      const others = Object.keys(props).every((n) => n === p.name || tp[n] === props[n]);
      if (reg.STATE_TYPE[t] !== type || tp[p.name] !== v || !others) out.push(`${at}: withProp(${p.name}=${v}) = ${t}`);
      const undo = reg.withProp(t, p.name, props[p.name]!);
      if (undo !== s) out.push(`${at}: withProp(${p.name}=${v}) then back = ${undo}`);
    }
  }
  return out;
}

export function registryRoundTripFailures(reg: BlockRegistry): string[] {
  const n = reg.stateCount;
  if (!Number.isInteger(n) || n < 1 || n > MAX_STATES) return [`stateCount ${n} outside 1 … ${MAX_STATES}`];
  const out: string[] = [];
  for (let t = 0; t < reg.typeCount; t++) {
    const base = reg.DEFAULT_STATE[t]!;
    let end = base;
    while (end < n && reg.STATE_TYPE[end] === t) end++;
    let count = 0;
    for (let s = 0; s < n; s++) if (reg.STATE_TYPE[s] === t) count++;
    if (count !== end - base || count === 0) out.push(`type ${reg.TYPE_NAMES[t]}: its states are not contiguous from its default ${base}`);
  }
  for (let s = 0; s < n; s++) {
    try {
      out.push(...stateFailures(reg, s));
    } catch (e) {
      out.push(`state ${s}: threw ${String(e)}`);
    }
  }
  return out;
}
```

Modify `test/thresholds.ts` (apply with `git apply`):

```diff
diff --git a/test/thresholds.ts b/test/thresholds.ts
index 576ca2e..a2d999d 100644
--- a/test/thresholds.ts
+++ b/test/thresholds.ts
@@ -33,6 +33,8 @@ export const THRESHOLDS: ThresholdTable = {
   },
   B5: { perKm2Min: { min: 0.2, activeFrom: 'SP2a' }, perKm2Max: { max: 2, activeFrom: 'SP2a' }, highShare: { min: 0.3, activeFrom: 'SP2a' } },
   U2: { value: { min: 1, activeFrom: 'SP2b' } },
+  DT1: { mismatches: { max: 0, activeFrom: 'SP3a' } },
+  M1: { states: { max: 4096, activeFrom: 'SP3a' }, roundTripFailures: { max: 0, activeFrom: 'SP3a' }, lockChanges: { max: 0, activeFrom: 'SP3a' } },
   U4: {
     registryIssues: { max: 0, activeFrom: 'SP1' },
     migrationFailures: { max: 0, activeFrom: 'SP1' },
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run test:accept-thresholds`

The command writes `test/thresholds.lock.json`; the dry run's result:

Modify `test/thresholds.lock.json` (apply with `git apply`):

```diff
diff --git a/test/thresholds.lock.json b/test/thresholds.lock.json
index 7538650..21b67dd 100644
--- a/test/thresholds.lock.json
+++ b/test/thresholds.lock.json
@@ -1,5 +1,5 @@
 {
-  "sha256": "c65639a9c6f45a5e27df2f85ed6a3ec5450b860e439a0c641569e8d96beff608",
+  "sha256": "bd21cc78065fc7dd58240d261fc72635a7443a7a187c9bfeb8cb9fe75140fd86",
   "canonical": {
     "startedSps": [
       "SP0",
@@ -89,6 +89,26 @@
           "min": 0.2
         }
       },
+      "DT1": {
+        "mismatches": {
+          "activeFrom": "SP3a",
+          "max": 0
+        }
+      },
+      "M1": {
+        "lockChanges": {
+          "activeFrom": "SP3a",
+          "max": 0
+        },
+        "roundTripFailures": {
+          "activeFrom": "SP3a",
+          "max": 0
+        },
+        "states": {
+          "activeFrom": "SP3a",
+          "max": 4096
+        }
+      },
       "N1": {
         "ksD": {
           "activeFrom": "SP1",
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project integration --project metrics-fast --project unit test/integration/region.test.ts test/metrics/blocks.metric.ts test/metrics/region.metric.ts test/unit/fnvStream.test.ts test/unit/registryChecks.test.ts`

Expected: PASS (exit 0)

```
Test Files  5 passed (5)
Tests  21 passed (21)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  117 passed | 2 skipped (119)
Tests  1517 passed | 2 skipped (1519)
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md src/core/hash.ts test/harness/registryChecks.ts test/integration/region.test.ts test/metrics/blocks.metric.ts test/metrics/region.metric.ts test/thresholds.lock.json test/thresholds.ts test/unit/fnvStream.test.ts test/unit/registryChecks.test.ts
git commit -F - <<'EOF'
test(metrics): DT1 on the provisional T and M1 registry parts (SP3a §6.3, §2.4)

- DT1 (test/metrics/region.metric.ts), every tier: per profile (default,
  large_biomes) and tier seed, five genRegion runs of the tier's region
  (fast 8 x 8 at (-4, -4); quick/full 32 x 32 at (-16, -16)) give equal
  region hashes: spiral/1 cold, shuffled/4 cold, spiral/1 cold again,
  shuffled/4 cache, spiral/1 cache (must hit); the seed '42' spiral run's
  8 x 8 window at (-4, -4) is sp3a.region.T.<profile>. Full tier keeps the
  four seeds '42', '1', '2', '3'. DT1_SHUFFLE_SEED is printed on failure.
- M1 (test/metrics/blocks.metric.ts), every tier: used states <= 4096;
  rotations, mirrors and round trips exact over the real and the fixture
  registry (test/harness/registryChecks.ts, unit-tested); stateIds lock
  violations 0.
- Threshold rows DT1.mismatches and M1.states/roundTripFailures/lockChanges
  (activeFrom SP3a); thresholds lock accepted; Threshold-log line.
- core/hash.ts: the streaming FNV-1a 64 steps in 16-bit integer limbs and
  inlines the step in the repeat loops (bit-identical, ~8x faster per
  region hash), so DT1's full tier runs in ~1.5 min instead of ~8.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `f9cd4a3` on `dry/sp3a`; 10 files changed, 327 insertions(+), 16 deletions(-)):

Test-side task as Tasks 8 and 11 (the only `src` change, `core/hash.ts`, is behaviour-neutral), so the plan's RED replay of the commit's `test/**` over the parent PASSES (unit + arch + metrics-fast: 113 files / 1503 tests, ≈52 s; DT1 fast on the parent's slower hash ≈11 s). RED as watched during TDD: `test/unit/registryChecks.test.ts` fails to import `../harness/registryChecks` (1 file failed, no tests); with the two metric files and no rows, `test/arch/thresholds.test.ts` fails ("M1 is not in THRESHOLDS", "DT1 is not in THRESHOLDS") and M1 fails ("M1.states: not in THRESHOLDS" …); with the rows, the lock test fails ("governance state changed: TIGHTEN DT1.mismatches added, TIGHTEN M1.lockChanges/roundTripFailures/states added") until `npm run test:accept-thresholds`. GREEN: typecheck clean; `npm test` 117 files passed, 2 skipped / 1510 passed, 2 skipped (≈81 s, load ≈3.3); `GOVERNANCE_BASE=main` governance test passes; Bun `goldensJsc.ts` 50/50 (the stream arithmetic changed). Mutation (scratch, reverted): an order-dependent T stage (the 7th column of a process gets one stone more) → DT1 fast fails with 8 mismatches (golden window + invariance across runs).

DT1 timings (load average 3.7-5.5 on 20 cores, another agent's work alongside): fast 3.3-3.5 s (10 regions of 8 × 8); quick 25 s (10 regions of 32 × 32, generation 10.5 s); **full 93 s cold** (empty `test/.cache/regions`; 40 regions of 32 × 32, generation 38 s, hashing ≈ 55 s) and 92 s with two dumps already present — under the ~3 min budget, so the full tier keeps the four seeds '42', '1', '2', '3'. Before the hash change (below) a 32 × 32 hash took ≈ 11 s (≈ 11 ms per column, measured 2.3-3.5 s per 256 columns), i.e. a full tier of ≈ 8 min; DT1 fast was ≈ 11 s.

- Ruling: `core/hash.ts`'s streaming FNV (`createFnv64`, Task 2) now steps in 16-bit integer limbs (`a = (l & 0xffff)·0x1b3; c = (l >>> 16)·0x1b3 + (a >>> 16); hi = imul(hi, 0x1b3) + (c >>> 16) + (l << 8); lo = (c << 16) | (a & 0xffff)`) instead of a float multiply and division per byte, and the step is inlined in `updateRepeatU8`/`updateRepeatU16LE` (Task 11's hand-over): ≈ 8× per region hash (256 columns 2.3-3.5 s → 0.31-0.40 s), bit-identical (the existing equality tests, a new 300-stream test mixing every update kind against `fnv1a64Bytes`, the sp3a goldens in V8 and Bun); `fnv1a64Bytes` (every older golden) is untouched — the alternative, comparing DT1's runs with `regionDiff` and hashing only the reference, departs from §6.3's "equal region hashes" — cost if wrong: none (equality pinned; a revert only costs time).
- Ruling: DT1 is one threshold part, `mismatches` (= invariance + golden mismatches), as §9's row "DT1 (mismatches max 0)"; the metric also records `invarianceMismatches`, `goldenMismatches`, `firstCacheHits`, `regions`, `genSeconds` in `test/metrics/.out/DT1.json` (unlisted values are allowed) and soft-expects the list of problems, each naming profile, seed and `shuffleSeed` — cost if wrong: split the row into two parts later.
- Ruling: the five runs are, in order: spiral/1/cold (the reference, hashed whole, plus the golden window for seed '42'), shuffled/4/cold, spiral/1/cold again, shuffled/4/`cache: true`, spiral/1/`cache: true` (must report `cacheHit`); each run's whole-region hash is compared with the reference — §6.3 lists the five runs but not the order/threads of the two cache runs; shuffled/4 then spiral/1 means a miss writes the dump from a shared store written by 4 threads and the hit rebuilds it into an `ArrayBuffer` store — cost if wrong: none.
- Ruling: the first cache run may itself be a hit (a dump left by an earlier run with the same `srcKey`), which is what SP3b's CI cache is for; it is recorded as `firstCacheHits`, not a failure; only the second must hit. The real `test/.cache/regions/` is used (no test seam) — cost if wrong: none.
- Ruling: the golden part goes through `expectGolden('sp3a.region.T.<profile>', …)` (thrown errors counted as golden mismatches), so under `npm run test:goldens` (which runs metrics-quick in record mode) DT1 records an observation that the merge checks against the unit test's `genRegionInProcess` value ("nondeterministic golden" if they differ) — cost if wrong: none.
- Ruling: shuffle seed `DT1_SHUFFLE_SEED` (env, default 1, integer) — §6.1 "the seed is printed when DT1 fails" — cost if wrong: none.
- Ruling: the 4-thread runs build their worker bundle in `test/.cache/dt1RegionWorker` (`workerDir`), not the default `regionWorker` of the integration test, so the metrics and integration projects never build into the same directory concurrently — cost if wrong: none.
- Ruling: M1 is three parts, `states` (max 4096; `REGISTRY.stateCount`, 3 today), `roundTripFailures` (max 0) and `lockChanges` (max 0; `stateLockViolations(readStateLock(), REGISTRY).length`, which also counts registered states not yet in the lock), following master §6.4's M1 cells (§9 lists "rotation and round-trip failures" as one cell); SP8a adds the shape part — cost if wrong: renames before the lock is relied on.
- Ruling: `test/harness/registryChecks.ts` `registryRoundTripFailures(reg)` checks, per state: four `rotateState(·, 1)` = identity, `mirrorState` twice per axis = identity, `stateOf(STATE_TYPE, propsOf)`, `parseStateKey(stateKey)`, and for every property and every kind value a `withProp` that sets exactly that property (same type, others unchanged) and a `withProp` back to the original; plus per type contiguous states from `DEFAULT_STATE`, and `stateCount` within 1 … `MAX_STATES` (checked first, so a broken count does not cascade); a throwing method is one failure of that state. Run over the real registry and the fixture (61 states); unit-tested with broken registries (each check must report) — cost if wrong: none.
- Ruling: the integration region test's doc comment no longer says hashing a 16 × 16 region "costs seconds" (≈ 0.35 s now); its byte comparison stays — cost if wrong: none.
- Ruling (handed to Task 16 / SP3b): the region cache has no eviction; a 32 × 32 dump is ≈ 25 MB, so each `srcKey` change leaves ≈ 50 MB of quick-tier and ≈ 200 MB of full-tier dumps in `test/.cache/regions/` locally (CI in SP3b restores by exact key, no `restore-keys`, so it does not accumulate there); `rm -rf test/.cache/regions` clears them — a prune of dumps whose header `srcKey` differs could be added to `cache.ts` — cost if wrong: local disk only.
- No spec defects found for Task 12.

---

### Task 13: The slice job

**Spec:** §5.1

**Files:**
- Modify: `src/engine/workerPool.ts`
- Modify: `src/ui/map/perfHook.ts`
- Modify: `src/workers/protocol.ts`
- Create: `src/workers/sliceJob.ts`
- Modify: `src/workers/taskHandler.ts`
- Modify: `test/unit/perfHook.test.ts`
- Modify: `test/unit/protocol.test.ts`
- Create: `test/unit/sliceJob.test.ts`
- Modify: `test/unit/workerPool.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/core/coords.ts` (Task 2): `colKey`, `torusSlot`
  - `src/world/store/store.ts` (Task 7): `createStore`, `type VoxelStore`
  - `src/metrics/region.ts` (Task 9): `fillColumnT`
- Produces (exports added by this task):
  - `src/engine/workerPool.ts`:
    - `export interface SliceResult`
  - `src/workers/protocol.ts`:
    - `export interface SliceMsg { readonly type: 'slice'; readonly jobId: number; readonly epoch: number; readonly ax: number; readonly az: number; readonly bx: number; read…`
    - `export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SliceMsg | SelftestMsg;`
    - `export interface SliceResultMsg { readonly type: 'sliceResult'; readonly jobId: number; readonly epoch: number; readonly blocks: ArrayBuffer; readonly fluid: ArrayBuff…`
    - `export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SliceResultMsg | SelftestResultMsg | ErrorMsg;`
    - `export const SLICE_POINTS = 512;`
    - `export const SLICE_ROWS = 384;`
    - `export const SLICE_SAMPLES = SLICE_POINTS * SLICE_ROWS;`
    - `export const sliceIndex = (i: number, y: number): number => (319 - y) * SLICE_POINTS + i;`
  - `src/workers/sliceJob.ts`:
    - `export const SLICE_MAX_BLOCK_BYTES = 32 * MiB;`
    - `export const SLICE_MAX_BYTE_BYTES = 16 * MiB;`
    - `export const SLICE_LRU_COLUMNS = 64;`
    - `export interface SliceData`
    - `export interface SliceJob`
    - `export function createSliceJob(): SliceJob`
  - `src/workers/taskHandler.ts`:
    - `export function createTaskHandler(slices: SliceJob = CREATE_SLICE_JOB()): TaskHandler`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/perfHook.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/perfHook.test.ts b/test/unit/perfHook.test.ts
index 67b7a26..dfc98e2 100644
--- a/test/unit/perfHook.test.ts
+++ b/test/unit/perfHook.test.ts
@@ -154,6 +154,8 @@ describe('instrumented pool (SP2b spec §2.8)', () => {
     log.drawn(0, 1, 1, 100);
     expect(log.record(r.id)).toMatchObject({ poolEpoch: 0, configurePostedAt: 1, readyAt: 2, previewDoneAt: 3, drawnAt: 100, latencyMs: 99.5 });
     expect((await pool.point(1, 2)).z).toBe(2);
+    // Slice jobs (SP3a spec §5.1) pass through untimed.
+    expect((await pool.slice({ ax: 0, az: 0, bx: 40, bz: 3 })).blocks.length).toBe(512 * 384);
     pool.terminate();
   });
 });
```

Modify `test/unit/protocol.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/protocol.test.ts b/test/unit/protocol.test.ts
index fad6f83..a3b2088 100644
--- a/test/unit/protocol.test.ts
+++ b/test/unit/protocol.test.ts
@@ -10,7 +10,8 @@ import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
 import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode, type SplineLeaf } from '../../src/metrics/splineStats';
 import { paintTile, paintTileAbortable } from '../../src/gen/map/tile';
 import { leafOpts } from '../../src/ui/splineEditor/model';
-import { parseFromWorker, parseToWorker, pointInWindow, tileInWindow } from '../../src/workers/protocol';
+import { parseFromWorker, parseToWorker, pointInWindow, SLICE_SAMPLES, tileInWindow } from '../../src/workers/protocol';
+import { createSliceJob } from '../../src/workers/sliceJob';
 import { createTaskHandler } from '../../src/workers/taskHandler';
 import { ctxFor } from '../harness/gen';
 
@@ -36,6 +37,7 @@ describe('parseToWorker', () => {
     expect(parseToWorker(stats(6, 3, 'splineStats', 0, 100, { len: 87, leaf: 'shape.offset', node: [6, 0] }))).not.toBeNull();
     expect(parseToWorker(stats(7, 3, 'biomeShares', 5, 5, { len: 31 }))).not.toBeNull();
     expect(parseToWorker(stats(8, 3, 'crossSection', 0, 512, line(5120, 3072, 6656, 3072)))).not.toBeNull();
+    expect(parseToWorker({ type: 'slice', jobId: 9, epoch: 3, ax: 5120, az: 3072, bx: 6656, bz: 3072 })).not.toBeNull();
   });
   test('crossSection ends are only checked to be numbers: outside the window, NaN or A = B parse, and the handler answers BAD_ARGS', () => {
     for (const args of [line(524288, 0, 0, 0), line(Number.NaN, 0, 1, 1), line(0, Infinity, 1, 1), line(7, 7, 7, 7)]) {
@@ -285,3 +287,96 @@ describe('task handler', () => {
     expect(r.type === 'error' && r.jobId).toBe(1);
   });
 });
+
+describe('slice messages and the slice job (SP3a spec §5.1)', () => {
+  const slice = (jobId: number, epoch: number, ax: unknown, az: unknown, bx: unknown, bz: unknown) => ({ type: 'slice', jobId, epoch, ax, az, bx, bz });
+  const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
+  const coast = (jobId: number, epoch: number) => slice(jobId, epoch, COAST.ax, COAST.az, COAST.bx, COAST.bz);
+  const live = (s: { blockPool: { slotCount(): number; freeCount(): number }; bytePool: { slotCount(): number; freeCount(): number } }) =>
+    [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];
+
+  test('parseToWorker: integer jobId and epoch, numeric ends (the window and A ≠ B are the handler\'s BAD_ARGS)', () => {
+    expect(parseToWorker(coast(1, 0))).not.toBeNull();
+    for (const m of [slice(1, 0, 524288, 0, 0, 0), slice(1, 0, Number.NaN, 0, 1, 1), slice(1, 0, 7, 7, 7, 7)]) expect(parseToWorker(m)).not.toBeNull();
+    for (const m of [slice(1.5, 0, 0, 0, 1, 1), slice(1, null as unknown as number, 0, 0, 1, 1), slice(1, 0, '0', 0, 1, 1), slice(1, 0, 0, 0, 1, undefined), { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1 }]) {
+      expect(parseToWorker(m)).toBeNull();
+    }
+  });
+  test('parseFromWorker: sliceResult carries 196 608 u16 block states and 196 608 fluid bytes in ArrayBuffers', () => {
+    const result = (blocks: unknown, fluid: unknown, jobId: unknown = 4) => ({ type: 'sliceResult', jobId, epoch: 2, blocks, fluid });
+    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).not.toBeNull();
+    expect(parseFromWorker(result(new ArrayBuffer(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBeNull();
+    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(2 * SLICE_SAMPLES)))).toBeNull();
+    expect(parseFromWorker(result(new Uint16Array(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBeNull();
+    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new Uint8Array(SLICE_SAMPLES)))).toBeNull();
+    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES), null))).toBeNull();
+  });
+  test('a slice replies with the slice job\'s blocks and fluid, both transferred, at the job\'s epoch', () => {
+    const h = createTaskHandler();
+    h.handle(configure(3));
+    const r = h.handle(coast(7, 3));
+    expect(r.msg).toMatchObject({ type: 'sliceResult', jobId: 7, epoch: 3 });
+    if (r.msg.type !== 'sliceResult') return;
+    expect(r.transfer).toEqual([r.msg.blocks, r.msg.fluid]);
+    const want = createSliceJob().run(ctxFor('42'), 3, COAST, () => false)!;
+    expect(sameBytes(r.msg.blocks, want.blocks)).toBe(true);
+    expect(sameBytes(r.msg.fluid, want.fluid)).toBe(true);
+  });
+  test('a slice before configure, of a stale epoch or whose line leaves the half-open window or has no length is refused', () => {
+    const h = createTaskHandler();
+    const reply = (m: unknown) => {
+      const r = h.handle(m).msg;
+      return r.type === 'error' ? [r.code, r.jobId, r.epoch, r.message] : [r.type];
+    };
+    expect(reply(coast(1, 3)).slice(0, 3)).toEqual(['NOT_CONFIGURED', 1, 3]);
+    h.handle(configure(3));
+    expect(reply(coast(2, 2)).slice(0, 3)).toEqual(['STALE_EPOCH', 2, 2]);
+    const outside = (end: string, x: string, z: string) => ['BAD_ARGS', 1, 3, `${end} (${x}, ${z}) is outside the world window [-524288, 524288)`];
+    expect(reply(slice(1, 3, 524288, 0, 0, 0))).toEqual(outside('A', '524288', '0'));
+    expect(reply(slice(1, 3, 0, -524289, 0, 0))).toEqual(outside('A', '0', '-524289'));
+    expect(reply(slice(1, 3, 0, 0, 100, 524288))).toEqual(outside('B', '100', '524288'));
+    expect(reply(slice(1, 3, Number.NaN, 0, 100, 0))).toEqual(outside('A', 'NaN', '0'));
+    expect(reply(slice(1, 3, 0, 0, -Infinity, 0))).toEqual(outside('B', '-Infinity', '0'));
+    expect(reply(slice(1, 3, -40, 9, -40, 9))).toEqual(['BAD_ARGS', 1, 3, 'A and B are the same point (-40, 9)']);
+    // The window's own corners are inside.
+    expect(reply(slice(1, 3, -524288, -524288, 524287, 524287))).toEqual(['sliceResult']);
+  });
+  test('with an abort cell, a slice whose epoch the cell has left replies ABORTED and keeps no half-written column', () => {
+    const sab = new SharedArrayBuffer(4);
+    const cell = new Int32Array(sab);
+    const job = createSliceJob();
+    const h = createTaskHandler(job);
+    Atomics.store(cell, 0, 3);
+    h.handle(configure(3, sab));
+    Atomics.store(cell, 0, 4);
+    const r = h.handle(coast(1, 3));
+    expect(r.msg).toMatchObject({ type: 'error', jobId: 1, epoch: 3, code: 'ABORTED' });
+    expect(r.transfer).toEqual([]);
+    expect([job.misses, job.resident()]).toEqual([0, []]);
+    Atomics.store(cell, 0, 3);
+    expect(h.handle(coast(2, 3)).msg.type).toBe('sliceResult');
+  });
+  test('the worker keeps one slice store for its lifetime; a configure frees every resident column and empties the LRU', () => {
+    const job = createSliceJob();
+    const h = createTaskHandler(job);
+    h.handle(configure(3));
+    expect(job.store).toBeNull();
+    const first = h.handle(coast(1, 3)).msg;
+    const store = job.store!;
+    expect(job.resident().length).toBeGreaterThan(0);
+    expect(live(store).every((n) => n > 0)).toBe(true);
+    expect(h.handle(configure(4, null, DEFAULTS, '7')).msg.type).toBe('ready');
+    expect([job.resident(), live(store)]).toEqual([[], [0, 0]]);
+    // A failed configure keeps the configured epoch, its context and its columns.
+    const other = h.handle(coast(2, 4)).msg;
+    const resident = job.resident();
+    expect(h.handle(configure(5, null, { climate: {} })).msg).toMatchObject({ code: 'BAD_PARAMS' });
+    expect(job.resident()).toEqual(resident);
+    expect(h.handle(configure(6)).msg.type).toBe('ready');
+    const again = h.handle(coast(3, 6)).msg;
+    expect(job.store).toBe(store);
+    if (first.type !== 'sliceResult' || other.type !== 'sliceResult' || again.type !== 'sliceResult') throw new Error('no slice');
+    expect(sameBytes(again.blocks, first.blocks)).toBe(true);
+    expect(sameBytes(other.blocks, first.blocks)).toBe(false);
+  });
+});
```

Create `test/unit/sliceJob.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { colKey, torusSlot } from '../../src/core/coords';
import { CROSS_SECTION_POINTS, segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { fillColumnT, genRegionInProcess } from '../../src/metrics/region';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { fluidLevel, fluidType, FLUID_WATER } from '../../src/world/blocks/fluid';
import { REC_EPOCH } from '../../src/world/store/columnTable';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
import { createSliceJob, SLICE_LRU_COLUMNS, SLICE_MAX_BLOCK_BYTES, SLICE_MAX_BYTE_BYTES, type SliceData } from '../../src/workers/sliceJob';
import { ctxFor } from '../harness/gen';
import { regionView } from '../harness/region';

const MiB = 1 << 20;
const NEVER = () => false;
const ctx = ctxFor('42');
const seg = (ax: number, az: number, bx: number, bz: number): Segment => ({ ax, az, bx, bz });
/** Slots in use in each pool: [block, byte]. */
const live = (s: VoxelStore) => [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];
/** The live slots of a fresh store holding just these columns. */
const liveOf = (cols: ReadonlyArray<readonly [number, number]>) => {
  const ref = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  for (const [cx, cz] of cols) fillColumnT(ref, ctx, cx, cz, NEVER);
  return live(ref);
};
/** A slice that is not stopped. */
const runOk = (job: ReturnType<typeof createSliceJob>, s: Segment, epoch = 0): SliceData => {
  const r = job.run(ctx, epoch, s, NEVER);
  if (r === null) throw new Error('slice stopped');
  return r;
};
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
/** The columns a segment's samples fall in, in sample order, each once. */
const columnsOf = (s: Segment): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < SLICE_POINTS; i++) {
    const [x, z] = segmentPointAt(s, i);
    const c: [number, number] = [Math.floor(x) >> 4, Math.floor(z) >> 4];
    const last = out[out.length - 1];
    if (last === undefined || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
  }
  return out;
};

/** A coast west of (−1963, −2000) for seed '42' (sea at (−2000, −2000), land at (−1963, −2000): Task 9's columns). */
const COAST = seg(-2030.5, -2007.25, -1950.75, -1990.5);

describe('slice layout (SP3a spec §5.1)', () => {
  test('512 samples along the line × 384 rows; row 0 is y 319, index (319 − y)·512 + i', () => {
    expect([SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, CROSS_SECTION_POINTS]).toEqual([512, 384, 196608, 512]);
    expect([sliceIndex(0, 319), sliceIndex(511, 319), sliceIndex(0, 318), sliceIndex(7, -64), sliceIndex(511, -64)]).toEqual([0, 511, 512, 383 * 512 + 7, SLICE_SAMPLES - 1]);
  });
  test('the slice store: 32 MiB of blocks, 16 MiB of bytes, an LRU of 64 columns', () => {
    expect([SLICE_MAX_BLOCK_BYTES, SLICE_MAX_BYTE_BYTES, SLICE_LRU_COLUMNS]).toEqual([32 * MiB, 16 * MiB, 64]);
    const job = createSliceJob();
    expect(job.store).toBeNull();
    runOk(job, seg(0, 0, 15, 0));
    expect([job.store!.shared, job.store!.blockPool.maxSlots, job.store!.bytePool.maxSlots]).toEqual([false, 4096, 4096]);
  });
});

describe('slice job: samples (SP3a spec §5.1)', () => {
  test.each<[string, Segment]>([
    ['a coast, west to east', COAST],
    ['the same coast, east to west', seg(COAST.bx, COAST.bz, COAST.ax, COAST.az)],
    ['a short steep line across column boundaries', seg(-1999.9, -2003.2, -2001.1, -1985.6)],
    ['from the window\'s negative corner (−524288, −524288), column (−32768, −32768)', seg(-524288, -524288, -524000, -524100)],
    ['from the window\'s last block (524287, 524287), column (32767, 32767), towards negative x and z', seg(524287, 524287, 523900, 524000)],
    ['along the window\'s last row z = 524287 from its first block x = −524288', seg(-524288, 524287, -523800, 524287)],
  ])('%s: sample (i, y) is the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋) of a region generated in process, byte for byte', (_n, s) => {
    const cols = columnsOf(s);
    const cx0 = Math.min(...cols.map((c) => c[0]));
    const cz0 = Math.min(...cols.map((c) => c[1]));
    const w = Math.max(...cols.map((c) => c[0])) - cx0 + 1;
    const h = Math.max(...cols.map((c) => c[1])) - cz0 + 1;
    const store = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
    genRegionInProcess(store, ctx, cx0, cz0, w, h);
    const view = regionView(store, cx0, cz0, w, h);
    const job = createSliceJob();
    const r = runOk(job, s);
    expect([r.blocks.length, r.fluid.length, r.blocks.buffer.byteLength, r.fluid.buffer.byteLength]).toEqual([SLICE_SAMPLES, SLICE_SAMPLES, 2 * SLICE_SAMPLES, SLICE_SAMPLES]);
    const wantB = new Uint16Array(SLICE_SAMPLES);
    const wantF = new Uint8Array(SLICE_SAMPLES);
    for (let i = 0; i < SLICE_POINTS; i++) {
      const [x, z] = segmentPointAt(s, i);
      for (let y = -64; y <= 319; y++) {
        wantB[(319 - y) * 512 + i] = view.block(Math.floor(x), y, Math.floor(z));
        wantF[(319 - y) * 512 + i] = view.fluid(Math.floor(x), y, Math.floor(z));
      }
    }
    expect(sameBytes(r.blocks, wantB)).toBe(true);
    expect(sameBytes(r.fluid, wantF)).toBe(true);
    // Every column is generated once (the samples of a column are contiguous) and stays resident.
    expect(job.misses).toBe(cols.length);
    expect(job.resident()).toEqual(cols);
  });
  test('the coast slice holds bedrock at row 383, air at row 0, stone, and water sources at and below y 63', () => {
    const r = runOk(createSliceJob(), COAST);
    for (let i = 0; i < SLICE_POINTS; i++) {
      expect([r.blocks[sliceIndex(i, -64)], r.blocks[sliceIndex(i, 319)], r.fluid[sliceIndex(i, 319)]]).toEqual([BEDROCK, AIR, 0]);
    }
    const water = new Set<number>();
    let stone = 0;
    for (let k = 0; k < SLICE_SAMPLES; k++) {
      if (r.blocks[k] === STONE) stone++;
      if (r.fluid[k] !== 0) {
        expect([r.blocks[k], fluidType(r.fluid[k]!), fluidLevel(r.fluid[k]!)]).toEqual([AIR, FLUID_WATER, 0]);
        water.add(319 - Math.floor(k / 512));
      }
    }
    expect(stone).toBeGreaterThan(0);
    expect(Math.max(...water)).toBe(63);
  });
  test('a segment with a problem throws RangeError (the handler answers BAD_ARGS first)', () => {
    const job = createSliceJob();
    expect(() => job.run(ctx, 0, seg(524288, 0, 0, 0), NEVER)).toThrow(RangeError);
    expect(() => job.run(ctx, 0, seg(5, 5, 5, 5), NEVER)).toThrow(/same point/);
  });
});

describe('slice job: the LRU (SP3a spec §5.1)', () => {
  test('a second run of the same line generates nothing; the columns move to the most recent end', () => {
    const job = createSliceJob();
    const a = runOk(job, COAST);
    const misses = job.misses;
    const b = runOk(job, COAST);
    expect([job.misses, job.hits]).toEqual([misses, misses]);
    expect(sameBytes(a.blocks, b.blocks) && sameBytes(a.fluid, b.fluid)).toBe(true);
  });
  test('at 64 resident columns a miss frees the least recently used one', () => {
    const job = createSliceJob();
    // cx 0 … 63 at cz 0: 64 columns on 64 different torus records.
    runOk(job, seg(0, 0, 1023, 0));
    expect(job.resident()).toEqual(Array.from({ length: 64 }, (_, cx) => [cx, 0]));
    const store = job.store!;
    const full = live(store);
    // Touch cx 0 … 4 again (they become the most recent), then 10 new columns at cz 1.
    runOk(job, seg(0, 0, 79, 0));
    runOk(job, seg(0, 16, 159, 16));
    const want = [...Array.from({ length: 49 }, (_, k) => [k + 15, 0]), ...Array.from({ length: 5 }, (_, cx) => [cx, 0]), ...Array.from({ length: 10 }, (_, cx) => [cx, 1])];
    expect(job.resident()).toEqual(want);
    for (let cx = 5; cx < 15; cx++) expect(store.proto(cx, 0)).toBeNull();
    // Nothing leaks: the live slots are those of the 64 resident columns.
    expect(live(store)).toEqual(liveOf(want as Array<[number, number]>));
    expect(full).toEqual(liveOf(Array.from({ length: 64 }, (_, cx) => [cx, 0])));
  });
  test('a miss frees the resident column on the same torus record first, even below 64 columns', () => {
    const job = createSliceJob();
    runOk(job, seg(0, 0, 15, 0));
    const store = job.store!;
    const one = liveOf([[0, 0]]);
    expect(live(store)).toEqual(one);
    expect(torusSlot(64, 0)).toBe(torusSlot(0, 0));
    runOk(job, seg(1024, 0, 1039, 0));
    expect(job.resident()).toEqual([[64, 0]]);
    expect([store.proto(0, 0), store.table.find(0, 0)]).toEqual([null, -1]);
    expect(store.proto(64, 0)).not.toBeNull();
    expect(live(store)).toEqual(liveOf([[64, 0]]));
  });
  test('reset frees every resident column and empties the LRU; a run of another epoch resets first', () => {
    const job = createSliceJob();
    runOk(job, COAST, 3);
    const store = job.store!;
    expect(live(store).every((n) => n > 0)).toBe(true);
    job.reset();
    expect([job.resident(), live(store)]).toEqual([[], [0, 0]]);
    runOk(job, COAST, 3);
    const cols = job.resident();
    runOk(job, seg(0, 0, 15, 0), 4);
    expect(job.resident()).toEqual([[0, 0]]);
    for (const [cx, cz] of cols) expect(store.proto(cx, cz)).toBeNull();
    // The column was claimed with the job's epoch.
    expect(Atomics.load(store.table.ints, store.table.find(0, 0) + REC_EPOCH)).toBe(4);
    expect(store).toBe(job.store);
  });
});

describe('slice job: abort (SP3a spec §5.1)', () => {
  test('stop is read before each column; a column stopped half-way is freed by fillColumnT and not inserted', () => {
    const job = createSliceJob();
    const cols = columnsOf(COAST);
    expect(cols.length).toBeGreaterThanOrEqual(3);
    // Column 0: 1 job poll + 24 section polls; column 1: 1 + 24; column 2: its job poll, then section polls: stop at the 5th.
    let calls = 0;
    expect(job.run(ctx, 0, COAST, () => ++calls > 2 * 25 + 1 + 4)).toBeNull();
    const store = job.store!;
    expect(job.resident()).toEqual(cols.slice(0, 2));
    expect(store.table.find(cols[2]![0], cols[2]![1])).toBe(-1);
    // Live slots are those of the two resident columns: the same as a store holding just them.
    expect(live(store)).toEqual(liveOf(cols.slice(0, 2)));
    // A stop before the first column generates nothing.
    const fresh = createSliceJob();
    expect(fresh.run(ctx, 0, COAST, () => true)).toBeNull();
    expect([fresh.misses, fresh.resident()]).toEqual([0, []]);
    // The stopped job's resident columns are reused by the next run.
    runOk(job, COAST);
    expect([job.hits, job.misses]).toEqual([2, cols.length]);
    // Every column resident: stop is still read once per column, and a stop on a hit stops the run.
    let polls = 0;
    expect(job.run(ctx, 0, COAST, () => { polls++; return false; })).not.toBeNull();
    expect(polls).toBe(cols.length);
    expect(job.run(ctx, 0, COAST, () => true)).toBeNull();
  });
});

describe('slice job: a line whose columns all share torus record 0 (SP3a spec §8)', () => {
  test('A = (0, 0), B = (523264, 0) refreshed 10 times: byte-equal results and flat live-slot counts', () => {
    const s = seg(0, 0, 523264, 0);
    const cols = columnsOf(s);
    expect(cols.length).toBe(512);
    expect(new Set(cols.map(([cx, cz]) => torusSlot(cx, cz)))).toEqual(new Set([0]));
    const job = createSliceJob();
    const first = runOk(job, s);
    const store = job.store!;
    const after = [...live(store), store.blockPool.slotCount(), store.bytePool.slotCount()];
    expect(job.resident()).toEqual([[32704, 0]]);
    for (let k = 1; k < 10; k++) {
      const r = runOk(job, s);
      expect(sameBytes(r.blocks, first.blocks) && sameBytes(r.fluid, first.fluid), `refresh ${k}`).toBe(true);
      expect([...live(store), store.blockPool.slotCount(), store.bytePool.slotCount()], `refresh ${k}`).toEqual(after);
    }
    expect([job.misses, job.hits, job.resident()]).toEqual([5120, 0, [[32704, 0]]]);
    // The last column equals a fresh in-process fill of (32704, 0).
    const ref = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
    fillColumnT(ref, ctx, 32704, 0, NEVER);
    const v = ref.proto(32704, 0)!;
    for (let y = -64; y <= 319; y++) expect(first.blocks[sliceIndex(511, y)]).toBe(v.block(0, y, 0));
    expect(colKey(32704, 0)).toBe(colKey(cols[511]![0], cols[511]![1]));
    // 5,120 columns generated: ≈ 6 s alone, several times that while the whole suite loads the CPU.
  }, 120_000);
});
```

Modify `test/unit/workerPool.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/workerPool.test.ts b/test/unit/workerPool.test.ts
index 7acbac1..9bee1ef 100644
--- a/test/unit/workerPool.test.ts
+++ b/test/unit/workerPool.test.ts
@@ -5,7 +5,8 @@ import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLeng
 import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength } from '../../src/metrics/crossSection';
 import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../../src/metrics/splineStats';
 import type { KnotPath } from '../../src/core/spline/types';
-import type { ToWorker } from '../../src/workers/protocol';
+import { SLICE_SAMPLES, type ToWorker } from '../../src/workers/protocol';
+import { createSliceJob } from '../../src/workers/sliceJob';
 import { createTaskHandler } from '../../src/workers/taskHandler';
 import { ctxFor } from '../harness/gen';
 
@@ -436,3 +437,71 @@ describe('worker pool: probe (SP2b spec §2.8)', () => {
     pool.terminate();
   });
 });
+
+describe('worker pool: slice jobs (SP3a spec §5.1)', () => {
+  const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
+  const slicesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'slice' ? [[m.jobId, m.epoch, m.ax, m.az, m.bx, m.bz]] : []));
+
+  test('a slice is one job on one worker at the stats priority (500: after preview tiles, before fine tiles); it resolves with the job\'s blocks and fluid', async () => {
+    const log: ToWorker[] = [];
+    const pool = createWorkerPool(1, () => fakeWorker(log));
+    const ready = pool.configure('42', DEFAULTS);
+    const fine = pool.tile(tile(1), 1000);
+    const got = pool.slice(COAST);
+    const preview = pool.tile(tile(0), 3);
+    await ready;
+    const [, r] = await Promise.all([fine, got, preview]);
+    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? ['slice'] : []))).toEqual(['tile 0', 'slice', 'tile 1']);
+    expect(slicesOf(log).map((s) => s.slice(1))).toEqual([[0, COAST.ax, COAST.az, COAST.bx, COAST.bz]]);
+    const want = createSliceJob().run(ctxFor('42'), 0, COAST, () => false)!;
+    expect(r.blocks).toBeInstanceOf(Uint16Array);
+    expect(r.fluid).toBeInstanceOf(Uint8Array);
+    expect([r.blocks.length, r.fluid.length]).toEqual([SLICE_SAMPLES, SLICE_SAMPLES]);
+    expect(Buffer.from(r.blocks.buffer).equals(Buffer.from(want.blocks.buffer))).toBe(true);
+    expect(Buffer.from(r.fluid.buffer).equals(Buffer.from(want.fluid.buffer))).toBe(true);
+  });
+  test('a priority can be given; probe shows the job as a slice of level null', async () => {
+    const log: ToWorker[] = [];
+    const pool = createWorkerPool(1, () => fakeWorker(log));
+    const ready = pool.configure('42', DEFAULTS);
+    const jobs = [pool.slice(COAST, 30), pool.tile(tile(1), 20), pool.tile(tile(0), 3)];
+    await ready;
+    await Promise.all(jobs);
+    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? ['slice'] : []))).toEqual(['tile 0', 'tile 1', 'slice']);
+    const idle = createWorkerPool(1, () => silentWorker());
+    void settle(idle.slice(COAST));
+    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'slice', epoch: -1, level: null }]);
+    idle.terminate();
+  });
+  test('a bad line rejects with the worker\'s BAD_ARGS', async () => {
+    const pool = createWorkerPool(1, () => fakeWorker([]));
+    await pool.configure('42', DEFAULTS);
+    await expect(pool.slice({ ax: 3, az: 3, bx: 3, bz: 3 })).rejects.toThrow(/^BAD_ARGS: A and B are the same point/);
+    await expect(pool.slice({ ax: 0, az: 0, bx: 524288, bz: 0 })).rejects.toThrow(/^BAD_ARGS: B \(524288, 0\) is outside/);
+  });
+  test('a configure rejects a queued slice with JobCancelled', async () => {
+    const pool = createWorkerPool(1, () => fakeWorker([]));
+    const first = pool.configure('42', DEFAULTS);
+    const req = settle(pool.slice(COAST));
+    const second = pool.configure('7', DEFAULTS);
+    expect(await settle(first)).toBeInstanceOf(JobCancelled);
+    expect(await req).toBeInstanceOf(JobCancelled);
+    expect((await second).epoch).toBe(1);
+  });
+  test('an in-flight slice of a superseded epoch is aborted by the worker (ABORTED) and rejects as JobCancelled; the next slice runs', async () => {
+    const cell = new Int32Array(new SharedArrayBuffer(4));
+    const log: ToWorker[] = [];
+    const replies: unknown[] = [];
+    const held = heldWorker(log, (m) => m.type === 'slice', replies);
+    const pool = createWorkerPool(1, () => held, { abortCell: cell });
+    await pool.configure('42', DEFAULTS);
+    const req = settle(pool.slice(COAST));
+    const next = pool.configure('42', DEFAULTS);
+    held.flush();
+    expect(await req).toBeInstanceOf(JobCancelled);
+    expect(replies).toContainEqual(expect.objectContaining({ type: 'error', epoch: 0, code: 'ABORTED' }));
+    expect((await next).epoch).toBe(1);
+    held.holding = false;
+    expect((await pool.slice(COAST)).blocks.length).toBe(SLICE_SAMPLES);
+  });
+});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/perfHook.test.ts test/unit/protocol.test.ts test/unit/sliceJob.test.ts test/unit/workerPool.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× logs configure posted and ready and the preview jobs done, and otherwise behaves as the pool 543ms
FAIL  |unit| test/unit/protocol.test.ts [ test/unit/protocol.test.ts ]
Error: Cannot find module '../../src/workers/sliceJob' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/protocol.test.ts
FAIL  |unit| test/unit/sliceJob.test.ts [ test/unit/sliceJob.test.ts ]
Error: Cannot find module '../../src/workers/sliceJob' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/sliceJob.test.ts
FAIL  |unit| test/unit/workerPool.test.ts [ test/unit/workerPool.test.ts ]
Error: Cannot find module '../../src/workers/sliceJob' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/workerPool.test.ts
FAIL  |unit| test/unit/perfHook.test.ts > instrumented pool (SP2b spec §2.8) > logs configure posted and ready and the preview jobs done, and otherwise behaves as the pool
TypeError: pool.slice is not a function
Test Files  4 failed (4)
Tests  1 failed | 8 passed (9)
```

- [ ] **Step 3: Implement**

Modify `src/engine/workerPool.ts` (apply with `git apply`):

```diff
diff --git a/src/engine/workerPool.ts b/src/engine/workerPool.ts
index 093afae..b9bc194 100644
--- a/src/engine/workerPool.ts
+++ b/src/engine/workerPool.ts
@@ -8,11 +8,13 @@
  * with WorkerFailed. SP2b §5.4: a stats request runs as `size` slices whose raw sums are added element-wise
  * (a crossSection request as one job, §4.5).
  * SP2b §2.8: `probe()` reports what the workers run, for the latency hook.
+ * SP3a §5.1: a slice request (the voxels under a line) runs as one job on one worker, as a crossSection does.
  */
 import type { MapLevel } from '../core/constants';
 import type { ColumnPoint } from '../gen/column/columnPoint';
 import type { Spawn } from '../gen/column/spawn';
 import type { LayerId } from '../gen/map/layers';
+import type { Segment } from '../metrics/crossSection';
 import { parseFromWorker, STATS_KINDS, type FromWorker, type ReadyMsg, type StatsArgs, type StatsKind, type StatsMsg, type ToWorker } from '../workers/protocol';
 
 export interface WorkerLike {
@@ -29,6 +31,15 @@ export interface TileRequest { readonly layer: LayerId; readonly level: MapLevel
 /** A painted tile: RGBA bytes, and for layer 'biome' the biome id of every pixel (SP2b spec §5.3). */
 export interface TileResult { readonly rgba: ArrayBuffer; readonly ids: ArrayBuffer | null }
 
+/**
+ * The voxels of the vertical slice under a line (SP3a spec §5.1): SLICE_SAMPLES (512 × 384) block states and fluid
+ * bytes, sample (i, y) at `sliceIndex(i, y)` of `workers/protocol.ts` (row 0 is y 319).
+ */
+export interface SliceResult {
+  readonly blocks: Uint16Array<ArrayBuffer>;
+  readonly fluid: Uint8Array<ArrayBuffer>;
+}
+
 export class JobCancelled extends Error {
   constructor() { super('job cancelled'); }
 }
@@ -88,6 +99,12 @@ export interface WorkerPool {
    * non-negative integer or args.len not a positive one.
    */
   stats<K extends StatsKind>(kind: K, n: number, args: StatsArgs<K>, priority?: number): Promise<Float64Array<ArrayBuffer>>;
+  /**
+   * The slice under `segment` (SP3a spec §5.1): one job on one worker, never split, at `priority` (default 500, the
+   * stats priority). A configure rejects it with JobCancelled, and so does an ABORTED reply; a line with an end
+   * outside the half-open world window or of zero length rejects with the worker's BAD_ARGS.
+   */
+  slice(segment: Segment, priority?: number): Promise<SliceResult>;
   /** Recomputes one golden in a worker (no configure needed). */
   selftest(key: string): Promise<{ actual: string | null; error: string | null }>;
   /** Rejects queued tile jobs matching `pred` with JobCancelled. */
@@ -277,6 +294,13 @@ export function createWorkerPool(size: number, spawn: () => WorkerLike, opts: Po
       }
       return sum;
     },
+    async slice(segment, priority = 500) {
+      const e = epoch;
+      const { ax, az, bx, bz } = segment;
+      const r = await enqueue(priority, (jobId) => ({ type: 'slice', jobId, epoch: e, ax, az, bx, bz }), null);
+      if (r.type !== 'sliceResult') throw new Error(`unexpected reply ${r.type}`);
+      return { blocks: new Uint16Array(r.blocks), fluid: new Uint8Array(r.fluid) };
+    },
     async selftest(key) {
       const r = await enqueue(0, (jobId) => ({ type: 'selftest', jobId, key }), null);
       if (r.type !== 'selftestResult') throw new Error(`unexpected reply ${r.type}`);
```

Modify `src/ui/map/perfHook.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/map/perfHook.ts b/src/ui/map/perfHook.ts
index 012be50..7893509 100644
--- a/src/ui/map/perfHook.ts
+++ b/src/ui/map/perfHook.ts
@@ -221,6 +221,7 @@ export function instrumentPool(pool: WorkerPool, log: LatencyLog, now: () => num
     point: (x, z, priority) => pool.point(x, z, priority),
     spawn: () => pool.spawn(),
     stats: (kind, n, args, priority) => pool.stats(kind, n, args, priority),
+    slice: (segment, priority) => pool.slice(segment, priority),
     selftest: (key) => pool.selftest(key),
     cancelTiles: (pred) => pool.cancelTiles(pred),
     probe: () => pool.probe(),
```

Modify `src/workers/protocol.ts` (apply with `git apply`):

```diff
diff --git a/src/workers/protocol.ts b/src/workers/protocol.ts
index 420d606..63c13d4 100644
--- a/src/workers/protocol.ts
+++ b/src/workers/protocol.ts
@@ -1,11 +1,11 @@
 /**
  * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
- * The main thread sends configure / mapTile / point / spawn / stats / selftest; the worker answers ready /
- * tile / pointResult / spawnResult / statsResult / selftestResult / error. selftest needs no configure.
+ * The main thread sends configure / mapTile / point / spawn / stats / slice / selftest; the worker answers ready /
+ * tile / pointResult / spawnResult / statsResult / sliceResult / selftestResult / error. selftest needs no configure.
  * Configure carries the pool's abort cell (SP2b spec §2.2), errors carry the epoch of the message they
  * answer (§2.3), biome tiles carry the biome id of every pixel (§5.3), and a stats job returns the raw
  * sums of one kind over a range of the kind's fixed point stream (§5.4) or, for crossSection, of the points
- * along its line (§4.5).
+ * along its line (§4.5). A slice job (SP3a spec §5.1) returns the voxels of the vertical slice under a line.
  */
 import { MAP_LEVELS, MAP_TILE_PX, type MapLevel } from '../core/constants';
 import type { StageId } from '../core/ids';
@@ -41,7 +41,12 @@ export interface CrossSectionMsg extends StatsBase {
 export type StatsMsg = SplineStatsMsg | BiomeSharesMsg | CrossSectionMsg;
 export type StatsKind = StatsMsg['kind'];
 export type StatsArgs<K extends StatsKind> = Extract<StatsMsg, { readonly kind: K }>['args'];
-export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SelftestMsg;
+/**
+ * The vertical slice under the line A = (ax, az) → B = (bx, bz) (SP3a spec §5.1): one job, never split. The ends are
+ * only checked to be numbers here; an end outside the half-open world window or A = B is the handler's BAD_ARGS.
+ */
+export interface SliceMsg { readonly type: 'slice'; readonly jobId: number; readonly epoch: number; readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }
+export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SliceMsg | SelftestMsg;
 
 export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
 /** `ids` (256·256 biome ids, one per pixel) comes with layer 'biome' only. */
@@ -54,9 +59,23 @@ export interface ErrorMsg { readonly type: 'error'; readonly jobId: number | nul
 export interface SpawnResultMsg { readonly type: 'spawnResult'; readonly jobId: number; readonly epoch: number; readonly spawn: Spawn }
 /** `data` holds a Float64Array of the job's raw, unnormalised sums (transferred). */
 export interface StatsResultMsg { readonly type: 'statsResult'; readonly jobId: number; readonly epoch: number; readonly kind: StatsKind; readonly data: ArrayBuffer }
+/**
+ * A slice's voxels (transferred): `blocks` holds SLICE_SAMPLES u16 block states and `fluid` SLICE_SAMPLES fluid
+ * bytes, sample (i, y) at `sliceIndex(i, y)`.
+ */
+export interface SliceResultMsg { readonly type: 'sliceResult'; readonly jobId: number; readonly epoch: number; readonly blocks: ArrayBuffer; readonly fluid: ArrayBuffer }
 /** One recomputed golden: the digest, or the error that stopped it. */
 export interface SelftestResultMsg { readonly type: 'selftestResult'; readonly jobId: number; readonly key: string; readonly actual: string | null; readonly error: string | null }
-export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SelftestResultMsg | ErrorMsg;
+export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SliceResultMsg | SelftestResultMsg | ErrorMsg;
+
+/** Samples along a slice's line, A and B included (the cross-section's 512 points, SP2b spec §4.5). */
+export const SLICE_POINTS = 512;
+/** Rows of a slice: y 319 down to −64. */
+export const SLICE_ROWS = 384;
+/** Entries of a slice's blocks and fluid arrays: 512 × 384. */
+export const SLICE_SAMPLES = SLICE_POINTS * SLICE_ROWS;
+/** Index of sample (i, y) in a slice: row 0 is y 319, the order the Voxels mode draws in. */
+export const sliceIndex = (i: number, y: number): number => (319 - y) * SLICE_POINTS + i;
 
 const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
 const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
@@ -120,6 +139,8 @@ export function parseToWorker(m: unknown): ToWorker | null {
       return isInt(m['jobId']) && isInt(m['epoch']) ? (m as unknown as SpawnMsg) : null;
     case 'stats':
       return statsOk(m) ? (m as unknown as StatsMsg) : null;
+    case 'slice':
+      return isInt(m['jobId']) && isInt(m['epoch']) && SEGMENT_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SliceMsg) : null;
     case 'selftest':
       return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
     default:
@@ -145,6 +166,12 @@ export function parseFromWorker(m: unknown): FromWorker | null {
       const data = m['data'];
       return isInt(m['jobId']) && isInt(m['epoch']) && isStatsKind(m['kind']) && data instanceof ArrayBuffer && data.byteLength > 0 && data.byteLength % 8 === 0 ? (m as unknown as StatsResultMsg) : null;
     }
+    case 'sliceResult': {
+      const blocks = m['blocks'];
+      const fluid = m['fluid'];
+      const ok = blocks instanceof ArrayBuffer && blocks.byteLength === 2 * SLICE_SAMPLES && fluid instanceof ArrayBuffer && fluid.byteLength === SLICE_SAMPLES;
+      return isInt(m['jobId']) && isInt(m['epoch']) && ok ? (m as unknown as SliceResultMsg) : null;
+    }
     case 'error': return (m['jobId'] === null || isInt(m['jobId'])) && (m['epoch'] === null || isInt(m['epoch'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? (m as unknown as ErrorMsg) : null;
     default: return null;
   }
```

Create `src/workers/sliceJob.ts`:

```ts
/**
 * The slice job (SP3a spec §5.1): the voxels of the vertical slice under a line, from a worker-local voxel store.
 * Sample (i, y) is the proto voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋), where (xᵢ, zᵢ) = `segmentPointAt(segment, i)`, for i 0 … 511 and
 * y −64 … 319, written at `sliceIndex(i, y)` (row 0 is y 319).
 *
 * The store (an `ArrayBuffer` store of 32 MiB of blocks and 16 MiB of bytes) is created on the first run and kept;
 * an LRU keyed by colKey holds at most 64 generated columns of one epoch. The job walks the samples in order: a
 * straight segment enters each column once (⌊x⌋ and ⌊z⌋ are monotone along it), so a column's samples are
 * contiguous. On reaching a new column it calls `stop`, then takes the column from the LRU or, on a miss, frees the
 * resident column on the same torus record (if any), frees the least recently used column if 64 are resident and
 * runs `fillColumnT` with `stop` and the job's epoch. It reads all of the column's samples before moving on, so it
 * never holds two columns of one torus record and `claimColumn` never throws `SlotBusy`. A stopped column is freed
 * by `fillColumnT` and not inserted; the run returns null.
 */
import { colKey, torusSlot } from '../core/coords';
import type { GenContext } from '../gen/context';
import { segmentPointAt, segmentProblem, type Segment } from '../metrics/crossSection';
import { fillColumnT } from '../metrics/region';
import { createStore, type VoxelStore } from '../world/store/store';
import { SLICE_POINTS, SLICE_SAMPLES } from './protocol';

const COL_KEY = colKey;
const TORUS = torusSlot;
const POINT_AT = segmentPointAt;
const PROBLEM = segmentProblem;
const FILL = fillColumnT;
const CREATE_STORE = createStore;
const N = SLICE_POINTS;
const SAMPLES = SLICE_SAMPLES;

const MiB = 1 << 20;
/** The slice store's pool maxima: 65 proto columns need at most 1,560 block and 1,625 byte slots (§5.1). */
export const SLICE_MAX_BLOCK_BYTES = 32 * MiB;
export const SLICE_MAX_BYTE_BYTES = 16 * MiB;
/** Columns the slice store keeps between jobs. */
export const SLICE_LRU_COLUMNS = 64;

/** A slice's voxels: SLICE_SAMPLES block states and fluid bytes, sample (i, y) at `sliceIndex(i, y)`. */
export interface SliceData {
  readonly blocks: Uint16Array<ArrayBuffer>;
  readonly fluid: Uint8Array<ArrayBuffer>;
}

export interface SliceJob {
  /**
   * The slice under `segment`, with columns generated by `ctx` and claimed with `epoch`; null when `stop` fired. A
   * run of another epoch than the resident columns' first frees them. Throws RangeError on a segment with a problem
   * (`segmentProblem`: an end outside the window, or A = B).
   */
  run(ctx: GenContext, epoch: number, segment: Segment, stop: () => boolean): SliceData | null;
  /** Frees every resident column and empties the LRU (a configure). */
  reset(): void;
  /** The slice store, null before the first run. */
  readonly store: VoxelStore | null;
  /** The resident columns (cx, cz), least recently used first. */
  resident(): Array<[number, number]>;
  /** Columns generated (LRU misses that completed) and taken from the LRU, over the job's lifetime. */
  readonly misses: number;
  readonly hits: number;
}

interface Resident {
  readonly cx: number;
  readonly cz: number;
}

export function createSliceJob(): SliceJob {
  let store: VoxelStore | null = null;
  /** Insertion order = recency: a hit is deleted and set again. */
  const lru = new Map<number, Resident>();
  /** colKey of the resident column on each used torus record. */
  const bySlot = new Map<number, number>();
  let lruEpoch: number | null = null;
  let misses = 0;
  let hits = 0;
  /** The current column's 24 proto block and fluid sections (a dense view or the uniform value). */
  const secBlocks: Array<Uint16Array | number> = new Array<Uint16Array | number>(24).fill(0);
  const secFluid: Array<Uint8Array | number> = new Array<Uint8Array | number>(24).fill(0);

  const drop = (st: VoxelStore, key: number): void => {
    const c = lru.get(key)!;
    st.freeColumn(c.cx, c.cz);
    lru.delete(key);
    bySlot.delete(TORUS(c.cx, c.cz));
  };

  const reset = (): void => {
    if (store !== null) for (const key of [...lru.keys()]) drop(store, key);
    lru.clear();
    bySlot.clear();
    lruEpoch = null;
  };

  /** Loads column (cx, cz) into the section arrays from the LRU or by generating it; false when stopped. */
  const load = (st: VoxelStore, ctx: GenContext, cx: number, cz: number, epoch: number, stop: () => boolean): boolean => {
    const key = COL_KEY(cx, cz);
    const hit = lru.get(key);
    if (hit !== undefined) {
      lru.delete(key);
      lru.set(key, hit);
      hits++;
    } else {
      const slot = TORUS(cx, cz);
      const holder = bySlot.get(slot);
      if (holder !== undefined) drop(st, holder);
      if (lru.size >= SLICE_LRU_COLUMNS) drop(st, lru.keys().next().value!);
      if (!FILL(st, ctx, cx, cz, stop, epoch)) return false;
      lru.set(key, { cx, cz });
      bySlot.set(slot, key);
      misses++;
    }
    const v = st.proto(cx, cz);
    if (v === null) throw new Error(`slice: column (${cx}, ${cz}) is resident but has no proto set`);
    for (let sy = 0; sy < 24; sy++) {
      secBlocks[sy] = v.sectionBlocks(sy);
      secFluid[sy] = v.sectionFluid(sy);
    }
    return true;
  };

  return {
    get store() { return store; },
    get misses() { return misses; },
    get hits() { return hits; },
    resident: () => [...lru.values()].map((c): [number, number] => [c.cx, c.cz]),
    reset,
    run(ctx, epoch, segment, stop) {
      const problem = PROBLEM(segment);
      if (problem !== null) throw new RangeError(`slice: ${problem}`);
      if (lruEpoch !== epoch) {
        reset();
        lruEpoch = epoch;
      }
      const st = store ??= CREATE_STORE({ shared: false, maxBlockBytes: SLICE_MAX_BLOCK_BYTES, maxByteBytes: SLICE_MAX_BYTE_BYTES });
      const blocks = new Uint16Array(SAMPLES);
      const fluid = new Uint8Array(SAMPLES);
      let curCx = 0;
      let curCz = 0;
      let loaded = false;
      for (let i = 0; i < N; i++) {
        const [x, z] = POINT_AT(segment, i);
        const bx = Math.floor(x);
        const bz = Math.floor(z);
        const cx = bx >> 4;
        const cz = bz >> 4;
        if (!loaded || cx !== curCx || cz !== curCz) {
          if (stop() || !load(st, ctx, cx, cz, epoch, stop)) return null;
          curCx = cx;
          curCz = cz;
          loaded = true;
        }
        const inSection = ((bz & 15) << 4) | (bx & 15);
        // Row of y = 16·sy − 64 + ly is 319 − y = 383 − 16·sy − ly.
        for (let sy = 0; sy < 24; sy++) {
          const b = secBlocks[sy]!;
          const f = secFluid[sy]!;
          let at = (383 - 16 * sy) * N + i;
          for (let ly = 0; ly < 16; ly++, at -= N) {
            blocks[at] = typeof b === 'number' ? b : b[(ly << 8) | inSection]!;
            fluid[at] = typeof f === 'number' ? f : f[(ly << 8) | inSection]!;
          }
        }
      }
      return { blocks, fluid };
    },
  };
}
```

Modify `src/workers/taskHandler.ts` (apply with `git apply`):

```diff
diff --git a/src/workers/taskHandler.ts b/src/workers/taskHandler.ts
index 9168f41..88f7702 100644
--- a/src/workers/taskHandler.ts
+++ b/src/workers/taskHandler.ts
@@ -1,10 +1,12 @@
 /**
  * The pure message handler of a task worker (SP2a spec §5.1): owns one GenContext per configured epoch
  * and answers each validated message. No DOM and no worker globals, so Node tests drive it directly.
- * Tile, spawn and stats jobs stop as soon as the pool's abort cell leaves their epoch and reply ABORTED
+ * Tile, spawn, stats and slice jobs stop as soon as the pool's abort cell leaves their epoch and reply ABORTED
  * (SP2b spec §2.2); point and selftest jobs always run to the end. Stats jobs (§5.4) run the metrics
  * functions over a range of their kind's fixed point stream, or of the points along a crossSection's line
- * (§4.5), and reply with the raw sums.
+ * (§4.5), and reply with the raw sums. Slice jobs (SP3a spec §5.1) read the voxels under a line from the
+ * handler's slice job (`sliceJob.ts`: a worker-local store and LRU kept for the handler's lifetime, emptied by every
+ * configure) and stop like stats jobs.
  */
 import { hex64 } from '../core/hash';
 import { checkParams } from '../core/params/kit';
@@ -21,6 +23,7 @@ import type { Points } from '../metrics/noiseStats';
 import { computeAnyGolden } from '../metrics/sp2aGoldens';
 import { splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../metrics/splineStats';
 import { parseToWorker, type ErrorCode, type FromWorker, type StatsMsg } from './protocol';
+import { createSliceJob, type SliceJob } from './sliceJob';
 
 const HEX = hex64;
 const CHECK = checkParams;
@@ -45,6 +48,7 @@ const SECTION_POINTS = CROSS_SECTION_POINTS;
 const SECTION_INTO = crossSectionInto;
 const SECTION_LEN = crossSectionLength;
 const SEGMENT_PROBLEM = segmentProblem;
+const CREATE_SLICE_JOB = createSliceJob;
 
 export interface Reply {
   readonly msg: FromWorker;
@@ -101,7 +105,8 @@ function runStats(ctx: GenContext, m: StatsMsg, stop: () => boolean): Float64Arr
   return SHARES_INTO(ctx, pts, m.from, m.to, out, stop) ? out : null;
 }
 
-export function createTaskHandler(): TaskHandler {
+/** `slices` is the worker's slice job (a test seam; one per handler by default). */
+export function createTaskHandler(slices: SliceJob = CREATE_SLICE_JOB()): TaskHandler {
   let epoch = -1;
   let ctx: GenContext | null = null;
   let cell: Int32Array | null = null;
@@ -124,6 +129,7 @@ export function createTaskHandler(): TaskHandler {
           const seed = SEED(m.seedText);
           ctx = CREATE(seed, params);
           epoch = m.epoch;
+          slices.reset();
           cell = m.abort === null ? null : new Int32Array(m.abort);
           const h = HASHES(params);
           const hex: Record<string, string> = {};
@@ -159,6 +165,14 @@ export function createTaskHandler(): TaskHandler {
           if (typeof sum === 'string') return err(m.jobId, m.epoch, 'BAD_ARGS', sum);
           return { msg: { type: 'statsResult', jobId: m.jobId, epoch, kind: m.kind, data: sum.buffer }, transfer: [sum.buffer] };
         }
+        if (m.type === 'slice') {
+          const segment = { ax: m.ax, az: m.az, bx: m.bx, bz: m.bz };
+          const problem = SEGMENT_PROBLEM(segment);
+          if (problem !== null) return err(m.jobId, m.epoch, 'BAD_ARGS', problem);
+          const r = slices.run(ctx, m.epoch, segment, stopFor(m.epoch));
+          if (r === null) return aborted();
+          return { msg: { type: 'sliceResult', jobId: m.jobId, epoch, blocks: r.blocks.buffer, fluid: r.fluid.buffer }, transfer: [r.blocks.buffer, r.fluid.buffer] };
+        }
         return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
       } catch (e) {
         return err(jobId, msgEpoch, 'INTERNAL', e instanceof Error ? e.message : String(e));
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/perfHook.test.ts test/unit/protocol.test.ts test/unit/sliceJob.test.ts test/unit/workerPool.test.ts`

Expected: PASS (exit 0)

```
Test Files  4 passed (4)
Tests  113 passed (113)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  118 passed | 2 skipped (120)
Tests  1544 passed | 2 skipped (1546)
```

- [ ] **Step 6: Commit**

```bash
git add src/engine/workerPool.ts src/ui/map/perfHook.ts src/workers/protocol.ts src/workers/sliceJob.ts src/workers/taskHandler.ts test/unit/perfHook.test.ts test/unit/protocol.test.ts test/unit/sliceJob.test.ts test/unit/workerPool.test.ts
git commit -F - <<'EOF'
feat(workers,engine): the slice job and pool.slice (SP3a §5.1)

- protocol: {type: 'slice', jobId, epoch, ax, az, bx, bz} ->
  {type: 'sliceResult', jobId, epoch, blocks, fluid} (ArrayBuffers of
  512 x 384 u16 states and fluid bytes, transferred); SLICE_POINTS,
  SLICE_ROWS, SLICE_SAMPLES and sliceIndex(i, y) = (319 - y)·512 + i.
- workers/sliceJob.ts: a worker-local ArrayBuffer store (32 MiB blocks,
  16 MiB bytes) made on the first slice and kept, an LRU of at most 64
  columns of one epoch keyed by colKey; samples (floor x_i, y, floor z_i)
  at segmentPointAt(segment, i); per new column: stop, then an LRU hit or
  free the column on the same torus record, free the LRU tail at 64, and
  fillColumnT with stop and the job's epoch. A stopped column is freed by
  fillColumnT and not inserted.
- taskHandler: BAD_ARGS for an end outside the half-open window or A = B
  (segmentProblem, as crossSection), ABORTED through the abort cell, and
  every configure frees the resident columns.
- workerPool: pool.slice(segment, priority = 500) as one job on one
  worker; configure and ABORTED reject it with JobCancelled. The latency
  hook's instrumented pool forwards it.
- Tests: buffer layout, byte equality with a RegionView at
  (floor x_i, y, floor z_i) both directions, LRU and torus eviction,
  reset/reconfigure, abort mid-column, and the all-record-0 line
  A = (0, 0), B = (523264, 0) refreshed 10 times with byte-equal results
  and flat live-slot counts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `272bb7a` on `dry/sp3a`; 9 files changed, 641 insertions(+), 10 deletions(-)):

RED replay (the commit's `test/**` over the parent, throwaway detached worktree, unit + arch): 4 files failed — `test/unit/sliceJob.test.ts`, `protocol.test.ts` and `workerPool.test.ts` fail to import `src/workers/sliceJob` (whole files), `perfHook.test.ts` 1 failed (`pool.slice is not a function`); 103 files / 1407 tests pass. GREEN: typecheck clean; `npm test` 118 files passed, 2 skipped / 1534 passed, 2 skipped (≈90 s, load average ≈4); `npm run build` green. Slice cost: ≈1.3 ms per generated column under that load (fillColumnT dominates; the walk and the reads are noise), a fully cached rerun ≈18 ms. Mutations checked (scratch, restored): no torus-holder eviction (3 fail: SlotBusy), a hit not moved to the recent end (1), no `slices.reset()` on configure (1), no epoch reset in `run` (1), LRU bound 65 (1), no `stop()` before a column (survived at first — `fillColumnT` polls before section 0 anyway — then caught by the added all-hits stop assertion).

- Ruling: the job lives in `src/workers/sliceJob.ts`: `createSliceJob(): SliceJob` = `run(ctx, epoch, segment, stop): SliceData | null`, `reset()`, `store` (null before the first run), `resident()` (cx, cz, least recently used first), `misses`/`hits` counters, and `SLICE_MAX_BLOCK_BYTES` 32 MiB, `SLICE_MAX_BYTE_BYTES` 16 MiB, `SLICE_LRU_COLUMNS` 64; `createTaskHandler(slices = createSliceJob())` takes it as an optional test seam (the store and LRU are observable only through it; `buildNodeTaskWorker`'s no-argument contract is unchanged) — §5.1 puts the store and LRU "in the worker" without an API — cost if wrong: none (internal).
- Ruling: the slice layout lives in `workers/protocol.ts`: `SLICE_POINTS` 512, `SLICE_ROWS` 384, `SLICE_SAMPLES` 196,608 and `sliceIndex(i, y) = (319 − y)·512 + i` as literals (the protocol is in the main bundle and imports no metrics values); a unit test pins `SLICE_POINTS = CROSS_SECTION_POINTS`. Task 14's Voxels mode should read the buffers through `sliceIndex` — cost if wrong: none.
- Ruling: `parseToWorker` checks only that the four ends are numbers (as crossSection); the handler answers `BAD_ARGS` with `segmentProblem`'s text after `NOT_CONFIGURED`/`STALE_EPOCH`, and `SliceJob.run` itself throws RangeError on such a segment (defensive); `parseFromWorker` requires `blocks` and `fluid` to be ArrayBuffers of exactly 393,216 and 196,608 bytes — cost if wrong: none.
- Ruling: the handler calls `slices.reset()` on every successful configure (a `BAD_PARAMS` configure keeps the old context, epoch and columns, as it already kept the context), and `run` resets by itself when its epoch differs from the resident columns' — the "one configured epoch" invariant holds even without the handler — cost if wrong: none.
- Ruling: on a miss the job first frees the resident column on the same torus record, then the LRU tail if 64 are still resident, then generates — so at most 64 columns are resident even while one is generated (§5.1 sizes the store for 65, an upper bound) — cost if wrong: none.
- Ruling: `stop` is polled once per column on hits and misses alike, plus `fillColumnT`'s 24 polls on a miss; a stopped run keeps the columns it completed (valid for the epoch: a rerun of the same epoch reuses them, a configure frees them) — §5.1 "a stopped column is freed by fillColumnT, not inserted" says nothing of the completed ones — cost if wrong: one `reset()` on the abort path.
- Ruling: the walk caches the column's 24 `sectionBlocks`/`sectionFluid` (dense view or uniform value) when it enters it and writes each sample's 384 entries from them, so uniform sections cost no lookup and no per-voxel bounds checks; "no fluid" (−1) reads as 0 — cost if wrong: none.
- Ruling: `pool.slice` resolves `SliceResult = {blocks: Uint16Array, fluid: Uint8Array}` (views over the transferred buffers), validates nothing on the main thread (a bad line rejects with `Error('BAD_ARGS: …')` from the worker, as crossSection stats do), and appears in `probe()` as type 'slice', level null; `instrumentPool` (latency hook) forwards it untimed — cost if wrong: none.
- Ruling: the all-record-0 test (A = (0, 0), B = (523264, 0): every sample's column is cx = 64·i, torus record 0; 10 refreshes = 5,120 generated columns) takes ≈6 s alone and passed the unit project's 30 s timeout under the full suite's load (38 s once), so it carries its own 120 s timeout; it checks byte-equal results, flat live-slot counts and flat pool sizes after every refresh, 5,120 misses, 0 hits, and the last sample against a fresh in-process fill — §8 fixes the line and the 10 refreshes — cost if wrong: ≈6 s of unit time (vitest runs files in parallel).
- Ruling: the sample tests compare the whole 512 × 384 buffers byte for byte with `regionView` reads at (⌊xᵢ⌋, y, ⌊zᵢ⌋) of a region generated by `genRegionInProcess` on a separate store, for a coast line (Task 9's seed-'42' sea and land columns near (−2000, −2000)) in both directions and a short steep line; the coast slice also holds bedrock in row 383, air in row 0, stone, and water sources whose top is y 63 — cost if wrong: none.
- No spec defects found for Task 13.

---

### Task 14: The Voxels mode

**Spec:** §5.2

**Files:**
- Modify: `src/ui/crossSection/model.ts`
- Modify: `src/ui/crossSection/section.css`
- Modify: `src/ui/crossSection/section.ts`
- Create: `src/ui/crossSection/voxels.ts`
- Modify: `test/harness/png.ts`
- Modify: `test/tools/uiSmoke.ts`
- Modify: `test/unit/crossSectionModel.test.ts`
- Create: `test/unit/crossSectionVoxels.test.ts`
- Modify: `test/unit/uiSmoke.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/core/coords.ts` (Task 2): `MAX_Y`
  - `src/world/blocks/fluid.ts` (Task 3): `FLUID_LAVA`, `FLUID_WATER`, `WATER_SOURCE`, `fluidFalling`, `fluidLevel`, `fluidType`
  - `src/world/blocks/index.ts` (Task 4): `AIR`, `BEDROCK`, `REGISTRY`, `STONE`
- Produces (exports added by this task):
  - `src/ui/crossSection/model.ts`:
    - `export interface LineSource`
    - `export interface LineRequests<R>`
    - `export function createLineRequests<R>(src: LineSource, fetch: (line: Segment) => Promise<R>): LineRequests<R>`
    - `export interface SectionSource extends LineSource`
    - `export type SectionRequests = LineRequests<CrossSectionProfile>;`
    - `export function createSectionRequests(src: SectionSource): SectionRequests`
    - `export interface SliceSource extends LineSource`
    - `export type SliceRequests = LineRequests<SliceResult>;`
    - `export function createSliceRequests(src: SliceSource): SliceRequests`
    - `export type SectionMode = 'profile' | 'voxels';`
    - `export const SECTION_MODES: readonly SectionMode[] = Object.freeze(['profile', 'voxels']);`
    - `export function sectionStatus(view: SectionView, pending: boolean, hasLine: boolean, mode: SectionMode = 'profile'): string`
  - `src/ui/crossSection/voxels.ts`:
    - `export type Rgb = readonly [number, number, number];`
    - `export const VOXEL_COLORS =`
    - `export const SEA_LEVEL_Y = SEA_LEVEL;`
    - `export function voxelRgb(state: number, fluid: number, depth: number): Rgb`
    - `export function sliceRgba(s: SliceResult): Uint8ClampedArray<ArrayBuffer>`
    - `export interface VoxelPlots`
    - `export function voxelPlots(box: PlotBox, length: number): VoxelPlots`
    - `export interface VoxelCell`
    - `export function voxelCell(cells: Plot, px: number, py: number): VoxelCell | null`
    - `export function blockName(state: number): string`
    - `export function fluidText(b: number): string`
    - `export function voxelReadout(line: Segment, s: SliceResult, i: number, y: number): string`
    - `export function sliceSummary(s: SliceResult): string`
  - `test/harness/png.ts`:
    - `export { SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb };`
  - `test/tools/uiSmoke.ts`:
    - `export function voxelReadoutOk(text: string): boolean`
    - `export function voxelSummaryOk(text: string): boolean`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/crossSectionModel.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/crossSectionModel.test.ts b/test/unit/crossSectionModel.test.ts
index 712a3c0..6683ada 100644
--- a/test/unit/crossSectionModel.test.ts
+++ b/test/unit/crossSectionModel.test.ts
@@ -149,7 +149,7 @@ describe('the profile\'s requests and stale state', () => {
     await flush();
     expect(h.r.pending).toBeNull();
     expect(h.r.shown?.epoch).toBe(3);
-    expect(h.r.shown?.profile).toEqual(coast());
+    expect(h.r.shown?.value).toEqual(coast());
     expect(h.changes()).toBe(3);
     h.r.request(true);
     expect(h.calls).toHaveLength(1);
```

Create `test/unit/crossSectionVoxels.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { SEA_LEVEL } from '../../src/core/constants';
import { JobCancelled, type SliceResult, type WorkerPool } from '../../src/engine/workerPool';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { genRegionInProcess } from '../../src/metrics/region';
import { createSliceRequests, sectionStatus, SECTION_MODES } from '../../src/ui/crossSection/model';
import {
  blockName, fluidText, sliceRgba, sliceSummary, SEA_LEVEL_Y, VOXEL_COLORS, voxelCell, voxelPlots, voxelReadout, voxelRgb,
} from '../../src/ui/crossSection/voxels';
import { toPx } from '../../src/ui/splineEditor/model';
import { FLUID_LAVA, FLUID_WATER, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { SLICE_POINTS, SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
import { createSliceJob } from '../../src/workers/sliceJob';
import * as png from '../harness/png';
import { ctxFor } from '../harness/gen';
import { regionView } from '../harness/region';

const MiB = 1 << 20;

/** An empty slice (air, no fluid) and a writer of one sample column: `fill(i, y)` gives [state, fluid] for y −64 … 319. */
function slice(columns: Record<number, (y: number) => readonly [number, number]> = {}): SliceResult {
  const blocks = new Uint16Array(SLICE_SAMPLES);
  const fluid = new Uint8Array(SLICE_SAMPLES);
  for (const [k, f] of Object.entries(columns)) {
    for (let y = -64; y <= 319; y++) {
      const [s, b] = f(y);
      blocks[sliceIndex(Number(k), y)] = s;
      fluid[sliceIndex(Number(k), y)] = b;
    }
  }
  return { blocks, fluid };
}
/** Bedrock at −64, stone up to `top`, water sources up to `water`, air above. */
const ground = (top: number, water = -Infinity) => (y: number): readonly [number, number] =>
  y === -64 ? [BEDROCK, 0] : y <= top ? [STONE, 0] : y <= water ? [AIR, WATER_SOURCE] : [AIR, 0];
const pixel = (rgba: Uint8ClampedArray, i: number, y: number): number[] => Array.from(rgba.subarray(4 * sliceIndex(i, y), 4 * sliceIndex(i, y) + 4));
const opaque = (c: readonly [number, number, number]): number[] => [...c, 255];

describe('the Voxels palette (SP3a spec §5.2)', () => {
  test('one palette: the harness PNG slices use the cut line\'s colours', () => {
    expect(png.VOXEL_COLORS).toBe(VOXEL_COLORS);
    expect(png.voxelRgb).toBe(voxelRgb);
    expect(SEA_LEVEL_Y).toBe(SEA_LEVEL);
  });
  test('air sky, stone grey, bedrock near black, an unknown state magenta; a fluid on a block keeps the block\'s colour', () => {
    expect(voxelRgb(AIR, 0, 0)).toEqual(VOXEL_COLORS.sky);
    expect(voxelRgb(STONE, 0, 0)).toEqual(VOXEL_COLORS.stone);
    expect(voxelRgb(BEDROCK, 0, 0)).toEqual(VOXEL_COLORS.bedrock);
    expect(voxelRgb(STONE, WATER_SOURCE, 3)).toEqual(VOXEL_COLORS.stone);
    expect(voxelRgb(7, 0, 0)).toEqual(VOXEL_COLORS.unknown);
    const [r, g, b] = VOXEL_COLORS.stone;
    expect(r === g && g === b).toBe(true);
    expect(Math.max(...VOXEL_COLORS.bedrock)).toBeLessThan(40);
  });
  test('water is blue and darkens by 1/48 per block below its surface, down to 30 %', () => {
    const [r, g, b] = VOXEL_COLORS.water;
    expect(b).toBeGreaterThan(Math.max(r, g));
    expect(voxelRgb(AIR, WATER_SOURCE, 0)).toEqual(VOXEL_COLORS.water);
    expect(voxelRgb(AIR, WATER_SOURCE, -2)).toEqual(VOXEL_COLORS.water);
    expect(voxelRgb(AIR, WATER_SOURCE, 24)).toEqual([r, g, b].map((v) => Math.round(v * 0.5)));
    expect(voxelRgb(AIR, WATER_SOURCE, 34)).toEqual([r, g, b].map((v) => Math.round(v * 0.3)));
    expect(voxelRgb(AIR, WATER_SOURCE, 300)).toEqual([r, g, b].map((v) => Math.round(v * 0.3)));
  });
});

describe('sliceRgba: one pixel per sample, row 0 at y 319', () => {
  test('colours by sample; water depth counts from the top of each run of fluid in its sample column', () => {
    const s = slice({
      0: ground(40, 63),
      // Water 100 … 90, stone 89 … 80 (an overhang), water 79 … 70: the lower run has its own surface.
      5: (y) => (y <= 100 && y >= 90) || (y <= 79 && y >= 70) ? [AIR, WATER_SOURCE] : y < 90 && y >= 80 ? [STONE, 0] : [AIR, 0],
      // A block holding water (waterlogged) is drawn as the block.
      9: (y) => y === 10 ? [STONE, WATER_SOURCE] : [AIR, 0],
      511: ground(200),
    });
    const rgba = sliceRgba(s);
    expect(rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(rgba.length).toBe(4 * SLICE_SAMPLES);
    for (let k = 3; k < rgba.length; k += 4) if (rgba[k] !== 255) throw new Error(`alpha ${rgba[k]} at byte ${k}`);
    expect(pixel(rgba, 0, -64)).toEqual(opaque(VOXEL_COLORS.bedrock));
    expect(pixel(rgba, 0, 40)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 0, 63)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 0)));
    expect(pixel(rgba, 0, 41)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 22)));
    expect(pixel(rgba, 0, 64)).toEqual(opaque(VOXEL_COLORS.sky));
    expect(pixel(rgba, 0, 319)).toEqual(opaque(VOXEL_COLORS.sky));
    expect(pixel(rgba, 5, 100)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 0)));
    expect(pixel(rgba, 5, 90)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 10)));
    expect(pixel(rgba, 5, 85)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 5, 79)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 0)));
    expect(pixel(rgba, 5, 70)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 9)));
    expect(pixel(rgba, 9, 10)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 511, 200)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 511, 201)).toEqual(opaque(VOXEL_COLORS.sky));
    expect(pixel(rgba, 300, 0)).toEqual(opaque(VOXEL_COLORS.sky));
  });
  test('a real slice across a coast equals the harness PNG colours of the same voxels (depth below worldSurfaceWG)', () => {
    // Seed '42', default profile: sea at (−2000, −2000), land at (−1963, −2000) (Task 9's columns).
    const line: Segment = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
    const ctx = ctxFor('42');
    const r = createSliceJob().run(ctx, 0, line, () => false);
    if (r === null) throw new Error('slice stopped');
    const rgba = sliceRgba(r);
    const store = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
    const cx0 = -128;
    const cz0 = -126;
    genRegionInProcess(store, ctx, cx0, cz0, 7, 2);
    const view = regionView(store, cx0, cz0, 7, 2);
    let water = 0;
    for (let i = 0; i < SLICE_POINTS; i++) {
      const [px, pz] = segmentPointAt(line, i);
      const x = Math.floor(px);
      const z = Math.floor(pz);
      for (let y = -64; y <= 319; y++) {
        const want = png.voxelRgb(view.block(x, y, z), view.fluid(x, y, z), view.worldSurfaceWG(x, z) - 1 - y);
        const got = pixel(rgba, i, y);
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) throw new Error(`sample (${i}, ${y}) at (${x}, ${z}): ${got} ≠ ${want}`);
        if (view.fluid(x, y, z) !== 0) water++;
      }
    }
    expect(water).toBeGreaterThan(1000);
  });
});

describe('the Voxels plot and hover (SP3a spec §5.2)', () => {
  const box = { left: 10, top: 20, width: 1024, height: 768 };
  test('voxelPlots: cells over 512 × [−64, 320); distances put point i at the centre of its pixel column', () => {
    const { cells, distance } = voxelPlots(box, 1022);
    expect(cells).toEqual({ ...box, xMin: 0, xMax: 512, yMin: -64, yMax: 320 });
    expect(toPx(distance, 0, 0).px).toBe(11);
    expect(toPx(distance, 1022, 0).px).toBeCloseTo(1033, 9);
    expect(toPx(distance, 2 * 100, 0).px).toBeCloseTo(10 + 2 * 100 + 1, 9);
    expect(toPx(cells, 0, 320).py).toBe(20);
    expect(toPx(cells, 0, -64).py).toBe(788);
  });
  test('voxelCell: the sample (i, y) under a pixel; clamped within 2 px of the plot, null further out', () => {
    const { cells } = voxelPlots(box, 100);
    expect(voxelCell(cells, 10, 20)).toEqual({ i: 0, y: 319 });
    expect(voxelCell(cells, 11.9, 21.9)).toEqual({ i: 0, y: 319 });
    expect(voxelCell(cells, 12, 22)).toEqual({ i: 1, y: 318 });
    expect(voxelCell(cells, 1033.9, 787.9)).toEqual({ i: 511, y: -64 });
    expect(voxelCell(cells, 1035, 789)).toEqual({ i: 511, y: -64 });
    expect(voxelCell(cells, 8.5, 400)).toEqual({ i: 0, y: 129 });
    expect(voxelCell(cells, 7.9, 400)).toBeNull();
    expect(voxelCell(cells, 500, 17.9)).toBeNull();
    expect(voxelCell(cells, 500, 790.1)).toBeNull();
    expect(voxelCell(cells, Number.NaN, 400)).toBeNull();
    const at63 = toPx(cells, 0, 63.5).py;
    expect(voxelCell(cells, 500, at63)?.y).toBe(63);
  });
  test('blockName: the state\'s canonical key; fluidText: type, level, source and falling', () => {
    expect([blockName(AIR), blockName(STONE), blockName(BEDROCK), blockName(4095)]).toEqual(['air', 'stone', 'bedrock', 'unknown state 4095']);
    expect(fluidText(0)).toBe('no fluid');
    expect(fluidText(WATER_SOURCE)).toBe('water, level 0 (source)');
    expect(fluidText(packFluid(FLUID_WATER, 3, true))).toBe('water, level 3, falling');
    expect(fluidText(packFluid(FLUID_LAVA, 0))).toBe('lava, level 0 (source)');
    expect(fluidText(packFluid(3, 5))).toBe('fluid 3, level 5');
  });
  test('voxelReadout: the integer (⌊xᵢ⌋, y, ⌊zᵢ⌋), the block, the fluid and the point', () => {
    const line: Segment = { ax: -3, az: 0, bx: 7, bz: 5 };
    const s = slice({ 0: ground(10, 63), 511: ground(70) });
    expect(voxelReadout(line, s, 0, 63)).toBe('(-3, 63, 0) · air · water, level 0 (source) · point 0, 0.0 blocks from A');
    expect(voxelReadout(line, s, 0, 64)).toBe('(-3, 64, 0) · air · no fluid · point 0, 0.0 blocks from A');
    expect(voxelReadout(line, s, 511, 70)).toBe('(7, 70, 5) · stone · no fluid · point 511, 11.2 blocks from A');
    // Point 1 is (−3 + 10/511, 5/511): its block is (−3, 0).
    expect(voxelReadout(line, s, 1, -64)).toBe('(-3, -64, 0) · air · no fluid · point 1, 0.0 blocks from A');
    const neg: Segment = { ax: -0.5, az: -10.5, bx: -0.5, bz: -20.5 };
    expect(voxelReadout(neg, s, 0, 0).startsWith('(-1, 0, -11) · ')).toBe(true);
  });
  test('sliceSummary: the ground top range and the water along the line', () => {
    const cols: Record<number, (y: number) => readonly [number, number]> = {};
    for (let i = 0; i < SLICE_POINTS; i++) cols[i] = i < 128 ? ground(40, 63) : ground(i < 256 ? 70 : 90);
    expect(sliceSummary(slice(cols))).toBe('ground top y 40 to 90 · water on 25.0 % of the line, up to 23 deep');
    expect(sliceSummary(slice({}))).toBe('no ground · no water');
    const dry: Record<number, (y: number) => readonly [number, number]> = {};
    for (let i = 0; i < SLICE_POINTS; i++) dry[i] = ground(-64);
    expect(sliceSummary(slice(dry))).toBe('ground top y -64 to -64 · no water');
  });
});

describe('the Voxels requests (SP3a spec §5.2: the profile\'s rules)', () => {
  test('the modes and their status lines', () => {
    expect(SECTION_MODES).toEqual(['profile', 'voxels']);
    expect(sectionStatus('none', false, true, 'voxels')).toBe('the slice follows when the preview settles');
    expect(sectionStatus('none', true, true, 'voxels')).toBe('computing…');
    expect(sectionStatus('stale', false, true, 'voxels')).toBe('stale: updates when the preview settles');
    expect(sectionStatus('none', false, false, 'voxels')).toBe('no line: press Cut line in the toolbar, then click A and B on the map');
  });

  interface SliceCall { readonly segment: Segment; resolve(v: SliceResult): void; reject(e: unknown): void }
  const harness = () => {
    const calls: SliceCall[] = [];
    const session = { state: { epoch: 7 }, inGesture: false };
    const failures: string[] = [];
    let visible = true;
    const pool: Pick<WorkerPool, 'slice'> = {
      slice: (segment) => new Promise<SliceResult>((resolve, reject) => { calls.push({ segment, resolve, reject }); }),
    };
    const r = createSliceRequests({ session, pool, visible: () => visible, changed: () => undefined, failed: (m) => { failures.push(m); } });
    return { r, calls, session, failures, show: (v: boolean) => { visible = v; } };
  };
  const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });
  const LINE: Segment = { ax: 0, az: 0, bx: 100, bz: 0 };

  test('one pool.slice per session epoch and line, only when settled, on screen, outside a gesture and with a line', async () => {
    const h = harness();
    h.r.request(true);
    h.r.setLine(LINE);
    h.r.request(false);
    h.show(false);
    h.r.request(true);
    h.show(true);
    h.session.inGesture = true;
    h.r.request(true);
    expect(h.calls).toHaveLength(0);
    h.session.inGesture = false;
    h.r.request(true);
    h.r.request(true);
    expect(h.calls.map((c) => c.segment)).toEqual([LINE]);
    expect(h.r.pending).toBe(7);
    const s = slice({ 0: ground(10) });
    h.calls[0]!.resolve(s);
    await flush();
    expect([h.r.pending, h.r.shown?.epoch, h.r.shown?.value]).toEqual([null, 7, s]);
    h.r.request(true);
    expect(h.calls).toHaveLength(1);
    h.session.state = { epoch: 8 };
    h.r.request(true);
    expect(h.calls).toHaveLength(2);
  });
  test('JobCancelled keeps the last slice silently, another error reports it; a new line drops the slice', async () => {
    const h = harness();
    h.r.setLine(LINE);
    h.r.request(true);
    const s = slice();
    h.calls[0]!.resolve(s);
    await flush();
    h.session.state = { epoch: 8 };
    h.r.request(true);
    h.calls[1]!.reject(new JobCancelled());
    await flush();
    expect([h.r.shown?.value, h.r.pending, h.failures]).toEqual([s, null, []]);
    h.r.request(true);
    h.calls[2]!.reject(new Error('BAD_ARGS: B is A'));
    await flush();
    expect([h.r.shown?.value, h.failures]).toEqual([s, ['BAD_ARGS: B is A']]);
    h.r.setLine({ ...LINE, bx: 50 });
    expect([h.r.shown, h.r.pending]).toEqual([null, null]);
  });
  test('a slice superseded by a param edit or a new line is never shown, even when it settles after its successor', async () => {
    const h = harness();
    h.r.setLine(LINE);
    h.r.request(true); // call 0, epoch 7
    h.session.state = { epoch: 8 }; // a param edit while it runs
    h.r.request(true); // call 1, epoch 8
    expect(h.r.pending).toBe(8);
    const s8 = slice({ 0: ground(20) });
    h.calls[1]!.resolve(s8);
    await flush();
    expect([h.r.shown?.epoch, h.r.shown?.value, h.r.pending]).toEqual([8, s8, null]);
    // The superseded slice settles late: dropped.
    h.calls[0]!.resolve(slice({ 0: ground(10) }));
    await flush();
    expect([h.r.shown?.epoch, h.r.shown?.value]).toEqual([8, s8]);
    // Superseded before its successor settles: dropped too, and the successor stays pending.
    h.session.state = { epoch: 9 };
    h.r.request(true); // call 2
    h.session.state = { epoch: 10 };
    h.r.request(true); // call 3
    h.calls[2]!.resolve(slice({ 0: ground(30) }));
    await flush();
    expect([h.r.shown?.epoch, h.r.shown?.value, h.r.pending]).toEqual([8, s8, 10]);
    // A new line while call 3 runs: its late failure is not reported, and only the new line's slice is shown.
    const other: Segment = { ...LINE, bx: 50 };
    h.r.setLine(other);
    h.r.request(true); // call 4
    h.calls[3]!.reject(new Error('INTERNAL: boom'));
    await flush();
    expect([h.failures, h.r.shown, h.r.pending]).toEqual([[], null, 10]);
    const s10 = slice({ 0: ground(40) });
    h.calls[4]!.resolve(s10);
    await flush();
    expect([h.r.line, h.r.shown?.epoch, h.r.shown?.value, h.r.pending]).toEqual([other, 10, s10, null]);
    expect(h.calls.map((c) => c.segment)).toEqual([LINE, LINE, LINE, LINE, other]);
  });
});

```

Modify `test/unit/uiSmoke.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/uiSmoke.test.ts b/test/unit/uiSmoke.test.ts
index 11facb0..5b4898a 100644
--- a/test/unit/uiSmoke.test.ts
+++ b/test/unit/uiSmoke.test.ts
@@ -8,8 +8,12 @@ import { allGoldenKeys } from '../../src/metrics/sp2aGoldens';
 import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
 import { DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
 import { presetText } from '../../src/ui/presets/presetFile';
+import { sliceSummary, voxelReadout } from '../../src/ui/crossSection/voxels';
+import { WATER_SOURCE } from '../../src/world/blocks/fluid';
+import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
+import { SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
 import {
-  canonicalJson, goldenCount, ignoredLog, mapHash, parseArgs, presetProblems, readMapHash, sameJson, selftestAllMatch, SIZE_8, VIEWPORT, type MapUrlState,
+  canonicalJson, goldenCount, ignoredLog, mapHash, parseArgs, presetProblems, readMapHash, sameJson, selftestAllMatch, SIZE_8, VIEWPORT, voxelReadoutOk, voxelSummaryOk, type MapUrlState,
 } from '../tools/uiSmoke';
 
 const EDITED: MapState = {
@@ -78,6 +82,28 @@ describe('UI smoke test: pure parts (SP2b spec §8 Tools, §12)', () => {
     expect(selftestAllMatch('computing 50/50…', 50)).toBe(false);
   });
 
+  test('the Voxels step reads the page\'s hover readout and summary in the formats the cut line writes (SP3a spec §5.2)', () => {
+    const blocks = new Uint16Array(SLICE_SAMPLES);
+    const fluid = new Uint8Array(SLICE_SAMPLES);
+    for (let i = 0; i < 512; i++) {
+      for (let y = -64; y <= 70; y++) {
+        blocks[sliceIndex(i, y)] = y === -64 ? BEDROCK : y <= (i < 100 ? 40 : 70) ? STONE : AIR;
+        if (i < 100 && y > 40 && y <= 63) fluid[sliceIndex(i, y)] = WATER_SOURCE;
+      }
+    }
+    const s = { blocks, fluid };
+    const line = { ax: -2030, az: 7, bx: 1950, bz: -1990 };
+    for (const [i, y] of [[0, 63], [0, 64], [0, 40], [511, -64], [300, 319]] as const) {
+      const text = voxelReadout(line, s, i, y);
+      expect(voxelReadoutOk(text), text).toBe(true);
+    }
+    expect(voxelReadoutOk('hover the voxels to read a block')).toBe(false);
+    expect(voxelReadoutOk('12.0 blocks from A · x 1.0 z 2.0 · offset0 1.00')).toBe(false);
+    expect(voxelSummaryOk(sliceSummary(s))).toBe(true);
+    expect(voxelSummaryOk(sliceSummary({ blocks: new Uint16Array(SLICE_SAMPLES), fluid: new Uint8Array(SLICE_SAMPLES) }))).toBe(false);
+    expect(voxelSummaryOk('offset 1.0 to 2.0 blocks · water on 0.0 % of the line')).toBe(false);
+  });
+
   test('arguments: build, the OS temp directory and no screenshots by default', () => {
     expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
     expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/crossSectionModel.test.ts test/unit/crossSectionVoxels.test.ts test/unit/uiSmoke.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× requests crossSection for the line once per session epoch, only when settled, on screen, outside a gesture and with a line 39ms
FAIL  |unit| test/unit/crossSectionVoxels.test.ts [ test/unit/crossSectionVoxels.test.ts ]
Error: Cannot find module '../../src/ui/crossSection/voxels' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/crossSectionVoxels.test.ts
FAIL  |unit| test/unit/uiSmoke.test.ts [ test/unit/uiSmoke.test.ts ]
Error: Cannot find module '../../src/ui/crossSection/voxels' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/uiSmoke.test.ts
FAIL  |unit| test/unit/crossSectionModel.test.ts > the profile's requests and stale state > requests crossSection for the line once per session epoch, only when settled, on screen, outside a gesture and with a line
AssertionError: expected undefined to deeply equal { segment: { ax: 5120, …(3) }, …(10) }
Test Files  3 failed (3)
Tests  1 failed | 16 passed (17)
```

- [ ] **Step 3: Implement**

Modify `src/ui/crossSection/model.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/crossSection/model.ts b/src/ui/crossSection/model.ts
index 3360eaf..9ce4840 100644
--- a/src/ui/crossSection/model.ts
+++ b/src/ui/crossSection/model.ts
@@ -2,13 +2,14 @@
  * The cross-section's pure parts (SP2b spec §4.5), unit-tested:
  * - the map's two-click cut-line tool: armed from the toolbar or the tab, the first click sets A, the second B
  *   (both rounded to whole blocks, inside the half-open world window, B ≠ A); what the map draws of it;
- * - the profile's requests: one `crossSection` stats job per session epoch and line, made when the preview
- *   driver settles while the tab is on screen, so it runs on the draft the map shows; its stale state;
+ * - the requests: one `crossSection` stats job (the profile) or one `slice` job (the Voxels mode, SP3a spec §5.2)
+ *   per session epoch and line, made when the preview driver settles while the view is on screen, so it runs on
+ *   the draft the map shows; their stale state and the tab's two modes;
  * - the plot model: the value range, the runs of river channels, gorges and water, SVG area paths, the summary
  *   line and the hover readout.
  */
 import { SEA_LEVEL } from '../../core/constants';
-import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
+import { JobCancelled, type SliceResult, type WorkerPool } from '../../engine/workerPool';
 import {
   CROSS_SECTION_POINTS, crossSectionLength, segmentLength, segmentPointAt, summarizeCrossSection, type CrossSectionProfile, type Segment,
 } from '../../metrics/crossSection';
@@ -99,42 +100,41 @@ export function sameSegment(a: Segment | null, b: Segment | null): boolean {
 
 // ---------------------------------------------------------------- requests and stale state
 
-export interface SectionSource {
+/** What a cut-line request stream reads and reports (the profile's and the Voxels mode's). */
+export interface LineSource {
   /** The draft's session epoch and whether a gesture is active (a WorldSession). */
   readonly session: { readonly state: { readonly epoch: number }; readonly inGesture: boolean };
-  readonly pool: Pick<WorkerPool, 'stats'>;
-  /** Whether the Cross-section tab is on screen: a hidden tab requests nothing. */
+  /** Whether this stream's view is on screen (its tab, and its mode): a hidden view requests nothing. */
   visible(): boolean;
-  /** The line, the pending request or the shown profile changed. */
+  /** The line, the pending request or the shown result changed. */
   changed(): void;
-  /** A request failed with something other than JobCancelled (the profile stays stale). */
+  /** A request failed with something other than JobCancelled (the result stays stale). */
   failed(message: string): void;
 }
 
-export interface SectionRequests {
-  /** The line to profile (null: none). A different line drops the shown profile and the pending request. */
+export interface LineRequests<R> {
+  /** The line (null: none). A different line drops the shown result and the pending request. */
   setLine(line: Segment | null): void;
   readonly line: Segment | null;
   /**
-   * Requests the line's profile of the draft when `settled`, the tab is on screen, a line is set and no gesture
-   * is active, unless the shown profile or the pending request is already for this session epoch. The caller
+   * Requests the line's result for the draft when `settled`, the view is on screen, a line is set and no gesture
+   * is active, unless the shown result or the pending request is already for this session epoch. The caller
    * passes the driver's settled state (true from inside onSettled, whose status still reads false).
    */
   request(settled: boolean): void;
-  /** The line's last profile and the session epoch of the draft it ran on. */
-  readonly shown: { readonly epoch: number; readonly profile: CrossSectionProfile } | null;
+  /** The line's last result and the session epoch of the draft it ran on. */
+  readonly shown: { readonly epoch: number; readonly value: R } | null;
   /** The session epoch of the request in flight, if any. Only its result is shown. */
   readonly pending: number | null;
 }
 
 /**
- * The cross-section's requests (spec §4.5): `pool.stats('crossSection', 512, …)` (one job) per session epoch and
- * line. JobCancelled (a newer configure) keeps the last profile silently, any other error reports it; either way
- * the next settle requests again.
+ * One result per session epoch and line from `fetch` (a pool job). JobCancelled (a newer configure) keeps the last
+ * result silently, any other error reports it; either way the next settle requests again.
  */
-export function createSectionRequests(src: SectionSource): SectionRequests {
+export function createLineRequests<R>(src: LineSource, fetch: (line: Segment) => Promise<R>): LineRequests<R> {
   let line: Segment | null = null;
-  let shown: SectionRequests['shown'] = null;
+  let shown: LineRequests<R>['shown'] = null;
   /** A token per request, so that a result for a line replaced in the meantime is dropped even at the same epoch. */
   let pending: { readonly epoch: number } | null = null;
   return {
@@ -154,10 +154,10 @@ export function createSectionRequests(src: SectionSource): SectionRequests {
       const token = { epoch };
       pending = token;
       src.changed();
-      src.pool.stats('crossSection', CROSS_SECTION_POINTS, { len: crossSectionLength(), ax: at.ax, az: at.az, bx: at.bx, bz: at.bz }).then((sum) => {
+      fetch(at).then((value) => {
         if (pending !== token) return;
         pending = null;
-        shown = { epoch, profile: summarizeCrossSection(sum, at) };
+        shown = { epoch, value };
         src.changed();
       }, (e: unknown) => {
         if (pending !== token) return;
@@ -171,6 +171,33 @@ export function createSectionRequests(src: SectionSource): SectionRequests {
   };
 }
 
+export interface SectionSource extends LineSource {
+  readonly pool: Pick<WorkerPool, 'stats'>;
+}
+
+export type SectionRequests = LineRequests<CrossSectionProfile>;
+
+/** The profile's requests (spec §4.5): `pool.stats('crossSection', 512, …)` (one job) per session epoch and line. */
+export function createSectionRequests(src: SectionSource): SectionRequests {
+  return createLineRequests(src, (at) => src.pool.stats('crossSection', CROSS_SECTION_POINTS, { len: crossSectionLength(), ax: at.ax, az: at.az, bx: at.bx, bz: at.bz })
+    .then((sum) => summarizeCrossSection(sum, at)));
+}
+
+export interface SliceSource extends LineSource {
+  readonly pool: Pick<WorkerPool, 'slice'>;
+}
+
+export type SliceRequests = LineRequests<SliceResult>;
+
+/** The Voxels mode's requests (SP3a spec §5.2): `pool.slice(line)` (one job, abortable) per session epoch and line. */
+export function createSliceRequests(src: SliceSource): SliceRequests {
+  return createLineRequests(src, (at) => src.pool.slice(at));
+}
+
+/** The Cross-section tab's modes (SP3a spec §5.2): the SP2b profile, or the voxels of the vertical slice. */
+export type SectionMode = 'profile' | 'voxels';
+export const SECTION_MODES: readonly SectionMode[] = Object.freeze(['profile', 'voxels']);
+
 export type SectionView = 'none' | 'fresh' | 'stale';
 
 /**
@@ -183,10 +210,10 @@ export function sectionView(shownEpoch: number | null, epoch: number, inGesture:
 }
 
 /** The status next to the tab's title; empty while fresh. */
-export function sectionStatus(view: SectionView, pending: boolean, hasLine: boolean): string {
+export function sectionStatus(view: SectionView, pending: boolean, hasLine: boolean, mode: SectionMode = 'profile'): string {
   if (!hasLine) return 'no line: press Cut line in the toolbar, then click A and B on the map';
   if (view === 'fresh') return '';
-  if (view === 'none') return pending ? 'computing…' : 'the profile follows when the preview settles';
+  if (view === 'none') return pending ? 'computing…' : `the ${mode === 'profile' ? 'profile' : 'slice'} follows when the preview settles`;
   return pending ? 'stale: computing…' : 'stale: updates when the preview settles';
 }
 
```

Modify `src/ui/crossSection/section.css` (apply with `git apply`):

```diff
diff --git a/src/ui/crossSection/section.css b/src/ui/crossSection/section.css
index 67a6f3b..748ca86 100644
--- a/src/ui/crossSection/section.css
+++ b/src/ui/crossSection/section.css
@@ -1,4 +1,4 @@
-/* The Cross-section tab (SP2b spec §4.5): header, summary, the profile plot, its legend and the hover readout. */
+/* The Cross-section tab (SP2b spec §4.5): header, summary, the profile or Voxels plot (SP3a spec §5.2), its legend and the hover readout. */
 .cs { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto auto; height: 100%; min-height: 0; }
 .cs [hidden] { display: none !important; }
 .cs-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; padding: 4px 10px; border-bottom: 1px solid #333; }
@@ -6,13 +6,23 @@
 .cs-line { font-family: ui-monospace, monospace; color: #c8d0dc; }
 .cs-status { font-size: 12px; color: #8a95a8; }
 .cs[data-state="stale"] .cs-status { color: #f0b34a; }
+.cs-modes { display: inline-flex; }
+.cs-mode { font: inherit; font-size: 12px; padding: 1px 8px; border: 1px solid #45506a; background: #1c2029; color: #b8c2d0; }
+.cs-mode + .cs-mode { border-left: none; }
+.cs-mode:first-child { border-radius: 3px 0 0 3px; }
+.cs-mode:last-child { border-radius: 0 3px 3px 0; }
+.cs-mode[aria-pressed="true"] { background: #34406a; color: #e8ecf2; }
 .cs-actions { display: flex; gap: 4px; margin-left: auto; }
 .cs-actions button { font: inherit; font-size: 12px; padding: 1px 7px; }
 .cs-summary { padding: 3px 10px 0; font-size: 12px; color: #b8c2d0; }
 .cs-summary:empty { display: none; }
 .cs-plotwrap { position: relative; min-width: 0; min-height: 120px; overflow: hidden; }
 .cs-plot { position: absolute; inset: 0; display: block; user-select: none; touch-action: none; }
-.cs-plotwrap.cs-stale .cs-plot { opacity: 0.4; }
+.cs-plotwrap.cs-stale .cs-plot, .cs-plotwrap.cs-stale .cs-voxels { opacity: 0.4; }
+.cs-voxels { position: absolute; display: block; image-rendering: pixelated; pointer-events: none; }
+.cs-frame.cs-voxel-frame { fill: none; }
+.cs-tickmark { stroke: #5a6478; stroke-width: 1; }
+.cs-voxel-sealine { stroke-width: 1; stroke-dasharray: 4 3; }
 .cs-frame { fill: #15171b; stroke: #34406a; stroke-width: 0.5; }
 .cs-grid { stroke: #252b38; stroke-width: 1; }
 .cs-tick, .cs-axis-label, .cs-sea-label, .cs-lake-label, .cs-end-label, .cs-stale-label { font: 10px ui-monospace, monospace; fill: #8a95a8; }
```

Modify `src/ui/crossSection/section.ts` (apply with `git apply`):

```diff
diff --git a/src/ui/crossSection/section.ts b/src/ui/crossSection/section.ts
index b41b15f..6714d85 100644
--- a/src/ui/crossSection/section.ts
+++ b/src/ui/crossSection/section.ts
@@ -7,31 +7,39 @@
  *   offset line; offset0 as a thin dashed line; water above the ground (at sea level, and lakes labelled with
  *   their level); sea level 63 as a dashed line; river channels and gorges as stripes with a marker on the top
  *   edge; under the axis a strip with jag. Hovering the plot reads the nearest point.
- * - The profile is requested (model.ts createSectionRequests) when the preview driver settles while the tab is
- *   on screen, when the tab comes on screen while it is settled and when a new line is set, so it always runs on
- *   the draft the map shows. It is stale (dimmed, with its status) from the next session change, or during a
- *   gesture, until a new result arrives; a cancelled request stays stale silently, any other failure also
- *   shows a notice.
+ * - A `Profile | Voxels` toggle in the header (SP3a spec §5.2). Voxels draws the vertical slice under the line
+ *   from one `slice` job: one pixel per sample (512 × 384, row 0 at y 319) scaled to the drawer, in the palette
+ *   of voxels.ts, with the sea-level line at 63; hovering reads the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋), its block and fluid.
+ * - The current mode's result is requested (model.ts createSectionRequests, createSliceRequests) when the preview
+ *   driver settles while the tab is on screen, when the tab or the mode comes on screen while it is settled and
+ *   when a new line is set, so it always runs on the draft the map shows. It is stale (dimmed, with its status)
+ *   from the next session change, or during a gesture, until a new result arrives; a cancelled request stays
+ *   stale silently, any other failure also shows a notice. The mode is not stored: a page starts on Profile.
  */
 import './section.css';
 import { SEA_LEVEL } from '../../core/constants';
 import type { WorldSession } from '../../engine/session';
 import type { WorkerPool } from '../../engine/workerPool';
-import type { CrossSectionProfile, Segment } from '../../metrics/crossSection';
+import type { SliceResult } from '../../engine/workerPool';
+import { segmentLength, type CrossSectionProfile, type Segment } from '../../metrics/crossSection';
+import { WATER_SOURCE } from '../../world/blocks/fluid';
+import { AIR } from '../../world/blocks/index';
+import { SLICE_POINTS, SLICE_ROWS } from '../../workers/protocol';
 import { el } from '../common/dom';
 import type { Notices } from '../common/notice';
 import type { PreviewDriver } from '../map/previewDriver';
 import { curvePath, niceTicks, toPx, type Plot } from '../splineEditor/model';
 import {
-  areaPath, createSectionRequests, flagRuns, nearestPoint, runSpan, sectionRange, sectionReadout, sectionStatus, sectionSummary, sectionView,
-  segmentText, waterRuns, type Run,
+  areaPath, createSectionRequests, createSliceRequests, flagRuns, nearestPoint, runSpan, sectionRange, sectionReadout, sectionStatus, sectionSummary,
+  sectionView, segmentText, waterRuns, SECTION_MODES, type Run, type SectionMode,
 } from './model';
+import { sliceRgba, sliceSummary, SEA_LEVEL_Y, VOXEL_COLORS, voxelCell, voxelPlots, voxelReadout, voxelRgb, type Rgb } from './voxels';
 
 export interface SectionDeps {
   readonly session: WorldSession;
   readonly notices: Notices;
-  /** The pool's statistics jobs (spec §5.4). */
-  readonly pool: Pick<WorkerPool, 'stats'>;
+  /** The pool's statistics jobs (spec §5.4) and slice jobs (SP3a spec §5.1). */
+  readonly pool: Pick<WorkerPool, 'stats' | 'slice'>;
   /** The preview driver: the profile is requested when it settles. */
   readonly driver: Pick<PreviewDriver, 'onSettled' | 'status'>;
   /** Whether the drawer shows this tab. */
@@ -46,11 +54,14 @@ export interface SectionDeps {
 
 export interface CrossSection {
   readonly element: HTMLElement;
-  /** Profiles `line` (null: none); requests it at once if the tab is on screen and the driver is settled. */
+  /** Profiles `line` (null: none); requests the current mode's result at once if the tab is on screen and the driver is settled. */
   setLine(line: Segment | null): void;
   readonly line: Segment | null;
-  /** The tab came on screen: renders and requests the profile if the driver is settled and it is not current. */
+  /** The tab came on screen: renders and requests the current mode's result if the driver is settled and it is not current. */
   shown(): void;
+  /** Profile or Voxels (the header's toggle). */
+  readonly mode: SectionMode;
+  setMode(mode: SectionMode): void;
   /** Stops following the session and the driver (the DOM stays). */
   dispose(): void;
 }
@@ -73,6 +84,12 @@ const BOTTOM_PX = 4;
 const MARKER_PX = 6;
 const CLIP_ID = 'cs-plot-clip';
 const HINT = 'hover the plot to read a point';
+const VOXEL_HINT = 'hover the voxels to read a block';
+const MODE_LABELS: Readonly<Record<SectionMode, readonly [string, string]>> = {
+  profile: ['Profile', 'The 2D shape along the line: offset, σ, water, rivers, gorges and jag'],
+  voxels: ['Voxels', 'The voxels of the vertical slice under the line (the provisional terrain stage)'],
+};
+const css = (c: Rgb): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
 
 const tickText = (v: number): string => String(v).replace('-', '−');
 
@@ -94,11 +111,26 @@ export function createCrossSection(host: HTMLElement, deps: SectionDeps): CrossS
   const newBtn = button('New line', 'Draw a new line on the map: click its start A, then its end B (Escape cancels)', () => deps.arm());
   const clearBtn = button('Clear', 'Remove the line from the map and this tab', () => deps.clear());
   actions.append(newBtn, clearBtn, button('Close', 'Close the drawer (Escape)', () => deps.close()));
-  head.append(el('strong', 'cs-title', 'Cross-section'), lineText, status, actions);
+  const modes = el('div', 'cs-modes');
+  modes.setAttribute('role', 'group');
+  modes.setAttribute('aria-label', 'Cross-section mode');
+  const modeButtons = SECTION_MODES.map((m) => {
+    const b = button(MODE_LABELS[m][0], MODE_LABELS[m][1], () => setMode(m));
+    b.className = 'cs-mode';
+    b.dataset['mode'] = m;
+    modes.append(b);
+    return b;
+  });
+  head.append(el('strong', 'cs-title', 'Cross-section'), modes, lineText, status, actions);
   const summary = el('div', 'cs-summary');
   const plotHost = el('div', 'cs-plotwrap');
   const root = svg('svg', { class: 'cs-plot', role: 'img', 'aria-label': 'Cross-section profile' });
-  plotHost.append(root);
+  /** The Voxels image: SLICE_POINTS × SLICE_ROWS pixels under the SVG, placed over its plot and scaled by CSS. */
+  const canvas = el('canvas', 'cs-voxels');
+  canvas.width = SLICE_POINTS;
+  canvas.height = SLICE_ROWS;
+  canvas.hidden = true;
+  plotHost.append(canvas, root);
   const legend = el('div', 'cs-legend');
   for (const [cls, label] of [
     ['cs-key-offset', 'offset'], ['cs-key-band', 'offset ± σ'], ['cs-key-offset0', 'offset0'], ['cs-key-sea', 'water at sea level'],
@@ -108,26 +140,60 @@ export function createCrossSection(host: HTMLElement, deps: SectionDeps): CrossS
     item.append(el('span', `cs-swatch ${cls}`), el('span', '', label));
     legend.append(item);
   }
+  const voxelLegend = el('div', 'cs-legend');
+  voxelLegend.hidden = true;
+  const deep = voxelRgb(AIR, WATER_SOURCE, 48);
+  for (const [bg, label] of [
+    [css(VOXEL_COLORS.sky), 'air'], [css(VOXEL_COLORS.stone), 'stone'], [css(VOXEL_COLORS.bedrock), 'bedrock'],
+    [`linear-gradient(to right, ${css(VOXEL_COLORS.water)}, ${css(deep)})`, 'water, darker with depth'],
+  ] as const) {
+    const item = el('span', 'cs-key');
+    const sw = el('span', 'cs-swatch');
+    sw.style.background = bg;
+    item.append(sw, el('span', '', label));
+    voxelLegend.append(item);
+  }
+  const seaKey = el('span', 'cs-key');
+  const seaSwatch = el('span', 'cs-swatch cs-key-sealine');
+  seaSwatch.style.borderTopColor = css(VOXEL_COLORS.seaLevel);
+  seaKey.append(seaSwatch, el('span', '', `sea level ${SEA_LEVEL_Y}`));
+  voxelLegend.append(seaKey);
   const readout = el('div', 'cs-readout', HINT);
-  element.append(head, summary, plotHost, legend, readout);
+  element.append(head, summary, plotHost, legend, voxelLegend, readout);
   host.replaceChildren(element);
 
   let w = 0;
   let h = 0;
-  /** The main plot of the last draw, for the hover readout. */
+  let mode: SectionMode = 'profile';
+  /** The main plot of the last draw (the profile's, or the Voxels sample cells), for the hover readout. */
   let plot: Plot | null = null;
   let cursor: SVGLineElement | null = null;
+  /** The Voxels mode's horizontal cursor. */
+  let cursorY: SVGLineElement | null = null;
+  /** The slice whose pixels the canvas holds. */
+  let painted: SliceResult | null = null;
+  const summaries = new WeakMap<SliceResult, string>();
 
   const requests = createSectionRequests({
     session, pool: deps.pool,
-    visible: () => deps.visible(),
+    visible: () => deps.visible() && mode === 'profile',
     changed: () => render(),
     failed: (m) => deps.notices.show(`cross-section failed: ${m}`, { kind: 'warn' }),
   });
+  const slices = createSliceRequests({
+    session, pool: deps.pool,
+    visible: () => deps.visible() && mode === 'voxels',
+    changed: () => render(),
+    failed: (m) => deps.notices.show(`voxel slice failed: ${m}`, { kind: 'warn' }),
+  });
+  const current = () => (mode === 'profile' ? requests : slices);
 
   function draw(p: CrossSectionProfile | null, stale: boolean): void {
     plot = null;
     cursor = null;
+    cursorY = null;
+    canvas.hidden = true;
+    root.setAttribute('aria-label', 'Cross-section profile');
     if (p === null || w <= 0 || h <= 0) {
       root.replaceChildren();
       return;
@@ -213,32 +279,141 @@ export function createCrossSection(host: HTMLElement, deps: SectionDeps): CrossS
     root.replaceChildren(...out);
   }
 
-  /** The profile drawn last, so that a session change that leaves it as it was does not redraw it. */
-  let drawn: { readonly profile: CrossSectionProfile | null; readonly stale: boolean; readonly w: number; readonly h: number } | null = null;
+  /** The Voxels plot: the slice's pixels on the canvas, and over it in the SVG the axes, the sea level and the cursors. */
+  function drawVoxels(s: SliceResult | null, line: Segment | null, stale: boolean): void {
+    plot = null;
+    cursor = null;
+    cursorY = null;
+    root.setAttribute('aria-label', 'Cross-section voxels');
+    if (s === null || line === null || w <= 0 || h <= 0) {
+      canvas.hidden = true;
+      root.replaceChildren();
+      return;
+    }
+    const height = Math.max(20, h - MARGIN.top - X_TICKS_PX - BOTTOM_PX);
+    const width = Math.max(20, w - MARGIN.left - MARGIN.right);
+    const length = segmentLength(line);
+    const { cells, distance } = voxelPlots({ left: MARGIN.left, top: MARGIN.top, width, height }, length);
+    plot = cells;
+    if (painted !== s) {
+      canvas.getContext('2d')?.putImageData(new ImageData(sliceRgba(s), SLICE_POINTS, SLICE_ROWS), 0, 0);
+      painted = s;
+    }
+    Object.assign(canvas.style, { left: `${cells.left}px`, top: `${cells.top}px`, width: `${width}px`, height: `${height}px` });
+    canvas.hidden = false;
+    root.setAttribute('viewBox', `0 0 ${w} ${h}`);
+    root.setAttribute('width', String(w));
+    root.setAttribute('height', String(h));
+    const right = cells.left + width;
+    const bottom = cells.top + height;
+    const rowY = (y: number): number => toPx(cells, 0, y + 0.5).py;
+    const out: SVGElement[] = [svg('rect', { class: 'cs-frame cs-voxel-frame', x: cells.left, y: cells.top, width, height })];
+    for (const t of niceTicks(0, length, Math.max(2, Math.floor(width / 70)))) {
+      const x = toPx(distance, t, 0).px;
+      out.push(svg('line', { class: 'cs-tickmark', x1: x, y1: bottom, x2: x, y2: bottom + 3 }));
+      out.push(svg('text', { class: 'cs-tick', x, y: bottom + 11, 'text-anchor': 'middle' }, tickText(t)));
+    }
+    for (const t of niceTicks(-64, 319, Math.max(3, Math.floor(height / 24)))) {
+      out.push(svg('line', { class: 'cs-tickmark', x1: cells.left - 3, y1: rowY(t), x2: cells.left, y2: rowY(t) }));
+      out.push(svg('text', { class: 'cs-tick', x: cells.left - 4, y: rowY(t) + 3, 'text-anchor': 'end' }, tickText(t)));
+    }
+    out.push(svg('text', { class: 'cs-axis-label', x: 0, y: 0, transform: `translate(11 ${cells.top + height / 2}) rotate(-90)`, 'text-anchor': 'middle' }, 'y'));
+    const sea = rowY(SEA_LEVEL_Y);
+    out.push(svg('line', { class: 'cs-voxel-sealine', x1: cells.left, y1: sea, x2: right, y2: sea, stroke: css(VOXEL_COLORS.seaLevel) }));
+    out.push(svg('text', { class: 'cs-sea-label', x: cells.left + 4, y: sea - 3 }, `sea ${SEA_LEVEL_Y}`));
+    out.push(svg('text', { class: 'cs-end-label', x: cells.left + 3, y: cells.top - 2 }, 'A'));
+    out.push(svg('text', { class: 'cs-end-label', x: right - 3, y: cells.top - 2, 'text-anchor': 'end' }, 'B'));
+    if (stale) out.push(svg('text', { class: 'cs-stale-label', x: right - 4, y: cells.top + 12, 'text-anchor': 'end' }, 'voxels stale'));
+    cursor = svg('line', { class: 'cs-cursor', x1: 0, y1: cells.top, x2: 0, y2: bottom, visibility: 'hidden' });
+    cursorY = svg('line', { class: 'cs-cursor', x1: cells.left, y1: 0, x2: right, y2: 0, visibility: 'hidden' });
+    out.push(cursor, cursorY);
+    root.replaceChildren(...out);
+  }
+
+  /** What was drawn last, so that a session change that leaves it as it was does not redraw it. */
+  let drawn: { readonly mode: SectionMode; readonly value: unknown; readonly stale: boolean; readonly w: number; readonly h: number } | null = null;
+
+  const sliceText = (s: SliceResult): string => {
+    let t = summaries.get(s);
+    if (t === undefined) {
+      t = sliceSummary(s);
+      summaries.set(s, t);
+    }
+    return t;
+  };
+
+  function hint(): void {
+    readout.textContent = mode === 'profile' ? HINT : VOXEL_HINT;
+    delete readout.dataset['point'];
+    delete readout.dataset['y'];
+  }
 
   function render(): void {
-    const line = requests.line;
-    const shown = requests.shown;
+    const req = current();
+    const line = req.line;
+    const shown = req.shown;
     const view = sectionView(shown?.epoch ?? null, session.state.epoch, session.inGesture);
     element.dataset['state'] = view;
-    element.setAttribute('aria-busy', String(requests.pending !== null));
+    element.dataset['mode'] = mode;
+    element.setAttribute('aria-busy', String(req.pending !== null));
     lineText.textContent = line === null ? '' : segmentText(line);
-    status.textContent = sectionStatus(view, requests.pending !== null, line !== null);
+    status.textContent = sectionStatus(view, req.pending !== null, line !== null, mode);
     clearBtn.disabled = line === null;
-    const profile = shown?.profile ?? null;
-    summary.textContent = profile === null ? '' : sectionSummary(profile);
+    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset['mode'] === mode));
+    legend.hidden = mode !== 'profile';
+    voxelLegend.hidden = mode !== 'voxels';
+    const profile = mode === 'profile' ? requests.shown?.value ?? null : null;
+    const slice = mode === 'voxels' ? slices.shown?.value ?? null : null;
+    summary.textContent = profile !== null ? sectionSummary(profile) : slice !== null ? sliceText(slice) : '';
     plotHost.classList.toggle('cs-stale', view === 'stale');
     if (!deps.visible()) return;
     const stale = view === 'stale';
-    if (drawn !== null && drawn.profile === profile && drawn.stale === stale && drawn.w === w && drawn.h === h) return;
-    drawn = { profile, stale, w, h };
-    draw(profile, stale);
-    readout.textContent = HINT;
-    delete readout.dataset['point'];
+    const value = profile ?? slice;
+    if (drawn !== null && drawn.mode === mode && drawn.value === value && drawn.stale === stale && drawn.w === w && drawn.h === h) return;
+    drawn = { mode, value, stale, w, h };
+    if (mode === 'profile') draw(profile, stale);
+    else drawVoxels(slice, line, stale);
+    hint();
+  }
+
+  function setMode(next: SectionMode): void {
+    if (next === mode) return;
+    mode = next;
+    render();
+    current().request(deps.driver.status.settled);
+  }
+
+  function hoverVoxels(e: PointerEvent): void {
+    const s = slices.shown?.value;
+    const line = slices.line;
+    if (plot === null || cursor === null || cursorY === null || s === undefined || line === null) return;
+    const r = root.getBoundingClientRect();
+    const cell = voxelCell(plot, e.clientX - r.left, e.clientY - r.top);
+    if (cell === null) {
+      cursor.setAttribute('visibility', 'hidden');
+      cursorY.setAttribute('visibility', 'hidden');
+      hint();
+      return;
+    }
+    const x = toPx(plot, cell.i + 0.5, 0).px;
+    const y = toPx(plot, 0, cell.y + 0.5).py;
+    cursor.setAttribute('x1', String(x));
+    cursor.setAttribute('x2', String(x));
+    cursorY.setAttribute('y1', String(y));
+    cursorY.setAttribute('y2', String(y));
+    cursor.setAttribute('visibility', 'visible');
+    cursorY.setAttribute('visibility', 'visible');
+    readout.textContent = voxelReadout(line, s, cell.i, cell.y);
+    readout.dataset['point'] = String(cell.i);
+    readout.dataset['y'] = String(cell.y);
   }
 
   root.addEventListener('pointermove', (e) => {
-    const p = requests.shown?.profile;
+    if (mode === 'voxels') {
+      hoverVoxels(e);
+      return;
+    }
+    const p = requests.shown?.value;
     if (plot === null || cursor === null || p === undefined) return;
     const r = root.getBoundingClientRect();
     const px = e.clientX - r.left;
@@ -257,8 +432,8 @@ export function createCrossSection(host: HTMLElement, deps: SectionDeps): CrossS
   });
   root.addEventListener('pointerleave', () => {
     cursor?.setAttribute('visibility', 'hidden');
-    readout.textContent = HINT;
-    delete readout.dataset['point'];
+    cursorY?.setAttribute('visibility', 'hidden');
+    hint();
   });
 
   new ResizeObserver(() => {
@@ -270,20 +445,23 @@ export function createCrossSection(host: HTMLElement, deps: SectionDeps): CrossS
 
   const offSession = session.subscribe(() => render());
   // The driver's status still reads unsettled while it runs its onSettled listeners.
-  const offSettled = deps.driver.onSettled(() => requests.request(true));
+  const offSettled = deps.driver.onSettled(() => current().request(true));
   render();
 
   return {
     element,
     setLine(line) {
       requests.setLine(line);
-      requests.request(deps.driver.status.settled);
+      slices.setLine(line);
+      current().request(deps.driver.status.settled);
     },
     get line() { return requests.line; },
     shown() {
       render();
-      requests.request(deps.driver.status.settled);
+      current().request(deps.driver.status.settled);
     },
+    get mode() { return mode; },
+    setMode,
     dispose() {
       offSession();
       offSettled();
```

Create `src/ui/crossSection/voxels.ts`:

```ts
/**
 * The Voxels mode's pure parts (SP3a spec §5.2), unit-tested:
 * - the palette, shared with the harness PNG slices (`test/harness/png.ts` re-exports it): air in a sky colour,
 *   stone grey, bedrock near black, water blue darkening with depth below its surface;
 * - the slice image: one RGBA pixel per sample of a `pool.slice` result (512 × 384, row 0 at y 319);
 * - the plot: sample cells over the drawer, a distance axis whose point i sits at the centre of pixel column i,
 *   and the hover mapping from a pixel to the sample (i, y) under it;
 * - the hover readout (the integer (⌊xᵢ⌋, y, ⌊zᵢ⌋), the block's canonical key and the fluid) and the summary line.
 */
import { MIN_Y, SEA_LEVEL } from '../../core/constants';
import { MAX_Y } from '../../core/coords';
import type { SliceResult } from '../../engine/workerPool';
import { segmentLength, segmentPointAt, type Segment } from '../../metrics/crossSection';
import { FLUID_LAVA, FLUID_WATER, fluidFalling, fluidLevel, fluidType } from '../../world/blocks/fluid';
import { AIR, BEDROCK, REGISTRY, STONE } from '../../world/blocks/index';
import { SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES } from '../../workers/protocol';
import type { Plot, PlotBox } from '../splineEditor/model';

export type Rgb = readonly [number, number, number];

/** The Voxels palette. `seaLevel` is the sea-level line; `unknown` marks a state the palette does not know (none in SP3a). */
export const VOXEL_COLORS = {
  sky: [168, 204, 255],
  seaLevel: [112, 150, 206],
  stone: [125, 125, 125],
  bedrock: [28, 28, 30],
  water: [40, 92, 222],
  unknown: [255, 0, 255],
} as const satisfies Record<string, Rgb>;

/** The sea-level line's y. */
export const SEA_LEVEL_Y = SEA_LEVEL;
/** Water loses this share of its brightness per block of depth, down to `WATER_FLOOR`. */
const WATER_FADE = 1 / 48;
const WATER_FLOOR = 0.3;

/**
 * The colour of a voxel: its block state's, or water's when the fluid byte holds a fluid on air, darkened with
 * `depth` (blocks below the water surface, 0 at the surface).
 */
export function voxelRgb(state: number, fluid: number, depth: number): Rgb {
  if (state === AIR && fluidType(fluid) !== 0) {
    const f = Math.max(WATER_FLOOR, 1 - Math.max(0, depth) * WATER_FADE);
    const [r, g, b] = VOXEL_COLORS.water;
    return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
  }
  if (state === AIR) return VOXEL_COLORS.sky;
  if (state === STONE) return VOXEL_COLORS.stone;
  if (state === BEDROCK) return VOXEL_COLORS.bedrock;
  return VOXEL_COLORS.unknown;
}

const isWater = (state: number, fluid: number): boolean => state === AIR && fluidType(fluid) !== 0;

/**
 * The slice as an RGBA image, 512 × 384, pixel (i, row) at `sliceIndex(i, y)` (row 0 is y 319). A water voxel's depth
 * counts from the top of its run of water in the sample column (the voxel under air or a block), which equals the
 * harness's `worldSurfaceWG − 1 − y` for the provisional T's columns (no overhangs).
 */
export function sliceRgba(s: SliceResult): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(4 * SLICE_SAMPLES);
  for (let i = 0; i < SLICE_POINTS; i++) {
    let surface = 0;
    let wet = false;
    for (let row = 0; row < SLICE_ROWS; row++) {
      const k = row * SLICE_POINTS + i;
      const y = MAX_Y - row;
      const state = s.blocks[k]!;
      const fluid = s.fluid[k]!;
      const water = isWater(state, fluid);
      if (water && !wet) surface = y;
      wet = water;
      const c = voxelRgb(state, fluid, water ? surface - y : 0);
      out[4 * k] = c[0];
      out[4 * k + 1] = c[1];
      out[4 * k + 2] = c[2];
      out[4 * k + 3] = 255;
    }
  }
  return out;
}

/** The plots of the Voxels mode over `box`: sample cells, and distance from A in blocks along a line of `length`. */
export interface VoxelPlots {
  /** x: sample i covers [i, i + 1); y: voxel y covers [y, y + 1). */
  readonly cells: Plot;
  /** x: distance from A, point i (i·length/511 blocks) at the centre of its cell; y as `cells`. */
  readonly distance: Plot;
}

export function voxelPlots(box: PlotBox, length: number): VoxelPlots {
  const cells: Plot = { left: box.left, top: box.top, width: box.width, height: box.height, xMin: 0, xMax: SLICE_POINTS, yMin: MIN_Y, yMax: MAX_Y + 1 };
  const half = length / (2 * (SLICE_POINTS - 1));
  return { cells, distance: { ...cells, xMin: -half, xMax: length + half } };
}

/** A sample of the slice: point i along the line, voxel y. */
export interface VoxelCell {
  readonly i: number;
  readonly y: number;
}

/** Hover tolerance around the plot in CSS px: a pointer this close to the edge reads the edge sample. */
const EDGE_PX = 2;

/** The sample under plot pixel (px, py), clamped to the slice within 2 px of the plot; null further out. */
export function voxelCell(cells: Plot, px: number, py: number): VoxelCell | null {
  const dx = px - cells.left;
  const dy = py - cells.top;
  if (!(dx >= -EDGE_PX && dx <= cells.width + EDGE_PX && dy >= -EDGE_PX && dy <= cells.height + EDGE_PX)) return null;
  const i = Math.min(SLICE_POINTS - 1, Math.max(0, Math.floor((dx * SLICE_POINTS) / cells.width)));
  const row = Math.min(SLICE_ROWS - 1, Math.max(0, Math.floor((dy * SLICE_ROWS) / cells.height)));
  return { i, y: MAX_Y - row };
}

/** The block state's canonical key (`stone`, `log[axis=y]`), or `unknown state N`. */
export function blockName(state: number): string {
  return Number.isInteger(state) && state >= 0 && state < REGISTRY.stateCount ? REGISTRY.stateKey(state) : `unknown state ${state}`;
}

const FLUID_NAMES: Readonly<Record<number, string>> = { [FLUID_WATER]: 'water', [FLUID_LAVA]: 'lava' };

/** `no fluid`, or the fluid's type and level: `water, level 0 (source)`, `water, level 3, falling`. */
export function fluidText(b: number): string {
  const type = fluidType(b);
  if (type === 0) return 'no fluid';
  const level = fluidLevel(b);
  return `${FLUID_NAMES[type] ?? `fluid ${type}`}, level ${level}${level === 0 ? ' (source)' : ''}${fluidFalling(b) ? ', falling' : ''}`;
}

/** The hover readout of sample (i, y): `(x, y, z) · block · fluid · point i, D blocks from A`. */
export function voxelReadout(line: Segment, s: SliceResult, i: number, y: number): string {
  const [px, pz] = segmentPointAt(line, i);
  const k = (MAX_Y - y) * SLICE_POINTS + i;
  const d = (segmentLength(line) * i) / (SLICE_POINTS - 1);
  return `(${Math.floor(px)}, ${y}, ${Math.floor(pz)}) · ${blockName(s.blocks[k]!)} · ${fluidText(s.fluid[k]!)} · point ${i}, ${d.toFixed(1)} blocks from A`;
}

/**
 * `ground top y LO to HI · water on P % of the line, up to D deep`: the range of the highest block (not air) of each
 * sample column, the share of sample columns holding water and the longest run of water from the top of a column.
 */
export function sliceSummary(s: SliceResult): string {
  let lo = Infinity;
  let hi = -Infinity;
  let wetColumns = 0;
  let deepest = 0;
  for (let i = 0; i < SLICE_POINTS; i++) {
    let top: number | null = null;
    let run = 0;
    let firstRun = -1;
    for (let row = 0; row < SLICE_ROWS; row++) {
      const k = row * SLICE_POINTS + i;
      const state = s.blocks[k]!;
      if (isWater(state, s.fluid[k]!)) run++;
      else if (run > 0 && firstRun < 0) firstRun = run;
      if (state !== AIR && top === null) top = MAX_Y - row;
    }
    if (run > 0 && firstRun < 0) firstRun = run;
    if (top !== null) {
      lo = Math.min(lo, top);
      hi = Math.max(hi, top);
    }
    if (firstRun > 0) {
      wetColumns++;
      deepest = Math.max(deepest, firstRun);
    }
  }
  const ground = lo === Infinity ? 'no ground' : `ground top y ${lo} to ${hi}`;
  const water = wetColumns === 0 ? 'no water' : `water on ${((wetColumns / SLICE_POINTS) * 100).toFixed(1)} % of the line, up to ${deepest} deep`;
  return `${ground} · ${water}`;
}
```

Modify `test/harness/png.ts` (apply with `git apply`):

```diff
diff --git a/test/harness/png.ts b/test/harness/png.ts
index 37b4daf..35b7c03 100644
--- a/test/harness/png.ts
+++ b/test/harness/png.ts
@@ -1,13 +1,15 @@
 /**
  * PNG slices of a generated region (SP3a spec §6.1): a small PNG encoder over `node:zlib` (8-bit RGBA, one IDAT,
  * filter 0 on every row) and vertical (an x or a z plane) and horizontal (a y plane) slices drawn with the Voxels
- * palette of the cut line (§5.2): air in a sky colour, stone grey, bedrock near black, water blue darkening with
- * depth below the water surface, and the sea-level line at y 63 on the air of vertical slices.
+ * palette of the cut line (§5.2, `src/ui/crossSection/voxels.ts`): air in a sky colour, stone grey, bedrock near
+ * black, water blue darkening with depth below the water surface, and the sea-level line at y 63 on the air of
+ * vertical slices.
  */
 import { writeFileSync } from 'node:fs';
 import { deflateSync } from 'node:zlib';
+import { SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb, type Rgb } from '../../src/ui/crossSection/voxels';
 import { fluidType } from '../../src/world/blocks/fluid';
-import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
+import { AIR } from '../../src/world/blocks/index';
 import type { RegionView } from './region';
 
 export interface RgbaImage {
@@ -17,41 +19,11 @@ export interface RgbaImage {
   readonly rgba: Uint8Array;
 }
 
-type Rgb = readonly [number, number, number];
-
-/** The Voxels palette (§5.2). `unknown` marks a state the palette does not know (none in SP3a). */
-export const VOXEL_COLORS = {
-  sky: [168, 204, 255],
-  seaLevel: [112, 150, 206],
-  stone: [125, 125, 125],
-  bedrock: [28, 28, 30],
-  water: [40, 92, 222],
-  unknown: [255, 0, 255],
-} as const satisfies Record<string, Rgb>;
-
-export const SEA_LEVEL_Y = 63;
-/** Water loses this share of its brightness per block of depth, down to `WATER_FLOOR`. */
-const WATER_FADE = 1 / 48;
-const WATER_FLOOR = 0.3;
+/** The Voxels palette lives with the cut line's Voxels mode (§5.2), so the PNGs and the page draw the same colours. */
+export { SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb };
 const MIN_Y = -64;
 const MAX_Y = 319;
 
-/**
- * The colour of a voxel: its block state's, or water's when the fluid byte holds a fluid on air, darkened with
- * `depth` (blocks below the water surface of its column, 0 at the surface).
- */
-export function voxelRgb(state: number, fluid: number, depth: number): Rgb {
-  if (state === AIR && fluidType(fluid) !== 0) {
-    const f = Math.max(WATER_FLOOR, 1 - Math.max(0, depth) * WATER_FADE);
-    const [r, g, b] = VOXEL_COLORS.water;
-    return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
-  }
-  if (state === AIR) return VOXEL_COLORS.sky;
-  if (state === STONE) return VOXEL_COLORS.stone;
-  if (state === BEDROCK) return VOXEL_COLORS.bedrock;
-  return VOXEL_COLORS.unknown;
-}
-
 const CRC_TABLE = (() => {
   const t = new Uint32Array(256);
   for (let n = 0; n < 256; n++) {
```

Modify `test/tools/uiSmoke.ts` (apply with `git apply`):

```diff
diff --git a/test/tools/uiSmoke.ts b/test/tools/uiSmoke.ts
index 2a17ffd..deb52e3 100644
--- a/test/tools/uiSmoke.ts
+++ b/test/tools/uiSmoke.ts
@@ -23,6 +23,7 @@
  * - undo/redo: Ctrl+Z through the whole history, then Ctrl+Shift+Z and Ctrl+Y back;
  * - reload: the draft, the controls and the stored layout come back;
  * - cut line: a two-click line on the map and its profile in the drawer's Cross-section tab;
+ * - voxels: the tab's Voxels mode (SP3a spec §5.2): a fresh, non-empty slice, the hover readout, back to Profile;
  * - tabs: ArrowRight, ArrowLeft, Home and End move the selection and the focus on both tab bars;
  * - console: no exception, console error or failed load, except the known favicon.ico 404.
  * With --shots DIR it then writes the spec §12 screenshots into DIR, at seed 42 from a newly loaded page (the
@@ -90,6 +91,16 @@ export function selftestAllMatch(summary: string, count: number): boolean {
   return m !== null && Number(m[1]) === count;
 }
 
+/** The Voxels mode's hover readout: `(x, y, z) · block · fluid · point i, D blocks from A` (SP3a spec §5.2). */
+export function voxelReadoutOk(text: string): boolean {
+  return /^\(-?\d+, -?\d+, -?\d+\) · (?:[a-z][a-z0-9_]*(?:\[[a-z0-9_=,]+\])?|unknown state \d+) · (?:no fluid|[a-z0-9 ]+, level [0-7](?: \(source\))?(?:, falling)?) · point \d+, \d+\.\d blocks from A$/.test(text);
+}
+
+/** The Voxels mode's summary of a non-empty slice: `ground top y LO to HI · …water…`. */
+export function voxelSummaryOk(text: string): boolean {
+  return /^ground top y -?\d+ to -?\d+ · (?:no water|water on \d+\.\d % of the line, up to \d+ deep)$/.test(text);
+}
+
 /** A page log entry the smoke test does not count: the favicon.ico 404 (index.html declares no icon). */
 export function ignoredLog(text: string, url: string | undefined): boolean {
   return url !== undefined && /\/favicon\.ico(\?|$)/.test(url) && text.includes('404');
@@ -696,6 +707,25 @@ async function runSmoke(t: Smoke): Promise<void> {
   t.check(/^A \(-?\d+, -?\d+\) → B \(-?\d+, -?\d+\) · [\d ]+ blocks$/.test(line), `the line: ${line}`, line);
   t.check(true, `the profile: ${await p.eval<string>(`document.querySelector('.cs-summary').textContent`)}`);
 
+  t.step('voxels: the Cross-section tab\'s Voxels mode');
+  await p.click('.cs-mode[data-mode="voxels"]');
+  t.check(await p.eval<boolean>(`document.querySelector('.cs-mode[data-mode="voxels"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.cs').dataset.mode === 'voxels'`), 'the toggle selects Voxels');
+  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice');
+  const sliceSum = await p.eval<string>(`document.querySelector('.cs-summary').textContent`);
+  t.check(voxelSummaryOk(sliceSum), `the slice: ${sliceSum}`, sliceSum);
+  const colours = await p.eval<number>(`(() => { const c = document.querySelector('.cs-voxels'); if (c.hidden || c.width !== 512 || c.height !== 384) return -1; const d = c.getContext('2d').getImageData(0, 0, 512, 384).data; const s = new Set(); for (let k = 0; k < d.length; k += 4) s.add(d[k] * 65536 + d[k + 1] * 256 + d[k + 2]); return s.size; })()`);
+  t.check(colours >= 3, `the 512 × 384 slice shows ${colours} colours (air, stone and bedrock at least)`, colours);
+  const covered = await p.eval<string[]>(`[...document.querySelectorAll('.cs-plot rect, .cs-plot path')].filter((e) => getComputedStyle(e).fill !== 'none').map((e) => e.getAttribute('class'))`);
+  t.check(covered.length === 0, 'nothing in the SVG over the slice is filled', covered);
+  const vox = await p.center('.cs-voxels');
+  await p.mouse('mouseMoved', vox.x, vox.box.y + vox.box.height * 0.8);
+  const voxRead = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
+  t.check(voxelReadoutOk(voxRead), `hover: ${voxRead}`, voxRead);
+  await p.mouse('mouseMoved', vox.x, vox.box.y - 200);
+  await p.click('.cs-mode[data-mode="profile"]');
+  await p.until(`document.querySelector('.cs').dataset.mode === 'profile' && document.querySelector('.cs').dataset.state === 'fresh'`, 'the profile again');
+  t.check(await p.eval<boolean>(`document.querySelector('.cs-voxels').hidden && document.querySelector('.cs-plot .cs-offset') !== null`), 'Profile shows the profile again (kept for the same draft)');
+
   t.step('tabs: the arrow keys, Home and End on both tab bars');
   const shown = (bar: string) => p.eval<string>(`(() => { const s = document.querySelector('${bar} [aria-selected="true"]'); return s === document.activeElement && s.tabIndex === 0 && !document.getElementById(s.getAttribute('aria-controls')).hidden ? s.id : 'focus ' + document.activeElement?.id + ', selected ' + s?.id; })()`);
   await p.eval<boolean>(`(document.getElementById('map-tab-presets').focus(), true)`);
@@ -801,6 +831,14 @@ async function runShots(p: Page, dir: string): Promise<string[]> {
   await p.mouse('mouseMoved', frame.box.x + (frame.box.width * 470) / 511, frame.y);
   await sleep(1500);
   await save('cross-section.png');
+
+  // The same line in the Voxels mode (SP3a spec §5.2), the pointer under the sea near B.
+  await p.click('.cs-mode[data-mode="voxels"]');
+  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice');
+  const vox = await p.center('.cs-voxels');
+  await p.mouse('mouseMoved', vox.box.x + vox.box.width * 0.1, vox.box.y + (vox.box.height * (319 - 50)) / 384);
+  await sleep(1000);
+  await save('cross-section-voxels.png');
   return out;
 }
 
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/crossSectionModel.test.ts test/unit/crossSectionVoxels.test.ts test/unit/uiSmoke.test.ts`

Expected: PASS (exit 0)

```
Test Files  3 passed (3)
Tests  41 passed (41)
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  119 passed | 2 skipped (121)
Tests  1559 passed | 2 skipped (1561)
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/crossSection/model.ts src/ui/crossSection/section.css src/ui/crossSection/section.ts src/ui/crossSection/voxels.ts test/harness/png.ts test/tools/uiSmoke.ts test/unit/crossSectionModel.test.ts test/unit/crossSectionVoxels.test.ts test/unit/uiSmoke.test.ts
git commit -F - <<'EOF'
feat(ui): the Voxels mode of the cut-line cross-section (SP3a §5.2)

- The Cross-section tab gains a Profile | Voxels toggle. Voxels draws the
  pool.slice result one pixel per sample (512 x 384, row 0 at y 319) on a
  canvas scaled to the drawer, with distance and y axes, the sea-level line
  at 63 and A/B labels; hovering reads (floor x_i, y, floor z_i), the
  block's canonical key and the fluid (type, level), with a crosshair.
- Requests follow the profile's rules: one job per session epoch and line
  when the driver settles while the mode is on screen, stale from the next
  session change, JobCancelled silent (model.ts createLineRequests, shared
  by createSectionRequests and the new createSliceRequests).
- ui/crossSection/voxels.ts holds the pure parts: the palette (the harness
  PNG slices now re-export it), sliceRgba (water depth from the top of each
  water run), the plots and the hover mapping, the readout and a summary.
- uiSmoke: a voxels step (toggle, fresh non-empty slice, nothing filled over
  the canvas, hover readout, back to Profile) and a cross-section-voxels.png
  screenshot.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `57fd744` on `dry/sp3a`; 9 files changed, 809 insertions(+), 98 deletions(-)):

RED replay (the commit's `test/**` over the parent, throwaway detached worktree, unit + arch): 4 files failed — `test/unit/crossSectionVoxels.test.ts` fails to import `src/ui/crossSection/voxels` (whole file), `png.test.ts` and `uiSmoke.test.ts` fail to import it through `test/harness/png.ts` / the new voxels test (whole files), `crossSectionModel.test.ts` 1 failed (`shown.value` is undefined: the requests are not generic yet); 104 files / 1490 tests pass. GREEN: typecheck clean; `npm test` 119 files passed, 2 skipped / 1548 passed, 2 skipped (≈94 s); `npm run build` green (run by uiSmoke). Headless Chrome: `node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots <scratch>` (its own build, `vite preview` on a free port, its own headless Chrome, all stopped and the profile removed at the end): 77/77 checks pass, `?selftest=1` all 50 goldens match, 0 page errors; the voxels step on the 25,600-block line A (−12800, 0) → B (12800, 0): "ground top y 26 to 203 · water on 14.6 % of the line, up to 37 deep", 38 colours in the 512 × 384 canvas, hover "(25, 12, 0) · stone · no fluid · point 256, 12825.0 blocks from A". Screenshot (coast line A (5122, 3074) → B (6658, 3074), 4 blocks/px): `P/shots/task-14.png`. The first run passed every check but its screenshot showed an empty plot: the SVG frame rect (`.cs-frame` fill) covered the canvas (CSS order); fixed with `.cs-frame.cs-voxel-frame { fill: none }` and a smoke check that nothing in the SVG over the slice is filled.

- Ruling: the pure parts live in `src/ui/crossSection/voxels.ts`: `VOXEL_COLORS`, `SEA_LEVEL_Y` (= `SEA_LEVEL`), `voxelRgb(state, fluid, depth)`, `sliceRgba(slice)` (Uint8ClampedArray 512 × 384 × 4, pixel at `sliceIndex`), `voxelPlots(box, length)` → `{cells, distance}`, `voxelCell(cells, px, py)` → `{i, y} | null`, `blockName(state)`, `fluidText(byte)`, `voxelReadout(line, slice, i, y)`, `sliceSummary(slice)`; `test/harness/png.ts` re-exports the palette from there (Task 11's hand-over) — one palette for the PNGs and the page — cost if wrong: none.
- Ruling: in the page a water voxel's depth counts from the top of its run of water in the sample column (the slice has no heightmap); the harness PNGs keep `worldSurfaceWG − 1 − y`; both agree on the provisional T (no overhangs), pinned by a unit test that compares `sliceRgba` of a real coast slice with `png.voxelRgb` over a `regionView` of the same voxels — cost if wrong: SP3b's caves under water would shade differently in the PNGs and the page (the run rule is the one that reads right under an overhang).
- Ruling: the requests are generic — `createLineRequests<R>(src, fetch)` with `shown: {epoch, value}`; `createSectionRequests` (profile, `shown.value` instead of `shown.profile`; one existing assertion renamed) and the new `createSliceRequests` (`pool.slice(line)`, default priority 500) are its two instances; each stream is visible only while the tab shows its mode, so only the current mode requests; on toggling, the new mode requests at once if the driver is settled; both streams get every new line — §5.2 "the line tool and the refresh rules are those of the profile" — cost if wrong: none.
- Ruling: the toggle is a two-button group (`.cs-mode[data-mode]`, `aria-pressed`) in the tab header; `.cs[data-mode]` carries the mode; the mode is not stored (not in the URL, not in `wi10.layout.v1`): a page starts on Profile — the spec does not say; adding it to the layout store is a later one-field change — cost if wrong: one field.
- Ruling: the slice is a `<canvas width=512 height=384>` under the SVG, CSS-scaled to the plot box with `image-rendering: pixelated` (non-uniform scale: the drawer is wide and low, ≈ 1340 × 150 px at 1400 × 900, so the 1-pixel bedrock row can drop out when downscaled); the axes, the sea-level line (dashed, in `VOXEL_COLORS.seaLevel`, through the middle of row 63), A/B, the stale label and a crosshair cursor are SVG on top; the sea-level line is an overlay, not pixels as in the PNGs, so it stays visible at any scale — "scaled to the drawer" — cost if wrong: none (a fixed aspect is a CSS change).
- Ruling: hover mapping is by pixel cell (`i = ⌊dx·512/width⌋`, `y = 319 − ⌊dy·384/height⌋`), clamped within 2 px of the plot (the profile's tolerance) and null further out; the readout is `(x, y, z) · <canonical state key> · <no fluid | water, level L (source)[, falling]> · point i, D blocks from A` with `readout.dataset.point`/`.y` — §5.2 "the block name": the canonical key (§2.3) is the type name for SP3a's states and names the properties later — cost if wrong: wording only.
- Ruling: Voxels shows a summary line under the header, "ground top y LO to HI · water on P % of the line, up to D deep" (cached per slice), mirroring the profile's summary; not asked by §5.2 — cost if wrong: none.
- Ruling: `uiSmoke.ts` gains pure `voxelReadoutOk`/`voxelSummaryOk` (regexes; a unit test feeds them the model's real outputs, so the smoke cannot drift from the page's formats), a `voxels` step after the cut line (toggle, fresh, summary format, ≥ 3 colours in the canvas via `getImageData`, nothing filled in the SVG, hover readout, back to Profile fresh) and a `cross-section-voxels.png` screenshot in `--shots` (Task 16's Voxels-mode screenshot) — §8 "uiSmoke.ts toggles Voxels and checks a non-empty slice" — cost if wrong: none.
- No spec defects found for Task 14.

---

### Task 15: Bench rows

**Spec:** §7

**Files:**
- Modify: `test/baselines.json`
- Modify: `test/bench/gates.ts`
- Modify: `test/bench/noise.bench.ts`
- Modify: `test/unit/benchGates.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `src/world/store/store.ts` (Task 7): `createStore`
  - `src/metrics/region.ts` (Task 9): `fillColumnT`
- Produces (exports added by this task):
  - `test/bench/gates.ts`:
    - `export const BENCH_ROWS = [`

- [ ] **Step 1: Write the failing tests**

Modify `test/unit/benchGates.test.ts` (apply with `git apply`):

```diff
diff --git a/test/unit/benchGates.test.ts b/test/unit/benchGates.test.ts
index da8313a..04497df 100644
--- a/test/unit/benchGates.test.ts
+++ b/test/unit/benchGates.test.ts
@@ -1,5 +1,6 @@
+import { readFileSync } from 'node:fs';
 import { expect, test } from 'vitest';
-import { gateFailures, KILL_RATIO_MAX, P1_MAX_REGRESSION, type Baselines } from '../bench/gates';
+import { BENCH_ROWS, gateFailures, KILL_RATIO_MAX, P1_MAX_REGRESSION, type Baselines } from '../bench/gates';
 
 const base: Baselines = { machine: 'm', node: 'v24', date: '2026-09-27', killRatio: 1.2, kernels: { a: { nsPerEval: 10, ratio: 2 }, b: { nsPerEval: 5, ratio: 1 } } };
 
@@ -17,3 +18,23 @@ test('P1: a kernel ratio above 1.3 × its baseline fails; new kernels are ignore
     'b: ratio 1.310 > 1.3 × baseline 1.000',
   ]);
 });
+
+test('the bench rows: SP1 to SP2b, then the SP3a store and provisional T rows (SP3a §7)', () => {
+  expect(BENCH_ROWS).toEqual([
+    'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
+    'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
+    'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
+    'store.alloc', 'terrain.provisional',
+  ]);
+  expect(new Set(BENCH_ROWS).size).toBe(BENCH_ROWS.length);
+});
+
+test('test/baselines.json records every bench row, so none is silently ungated', () => {
+  const baseline = JSON.parse(readFileSync(new URL('../baselines.json', import.meta.url), 'utf8')) as Baselines;
+  expect(Object.keys(baseline.kernels)).toEqual([...BENCH_ROWS]);
+  for (const [name, k] of Object.entries(baseline.kernels)) {
+    expect(k.nsPerEval, name).toBeGreaterThan(0);
+    expect(k.ratio, name).toBeGreaterThan(0);
+  }
+  expect(baseline.kernels['calibration.fmix32']!.ratio).toBe(1);
+});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit test/unit/benchGates.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× the bench rows: SP1 to SP2b, then the SP3a store and provisional T rows (SP3a §7) 4ms
× test/baselines.json records every bench row, so none is silently ungated 1ms
FAIL  |unit| test/unit/benchGates.test.ts > the bench rows: SP1 to SP2b, then the SP3a store and provisional T rows (SP3a §7)
AssertionError: expected undefined to deeply equal [ 'calibration.fmix32', …(19) ]
FAIL  |unit| test/unit/benchGates.test.ts > test/baselines.json records every bench row, so none is silently ungated
TypeError: BENCH_ROWS is not iterable
Test Files  1 failed (1)
Tests  2 failed | 3 passed (5)
```

- [ ] **Step 3: Implement**

Modify `test/bench/gates.ts` (apply with `git apply`):

```diff
diff --git a/test/bench/gates.ts b/test/bench/gates.ts
index be1432b..d647581 100644
--- a/test/bench/gates.ts
+++ b/test/bench/gates.ts
@@ -5,6 +5,18 @@ export const KILL_RATIO_MAX = 1.6;
 export const COLUMN_P50_MAX_MS = 0.7;
 export const COLUMN_P95_MAX_MS = 1.2;
 
+/**
+ * Every gated bench row, in measurement order: `noise.bench.ts` measures exactly these, and `test/baselines.json`
+ * records every one (a unit test), so a row added without `npm run bench:record` cannot stay ungated.
+ * SP3a §7 appends `store.alloc` and `terrain.provisional`.
+ */
+export const BENCH_ROWS = [
+  'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
+  'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
+  'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
+  'store.alloc', 'terrain.provisional',
+] as const;
+
 export interface BenchKernel {
   readonly nsPerEval: number;
   /** nsPerEval ÷ the calibration kernel's nsPerEval, measured in the same run. */
```

Modify `test/bench/noise.bench.ts` (apply with `git apply`):

```diff
diff --git a/test/bench/noise.bench.ts b/test/bench/noise.bench.ts
index eeacc23..3738d98 100644
--- a/test/bench/noise.bench.ts
+++ b/test/bench/noise.bench.ts
@@ -16,8 +16,10 @@ import { createGenContext } from '../../src/gen/context';
 import { columnPoint } from '../../src/gen/column/columnPoint';
 import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
 import { paintTile } from '../../src/gen/map/tile';
+import { fillColumnT } from '../../src/metrics/region';
+import { createStore } from '../../src/world/store/store';
 import { createTaskHandler } from '../../src/workers/taskHandler';
-import { COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, type Baselines, type BenchKernel } from './gates';
+import { BENCH_ROWS, COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, type Baselines, type BenchKernel } from './gates';
 import { buildPerm, perm3 } from './perm512';
 
 const FMIX = fmix32;
@@ -31,7 +33,7 @@ const BASELINE_PATH = fileURLToPath(new URL('../baselines.json', import.meta.url
 const N = 4096;
 let sink = 0;
 
-test('SP1, SP2a and SP2b kernels', async ({ bench }) => {
+test('SP1, SP2a, SP2b and SP3a kernels', async ({ bench }) => {
   const ns: Record<string, number> = {};
   const measure = async (name: string, evals: number, fn: () => void, iterations?: number) => {
     const r = await bench(name, fn).run(iterations === undefined ? undefined : { iterations, time: 0, warmupIterations: 1 });
@@ -98,7 +100,25 @@ test('SP1, SP2a and SP2b kernels', async ({ bench }) => {
   let pt = 0;
   await measure('map.tile.b256.biome', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'biome', 256, tx, tz, tile); sink += tile[0]!; }, 8);
   await measure('map.tile.b256.relief', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'relief', 256, tx, tz, tile); sink += tile[0]!; }, 8);
+  // SP3a §7, on one shared store (the backend the 4-thread harness and SP4's streaming use): one alloc and free on
+  // the byte pool (the lock, a stack pop and push, the refcount), and one column's provisional T stage including its
+  // ColumnSample, through fillColumnT (claim, 24 sections, aux A, commit) and the freeColumn that recycles its slots.
+  const store = createStore({ shared: true, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
+  const bytePool = store.bytePool;
+  await measure('store.alloc', N, () => { for (let i = 0; i < N; i++) { const id = bytePool.alloc(); bytePool.free(id); sink += id; } });
+  const never = (): boolean => false;
+  let tc = 0;
+  await measure('terrain.provisional', 1, () => {
+    tc++;
+    const tcx = (tc * 7919) % 60000 - 30000;
+    const tcz = (tc * 104729) % 60000 - 30000;
+    sink += fillColumnT(store, gen, tcx, tcz, never) ? 1 : 0;
+    store.freeColumn(tcx, tcz);
+  });
+  expect(bytePool.slotCount() - bytePool.freeCount(), 'store rows leak no slot').toBe(0);
+  expect(store.blockPool.slotCount() - store.blockPool.freeCount(), 'store rows leak no slot').toBe(0);
 
+  expect(Object.keys(ns), 'the measured rows are BENCH_ROWS').toEqual([...BENCH_ROWS]);
   const calib = ns['calibration.fmix32']!;
   const kernels: Record<string, BenchKernel> = {};
   for (const [name, v] of Object.entries(ns)) kernels[name] = { nsPerEval: Math.round(v * 1000) / 1000, ratio: Math.round((v / calib) * 1000) / 1000 };
```

- [ ] **Step 4: Regenerate the governed files**

`test/baselines.json` is recorded on your machine, not copied: its numbers are machine-specific. `npm run bench:record` rewrites every row and refuses to write when the absolute P1 gate (column p50 ≤ 0.7 ms) fails, so nothing else may load the CPU (spec §7). In this order:

1. `npm run bench`: against the SP2b baseline the existing rows must pass (the two new rows are skipped while absent).
2. `npm run bench:record`.
3. `npm run bench`: every row within +30 %.

Then check that `git diff test/baselines.json` adds `store.alloc` and `terrain.provisional`. On the reference machine `terrain.provisional` is about 0.66 ms per column and `store.alloc` about 170 ns per alloc and free pair.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project unit test/unit/benchGates.test.ts`

Expected: PASS (exit 0)

```
Test Files  1 passed (1)
Tests  5 passed (5)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  119 passed | 2 skipped (121)
Tests  1561 passed | 2 skipped (1563)
```

- [ ] **Step 7: Commit**

```bash
git add test/baselines.json test/bench/gates.ts test/bench/noise.bench.ts test/unit/benchGates.test.ts
git commit -F - <<'EOF'
test(bench): store.alloc and terrain.provisional rows, re-recorded baseline (SP3a §7)

store.alloc times one alloc and free on the byte pool of a shared store;
terrain.provisional one column's provisional T stage including its
ColumnSample, through fillColumnT and the freeColumn that recycles its slots.
BENCH_ROWS (test/bench/gates.ts) lists every gated row: the bench asserts it
measures exactly these, and a unit test that test/baselines.json records every
one, so a row cannot stay ungated. test/baselines.json re-recorded with
npm run bench:record (all 20 rows).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

**Dry-run notes** (dry-run commit `7709b51` on `dry/sp3a`; 4 files changed, 100 insertions(+), 39 deletions(-)):

Test-only task, as Tasks 8, 11 and 12: every file is under `test/` (`test/bench/{gates,noise.bench}.ts`, `test/unit/benchGates.test.ts`, `test/baselines.json`), so the plan's RED replay of the commit's `test/**` over the parent PASSES. RED as watched during TDD: `benchGates.test.ts` with the two new tests and the parent's `gates.ts`/baseline → 2 failed ("BENCH_ROWS is not iterable"). GREEN: typecheck clean; `npm test` 119 files passed, 2 skipped / 1550 passed, 2 skipped (≈97 s). Bench run ≈ 39 s per `npm run bench`.

**The machine was not quiet.** The user's own game (a `java` process at 120-260 % CPU plus its launcher, not started by this run and not touched) ran throughout; CPU cores peaked at ≈ 2.8 GHz (4.6 GHz max) and `calibration.fmix32` measured 1.2-1.6 ns against 0.636 ns in the quiet SP2b baseline. A 15-minute wait for it to go idle timed out. Evidence:
- `npm run bench` against the old baseline (rows ignored when absent): passed once (exit 0; column p50 0.681 ms, worst row ratio within the gate); 3 other runs failed only the ABSOLUTE P1 gate `column.sample p50 ≤ 0.7 ms` (0.706, 0.715, 0.795 ms), the ratio gate passing.
- `npm run bench:record`: written twice (p50 0.624 and 0.682 ms); four later attempts refused to write because the P1 absolute assertion runs before the write (p50 0.706-0.895 ms). The committed baseline is the second written record (killRatio 0.789; calibration 1.354 ns; new rows `store.alloc` 320.9 ns / ratio 236.96 per alloc+free pair, `terrain.provisional` 1.395 ms / ratio 1,029,781 per column). It was restored byte-for-byte from that run's printed table after an intermediate `git checkout` (same rounding, keys, machine, node and UTC date as the writer).
- `npm run bench` against it: 5 runs, all failing only the absolute P1 p50 (0.71-0.89 ms); ratio gates: 3 of 5 within +30 % for every row, 2 with one noisy row over (column.point 1.536, 1.469); the new rows stayed within the gate except once (`terrain.provisional` 1.51 × in a run where its own p50 doubled to 2.4 ms — a load spike).

- Ruling: `BENCH_ROWS` (`test/bench/gates.ts`) lists every gated row in measurement order; the bench asserts `Object.keys(ns)` equals it and a unit test asserts `test/baselines.json`'s kernels are exactly `BENCH_ROWS` (positive values, calibration ratio 1) — the only failing-first test a bench row can have, and it makes "a row added without `bench:record`" a unit failure (SP2b's rows had no test) — cost if wrong: none (a later SP adding a row edits the list and records in the same commit, which the skeleton already requires).
- Ruling: both rows run on one `createStore({shared: true, maxBlockBytes: 32 MiB, maxByteBytes: 16 MiB})` — the backend the 4-thread harness and SP4's streaming use (Atomics on a growable SAB); `store.alloc` = 4096 `bytePool.alloc()` + `free(id)` pairs per sample, reported per pair (like the other N-eval rows); `terrain.provisional` = one column per sample at the `column.sample` pseudo-random column sequence (`(t·7919) mod 60000 − 30000`, `(t·104729) mod 60000 − 30000`), through `fillColumnT(store, gen, cx, cz, () => false)` (claim, `terrainStage` with its ColumnSample, 24 `setProto`, aux A, commit) plus `store.freeColumn` (so the pool stays flat; the bench asserts 0 live slots in both pools afterwards) — §7 "one column's provisional T stage including its ColumnSample" — cost if wrong: claim/commit/free add a few µs to a ≈ 0.6-1.2 ms row.
- Ruling: the test title becomes 'SP1, SP2a, SP2b and SP3a kernels'; the absolute P1 gate (`COLUMN_P50_MAX_MS` 0.7, SP2a) is unchanged — cost if wrong: none.
- Ruling (handed to the executor and Task 16): re-run `npm run bench` → `bench:record` → `bench` on a quiet machine and commit THAT baseline. The loaded record shifts ratios against the quiet SP2b one by up to 1.31 × (old/new: column.sample 1.309, detErf 1.284, spline.offset 1.231, column.point 1.220, worker.configure 1.206; the calibration kernel slows more under load than the memory-bound kernels), so a quiet `npm run bench` against this dry-run baseline may fail `column.sample` (and others) on the +30 % ratio gate. Also: `bench:record` refuses to write when the absolute P1 p50 > 0.7 ms, so recording itself needs a quiet machine. On the quiet reference machine `terrain.provisional` should be ≈ 0.6-0.7 ms (Task 9: ≈ 0.7 ms) and `store.alloc` ≈ 150 ns per pair — cost if wrong: Task 16's bench evidence fails on ratios.
- Spec defect: §7 "New rows, recorded with `npm run bench:record` and gated at +30 % like the rest" and §12 "bench within +30 % with the new rows | `npm run bench`" do not say that `bench:record` rewrites every row (SP2b §9 said it and fixed the order bench → record → bench) nor that it needs a quiet machine → add to §7: "`npm run bench:record` rewrites every row, so on the reference machine with nothing else loading the CPU: `npm run bench` against the SP2b baseline (the existing rows must pass), then `npm run bench:record`, then `npm run bench`; the P1 absolute gate (column p50 ≤ 0.7 ms) must pass for the record to be written."

---

### Task 16: Amendments, docs, review PNGs, exit evidence

**Spec:** §11 (apply every master amendment to `docs/superpowers/specs/2026-09-26-architecture-design.md`, and the SP0 CI note if a SP0 spec mentions it), §12

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-26-architecture-design.md`
- Modify: `docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md`
- Modify: `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md`
- Create: `docs/superpowers/specs/assets/sp3a/cross-section-voxels.png`
- Create: `docs/superpowers/specs/assets/sp3a/slice-coast.png`
- Create: `docs/superpowers/specs/assets/sp3a/slice-lake.png`
- Create: `docs/superpowers/specs/assets/sp3a/slice-river.png`
- Create: `docs/superpowers/specs/assets/sp3a/slice-y62.png`
- Create: `docs/superpowers/specs/assets/sp3a/slices.json`
- Modify: `package.json`
- Create: `test/arch/masterSpec.test.ts`
- Modify: `test/baselines.json`
- Create: `test/harness/reviewSlices.ts`
- Create: `test/unit/reviewSlices.test.ts`

**Interfaces:**
- Consumes (from earlier SP3a tasks):
  - `test/harness/png.ts` (Task 11): `encodePng`, `sliceY`, `sliceZ`, `type RgbaImage`
  - `test/harness/region.ts` (Task 11): `genRegion`, `type RegionView`
- Produces (exports added by this task):
  - `test/harness/reviewSlices.ts`:
    - `export type ReviewKind = 'land' | 'sea' | 'lake' | 'river';`
    - `export const REVIEW_KINDS: readonly ReviewKind[] = ['land', 'sea', 'lake', 'river'];`
    - `export function positionKind(s: ColumnSample, x: number, z: number): ReviewKind`
    - `export interface VerticalSite`
    - `export interface HorizontalSite`
    - `export type ReviewSite = VerticalSite | HorizontalSite;`
    - `export const REVIEW_SITES: readonly ReviewSite[] = [`
    - `export function lineKinds(ctx: GenContext, site: ReviewSite): Record<ReviewKind, number>`
    - `export function upscale(img: RgbaImage, k: number): RgbaImage`
    - `export function renderSite(view: RegionView, site: ReviewSite): RgbaImage`
    - `export async function generateSite(seed: string, params: Params, site: ReviewSite): Promise<RegionView>`
    - `export interface WrittenSlice`
    - `export async function writeReviewSlices(dir: string, seed: string, params: Params, sites: readonly ReviewSite[] = REVIEW_SITES): Promise<WrittenSlice[]>`

- [ ] **Step 1: Write the failing tests**

Create `test/arch/masterSpec.test.ts`:

```ts
/**
 * The master spec's sub-project list agrees with the code (SP3a spec §11: the master §2.5 and §10 amendments): the
 * `SubProjectId` type of §2.5 lists `SUB_PROJECTS` in order, §10 has one header per sub-project in that order whose
 * parenthetical names every dependency `SP_DEPS` transcribes from it, and the critical path is a dependency chain.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SUB_PROJECTS, type SubProjectId } from '../../src/core/ids';
import { SP_DEPS } from '../harness/sp';

const MASTER = 'docs/superpowers/specs/2026-09-26-architecture-design.md';
const text = readFileSync(MASTER, 'utf8');
const SP_TOKEN = /\bSP(?:\d+[a-z]?)\b/g;

/** §10 headers: `**SPx — Title** (size; dependencies …)`, in document order. */
function headers(): Array<{ id: string; paren: string }> {
  const out: Array<{ id: string; paren: string }> = [];
  for (const m of text.matchAll(/^\*\*(SP\d+[a-z]?) — [^*]+\*\* \(([^)]*)\)/gm)) out.push({ id: m[1]!, paren: m[2]! });
  return out;
}

describe('master spec sub-projects (SP3a §11)', () => {
  test('§2.5 SubProjectId lists SUB_PROJECTS in order', () => {
    const line = text.split('\n').find((l) => l.startsWith('type SubProjectId ='));
    expect(line, 'no `type SubProjectId =` line in the master spec').toBeDefined();
    expect([...line!.matchAll(/'(SP[^']*)'/g)].map((m) => m[1])).toEqual([...SUB_PROJECTS]);
  });

  test('§10 has one header per sub-project, in order, naming every SP_DEPS dependency', () => {
    const hs = headers();
    expect(hs.map((h) => h.id)).toEqual([...SUB_PROJECTS]);
    for (const h of hs) {
      const named = new Set(h.paren.match(SP_TOKEN) ?? []);
      for (const dep of SP_DEPS[h.id as SubProjectId]) expect(named.has(dep), `${h.id} header (${h.paren}) misses ${dep}`).toBe(true);
    }
  });

  test('the critical path is a chain of SP_DEPS edges from SP0 to SP12', () => {
    const line = text.split('\n').find((l) => l.startsWith('Critical path: '));
    expect(line, 'no `Critical path:` line in the master spec').toBeDefined();
    const path = line!.slice('Critical path: '.length).replace(/\.$/, '').split(' → ');
    expect(path[0]).toBe('SP0');
    expect(path.at(-1)).toBe('SP12');
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [path[i - 1]!, path[i]!];
      expect(SUB_PROJECTS as readonly string[], `unknown sub-project ${b}`).toContain(b);
      expect(SP_DEPS[b as SubProjectId], `${a} → ${b} is not a dependency`).toContain(a);
    }
  });
});
```

Create `test/unit/reviewSlices.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { fluidType } from '../../src/world/blocks/fluid';
import { BEDROCK } from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { encodePng, VOXEL_COLORS } from '../harness/png';
import type { RegionView } from '../harness/region';
import {
  generateSite, lineKinds, positionKind, renderSite, REVIEW_KINDS, REVIEW_SITES, upscale, writeReviewSlices,
  type ReviewKind, type VerticalSite,
} from '../harness/reviewSlices';

const ctx = ctxFor('42');
const params = paramsWith();
const verticals = REVIEW_SITES.filter((s): s is VerticalSite => s.kind === 'vertical');

/** True when column (x, z) of the view holds a water voxel. */
function wetAt(view: RegionView, x: number, z: number): boolean {
  for (let y = -64; y <= 319; y++) if (fluidType(view.fluid(x, y, z)) !== 0) return true;
  return false;
}

describe('review sites (spec §12 visual review)', () => {
  test('the sites: a coast, a lake and a river vertical slice, and a horizontal slice at y 62', () => {
    expect(REVIEW_SITES.map((s) => s.name)).toEqual(['coast', 'lake', 'river', 'y62']);
    expect(new Set(REVIEW_SITES.map((s) => s.file)).size).toBe(REVIEW_SITES.length);
    const y62 = REVIEW_SITES.find((s) => s.name === 'y62')!;
    expect(y62.kind === 'horizontal' && y62.y).toBe(62);
    for (const s of REVIEW_SITES) {
      expect(s.w, s.name).toBeGreaterThanOrEqual(1);
      expect(s.w, s.name).toBeLessThanOrEqual(64);
      if (s.kind === 'horizontal') {
        expect(s.h).toBeLessThanOrEqual(64);
        expect(s.checkZ >> 4).toBeGreaterThanOrEqual(s.cz0);
        expect(s.checkZ >> 4).toBeLessThan(s.cz0 + s.h);
      }
    }
  });

  test.each(REVIEW_SITES.map((s) => [s.name, s] as const))('%s: the line crosses every kind the site needs', (_name, site) => {
    const kinds = lineKinds(ctx, site);
    expect(Object.values(kinds).reduce((a, b) => a + b, 0)).toBe(16 * site.w);
    for (const k of site.needs) expect(kinds[k], `${site.name} needs ${k}: ${JSON.stringify(kinds)}`).toBeGreaterThan(0);
  });

  test('positionKind: every kind occurs on the sites; a position outside the sample column throws', () => {
    const seen = new Set<ReviewKind>();
    for (const s of verticals) for (const [k, n] of Object.entries(lineKinds(ctx, s))) if (n > 0) seen.add(k as ReviewKind);
    expect([...seen].sort()).toEqual([...REVIEW_KINDS].sort());
    const s = buildColumnSample(ctx, 3, -2, newColumnSample());
    expect(() => positionKind(s, 16 * 3 + 16, -32)).toThrow(RangeError);
    expect(() => positionKind(s, 16 * 3, -33)).toThrow(RangeError);
  });
});

describe('vertical review slices over the generated voxels', () => {
  test.each(verticals.map((s) => [s.name, s] as const))('%s: kinds agree with the voxels; the crop removes only air and stone', async (_name, site) => {
    const view = await generateSite('42', params, site);
    const s = newColumnSample();
    let cx = Number.NaN;
    let lakeAbove63 = 0;
    for (let x = 16 * site.cx0; x < 16 * (site.cx0 + site.w); x++) {
      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), site.z >> 4, s);
      const kind = positionKind(s, x, site.z);
      expect(wetAt(view, x, site.z), `(${x}, ${site.z}) is ${kind}`).toBe(kind !== 'land');
      const top = view.worldSurfaceWG(x, site.z) - 1;
      const floor = view.oceanFloorWG(x, site.z) - 1;
      expect(top, `(${x}, ${site.z}) top ${top} above the crop`).toBeLessThanOrEqual(site.yMax);
      expect(floor, `(${x}, ${site.z}) ground ${floor} below the crop`).toBeGreaterThanOrEqual(site.yMin);
      if (kind === 'lake' && fluidType(view.fluid(x, top, site.z)) !== 0 && top > 63) lakeAbove63++;
      expect(view.block(x, -64, site.z)).toBe(BEDROCK);
    }
    if (site.needs.includes('lake')) expect(lakeAbove63).toBeGreaterThan(0);
  });

  test('renderSite: the slice size, the bottom row of bedrock at y −64, the upscale', async () => {
    const coast = verticals.find((s) => s.name === 'coast')!;
    expect([coast.yMin, coast.scale]).toEqual([-64, 1]);
    const img = renderSite(await generateSite('42', params, coast), coast);
    expect([img.width, img.height]).toEqual([16 * coast.w, coast.yMax - coast.yMin + 1]);
    const last = 4 * img.width * (img.height - 1);
    for (let i = 0; i < img.width; i++) {
      expect([...img.rgba.subarray(last + 4 * i, last + 4 * i + 3)]).toEqual([...VOXEL_COLORS.bedrock]);
    }
    const river = verticals.find((s) => s.name === 'river')!;
    const view = await generateSite('42', params, river);
    const one = renderSite(view, { ...river, scale: 1 });
    const two = renderSite(view, river);
    expect(river.scale).toBe(2);
    expect([two.width, two.height]).toEqual([2 * one.width, 2 * one.height]);
    for (const [x, y] of [[0, 0], [17, 9], [one.width - 1, one.height - 1]] as const) {
      const p = [...one.rgba.subarray(4 * (y * one.width + x), 4 * (y * one.width + x) + 4)];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const q = 4 * ((2 * y + dy) * two.width + 2 * x + dx);
        expect([...two.rgba.subarray(q, q + 4)]).toEqual(p);
      }
    }
    expect(() => upscale(one, 0)).toThrow(RangeError);
    expect(upscale(one, 1)).toBe(one);
  });

  test('writeReviewSlices writes each site as the PNG of its slice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi10-review-'));
    try {
      const site: VerticalSite = { ...verticals.find((s) => s.name === 'coast')!, w: 4, file: 'small.png' };
      const [written] = await writeReviewSlices(dir, '42', params, [site]);
      expect(written!.path).toBe(join(dir, 'small.png'));
      const bytes = readFileSync(written!.path);
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(encodePng(renderSite(await generateSite('42', params, site), site))));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 192]);
      expect([written!.width, written!.height, written!.bytes]).toEqual([64, 192, bytes.length]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `npm run docs:review-slices` sets REVIEW_SLICES_DIR to `docs/superpowers/specs/assets/sp3a` and writes every site
 * there (the 64 × 64 horizontal slice takes a few seconds), plus `slices.json` (each site and the kinds its line
 * crosses); without it nothing is written.
 */
test.runIf(process.env.REVIEW_SLICES_DIR !== undefined)('write the review slices into REVIEW_SLICES_DIR', async () => {
  const written = await writeReviewSlices(process.env.REVIEW_SLICES_DIR!, '42', params);
  expect(written.map((w) => w.site.file)).toEqual(REVIEW_SITES.map((s) => s.file));
  const summary = written.map((w) => ({
    file: w.site.file, width: w.width, height: w.height, site: w.site, lineKinds: lineKinds(ctx, w.site),
  }));
  writeFileSync(join(process.env.REVIEW_SLICES_DIR!, 'slices.json'), `${JSON.stringify({ seed: '42', profile: 'default', slices: summary }, null, 2)}\n`);
}, 300_000);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project arch --project unit test/arch/masterSpec.test.ts test/unit/reviewSlices.test.ts`

Expected: FAIL (the dry run printed, in part):

```
× §2.5 SubProjectId lists SUB_PROJECTS in order 7ms
× §10 has one header per sub-project, in order, naming every SP_DEPS dependency 1ms
× the critical path is a chain of SP_DEPS edges from SP0 to SP12 2ms
FAIL  |unit| test/unit/reviewSlices.test.ts [ test/unit/reviewSlices.test.ts ]
Error: Cannot find module '../harness/reviewSlices' imported from /home/maestre/Proyectos/world-imaginer-voxel/.superpowers/sp3/replay/test/unit/reviewSlices.test.ts
FAIL  |arch| test/arch/masterSpec.test.ts > master spec sub-projects (SP3a §11) > §2.5 SubProjectId lists SUB_PROJECTS in order
AssertionError: expected [ 'SP0', 'SP1', 'SP2a', 'SP2b', …(12) ] to deeply equal [ 'SP0', 'SP1', 'SP2a', 'SP2b', …(14) ]
FAIL  |arch| test/arch/masterSpec.test.ts > master spec sub-projects (SP3a §11) > §10 has one header per sub-project, in order, naming every SP_DEPS dependency
FAIL  |arch| test/arch/masterSpec.test.ts > master spec sub-projects (SP3a §11) > the critical path is a chain of SP_DEPS edges from SP0 to SP12
AssertionError: unknown sub-project SP3: expected [ 'SP0', 'SP1', 'SP2a', 'SP2b', …(14) ] to include 'SP3'
Test Files  2 failed (2)
Tests  3 failed (3)
```

- [ ] **Step 3: Implement**

Modify `CLAUDE.md` (apply with `git apply`):

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index 0f73a13..c3ccb7e 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -6,7 +6,7 @@ This file provides guidance to Claude Code (claude.ai/code) when working with co
 
 Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.
 
-**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3). SP3a (block registry, voxel store, region harness) in progress.
+**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3), SP3a complete (2026-10-03, GENERATOR_VERSION 3). SP3b is next.
 
 ## Source of truth
 
@@ -24,11 +24,12 @@ Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with cus
 - `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
 - `npm run test:accept-state-ids` — append the states of new block types to `test/stateIds.lock.json` (append-only: refuses a changed id, a removed entry or a new state of a locked type; the commit message says the lock changed)
 - `npm run docs:params` — regenerate the README parameter table from the schema
-- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1 and SP2a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
-- `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section, global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
+- `npm run docs:review-slices` — write the SP3a review PNG slices of the provisional terrain (a coast, a lake and a river, and y 62; seed 42) into `docs/superpowers/specs/assets/sp3a/` through the region harness
+- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1, SP2a and SP3a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
+- `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section with its Profile | Voxels toggle (SP3a: the real vertical slice of voxels), global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
 - `?map&perf=edit` — the same page with the SP2b latency hook (`src/ui/map/perfHook.ts`, `globalThis.__wiPerf`): pins the canvas to 1100 × 825 at seed 42, default profile, view (0, 0, 64 bpp)
 - `node test/tools/mapLatency.ts [--profile-dir DIR]` — the SP2b §2.8 edit → preview latency runner (not in CI; about 35 min): builds, serves `dist` on its own free port (never 5183), drives its own headless Chrome and writes `docs/superpowers/specs/assets/sp2b/latency-*.json`; `--quick` for a short run
-- `node test/tools/uiSmoke.ts [--profile-dir DIR] [--shots DIR]` — the SP2b UI smoke test (not in CI; about 1 min): `?selftest=1`, then every editor driven with real pointer and key input and checked through the DOM and the URL, no console errors; `--shots` also writes the spec §12 screenshots
+- `node test/tools/uiSmoke.ts [--profile-dir DIR] [--shots DIR]` — the SP2b UI smoke test (not in CI; about 1 min; SP3a adds the Voxels toggle): `?selftest=1`, then every editor driven with real pointer and key input and checked through the DOM and the URL, no console errors; `--shots` also writes the spec §12 screenshots
 - `docker compose up world-imaginer-voxel`
 - Each sub-project appends its id to `STARTED_SPS` in `test/harness/sp.ts` in its first commit. Appending changes the lock (`test/thresholds.lock.json`), so run `npm run test:accept-thresholds` and amend the spec in the same change.
 
@@ -40,7 +41,7 @@ Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with cus
 - In `core/`, `world/` and `gen/`: no `Math.random`, `Date.now`, `performance.now` or `console.*`; in `gen/` no `Math.sin/cos/exp/...` (use `core/detMath`) and no exported numeric constants (tunables live in `ParamSchema`).
 - No audio files (`.ogg`/`.mp3`/`.wav`) in the repository; sound packs are user-supplied.
 - Conventional commits scoped by area: `feat(gen):`, `feat(render):`, `fix(store):`, `test(metrics):`, `docs(spec):`, …
-- Determinism (SP1): in `core/noise/**`, `core/spline/**` and `metrics/**` an imported value binding is used only through a top-level `const` alias (vitest turns imports into getters; arch-tested); `core/` and `gen/` never call `Intl`, `localeCompare`, `toLocale*`, `.normalize(`, `TextEncoder` or `TextDecoder`; `Math.fround` is banned in `core/` and `gen/`.
+- Determinism (SP1): in `core/noise/**`, `core/spline/**`, `metrics/**` and `world/blocks/**` (SP3a) an imported value binding is used only through a top-level `const` alias (vitest turns imports into getters; arch-tested); `core/`, `gen/` and `world/blocks/**` never call `Intl`, `localeCompare`, `toLocale*`, `.normalize(`, `TextEncoder` or `TextDecoder`; `Math.fround` is banned in `core/`, `gen/` and `world/blocks/**`.
 - Generator outputs are NaN-free; every golden hasher writes NaN as `0x7FF8000000000000` (`hashF64`). Every validated parameter number goes through `q15`; canonical JSON throws on NaN, ±Infinity and −0.
 - A noise leaf's seed name is its path; renaming the path needs `seedName` to keep the same worlds.
 
```

Modify `README.md` (apply with `git apply`):

```diff
diff --git a/README.md b/README.md
index 1a17304..30c1bd2 100644
--- a/README.md
+++ b/README.md
@@ -6,7 +6,7 @@ It is the successor of [world-imaginer](https://github.com/MaestreDniel/world-im
 
 ## Status
 
-SP0, SP1, SP2a and SP2b are complete: `?map` shows the generated world's biomes, relief, rivers and lakes and edits every parameter, spline and biome box with a live preview (parameter panel, spline editor, biome table with share chart, presets, cross-section, undo/redo), and `?selftest=1` checks every golden in the browser (deployed at https://world-imaginer-voxel.vercel.app). SP3 (voxel store, density, surface rules) is next.
+SP0, SP1, SP2a, SP2b and SP3a are complete: `?map` shows the generated world's biomes, relief, rivers and lakes and edits every parameter, spline and biome box with a live preview (parameter panel, spline editor, biome table with share chart, presets, cross-section, undo/redo); the cross-section's Voxels mode shows the real vertical slice of voxels (SP3a: block registry, shared voxel store and a provisional terrain stage filled from the 2D world), and `?selftest=1` checks every golden in the browser (deployed at https://world-imaginer-voxel.vercel.app). SP3b (density, surfaceEstimate, terrain and surface rules) is next.
 
 ## Development
 
```

Modify `docs/superpowers/specs/2026-09-26-architecture-design.md` (apply with `git apply`):

````diff
diff --git a/docs/superpowers/specs/2026-09-26-architecture-design.md b/docs/superpowers/specs/2026-09-26-architecture-design.md
index 4c0a68f..cfd4c48 100644
--- a/docs/superpowers/specs/2026-09-26-architecture-design.md
+++ b/docs/superpowers/specs/2026-09-26-architecture-design.md
@@ -77,7 +77,10 @@ world-imaginer-voxel/          (repository root)
   src/
     core/                       L0 pure: no DOM, three, worker APIs, Math.random, Date.now, console.*
       constants.ts coords.ts    MIN_Y=-64, HEIGHT=384, SECTIONS=24, SEA=63; keys, voxel/quart index math, torus slots
-      hash.ts rng.ts seed.ts    fmix32, axis pre-mix, hash2/3/4, fnv1a32/64, hashF64, deriveSeed(world,name); xoshiro128** streams; seed text
+                                (SP3a: coords.ts holds x/y/z ↔ cx/cz/sy/lx/ly/lz, voxel and column indices, colKey, sectionKey,
+                                torus slot, quart coordinates and the window check, SP3a spec §1)
+      hash.ts rng.ts seed.ts    fmix32, axis pre-mix, hash2/3/4, fnv1a32/64, hashF64, deriveSeed(world,name); xoshiro128** streams; seed text;
+                                (SP3a) a streaming FNV-1a 64 equal to fnv1a64 over the concatenated bytes
       detMath.ts                detSin/detCos/detExp/detExp2/detErf/detSmoothstep (pinned domains; SP1 spec §1.5); the only transcendentals allowed in gen
       noise/lattice3.ts         hashed-lattice 3D gradient noise, 12 balanced edge gradients, quintic fade, no table, no period
       noise/octave.ts normal.ts cdf.ts   OctaveNoise (per-octave seed + fractional origin), NormalNoise (337/331), CDF remap
@@ -89,9 +92,13 @@ world-imaginer-voxel/          (repository root)
                                 (core cannot import gen/); graphicsPresets.ts = the §4.16 preset table as pure data (graphics + audio rows)
       stage/registry.ts hash.ts StageDef, stageHash, genKey, dirty-stage computation
     world/                      L1 (core only)
-      blocks/registry.ts states.ts shapes.ts tags.ts fluid.ts fluidRules.ts   u16 block-state ids (<= 4096 used), property
-                                model, SoA per-state tables, shape boxes; fluid byte; rules shared by settle + sim
-      store/slab.ts columnTable.ts section.ts aux.ts versions.ts api.ts padded.ts   SAB store; ColumnWriter/NeighborhoodReader
+      blocks/kinds.ts registry.ts defs.ts index.ts fluid.ts light.ts   (SP3a) u16 block-state ids (<= 4096 used): property kinds
+                                and codes, buildRegistry (ids, SoA per-state tables, keys, rotations, mirrors), the definitions, REGISTRY
+                                and its table aliases, fluid and light bytes; states.ts, shapes.ts (shape boxes), tags.ts and fluidRules.ts
+                                (rules shared by settle + sim) arrive with the SPs that need them (amended by SP3a)
+      store/pool.ts columnTable.ts section.ts aux.ts epochs.ts store.ts api.ts   (SP3a) SAB store: slab pools over growable buffers
+                                (pool.ts replaces slab.ts), the torus table (it holds the versions; no versions.ts), section descriptors,
+                                aux slots, per-scope epoch cells; ColumnWriter/ColumnView/NeighborhoodReader; padded.ts arrives in SP4
     gen/                        L1 pure (core + world/api types only)
       context.ts                GenContext per (epoch, paramsHash): noises, splines, compiled density, biome tables, templates, LRUs
       column/climate.ts shape.ts rivers.ts lakes.ts steep.ts columnPoint.ts columnStage.ts columnCache.ts surfaceEstimate.ts spawn.ts
@@ -117,8 +124,10 @@ world-imaginer-voxel/          (repository root)
     persist/kv.ts idb.ts memory.ts diffCodec.ts wiworld.ts saves.ts   L2 (IStorage adapter; MemoryKV for tests)
     metrics/*.ts                                    pure metric definitions shared by vitest and the in-app dashboard (SP1: noiseStats.ts,
                                 sp1Fixtures.ts, sp1Goldens.ts; SP2a: columnStats.ts, sp2aGoldens.ts; SP2b: biomeShares.ts,
-                                splineStats.ts, liveness.ts, crossSection.ts, also run by the workers' stats job)
-    workers/protocol.ts taskHandler.ts task.worker.ts sim.worker.ts   (taskHandler: pure message handler, SP2a)
+                                splineStats.ts, liveness.ts, crossSection.ts, also run by the workers' stats job; SP3a: region.ts
+                                (fillColumnT, genRegionInProcess, regionHash) and sp3aGoldens.ts)
+    workers/protocol.ts taskHandler.ts task.worker.ts sim.worker.ts   (taskHandler: pure message handler, SP2a; SP3a: sliceJob.ts,
+                                the slice job with its worker-local store and LRU)
     engine/                     main thread, no three
       coordinator.ts scheduler.ts rings.ts workerPool.ts throttle.ts uploadBudget.ts session.ts invalidation.ts capabilities.ts
     render/                     the only place three is imported (ui canvases are 2D; amended by SP0)
@@ -133,14 +142,16 @@ world-imaginer-voxel/          (repository root)
       sfx.ts footsteps.ts ambience.ts emitters.ts music.ts reverb.ts
     ui/map/* ui/selftest/*       (SP2a) the standalone ?map page (mounted in-game from SP4) and ?selftest=1; SP2b makes ?map the editor
     ui/common/* paramPanel/* splineEditor/* biomeTable/* presets/* crossSection/*   (SP2b) shared DOM helpers, notices and shortcuts;
-                                the parameter panel, spline drawer, biome table, presets tab and cross-section (pure models beside thin DOM)
+                                the parameter panel, spline drawer, biome table, presets tab and cross-section (pure models beside thin DOM);
+                                SP3a adds the cross-section's Voxels mode
     ui/lab/* seedBox.ts          (SP1) the ?lab=noise research page; DOM-free seed-box logic
     ui/shell.ts styles.css inspector/* sliceView.ts probe.ts mapView/*   (paramPanel, splineEditor and biomeTable became directories in SP2b)
        metricsDashboard.ts jsonEditor.ts worldsMenu.ts settingsPanel.ts palette.ts hud.ts debugOverlay.ts help.ts
     main.ts
   tools/detmath-oracle.py       (SP1) CPython port of detMath, a manual oracle for the detMath goldens
   test/ unit/ metrics/ bench/ arch/ harness/{region,refs,cache,stats,flood}.ts fixtures/ tools/ (SP2b: tools/mapLatency.ts, tools/uiSmoke.ts)
-        schema-shape.lock.json (SP1)
+        (SP3a: harness/{region,cache,png,regionWorker,fuzzWorker}.ts)
+        schema-shape.lock.json (SP1) stateIds.lock.json (SP3a)
         thresholds.ts thresholds.lock.json goldens.json baselines.json
 ```
 
@@ -163,8 +174,8 @@ The authoritative layer table (value and type-only edges, worker edges, `light`/
 `test/arch/banned.test.ts` enforces these:
 
 - In `core`, `world` and `gen`, and in the determinism files of the next rule: `Math.random`, `Date.now`, `performance.now` and `console.*` (amended by SP2b).
-- In `core/`, `gen/` and the determinism files (`DET_FILES` in `test/arch/rules/banned.ts`: `metrics/sp1Goldens.ts`, `metrics/sp1Fixtures.ts`, `metrics/sp2aGoldens.ts`, and the SP2b metrics shared by the tests, the workers and the UI, `metrics/splineStats.ts`, `metrics/biomeShares.ts`, `metrics/liveness.ts` and `metrics/crossSection.ts`): only exactly-specified `Math` members (the SP0 allowlist minus `fround`), no `**`; no `Intl`, `localeCompare`, `toLocale*`, `String.prototype.normalize`, `TextEncoder` or `TextDecoder` (amended by SP1, SP2a and SP2b).
-- In `core/noise/**`, `core/spline/**`, `metrics/**` and `gen/**`: imported value bindings are referenced only through top-level `const` aliases (vitest's transform turns them into getters; amended by SP1 and SP2a).
+- In `core/`, `gen/`, `world/blocks/**` (its ids and tables are hashed into goldens; `world/store/**` keeps only the bans of the previous rule) and the determinism files (`DET_FILES` in `test/arch/rules/banned.ts`: `metrics/sp1Goldens.ts`, `metrics/sp1Fixtures.ts`, `metrics/sp2aGoldens.ts`, the SP2b metrics shared by the tests, the workers and the UI, `metrics/splineStats.ts`, `metrics/biomeShares.ts`, `metrics/liveness.ts` and `metrics/crossSection.ts`, and the SP3a region core and goldens, `metrics/region.ts` and `metrics/sp3aGoldens.ts`): only exactly-specified `Math` members (the SP0 allowlist minus `fround`), no `**`; no `Intl`, `localeCompare`, `toLocale*`, `String.prototype.normalize`, `TextEncoder` or `TextDecoder` (amended by SP1, SP2a, SP2b and SP3a).
+- In `core/noise/**`, `core/spline/**`, `metrics/**`, `gen/**` and `world/blocks/**`: imported value bindings are referenced only through top-level `const` aliases (vitest's transform turns them into getters; amended by SP1, SP2a and SP3a).
 - Exported numeric consts anywhere in `gen/` (fixed world constants live only in `core/constants.ts`).
 - Anywhere in the repository: no `.ogg`/`.mp3`/`.wav` files (sound packs are user-supplied, D17) and no import specifier resolving outside the repository (no copy-forward imports from world-imaginer).
 
@@ -188,6 +199,7 @@ These are rewritten against new tests. Everything else is written fresh:
 - **Indices:** `cx = x>>4` and `sy = (y+64)>>4`. The voxel index inside a section is `ly<<8 | lz<<4 | lx`. Quarts are `qx = x>>2` and `qy = (y+64)>>2`, giving 96 vertical quarts.
 - **Column key:** `colKey = (cx+32768)*65536 + (cz+32768)`, a plain number below 2^32. The section key is `colKey*32 + sy`. No string keys are used anywhere.
 - **Loaded-column table:** a torus of W = 64 ≥ 2·(24+5)+1 = 59 (RD ≤ 24 plus the unload margin of 5, with slack for teleport prefetch; a power of two so `mod` is `& 63`). `slot = (cx & 63) + 64*(cz & 63)`, and each record stores cx and cz for validation.
+- **Directions and faces** (amended by SP3a): north = −z, south = +z, east = +x, west = −x, up = +y. A clockwise quarter turn seen from +y maps a horizontal offset (x, z) to (−z, x): north → east → south → west → north. A face index i ∈ 0..5 follows the `facing6` order: 0 north, 1 east, 2 south, 3 west, 4 up, 5 down; `FULL_FACES` bit i is face i and `FACE_TEX[state·6 + i]` is face i's texture.
 - **Terminology:** a *column* (also *chunk*) is one 16×16 block footprint over the full height; a *section* is 16³; a *render region* is 8×8 columns (§4.5); a *structure region* is a spacing cell (§3.13); a *harness region* is a rectangle of columns whose size each metric states (default 32×32).
 - **Rendering precision:** a floating render origin snaps to 512 blocks and rebases once the camera is more than 1024 blocks away.
 
@@ -206,20 +218,20 @@ These are rewritten against new tests. Everything else is written fresh:
 
 - **Connection-derived shapes are not stored.** Fence/pane connections and stair inner/outer corners are computed by the mesher (and collision/raycast) from neighbours, so edits never need neighbour state updates.
 - Waterlogging is not a property: it is the separate fluid byte.
-- **Append-only ids.** State ids are assigned append-only: `test/stateIds.lock.json` records every `(typeName, props) → id` ever published, and a unit test fails if an existing entry changes (new types and props only append). Each `worlds` record stores `stateTable` (the mapping at save time); load and import remap diffs through it (hotbar slots are stored by type name, §4.12); states whose type no longer exists become AIR, with a warning showing the count.
+- **Append-only ids.** State ids are assigned append-only: `test/stateIds.lock.json` records every `(typeName, props) → id` ever published, and a unit test fails if an existing entry changes (new types and props only append: new types with their full property sets append, and a locked type never gains a property or a value; a variant that needs one is a new type, and `withType` converts between them; amended by SP3a). Each `worlds` record stores `stateTable` (the mapping at save time); load and import remap diffs through it (hotbar slots are stored by type name, §4.12); states whose type no longer exists become AIR, with a warning showing the count.
 - A per-type `PLACEABLE` flag and a `category` (from `tags.ts`) drive the creative palette.
 - A test asserts at most **4096 used states** (`MAX_STATES`); per-state SoA tables are sized to it. `STATE_TYPE: Uint16Array` maps state → type; `stateOf(type, props)`, `propsOf(state)`, `withProp(state, prop, v)` and `withType(state, type)` (keeps the props both types share, defaults the rest; used by per-biome structure palettes) are pure table lookups; `rotateState(state, quarterTurns)` and `mirrorState` serve structure pieces and placement.
 
 Per-state SoA tables:
 - `OPACITY`: 0 transparent, 1 filters sky (leaves, ice, water), 15 opaque;
 - `PASS`: none / opaque / cutout / translucent;
-- `SHAPE`: cube / cross / fluid / pointed / **box model** (index into `SHAPE_BOXES`, a per-state table built at registry init by transforming the model's canonical boxes — facing north, half bottom, closed, hinge left — by the state's props; connection-derived models store one box list per variant: fence and pane 16 arm masks, stairs straight / inner-left / inner-right / outer-left / outer-right). The 11 models: slab, stairs, door, trapdoor, fence, fence gate, pane, torch, wall torch, lantern, ladder;
+- `SHAPE`: none (air; amended by SP3a) / cube / cross / fluid / pointed / **box model** (index into `SHAPE_BOXES`, a per-state table built at registry init by transforming the model's canonical boxes — facing north, half bottom, closed, hinge left — by the state's props; connection-derived models store one box list per variant: fence and pane 16 arm masks, stairs straight / inner-left / inner-right / outer-left / outer-right). The 11 models: slab, stairs, door, trapdoor, fence, fence gate, pane, torch, wall torch, lantern, ladder;
 - `FULL_FACES` (6-bit mask of faces that fully occlude a neighbour; drives face culling and light blocking for partial shapes). For connection-derived models it is the intersection over all derived variants (stairs: only the full half face, i.e. down for half=bottom and up for half=top; fences, panes and fence gates: 0), so culling never depends on a neighbour's neighbours;
 - `EMIT` (0-15), `CARVABLE`, `REPLACEABLE`;
 - `COLLIDE`: none / cube / boxes (`boxes` uses `SHAPE_BOXES`, except that fence and closed fence-gate posts extend to 1.5 blocks; torches, wall torches, lanterns, cross, pointed, ladders and open fence gates are none);
 - `FLUID_MODE` (shared by settle, the sim and the fluid mesher): `block` (fluid never enters: full solids, double slabs, doors), `hold` (keeps its state and takes the fluid byte: kelp, seagrass, leaves, slabs, stairs, fences, fence gates, panes, trapdoors, ladders), `displace` (flow replaces it with AIR plus fluid: torches, lanterns, plants, snow layers);
 - `TINT`: none / grass / foliage / water / fixed;
-- `SOUND`: sound group (stone, dirt, grass, sand, gravel, wood, snow, glass, leaves, metal, abyss) used by `audio`/`sound`.
+- `SOUND`: sound group (none, stone, dirt, grass, sand, gravel, wood, snow, glass, leaves, metal, abyss) used by `audio`/`sound`; none is air's and is never played (amended by SP3a).
 
 `FACE_TEX` is a `Uint16Array(MAX_STATES*6)` of base texture-array layers. This splits 09's overloaded `solid/transparent` into render pass, light opacity, face culling (opaque full faces only) and collision:
 - water: pass translucent, opacity 1, no collision;
@@ -228,6 +240,14 @@ Per-state SoA tables:
 - slabs/stairs: opaque pass, OPACITY 0, culling via `FULL_FACES`. **Light never crosses a face that is set in `FULL_FACES`** of the voxel it leaves or of the voxel it enters — in the initial BFS, the straight-down sky fall, incremental relight and the L1/L3 reference BFS. The sky fall enters a voxel unless its up face is full and stops below a voxel whose down face is full; `LIGHT_BLOCKING` is defined the same way. `slabType=double` is a plain full cube (SHAPE cube, OPACITY 15, FULL_FACES 63).
 - **Until SP8a** box-model states use SHAPE cube and FULL_FACES 63, and `COLLIDE: boxes` falls back to cube; OPACITY and `COLLIDE: none` (torches, ladders, …) already have their final values.
 
+**Encoding details** (amended by SP3a; SP3a spec §2.1-2.3, frozen from SP3a):
+- **Property kinds and values**, in kind order: `axis` (x, y, z), `facing4` (north, east, south, west), `facing6` (north, east, south, west, up, down), `half` (bottom, top), `open` (false, true), `hinge` (left, right), `slabType` (bottom, top, double). A property's code is its value's 0-based index.
+- **Enum codes:** every enum table stores the 0-based index of its value in the order written above: `PASS` none 0, opaque 1, cutout 2, translucent 3; `SHAPE` none 0, cube 1, cross 2, fluid 3, pointed 4, box 5; `COLLIDE` none 0, cube 1, boxes 2; `FLUID_MODE` block 0, hold 1, displace 2; `TINT` none 0, grass 1, foliage 2, water 3, fixed 4; `SOUND` none 0, stone 1 … abyss 11.
+- **Id order:** type and state ids start at 0 in definition order; a type's states are contiguous with the default first. With the property combinations numbered in mixed radix (properties in declaration order, values in kind order, the last property fastest), combination k of a type whose default is d takes id `base + (k = d ? 0 : k < d ? k + 1 : k)`, and `DEFAULT_STATE[type] = base`.
+- **Canonical key:** the bare type name for a type without properties; otherwise `name[p1=v1,p2=v2,…]` with every property in declaration order, defaults included, no spaces, each value spelled as its kind value name. Keys are ASCII and unique, and `parseStateKey(stateKey(s)) = s`; the lock and `stateTable` use them.
+- **`withType(state, type)`** keeps a property only when the target declares one with the same name and kind; every other property takes the target's default. **`rotateState(state, q)`** turns clockwise seen from +y by ((q mod 4) + 4) mod 4 quarter turns: horizontal `facing4`/`facing6` values step north → east → south → west, up and down stay, `axis` swaps x ↔ z on odd turns. **`mirrorState(state, 'x' | 'z')`** negates that axis (x: east ↔ west; z: north ↔ south), keeps up and down and flips `hinge`. `half`, `open` and `slabType` never change under either.
+- **The table set only grows:** later SPs add block types, the per-state values of new states and new tables (`PLACEABLE` and `category` in SP5, `SHAPE_BOXES` in SP8a); an existing table never changes its encoding.
+
 **Fluid byte (u8).**
 
 | bits | meaning |
@@ -244,10 +264,10 @@ A pure fluid voxel is AIR plus a fluid byte. Waterlogging comes free: a state wh
 
 ### 2.3 SharedArrayBuffer store (`world/store`)
 
-**Slabs.** Two slab pools share one allocator implementation parameterised by slot size: the **block pool** (1 MiB pages of 128 slots × 8 KiB, one u16 per voxel) and the **byte pool** (1 MiB pages of 256 slots × 4 KiB, for light, fluid and the two aux slots). A slot id is `page<<8|slot` within its pool.
-- Allocation uses an Int32 free stack per pool in a SAB, guarded by a CAS spinlock whose critical section is about 10 instructions. Workers allocate and free slots themselves.
-- Only the main thread grows pages. It keeps at least 15% headroom and broadcasts new pages.
-- A per-slot `Int32Array` refcount (Atomics) lets proto and final section sets share unmodified slots.
+**Slabs.** Two slab pools share one allocator implementation parameterised by slot size: the **block pool** (8 KiB slots, one u16 per voxel) and the **byte pool** (4 KiB slots, for light, fluid and the two aux slots). Each pool's slots live in **one growable buffer** (amended by SP3a): a `SharedArrayBuffer` created with `maxByteLength` (default 768 MiB for blocks, 512 MiB for bytes: reserved address space, not committed memory), or, with the same code, a resizable `ArrayBuffer`. A slot id is the slot's index in its pool.
+- Allocation uses an Int32 free stack per pool in a growable buffer, guarded by a CAS spinlock whose critical section is about 10 instructions. Workers allocate and free slots themselves.
+- Whichever thread finds the free stack empty grows its pool by 1 MiB (128 block or 256 byte slots) inside the same lock; length-tracking views see the growth in every thread, so there is no page broadcast (amended by SP3a). A pool at its maximum throws `StoreFull`.
+- A per-slot `Int32Array` refcount (Atomics) lets proto and final section sets share unmodified slots. Every non-negative descriptor entry and every allocated aux slot holds one reference; one free per reference.
 
 **Final section descriptor**, 4 × int32 per section:
 
@@ -255,8 +275,10 @@ A pure fluid voxel is AIR plus a fluid byte. Waterlogging comes free: a state wh
 |---|---|
 | blocks | block-pool slot ≥ 0, or `-1-uniformStateId` |
 | light | slot, or `-1-uniformByte` (all 0 in sealed rock and dark caves, all 0xF0 in open sky) |
-| fluid | slot, or -1 for none |
-| meta | nonAir 13 bits, flags 4 (hasOpaque, hasCutout, hasTranslucent, hasFluid), face-to-face connectivity 15 bits |
+| fluid | slot, or `-1-uniformByte`; -1 is "no fluid" (byte 0), so a full water section of an ocean costs no slot (amended by SP3a) |
+| meta | bits 0-12 nonAir (0-4096), 13 hasOpaque, 14 hasCutout, 15 hasTranslucent (any voxel whose `PASS` is that pass), 16 hasFluid (any fluid type ≠ 0), 17-31 face-to-face connectivity (0 until SP4) (amended by SP3a) |
+
+Each channel is stored on its own: uniform when every value of that channel is equal (no slot), dense otherwise; rewriting a descriptor releases what it held. Unwritten descriptors are −1 (uniform air, light byte 0, no fluid). The connectivity bits and `padded.ts` are SP4's (amended by SP3a).
 
 **Proto section descriptor**, 2 × int32: blocks and fluid. This is the pre-decoration state (terrain, aquifer, surface rules, carvers). It is immutable once T finishes.
 
@@ -269,6 +291,7 @@ A pure fluid voxel is AIR plus a fluid byte. Waterlogging comes free: a state wh
 | 6 | protoFlags (alive, pinnedByTuning) |
 | 7-8 | auxSlotA, auxSlotB |
 | 9-10 | unsettledCount, diffFlag |
+| 11 | `claimed` (Atomics: 0 free, 1 held; claiming a held record throws `SlotBusy`, and a read of a record that holds another column returns absent; amended by SP3a) |
 | 16-111 | final descriptors |
 | 112-159 | proto descriptors |
 
@@ -278,9 +301,11 @@ A pure fluid voxel is AIR plus a fluid byte. Waterlogging comes free: a state wh
 - `surfaceBiome` Uint8[256], taken after the Voronoi zoom;
 - `tintTH` Uint8[3·256]: T, H and an override per block.
 
-**Aux slot B:** `caveBiomeQ` Uint8[4·96·4 = 1536] and `surfaceBiomeQ` Uint8[16].
+Byte offsets (amended by SP3a): `WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WORLD_SURFACE` 1024, `MOTION_BLOCKING` 1536, `OCEAN_FLOOR` 2048, `LIGHT_BLOCKING` 2560, `surfaceBiome` 3072, `tintTH` 3328; per-position arrays use the column index `lz·16 + lx`, and Int16 values are little-endian. A heightmap value is the absolute y of the highest qualifying voxel plus one, −64 when none qualifies: `WORLD_SURFACE_WG` and `WORLD_SURFACE` count a state ≠ air or a fluid type ≠ 0; `OCEAN_FLOOR_WG` and `OCEAN_FLOOR` count `COLLIDE` ≠ none (the fluid byte is ignored); `MOTION_BLOCKING` counts `COLLIDE` ≠ none or a fluid type ≠ 0; `LIGHT_BLOCKING` follows the §2.2 light rule, pinned by SP4.
+
+**Aux slot B:** `caveBiomeQ` Uint8[4·96·4 = 1536] at 0 and `surfaceBiomeQ` Uint8[16] at 1536 (offsets amended by SP3a). Both aux slots are zero-filled when allocated (a recycled slot included), so a field no stage has written reads 0.
 
-**Epoch cell.** A SAB `Int32Array` epoch cell per scope is checked by workers between phases, so a job can abort mid-run.
+**Epoch cell.** A SAB `Int32Array` epoch cell per scope is checked by workers between phases, so a job can abort mid-run. SP3a builds the per-scope cells (terrain 0, decorate 1, light 2, mesh 3); SP4 wires them in place of SP2b's pool-wide cell (amended by SP3a).
 
 ### 2.4 ColumnSample (worker-local LRU of 1024, not in the SAB)
 
@@ -295,7 +320,7 @@ A pure fluid voxel is AIR plus a fluid byte. Waterlogging comes free: a state wh
 ```ts
 type Seed64 = readonly [lo: number, hi: number];   // u32 words, value = hi·2^32 + lo, normalised with >>> 0 (SP1); Hash64 alike
 type RegenScope = 'live' | 'remesh' | 'decorate' | 'terrain' | 'climate';
-type SubProjectId = 'SP0'|'SP1'|'SP2a'|'SP2b'|'SP3'|'SP4'|'SP5'|'SP6'|'SP7'|'SP8a'|'SP8b'|'SP8c'|'SP9'|'SP10'|'SP11'|'SP12';
+type SubProjectId = 'SP0'|'SP1'|'SP2a'|'SP2b'|'SP3a'|'SP3b'|'SP3c'|'SP4'|'SP5'|'SP6'|'SP7'|'SP8a'|'SP8b'|'SP8c'|'SP9'|'SP10'|'SP11'|'SP12';
 type StageId = 'climate'|'shape'|'surfaceEst'|'biome2d'|'terrain'|'decorate'|'light'|'mesh'|'lod'|'map';
 interface ParamMeta { path: string; label: string; doc: string; unit?: string;
   kind: 'number'|'int'|'bool'|'enum'|'noise'|'spline'|'expr'|'boxTable'|'ruleTree'|'featureList'|'structureSets';
@@ -326,8 +351,16 @@ type Expr =                                  // 3D density composition (preset d
   | { op:'ref'; id:string };
 interface CompiledDensity { cornerFn(ctx, x:number, y:number, z:number): number; voxelFn(ctx, i:number, interp:Float64Array): number;
   boundsCell(ctx, cellX:number, cellY:number, cellZ:number): [number, number]; point(x:number, y:number, z:number, tap?:string): number; }
-interface ColumnWriter { setProto(sy:number, blocks:Uint16Array, fluid:Uint8Array): void; setFinal(...): void; aux(): AuxView }
-interface NeighborhoodReader { proto(dx:number, dz:number): ColumnView; final(dx:number, dz:number): ColumnView; versions(): Int32Array }
+// From store.claimColumn(cx, cz, epoch) (amended by SP3a; SP3a spec §3.5). Each setter copies its 4096-entry arrays.
+interface ColumnWriter { setProto(sy:number, blocks:Uint16Array, fluid:Uint8Array): void;
+  setFinal(sy:number, blocks:Uint16Array, light:Uint8Array, fluid:Uint8Array): void;
+  shareFinal(sy:number, light:Uint8Array): void /* final blocks and fluid share the proto slots */;
+  aux(): AuxView; auxB(): AuxBView; commit(status: 1|2|3): void /* blockVersion += 1, then status last */ }
+interface ColumnView { block(lx:number, y:number, lz:number): number; fluid(lx:number, y:number, lz:number): number;
+  light(lx:number, y:number, lz:number): number; sectionBlocks(sy:number): Uint16Array|number; sectionFluid(sy:number): Uint8Array|number;
+  aux(): AuxView | null }
+interface NeighborhoodReader { proto(dx:number, dz:number): ColumnView | null; final(dx:number, dz:number): ColumnView | null;
+  versions(): Int32Array /* 3x3 in (dz, dx) order, blockVersion then lightVersion, -1 when absent */ }
 interface SectionMesh { secKey:number; pass:0|1|2; quads:number; position:Uint8Array /*Uint8x4*/; data:Uint32Array; index:Uint32Array;
   bounds:[number,number,number,number] /*sphere*/; seq:number; versions:Int32Array /*3x3 block+light*/;
   emitters?: Float32Array /* audio candidates: kind, x, y, z, strength (§4.18) */ }
@@ -554,7 +587,7 @@ final     = max( min( min(terrain + detail, max(caves, lakeRoof)), 16·noodle ),
 
 ### 3.7 surfaceEstimate and surfaceWaterLevel (shared by map, LOD, aquifer, structures, spawn and teleport)
 
-SP2a uses the 2D estimate `surfaceEst = offset` (after rivers and lakes); SP3 introduces the density-tap search below and bumps the `surfaceEst` stage version.
+SP2a uses the 2D estimate `surfaceEst = offset` (after rivers and lakes); SP3b introduces the density-tap search below and bumps the `surfaceEst` stage version (SP3a keeps the 2D estimate; amended by SP3a).
 
 
 - **surfaceEstimate(x,z):** start at `col.offset`, step ±8 blocks evaluating the `terrain` tap at the point, then bisect 4 times. That is about 6-10 point evaluations, ≈ 8 µs.
@@ -805,7 +838,7 @@ The built-in presets are the `PROFILES` entries of `core/params/profiles.ts` (SP
 Proof suite (DT1/DT2):
 - shuffled vs spiral order, 1 vs 4 `worker_threads`, cold vs warm cache, two runs, and goldens;
 - compiled vs reference bit-exact; probe == bulk; batch == point;
-- a browser self-test page (`?selftest=1`), built in SP2a and extended by every later SP with its stage, that recomputes golden hashes (column stage and map tiles from SP2a, proto regions from SP3, …) in a real module worker, run at every SP exit from SP2a on.
+- a browser self-test page (`?selftest=1`), built in SP2a and extended by every later SP with its stage, that recomputes golden hashes (column stage and map tiles from SP2a, proto regions from SP3a, …) in a real module worker, run at every SP exit from SP2a on.
 
 ## 4. Engine
 
@@ -1247,7 +1280,8 @@ WASD; Space (up/jump); Shift (down/sneak); Ctrl (sprint); F (walk/fly); M (map);
 
 **Harness** (`test/harness/region.ts`): `genRegion({seed, params, cx0, cz0, w, h, upTo:'T'|'D'|'L'|'MESH', order:'spiral'|'shuffled', threads?:1|4, debugTags?})`.
 - It runs the **real stage functions and coordinator prerequisite rules** in-process, on a real SAB store (or a plain ArrayBuffer), with `worker_threads` for the thread matrix.
-- It returns a stitched `RegionView` (block, fluid, light, fields, biome, tags) plus per-stage timings.
+- It returns a `RegionView` (block, fluid, light, fields, biome, tags) plus per-stage timings. The view reads through the store per column and is never stitched into one array (a 32 × 32 region would be about 300 MB; amended by SP3a).
+- SP3a's `genRegion` has `upTo: 'T'` only, plus `cache?` and `shuffleSeed?`, and no coordinator prerequisite rules until SP4 (amended by SP3a).
 
 **References** (`refs.ts`):
 - global reference light BFS;
@@ -1255,7 +1289,7 @@ WASD; Space (up/jump); Shift (down/sneak); Ctrl (sprint); F (walk/fly); M (map);
 - flood from sky and connected components;
 - a raycast visibility reference for cave culling.
 
-**Region cache** (`cache.ts`): binary dumps keyed by `genKey + region + upTo`, plus `stageHash('mesh')` when upTo is 'MESH' in `test/.cache`.
+**Region cache** (`cache.ts`): binary dumps keyed by `genKey + srcKey + REGION_CACHE_FORMAT + region + upTo`, plus `stageHash('mesh')` when upTo is 'MESH', in `test/.cache/regions`. `srcKey` hashes the generator sources and the format version is bumped when the dump layout changes, because `genKey` does not track code changes made without a stage bump (amended by SP3a).
 
 **Suites:**
 
@@ -1548,7 +1582,7 @@ High adds MSAA, a shadow cascade (about 2 ms), LOD 1 km and RD16 (dGPU target).
 
 1. **COOP/COEP needed for the SAB.**
    - Mitigation: headers in vite.config for dev and preview; Docker runs vite; `vercel.json` sets the same headers on Vercel (D11); a startup `crossOriginIsolated` check with an error screen; packs load from local files only; no cross-origin subresources anywhere (COEP `require-corp`). Isolation also requires a **secure context**: dev, preview and Docker must be opened via `http://localhost:<port>` (or 127.0.0.1) or over HTTPS, and a reverse proxy in front of the container must terminate TLS and pass COOP/COEP through unchanged. When `isSecureContext` is false, the error screen names this cause. Every worker script response (Vite dev `?worker_file` modules, `/node_modules/.vite/deps/*`, built `assets/*.js`) must carry the headers too.
-   - Kill: if SP3/SP4 shows an unfixable isolation or concurrency problem, switch to transferable snapshots. gen/light/mesh already run on plain ArrayBuffers in the harness, so only `store` and the transport change.
+   - Kill: if SP3a-SP4 shows an unfixable isolation or concurrency problem, switch to transferable snapshots. gen/light/mesh already run on plain ArrayBuffers in the harness, so only `store` and the transport change.
 2. **BatchedMesh with custom GLSL3 and an integer `data` attribute.**
    - Mitigation: an SP4 week-1 spike (stress test at Medium scale: ≈ 3.5k section instances, ≈ 0.75 M quads; remesh churn; `optimize`); pin three to `~0.186.1`; `WEBGL_multi_draw` detection; RegionMesh fallback behind the `SectionRenderer` interface.
 3. **T cost of the full cave family in JS, plus DAG closures.**
@@ -1606,11 +1640,11 @@ Each sub-project runs its own cycle:
 
 Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Sizes: S ≈ 2-4 days, M ≈ 1-2 weeks, L ≈ 2-3 weeks of focused work.
 
-**Cut lines.** Every SP names a cut line: what may slip if it overruns. A slipped item moves to a named receiving SP by amending this section, and the receiving SP adds it to its exit. Default receivers: SP0 Vercel preview check → SP4; SP2b share preview and cross-section → SP10 (both delivered in SP2b, so nothing moved); SP3 inspector pins → SP10; SP5 worlds-menu polish and palette search → SP10; SP7 vertex waves → SP11; SP8a animation frames → SP11; SP8a fence gates and trapdoors → SP12; SP8b giant trees, boulders and fossils → SP12; SP8c HRTF → SP11; SP9 jungle temple and village depth > 4 → SP12; SP11 Ultra shadows, 3D clouds and Fabulous water → SP12; SP6 underground-only carver and spaghetti-2D rarity bands → SP12; SP7 extra lava reactions → SP12; SP10 seed sweep and column-status heatmap → SP12. SP12's exit requires no open cut-line items, unless the user explicitly dropped one and the impact on its D-decision is recorded.
+**Cut lines.** Every SP names a cut line: what may slip if it overruns. A slipped item moves to a named receiving SP by amending this section, and the receiving SP adds it to its exit. Default receivers: SP0 Vercel preview check → SP4; SP2b share preview and cross-section → SP10 (both delivered in SP2b, so nothing moved); SP3c inspector pins → SP10; SP5 worlds-menu polish and palette search → SP10; SP7 vertex waves → SP11; SP8a animation frames → SP11; SP8a fence gates and trapdoors → SP12; SP8b giant trees, boulders and fossils → SP12; SP8c HRTF → SP11; SP9 jungle temple and village depth > 4 → SP12; SP11 Ultra shadows, 3D clouds and Fabulous water → SP12; SP6 underground-only carver and spaghetti-2D rarity bands → SP12; SP7 extra lava reactions → SP12; SP10 seed sweep and column-status heatmap → SP12. SP12's exit requires no open cut-line items, unless the user explicitly dropped one and the impact on its D-decision is recorded.
 
 **SP0 — Scaffold and guardrails** (S; no dependencies)
 - Repository scaffold at the root: Vite, TS strict, three `~0.186.1`, vitest projects (unit / arch / metrics-fast / metrics-quick / metrics-full / bench; see the SP0 spec).
-- Headers exactly `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, set in vite.config `server.headers` and `preview.headers` and in `vercel.json` with `source: "/(.*)"`. Dockerfile and the repository's own `docker-compose.yml` (service `world-imaginer-voxel`, port 5183, default compose network); README and CLAUDE.md updated with the real commands; GitHub Actions CI (`.github/workflows/ci.yml`: `npm ci`, `npm run build`, `npm test`, `npm run test:metrics`, on push and PR; the region-cache step for `npm run test:metrics` arrives in SP3, when the region cache exists).
+- Headers exactly `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, set in vite.config `server.headers` and `preview.headers` and in `vercel.json` with `source: "/(.*)"`. Dockerfile and the repository's own `docker-compose.yml` (service `world-imaginer-voxel`, port 5183, default compose network); README and CLAUDE.md updated with the real commands; GitHub Actions CI (`.github/workflows/ci.yml`: `npm ci`, `npm run build`, `npm test`, `npm run test:metrics`, on push and PR; the region-cache step for `npm run test:metrics` arrives in SP3b, caching `test/.cache/regions` only; amended by SP3a).
 - Arch tests (imports, banned APIs, no numeric tunables in `gen/`, no audio assets, no imports outside the project); thresholds-lock (with `activeFrom`) and goldens commands.
 - Capability probe: `isSecureContext`, `crossOriginIsolated` in the page **and in a module worker** sharing one SAB, `WEBGL_multi_draw`, timer query, max texture layers, WebGL renderer string; an error screen that names the missing condition.
 - CSS-grid shell and HUD.
@@ -1625,7 +1659,7 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 - **Cut line:** the lab's A/B mode (→ SP10).
 
 **SP2a — Column stage, worker pool and map** (L; SP1). Spec: `2026-09-28-sp2a-column-stage-map-design.md` (the 2026-09-28 split of the former SP2).
-- Climate with warps and CDF, PV fold; offset / σ / jag splines in blocks; steep from the halo; rivers (channel, valley, gorges) and lakes (column terms); a 2D `surfaceEst = offset` (SP3 replaces it); surface biome registry, picker and zoom; spawn search; ColumnSample LRU; point reference `columnPoint` and batched `buildColumnSample`, bit-exact at quart corners.
+- Climate with warps and CDF, PV fold; offset / σ / jag splines in blocks; steep from the halo; rivers (channel, valley, gorges) and lakes (column terms); a 2D `surfaceEst = offset` (SP3b replaces it); surface biome registry, picker and zoom; spawn search; ColumnSample LRU; point reference `columnPoint` and batched `buildColumnSample`, bit-exact at quart corners.
 - Task pool and protocol (`MAP_TILE`, `point`, `selftest`); the standalone `?map` page (coarse-first tiles; biome, relief, rivers, lakes, raw fields and offset/σ/jag layers; hover; spawn marker; click shows a coordinate); seed box, ready-profile select and a JSON patch box over `WorldSession`, in the URL hash.
 - `?selftest=1` page: recomputes column-stage and map-tile golden hashes in a real module worker.
 - **Deliverable:** an interactive world map of the default and large_biomes worlds, parameterised by URL patch.
@@ -1638,21 +1672,39 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 - **Deliverable:** the SP2a map updates live while splines and biome boxes are edited; a 1-10 biome-size slider drives `climate.scaleMul = 4^((v − 5)/5)` (5 = default, 10 = large_biomes; user request 2026-09-29).
 - **Exit:** U2 for column-scope params; spline-edit map preview ≤ 300 ms; preset unit tests; the SP1 deferred minors reachable through the editor (spline knot/tangent bounds, tiny amplitudes).
 - Received from SP2a (amended by SP2b): the raw W/T/H/R layers and the grid overlay exist; the spawn fallback refinement is closed as not needed (N4 spawnOnLand is 100 % over 64 seeds with the SP2a fallback).
-- Handed on (SP2b spec Appendix A): SP2a minors 5 and 6 → SP3; the `?lab=noise` minors → SP10.
+- Handed on (SP2b spec Appendix A): SP2a minors 5 and 6 → SP3 (SP3b after the split); the `?lab=noise` minors → SP10.
 - **Cut line:** the biome share preview and the cross-section profile (→ SP10). Both were delivered in SP2b, so nothing moved to SP10.
 
-**SP3 — Voxel store, block states, density DAG, surface rules, harness** (L; SP2b)
-- SAB store (two slab pools, CAS free stacks, refcounts, torus table, aux). **The u16 block-state encoding, the fluid byte and the light byte are frozen here, together with the property model, the registry API and the append-only id rule (§2.2).** Frozen means the encoding, the property kinds and the API; later SPs still add block types, SoA columns and per-state values (the block list grows in SP6, SP8a, SP8b and SP9).
-- Density: Expr, closure compiler with stage placement, reference interpreter, interval bounds with early-outs, probe; the default terrain expression without caves; the `islands` DAG term (−1e6 by default) and draft `floating_islands`, `amplified` and `archipelago` presets (terms, splines and params; surface-rule branch for islands), so per-preset goldens and SP11's LOD island scan have a target.
+SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a spec's Decisions): the context review sized it at 9-12 weeks, three to four times an "L". SP4 and SP6 depend on SP3b; SP3c can run alongside SP4.
+
+**SP3a — Block registry, voxel store and region harness** (M; SP2b). Spec: `2026-10-02-sp3a-blocks-store-harness-design.md`.
+- SAB store (two slab pools over growable buffers, CAS free stacks, refcounts, torus table, section descriptors, aux, per-scope epoch cells), on a SharedArrayBuffer or a plain ArrayBuffer; the block registry with air, stone and bedrock and `test/stateIds.lock.json`. **The u16 block-state encoding, the fluid byte and the light byte are frozen here, together with the property model, the registry API and the append-only id rule (§2.2).** Frozen means the encoding, the property kinds and the API; later SPs still add block types, SoA columns and per-state values (the block list grows in SP6, SP8a, SP8b and SP9).
+- A provisional T stage that fills columns from the 2D world (bedrock, stone, water up to surfaceWaterLevel, air) through the store API.
+- Harness `genRegion` (orders, 1 or 4 threads, region cache keyed by genKey + srcKey + format, PNG slices); the slice job and a Voxels mode in the `?map` cut-line cross-section; `?selftest=1` extended to proto region hashes (`sp3a.*`).
+- **Deliverable:** real voxels: the vertical slice of the provisional terrain under the cut line, and the harness PNG slices.
+- **Exit:** DT1 on the provisional T; M1 (registry parts); slab fuzz extended to promotion, sharing and the torus (4 threads × 100k ops, both pools, growth; 0 double allocations, 0 lost slots, exact refcounts); `?selftest=1` with the sp3a region hashes.
+- **Cut line:** none named by the SP3a spec.
+
+**SP3b — Density, surfaceEstimate, terrain and surface rules** (L; SP3a)
+- Density: Expr, closure compiler with stage placement, reference interpreter, interval bounds with early-outs, probe; the default terrain expression without caves, with the `islands` DAG term (−1e6 by default).
 - surfaceEstimate by bisection (replaces the 2D relief on the map).
 - Surface-rule data tree, compiler and whole-column scan (bedrock, deepslate, palettes, snowline, cliffs).
-- v0 water fill so oceans, rivers and lakes are visible early (air at y ≤ surfaceWaterLevel above surfaceEst − 12 becomes water sources; everything else stays dry).
-- Harness `genRegion` (orders, threads, cache by genKey, PNG slices); in-app slice viewer and density node inspector; `?selftest=1` extended to proto region hashes.
+- The real T stage with the general v0 water fill so oceans, rivers and lakes are visible early (air at y ≤ surfaceWaterLevel above surfaceEst − 12 becomes water sources; everything else stays dry; SP3a's provisional T is its no-overhang case); it writes aux B and bumps the `terrain` stage and `GENERATOR_VERSION`; the terrain palette appends to the registry and the lock.
+- The CI `actions/cache` step for `test/.cache/regions` before `npm run test:metrics` (moved from SP3a, whose provisional T regenerates a 32 × 32 region in about a second).
+- **Deliverable:** voxel terrain from the density DAG with surface rules and water, in the harness slices and the Voxels mode.
+- **Exit:** DT1 on the real T, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 on voxel terrain (true top from WORLD_SURFACE_WG), T4, T5; B4 (voxel parts: snow in desert, coast-band beach/stony shore/snowy beach share, land-biome tops below sea level outside rivers and lakes); S1 (buried surface blocks and y mod 16 parts), S2, S3 (snowline part); P1 bench: T without caves ≤ 4 ms p50.
+- Received from SP3a (its spec §10): T3's redefinition before it gates and T1's lowland band; the cost of the biome height filter on the real `surfaceEst` (column stage, map and share preview); the Expr ops' exact semantics and interval rules; an `sp3b.registry` golden over the appended states; SP2a minors 5 and 6 (handed to SP3 by SP2b); the ocean-floor σ/jag stripe, lake-rim islets and the shoreline zoom fringe.
+- **Cut line:** set by the SP3b spec.
+
+**SP3c — Draft presets, inspector and slice viewer** (M; SP3b)
+- Draft `floating_islands`, `amplified` and `archipelago` presets (terms, splines and params; surface-rule branch for islands), so per-preset goldens and SP11's LOD island scan have a target; their profiles become selectable (`readyFrom: 'SP3c'`).
+- In-app slice viewer and density node inspector.
 - **Deliverable:** live terrain cross-sections and the node inspector.
-- **Exit:** DT1, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 on voxel terrain (true top from WORLD_SURFACE_WG), T4, T5; B4 (voxel parts: snow in desert, coast-band beach/stony shore/snowy beach share, land-biome tops below sea level outside rivers and lakes); S1 (buried surface blocks and y mod 16 parts), S2, S3 (snowline part); M1 (registry parts); slab fuzz (4 threads × 100k alloc/free, 0 double allocations, both pools); P1 bench: T without caves ≤ 4 ms p50.
+- Received from SP3a (its spec §10): archipelago (≈ 60 % ocean) against B1's 45 % ocean-family cap (decide per-preset gating); amplified's offset multiplier and the 320 range.
+- **Exit:** set by the SP3c spec.
 - **Cut line:** inspector pins (→ SP10).
 
-**SP4 — Streaming renderer and light** (L; SP3)
+**SP4 — Streaming renderer and light** (L; SP3b)
 - **Week-1 spike:** RegionBatch with a Uint8x4 `position` plus a uint32 `data` attribute in a custom GLSL3 ShaderMaterial with batching chunks, precomputed spheres, `setGeometryAt` churn, per-region `optimize`, and the multi_draw fallback to RegionMesh, stressed at Medium scale.
 - Coordinator (statuses, rings, heap, epochs, versions, meshSeq, cancellation, unload hysteresis, adaptive throttle, upload budget); D-stage skeleton (pull-model infrastructure, zero features, proto retention); exact light job (FULL_FACES-aware); padded greedy mesher with `PACK_LAYOUT` and connectivity bits; still-water surface mesher.
 - Materials v1 (opaque / cutout / translucent passes; face shade × AO × smooth light × lightmap; spherical fog; Fast water); placeholder flat-colour DataArrayTexture; sky dome with sun; elevation-based day/night.
@@ -1670,7 +1722,7 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 - **Exit:** L3 (including shafts); E1-E7 (including the fault-injected flush and the unload/reload race); G2 (edit part: edit → visible p95 ≤ 50 ms); relight ≤ 3 ms p95; physics and palette unit tests.
 - **Cut line:** worlds-menu polish (rename, duplicate, thumbnails) and palette search (→ SP10).
 
-**SP6 — Caves, carvers and cave biomes** (L; SP3, SP5 for in-game review)
+**SP6 — Caves, carvers and cave biomes** (L; SP3b, SP5 for in-game review)
 - Cave family terms in the default DAG (cheese / layer / pillars, spaghetti 2D and 3D with rarity, noodle, entrances, roughness, cheese roof term, lake roof); worm and canyon carvers (detMath, LRU); 3D quart cave-biome picker (lush, dripstone, **abyss**) with cave floor and ceiling surface rules; the abyss surface-palette blocks (decided in this SP's spec); debug cave-type tag channel, cave-type tint in the slice viewer, map cave slice and cave-biome layers; `cave_heavy` preset; cave culling.
 - **Deliverable:** explorable caves with visible surface entrances and ravines.
 - **Exit:** C1-C6, B3, R3; re-asserted with caves: L2, S1 (grass at sky 0), DT1, DT2 (probe == bulk); P1: T ≤ 10 ms p50; DAG closure overhead vs a hand-inlined default expression measured and recorded (codegen kill criterion, §7).
@@ -1723,17 +1775,17 @@ Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Si
 
 **SP12 — Extreme presets and final tuning** (M; SP11)
 - Finalise amplified, archipelago, floating_islands, large_biomes and cave_heavy; goldens per preset; profile gallery in docs; baselines refreshed; README; received cut-line items.
-- A "continental" profile (user request, 2026-09-29): large continents with islands in open ocean, via a much longer C wavelength (about 8000) and deep-ocean-dominated low C; it may move to SP3 by amending this section. With it (user request, 2026-09-30): small islands or archipelagos at extremely low C, with no rivers on islets.
+- A "continental" profile (user request, 2026-09-29): large continents with islands in open ocean, via a much longer C wavelength (about 8000) and deep-ocean-dominated low C; it may move to SP3b or SP3c by amending this section. With it (user request, 2026-09-30): small islands or archipelagos at extremely low C, with no rivers on islets.
 - The volcanic cone (reserved by SP2a, its spec §10): sparse cells in hot high ground add a cone and crater to `offset` and assign the volcano biome by mask; lava in the crater uses SP7's fluids. It may move to an earlier SP by amending this section.
 - **Exit:** Z1-Z4; cave_heavy C1 10-22 %; every other active metric green per preset; DT1 goldens stable; no open cut-line items (unless explicitly dropped by the user with the D-decision impact recorded).
 
 ### Critical path and parallelism
 
-Critical path: SP0 → SP1 → SP2a → SP2b → SP3 → SP4 → SP5 → SP6 → SP7 → SP8b → SP9 → SP10 → SP11 → SP12.
+Critical path: SP0 → SP1 → SP2a → SP2b → SP3a → SP3b → SP4 → SP5 → SP6 → SP7 → SP8b → SP9 → SP10 → SP11 → SP12.
 
-In parallel: SP8a's texture parts after SP4 (alongside SP5-SP7; its shape collision/raycast parts after SP5); SP8c after SP7 (alongside SP8a/SP8b); the persistence codec and `.wiworld` format after SP3; the LOD and cloud parts of SP11 after SP4.
+In parallel: SP8a's texture parts after SP4 (alongside SP5-SP7; its shape collision/raycast parts after SP5); SP8c after SP7 (alongside SP8a/SP8b); the persistence codec and `.wiworld` format after SP3a; SP3c alongside SP4; the LOD and cloud parts of SP11 after SP4.
 
-Visible value in every SP: a map in SP2a (edited live in SP2b), slices in SP3, flight in SP4, editing in SP5, caves in SP6, water in SP7. The riskiest integrations sit early: the SAB store and the u16 state format in SP3, BatchedMesh in SP4 week 1, and fluid byte → light → mesh → edit → diff → IDB → reload in SP3-SP5.
+Visible value in every SP: a map in SP2a (edited live in SP2b), voxel slices in SP3a, terrain in SP3b, flight in SP4, editing in SP5, caves in SP6, water in SP7. The riskiest integrations sit early: the SAB store and the u16 state format in SP3a, BatchedMesh in SP4 week 1, and fluid byte → light → mesh → edit → diff → IDB → reload in SP3a-SP5.
 
 ## 11. Relationship with world-imaginer
 
````

Modify `docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md b/docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md
index 23cb0c1..222da4e 100644
--- a/docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md
+++ b/docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md
@@ -231,7 +231,7 @@ Blocking causes show a full-screen error screen naming each one; otherwise the s
 - **`vite.config.ts`**: `server` and `preview` on port 5183 with `strictPort` and the exact COOP/COEP headers; `worker.format = 'es'`; `build.chunkSizeWarningLimit = 1024` (three alone is ≈ 520 kB minified); `server.allowedHosts = ['world-imaginer-voxel', ...(process.env.VITE_ALLOWED_HOSTS?.split(',') ?? [])]` (localhost and IPs are allowed by default; Vite 8 answers other hosts with 403).
 - **`vercel.json`**: the same two headers for `source: "/(.*)"`; build `npm run build`, output `dist`. The user links the Vercel project to the repository root.
 - **Dockerfile**: `node:24-slim`, `npm ci`, `npx vite --host 0.0.0.0 --port 5183`. **`.dockerignore`**: `node_modules`, `dist`, `.git`, `test/.cache`. **`docker-compose.yml`**: service `world-imaginer-voxel`, container `world_imaginer_voxel`, `5183:5183`, bind mount plus a `node_modules` volume, the default compose network. Open it through `http://localhost:5183` to keep the secure context; a reverse proxy must forward its host via `VITE_ALLOWED_HOSTS`, terminate TLS and pass COOP/COEP through unchanged.
-- **CI** (`.github/workflows/ci.yml`): on `push` (all branches) and `pull_request` (D19); `permissions: { contents: read }`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; `ubuntu-latest`; `actions/checkout@v7` with `fetch-depth: 0`; `actions/setup-node@v7` with `node-version-file: .nvmrc` and `cache: npm`; `npm ci`; `npm run build`; `npm test` with `GOVERNANCE_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}` (an all-zero `before` skips the governance test); `npm run test:metrics`. The `actions/cache@v6` step for `test/.cache` is added in SP3, when the region cache exists (before that its post step would log a warning on every run). Action inputs were checked against their `action.yml`.
+- **CI** (`.github/workflows/ci.yml`): on `push` (all branches) and `pull_request` (D19); `permissions: { contents: read }`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; `ubuntu-latest`; `actions/checkout@v7` with `fetch-depth: 0`; `actions/setup-node@v7` with `node-version-file: .nvmrc` and `cache: npm`; `npm ci`; `npm run build`; `npm test` with `GOVERNANCE_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}` (an all-zero `before` skips the governance test); `npm run test:metrics`. The `actions/cache@v6` step is added in SP3b, when the generator is slow enough to need the region cache (before that its post step would log a warning on every run): it caches `test/.cache/regions` only, never the bundled `test/.cache/taskHandler*` files, before `npm run test:metrics` (amended by SP3a: SP3a's provisional T regenerates a 32 × 32 region in about a second, so its region cache is local only). Action inputs were checked against their `action.yml`.
 - **README / CLAUDE.md**: replace the "no code yet" notes with the real commands (`npm run dev|build|typecheck|test|test:metrics|test:metrics:full|bench|test:accept-thresholds|test:goldens`, `docker compose up world-imaginer-voxel`); the CLAUDE.md dev-dependency list adds `@types/node`; both status sections say SP0 is complete.
 
 ## Tests and exit criteria
@@ -257,7 +257,7 @@ Cut line: the Vercel preview check (→ SP4).
 
 ## Open items handed to later SPs
 
-- **Running TypeScript in `worker_threads` for the harness (SP3).** Node type stripping needs explicit `.ts` extensions, while the codebase uses bundler-style extensionless imports. SP3 decides between bundling harness worker entry points (Vite/Rolldown) and switching to explicit `.ts` extensions with `allowImportingTsExtensions`. SP0 sidesteps it with a plain `.mjs` fixture and by running acceptance through vitest.
+- **Running TypeScript in `worker_threads` for the harness (SP3).** Node type stripping needs explicit `.ts` extensions, while the codebase uses bundler-style extensionless imports. SP3 decides between bundling harness worker entry points (Vite/Rolldown) and switching to explicit `.ts` extensions with `allowImportingTsExtensions`. SP0 sidesteps it with a plain `.mjs` fixture and by running acceptance through vitest. Resolved (amended by SP3a): harness worker entry points are bundled with Vite by `buildNodeTaskWorker(dir, {entry?, stamp?})` in `test/harness/nodeWorker.ts` (SP2b for the task handler, generalised by SP3a to the region and fuzz workers).
 - **Metric registry shape.** `MetricDef.run(region)` and `RegionView` arrive with the harness (SP2/SP3); SP0 fixes only `THRESHOLDS`, per-part `activeFrom`, the lock and `metricTest`.
 
 ## Exit evidence
```

Modify `docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md` (apply with `git apply`):

```diff
diff --git a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
index ed75a24..d3ef3dd 100644
--- a/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
+++ b/docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md
@@ -371,6 +371,46 @@ The plan was dry-run in a scratch worktree: every task was implemented and every
 5. **Module layout** (Module layout). `workers/sliceJob.ts`, `ui/crossSection/voxels.ts`, the test harness files (`blockFixtures`, `stateLock`, `registryChecks`, `reviewSlices`) and the two metric files are listed; the tsconfig `lib` moves to ES2024 for the growable-buffer types (the target is unchanged).
 6. **Measured, unchanged:** DT1's full tier keeps the four seeds (≈ 130 s cold, after the streaming FNV was made about 8 × faster, bit-identical); the provisional T column costs ≈ 0.67 ms on the reference machine; the 4-thread harness, the slab fuzz (≈ 2 s) and the 10-refresh torus slice test run as specified.
 
+## Exit evidence
+
+Dry run of the implementation plan (2026-10-03, scratch branch `dry/sp3a`, Tasks 1-16; 12th Gen Intel(R) Core(TM) i7-12700H with 20 threads, Node v24.21.0, Chrome 153.0.8010.36). The executor of the plan re-measures every number below on its own branch and replaces this block.
+- `npm run typecheck`, `npm run build` (run by the smoke test) and `npm test` (121 files and 1564 tests passed, 3 skipped, 46 s) are green. `npm run test:metrics` (52 s) and `npm run test:metrics:full` (132 s cold) are green with DT1 and M1 active.
+- `git diff main -- test/goldens.json` adds exactly `sp3a.registry` 5e1febd88b449b63, `sp3a.region.T.default` 943479d09e0e89e3 and `sp3a.region.T.large_biomes` e20fb4ebf0a5e9fc; no other golden changed. `GENERATOR_VERSION` stays 3.
+- Slab fuzz (integration, `SLAB_FUZZ_SEED=1`): 4 threads × 100k ops on both pools, 1.6 s; the pools grew to 3840 block and 3840 byte slots; 0 double allocations, 0 lost slots, exact refcounts at every barrier and 0 after teardown (hard assertions). The 4-thread harness equals the 1-thread one in every order, for both profiles.
+
+| metric | fast | quick | full |
+|---|---|---|---|
+| DT1.mismatches | 0 | 0 | 0 |
+| DT1 regions (5 runs × 2 profiles × seeds) | 10 (8 × 8) | 10 (32 × 32) | 40 (32 × 32; seeds '42', '1', '2', '3') |
+| M1.states | 3 | 3 | 3 |
+| M1.roundTripFailures | 0 | 0 | 0 |
+| M1.lockChanges | 0 | 0 | 0 |
+
+DT1 on the full tier takes 41 s alone with the dumps of an earlier run present (8 first cache hits) and keeps its four seeds (§6.3). Every other metric equals its SP2b value.
+
+Bench (`npm run bench`; 20 kernels, 2 of them new in SP3a). Against the baseline recorded in Task 15 under load, the first quiet run passed. The baseline was then re-recorded on the quiet machine (`npm run bench:record`: killRatio 0.841, `column.sample` p50 0.344 ms), and two `npm run bench` runs against it passed (killRatio 0.843 and 0.877; `column.sample` p50 0.403 and 0.401 ms, p99 ≤ 0.523 ms). The new rows in the recorded baseline:
+
+| kernel | ns/eval | ratio to calibration |
+|---|---|---|
+| `calibration.fmix32` | 0.636 | 1 |
+| `store.alloc` (SP3a; one byte-pool alloc and free) | 173.839 | 273.442 |
+| `terrain.provisional` (SP3a; one column with its ColumnSample) | 664964 | 1045964.879 |
+
+JavaScriptCore: `npx --yes bun@1 test/tools/goldensJsc.ts` → `50/50 match on Bun 1.4.2 (JavaScriptCore)`.
+
+Browser checks (`node test/tools/uiSmoke.ts --shots <dir>`: its own build, `vite preview` on a free port and headless Chrome 153, 1400 × 900 at DPR 1; 46 s) → `smoke: 77/77 checks pass`:
+- `?selftest=1`: `✓ all 50 goldens match (5.7 s)`, and `test/goldens.json` holds 50 entries.
+- The Voxels mode on the line A (−12800, 0) → B (12800, 0): "ground top y 26 to 203 · water on 14.6 % of the line, up to 37 deep", 38 colours in the 512 × 384 slice, hover "(25, 12, 0) · stone · no fluid · point 256, 12825.0 blocks from A"; back to Profile, the profile is kept.
+- No page error apart from the favicon.ico 404.
+- Firefox (`?selftest=1` 50/50) and CI are checked after the merge, as in SP2b.
+
+Visual review (`docs/superpowers/specs/assets/sp3a/`; world seed '42', default profile, provisional T; air in sky blue, stone grey, bedrock near black, water blue darkening with depth). The slices are written by `npm run docs:review-slices` (`test/harness/reviewSlices.ts`). Each site's line is checked against the ColumnSample's land, sea, lake and river positions, and its crop is checked to remove only air and stone. `slices.json` lists the sites and the positions each line crosses.
+- `slice-coast.png` (1024 × 192, y −64 … 127): the z plane −31992 for x −27136 … −26113. The sea is up to 43 deep; a river mouth crosses the coast; a 27-column land strip rises to y 100 before the sea again. Line positions: 567 sea, 436 land, 21 river.
+- `slice-lake.png` (2 px per block, y 32 … 95): the same plane for x −16384 … −15873. A river channel at sea level 63 lies beside a lake whose water stands at y 70, above sea level. Line positions: 138 lake, 30 river, 344 land.
+- `slice-river.png` (2 px per block, y 32 … 95): the same plane for x −15552 … −15041. Three river channels with water up to y 63, at most 4 blocks deep, between land up to y 76. Line positions: 95 river, 417 land.
+- `slice-y62.png` (1024 × 1024): the y plane 62 of the 64 × 64 columns from (cx, cz) = (−1696, −2032), with north at the top. It shows the coastline, river channels, islets and enclosed water: water where the sea or a river reaches y 62, stone where the ground does.
+- `cross-section-voxels.png` (1400 × 900, the smoke test's `--shots`): `?map` with the Voxels mode on a coast line A (5122, 3074) → B (6658, 3074) at 4 blocks/px. The sea is up to 41 deep under the sea-level line, the badlands rise to y 208, and the hover reads a water source.
+
 ## Threshold log
 
 (One line per commit that changes `test/thresholds.lock.json`.)
```

Modify `package.json` (apply with `git apply`):

```diff
diff --git a/package.json b/package.json
index ec9a001..c905c86 100644
--- a/package.json
+++ b/package.json
@@ -20,7 +20,8 @@
     "test:goldens": "rm -rf test/.cache/goldens-obs && UPDATE_GOLDENS=1 vitest run --project unit --project metrics-quick && MERGE_GOLDENS=1 vitest run --project arch test/arch/goldensMerge.test.ts",
     "test:accept-schema": "ACCEPT_SCHEMA=1 vitest run --project arch test/arch/schemaShape.test.ts",
     "test:accept-state-ids": "ACCEPT_STATE_IDS=1 vitest run --project arch test/arch/stateIds.test.ts",
-    "docs:params": "WRITE_PARAMS_DOC=1 vitest run --project arch test/arch/paramsDoc.test.ts"
+    "docs:params": "WRITE_PARAMS_DOC=1 vitest run --project arch test/arch/paramsDoc.test.ts",
+    "docs:review-slices": "REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3a vitest run --project unit test/unit/reviewSlices.test.ts"
   },
   "dependencies": {
     "three": "~0.186.1"
```

Create `test/harness/reviewSlices.ts`:

```ts
/**
 * The SP3a visual review (spec §12, master §10 "PNG slices … attached to the SP spec"): the harness PNG slices of
 * the provisional T stage, at world seed '42' on the default profile — vertical slices across a coast, a lake and a
 * river, and a horizontal slice at y 62 — written by `npm run docs:review-slices` into
 * `docs/superpowers/specs/assets/sp3a/`.
 *
 * Each site states which kinds of position its line crosses (`needs`), and `lineKinds` re-derives them from the
 * ColumnSample (the §4 inputs), so a change of the 2D world that moves a coast, a lake or a river away from its
 * site fails the unit test instead of silently writing a slice without it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Params } from '../../src/core/params/schema';
import {
  buildColumnSample, latticeIndex, newColumnSample, readField, readLevel, riverWetAt, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { genRegion, type RegionView } from './region';
import { encodePng, sliceY, sliceZ, type RgbaImage } from './png';

/** What a block position holds on the provisional T: dry land, or water of the sea, a lake or a river. */
export type ReviewKind = 'land' | 'sea' | 'lake' | 'river';

export const REVIEW_KINDS: readonly ReviewKind[] = ['land', 'sea', 'lake', 'river'];

/**
 * The kind of position (x, z), from a ColumnSample built for its column: land when it holds no water voxel
 * (`⌊surfaceWaterLevel⌋ ≤ ⌊surfaceEst⌋`, or no water level at all); otherwise a lake when the nearest quart corner
 * (as `readLevel` picks it) is inside a lake mask, a river when that corner is a wet river channel, else the sea.
 */
export function positionKind(s: ColumnSample, x: number, z: number): ReviewKind {
  const lx = x - 16 * s.cx;
  const lz = z - 16 * s.cz;
  if (lx < 0 || lx > 15 || lz < 0 || lz > 15) throw new RangeError(`positionKind: (${x}, ${z}) is outside column (${s.cx}, ${s.cz})`);
  const top = Math.floor(readField(s, 'surfaceEst', x, z));
  const swl = readLevel(s, 'surfaceWaterLevel', x, z);
  if (swl === -Infinity || Math.floor(swl) <= top) return 'land';
  const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
  if (s.f.lakeMask[k] === 1) return 'lake';
  return riverWetAt(s, k) ? 'river' : 'sea';
}

/**
 * A vertical slice: the z plane `z` of the one-row region of columns cx0 … cx0 + w − 1 at cz = z >> 4, x across,
 * y from `yMax` (row 0) down to `yMin`.
 */
export interface VerticalSite {
  readonly name: string;
  readonly file: string;
  readonly kind: 'vertical';
  readonly cx0: number;
  readonly w: number;
  readonly z: number;
  readonly yMin: number;
  readonly yMax: number;
  /** Nearest-neighbour upscale of the PNG (1: one pixel per block). */
  readonly scale: number;
  /** Kinds the slice line must cross. */
  readonly needs: readonly ReviewKind[];
}

/** A horizontal slice: the y plane `y` of a w × h region, x across, z down (north at the top). */
export interface HorizontalSite {
  readonly name: string;
  readonly file: string;
  readonly kind: 'horizontal';
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
  readonly y: number;
  /** The row checked against `needs` (a full-region scan would cost a ColumnSample per column). */
  readonly checkZ: number;
  readonly needs: readonly ReviewKind[];
}

export type ReviewSite = VerticalSite | HorizontalSite;

/** The row z = −31992 (column row cz −2000, lz 8) of world seed '42', default profile, found by a scan. */
const ROW_CZ = -2000;
const ROW_Z = 16 * ROW_CZ + 8;

/**
 * The review sites (world seed '42', default profile). Vertical slices are cropped in y: the tests check that every
 * column's water and ground surface lies inside the crop, so it removes only air above and stone below. The lake and
 * river slices are narrow bands and are drawn at 2 pixels per block.
 */
export const REVIEW_SITES: readonly ReviewSite[] = [
  {
    name: 'coast', file: 'slice-coast.png', kind: 'vertical', cx0: -1696, w: 64, z: ROW_Z, yMin: -64, yMax: 127, scale: 1,
    needs: ['sea', 'land'],
  },
  {
    name: 'lake', file: 'slice-lake.png', kind: 'vertical', cx0: -1024, w: 32, z: ROW_Z, yMin: 32, yMax: 95, scale: 2,
    needs: ['lake', 'land'],
  },
  {
    name: 'river', file: 'slice-river.png', kind: 'vertical', cx0: -972, w: 32, z: ROW_Z, yMin: 32, yMax: 95, scale: 2,
    needs: ['river', 'land'],
  },
  {
    name: 'y62', file: 'slice-y62.png', kind: 'horizontal', cx0: -1696, cz0: ROW_CZ - 32, w: 64, h: 64, y: 62, checkZ: ROW_Z,
    needs: ['sea', 'land'],
  },
];

/** Kind counts (block positions) along a site's line: the vertical slice's line, or a horizontal site's `checkZ` row. */
export function lineKinds(ctx: GenContext, site: ReviewSite): Record<ReviewKind, number> {
  const out: Record<ReviewKind, number> = { land: 0, sea: 0, lake: 0, river: 0 };
  const z = site.kind === 'vertical' ? site.z : site.checkZ;
  const cz = z >> 4;
  const s = newColumnSample();
  for (let cx = site.cx0; cx < site.cx0 + site.w; cx++) {
    buildColumnSample(ctx, cx, cz, s);
    for (let lx = 0; lx < 16; lx++) out[positionKind(s, 16 * cx + lx, z)]++;
  }
  return out;
}

/** Each pixel of `img` as a k × k block. */
export function upscale(img: RgbaImage, k: number): RgbaImage {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`upscale: factor ${k}`);
  if (k === 1) return img;
  const width = img.width * k;
  const height = img.height * k;
  const rgba = new Uint8Array(4 * width * height);
  const src = new Uint32Array(img.rgba.buffer, img.rgba.byteOffset, img.width * img.height);
  const dst = new Uint32Array(rgba.buffer);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / k) * img.width;
    for (let x = 0; x < width; x++) dst[y * width + x] = src[row + Math.floor(x / k)]!;
  }
  return { width, height, rgba };
}

/** The PNG image of a site over its generated region. */
export function renderSite(view: RegionView, site: ReviewSite): RgbaImage {
  if (site.kind === 'horizontal') return sliceY(view, site.y);
  return upscale(sliceZ(view, site.z, { yMin: site.yMin, yMax: site.yMax }), site.scale);
}

/** Generates a site's region: provisional T, cold (no region cache), spiral order, 1 thread. */
export async function generateSite(seed: string, params: Params, site: ReviewSite): Promise<RegionView> {
  const h = site.kind === 'vertical' ? 1 : site.h;
  const cz0 = site.kind === 'vertical' ? site.z >> 4 : site.cz0;
  const r = await genRegion({ seed, params, cx0: site.cx0, cz0, w: site.w, h, upTo: 'T', order: 'spiral', threads: 1 });
  return r.view;
}

export interface WrittenSlice {
  readonly site: ReviewSite;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Generates every site and writes its PNG into `dir` (created if missing). */
export async function writeReviewSlices(dir: string, seed: string, params: Params, sites: readonly ReviewSite[] = REVIEW_SITES): Promise<WrittenSlice[]> {
  mkdirSync(dir, { recursive: true });
  const out: WrittenSlice[] = [];
  for (const site of sites) {
    const img = renderSite(await generateSite(seed, params, site), site);
    const png = encodePng(img);
    const path = join(dir, site.file);
    writeFileSync(path, png);
    out.push({ site, path, width: img.width, height: img.height, bytes: png.length });
  }
  return out;
}
```

- [ ] **Step 4: Regenerate the governed files**

Run: `npm run docs:review-slices`

`docs/superpowers/specs/assets/sp3a/cross-section-voxels.png` is the smoke test's screenshot: run `node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots $(mktemp -d /tmp/wi10-shots-XXXX)` and copy `cross-section-voxels.png` from the shots directory (the other screenshots are SP2b's and are not copied).

`docs/superpowers/specs/assets/sp3a/slice-coast.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3a/slice-lake.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3a/slice-river.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3a/slice-y62.png` is written by the command above (not copied).

`docs/superpowers/specs/assets/sp3a/slices.json` is written by the command above (not copied).

`test/baselines.json`: the dry run re-recorded it here because its Task 15 record was made under load. Re-record it only if yours was too (the Task 15 procedure); otherwise leave it out of this commit.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project arch --project unit test/arch/masterSpec.test.ts test/unit/reviewSlices.test.ts`

Expected: PASS (exit 0)

```
Test Files  2 passed (2)
Tests  14 passed | 1 skipped (15)
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`

Expected: exit 0

```
Test Files  121 passed | 2 skipped (123)
Tests  1575 passed | 3 skipped (1578)
```

- [ ] **Step 7: Measure the exit evidence**

Run each and replace the dry-run numbers in the spec's Exit evidence block (Step 3) with yours:

- `npm run build && npm test`
- `npm run test:metrics` and `npm run test:metrics:full` (DT1 = 0, M1 = 0 on every tier; record the DT1 full-tier time)
- `npx --yes bun@1 test/tools/goldensJsc.ts` → `50/50 match`
- `node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots $(mktemp -d /tmp/wi10-shots-XXXX)` → `smoke: 77/77 checks pass`, including `?selftest=1` "✓ all 50 goldens match"
- `npx vitest run --project integration` (the slab fuzz timing and pool growth)
- `npm run bench` (on a quiet machine)
- `git diff main -- test/goldens.json` adds only the three `sp3a.*` keys

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md README.md docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md docs/superpowers/specs/2026-10-02-sp3a-blocks-store-harness-design.md docs/superpowers/specs/assets/sp3a/cross-section-voxels.png docs/superpowers/specs/assets/sp3a/slice-coast.png docs/superpowers/specs/assets/sp3a/slice-lake.png docs/superpowers/specs/assets/sp3a/slice-river.png docs/superpowers/specs/assets/sp3a/slice-y62.png docs/superpowers/specs/assets/sp3a/slices.json package.json test/arch/masterSpec.test.ts test/baselines.json test/harness/reviewSlices.ts test/unit/reviewSlices.test.ts
git commit -F - <<'EOF'
docs(spec): SP3a exit — master and SP0 amendments, review slices, quiet bench baseline and exit evidence

The master spec takes the SP3a amendments (SP3a spec §11): SP3 split into
SP3a, SP3b and SP3c in §10 (SP4 and SP6 depend on SP3b, SP3c runs alongside
SP4, critical path SP2b → SP3a → SP3b → SP4), the §1 module layout and
banned-API scopes (world/blocks/**, metrics/region.ts, metrics/sp3aGoldens.ts),
the §2.1 compass and face order, the §2.2 codes, id order, canonical keys and
append-only reading, the §2.3 growable pools, uniform fluid, claimed record,
meta bits, aux offsets and heightmaps, the §2.5 SubProjectId and ColumnWriter,
and the §6.1 per-column RegionView and srcKey cache key. The SP0 spec's CI
note moves the region-cache step to SP3b. test/arch/masterSpec.test.ts checks
the master's SubProjectId, §10 headers and critical path against the code.

test/harness/reviewSlices.ts and npm run docs:review-slices write the §12
review PNGs (vertical slices across a coast, a lake and a river; y 62) into
docs/superpowers/specs/assets/sp3a/, each site checked against the
ColumnSample; the Voxels-mode screenshot comes from uiSmoke --shots. The
bench baseline is re-recorded on a quiet machine (Task 15's was loaded).
README and CLAUDE.md say SP3a is complete and SP3b is next.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
EOF
```

- [ ] **Step 9: Hand off to the user (do not push on your own)**

Report that the branch is ready. With the user's go-ahead, merge to `main` and push; CI must be green. Then the user checks `?selftest=1` in Firefox (50/50) and sends the JSON, which goes into `docs/superpowers/specs/assets/sp3a/selftest-firefox.json`. Add it to Exit evidence and set the SP3a spec Status to complete in that commit, as SP2b did.

**Dry-run notes** (dry-run commit `bc660bf` on `dry/sp3a`; 16 files changed, 651 insertions(+), 94 deletions(-)):

RED replay (the commit's `test/**` over the parent, throwaway detached worktree, unit + arch): 1 file failed — `test/arch/masterSpec.test.ts` 3 of 3 (the master's `SubProjectId` line lists 16 ids, not 18; §10 has no SP3a/SP3b/SP3c headers; "unknown sub-project SP3" on the critical path); 109 files / 1536 tests pass (`test/unit/reviewSlices.test.ts` passes on the parent because its harness is under `test/`, as in Tasks 8, 11, 12 and 15; during TDD it was watched failing to import `../harness/reviewSlices`). GREEN: typecheck clean; `npm test` 121 files passed, 2 skipped / 1564 passed, 3 skipped (37-46 s; the third skip is the env-gated slice writer); `GOVERNANCE_BASE=main` governance test passes. Mutations (scratch, reverted): `positionKind` with `<` instead of `≤` → 3 fail (kinds vs voxels); the river site moved to cx0 −940 → 2 fail.

Exit evidence measured (quiet machine, load ≈ 0.4-2): `npm run test:metrics` 52 s (DT1 quick 10 regions, genSeconds 7.5); `npm run test:metrics:full` 132 s cold (DT1 40 regions, genSeconds 29.9; DT1 alone 41 s with dumps present, 8 first cache hits), all green; Bun `goldensJsc.ts` 50/50 (6.5 s); `node test/tools/uiSmoke.ts --profile-dir $(mktemp -d /tmp/wi10-XXXX) --shots <scratch>` 77/77 incl. `?selftest=1` "✓ all 50 goldens match (5.7 s)" and its own `npm run build` (46 s; its Chrome, `vite preview` and profile dir all gone afterwards); integration project 15.5 s (slab fuzz 1.6 s, pools grew to 3840/3840 slots); `git diff main -- test/goldens.json` adds only the 3 sp3a keys.

- Ruling: "vertical across a coast, a lake and a river" is read as three vertical slices, one per feature (plus the y 62 slice): the known seed-'42' coast, lake and river columns (Task 9) lie ≈ 1300 columns apart on the row cz −2000, and a harness region is at most 64 columns (§6.1) — cost if wrong: one more site, the code takes any list.
- Ruling: the review slices are produced by a harness, `test/harness/reviewSlices.ts` (`REVIEW_SITES`, `positionKind`, `lineKinds`, `renderSite`, `upscale`, `generateSite`, `writeReviewSlices`), and an env-gated test in `test/unit/reviewSlices.test.ts` run by the new script `npm run docs:review-slices` (= `REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3a vitest run --project unit test/unit/reviewSlices.test.ts`, mirroring `docs:params`); a plain-Node tool cannot import `src/` (extensionless specifiers, §6.4) — cost if wrong: none (CLAUDE.md lists the script).
- Ruling: the sites are hard-coded (world seed '42', default profile, row z −31992 = cz −2000, lz 8, found by a ColumnSample scan): coast cx −1696 … −1633 (y −64 … 127, 1 px/block), lake cx −1024 … −993 and river cx −972 … −941 (y 32 … 95, 2 px/block), y 62 over the 64 × 64 columns from (−1696, −2032); unit tests re-derive each line's land/sea/lake/river positions from the ColumnSample (the Task 9 classification), check every position's kind against the voxels (wet ⇔ not land), that the crop removes only air above and stone below (WORLD_SURFACE_WG − 1 ≤ yMax, OCEAN_FLOOR_WG − 1 ≥ yMin), lake water above y 63, bedrock at y −64 and the upscale — so a world change (SP3b) fails loudly instead of writing slices without their feature; the assets themselves are NOT freshness-tested (they are SP3a's evidence, and SP3b's real T will change the world) — cost if wrong: SP3b re-picks sites for its own review.
- Ruling: the y 62 site's `needs` (sea, land) are checked only on its middle row (= the coast line), not over all 4096 columns (≈ 1.2 s of ColumnSamples plus ≈ 160 MB of proto columns in a unit test); the 64 × 64 region is generated only by `docs:review-slices` (≈ 3 s, 1 thread) — cost if wrong: none.
- Ruling: lake and river slices are cropped to y 32 … 95 and drawn at 2 px per block (nearest-neighbour `upscale`), the coast slice keeps y −64 … 127 at 1 px; full height (384 rows) would be ≈ 80 % sky and stone at these sites, and the rivers are 1-4 blocks deep — the spec fixes neither crop nor scale — cost if wrong: one field per site.
- Ruling: `docs:review-slices` also writes `assets/sp3a/slices.json` (seed, profile, each site and its line kinds), the source of the exit-evidence counts — vitest 5 did not print the test's `console.log` in this setup — cost if wrong: one small JSON asset.
- Ruling: the Voxels-mode screenshot is the smoke test's `cross-section-voxels.png` (Task 14), taken with `--shots` into a scratch dir and copied alone into `assets/sp3a/`; the other seven `--shots` files are SP2b's screenshots and are not duplicated — cost if wrong: none.
- Ruling: the failing-first test of this docs task is `test/arch/masterSpec.test.ts`: the master's `type SubProjectId =` line equals `SUB_PROJECTS`, §10 has one `**SPx — …** (…)` header per sub-project in order whose parenthetical names every `SP_DEPS` dependency (`sp.ts` says they are "transcribed from the §10 headers"), and the critical path is a chain of `SP_DEPS` edges from SP0 to SP12; only the forward direction is checked because headers carry qualified non-dependencies (SP8a "… in parallel with SP5-SP7") — cost if wrong: none (a later SP split must amend the master, which is the point).
- Ruling: master amendments beyond §11's list, so that no master text names a sub-project that no longer exists: §3.7 "SP3b introduces the density-tap search", §3.17 "proto regions from SP3a", §8 risk 1 "SP3a-SP4", §10 SP2a header "(SP3b replaces it)", SP2b "SP2a minors 5 and 6 → SP3 (SP3b after the split)", cut-line receivers "SP3c inspector pins", parallelism "after SP3a; SP3c alongside SP4", visible value and riskiest integrations, the continental profile "may move to SP3b or SP3c"; each SP3a/SP3b/SP3c block keeps the old SP3 bullets in the part §11 assigns them (the frozen-encoding sentence in SP3a; density, surfaceEstimate, surface rules and v0 water in SP3b; drafts, inspector, slice viewer, deliverable and cut line in SP3c) and gains "Received from SP3a" bullets from SP3a §10 — cost if wrong: wording only.
- Ruling: where §11 names no item the master §10 block says so instead of inventing one: SP3a "**Cut line:** none named by the SP3a spec.", SP3b "**Cut line:** set by the SP3b spec.", SP3c "**Exit:** set by the SP3c spec."; SP3b's deliverable ("voxel terrain from the density DAG with surface rules and water, in the harness slices and the Voxels mode") is written from §11's scope — cost if wrong: SP3b/SP3c specs amend those lines.
- Ruling: the SP0 spec's open item "Running TypeScript in `worker_threads` for the harness (SP3)" is marked resolved (bundling via `buildNodeTaskWorker(dir, {entry?, stamp?})`, SP2b for the task handler, generalised by SP3a), next to the §11-listed CI-note amendment — cost if wrong: one sentence.
- Ruling: the bench baseline is re-recorded in this commit on the quiet machine (Task 15's hand-over): `npm run bench` against Task 15's loaded baseline passed (calibration 0.636 ns, column.sample p50 0.404 ms), then `npm run bench:record` (killRatio 0.841, column.sample p50 0.344 ms; `store.alloc` 173.8 ns / ratio 273.4, `terrain.provisional` 0.665 ms / ratio 1,045,965), then `npm run bench` passed twice (column.sample p50 0.403/0.401 ms, ratio ≈ 1.17 of the recorded); `test/baselines.json` is a generated governance file the skeleton allows in a task commit; the record's column.sample (0.344 ms) is faster than SP2b's quiet 0.398 ms, so the margin on that row is ≈ 1.17 / 1.30 — cost if wrong: the executor re-records anyway (Task 15's ruling stands for the plan).
- Ruling: CLAUDE.md status "SP3a complete (2026-10-03, GENERATOR_VERSION 3). SP3b is next.", plus the new `docs:review-slices` command, Bun line "(SP1, SP2a and SP3a)", the Voxels toggle on `?map` and the smoke test, and `world/blocks/**` in the determinism lines; README status says SP3a is complete and SP3b (density, surfaceEstimate, terrain and surface rules) is next — cost if wrong: wording only.
- Ruling: the Exit evidence block says it is the dry run's and that Firefox `?selftest=1` and CI are checked after the merge (as SP2b's "Done after the merge"); no Threshold-log line (the lock did not change) — cost if wrong: none.
- Spec defect: §11 "Master-spec amendments made with this spec" lists §10 SP3a/SP3b/SP3c content but gives SP3a no cut line, SP3b no deliverable or cut line and SP3c no exit, while master §10 says "Every SP names a cut line" → add to §11: "SP3a's cut line: none (or name one, e.g. the Voxels hover → SP3c); SP3b's deliverable: voxel terrain from the density DAG with surface rules and water; SP3b's and SP3c's cut lines and SP3c's exit are set by their specs".
- Spec defect: §11 names only the §10 SP0 note and the SP0 spec's CI note, but the master still says SP3 in §3.7, §3.17, §8 (risk 1), §10's SP2a header, SP2b's hand-over, the cut-line receivers, the parallelism and visible-value paragraphs and SP12's continental line, and the SP0 spec's open item "Running TypeScript in worker_threads for the harness (SP3)" is resolved by SP3a → add to §11: "every other master reference to SP3 names the part it now belongs to (SP3a, SP3b or SP3c); the SP0 spec's worker_threads open item is resolved by bundling (`buildNodeTaskWorker`)".
- Spec defect: §12 "harness PNG slices (vertical across a coast, a lake and a river; horizontal at y 62)" does not say whether that is one slice or three, where the PNGs go or what writes them → "three vertical slices, one across each feature, and a horizontal slice at y 62, written by `npm run docs:review-slices` into `docs/superpowers/specs/assets/sp3a/`".

---

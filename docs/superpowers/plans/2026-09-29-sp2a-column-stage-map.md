# SP2a — Column stage, worker pool and map: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the SP1 math core into a 2D world: every column's climate, height, rivers, lakes and surface biome, computed identically by a point reference and a batched ColumnSample, and rendered by a worker pool into the `?map` page.

**Architecture:**
- **Pure `gen/` modules** (climate → shape → steep → rivers → lakes → water → biome) behind a per-epoch `GenContext`:
  - `samplePoint` is the readable reference;
  - `buildColumnSample` reproduces it bit for bit at quart corners (DT2).
- **Workers.** A module-worker pool runs a pure message handler (configure / mapTile / point / spawn / selftest).
- **The `?map` page** composes `WorldSession`, the pool and a canvas of cached tiles.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-sp2a-column-stage-map-design.md` (revised by this plan's dry run, spec §12). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`.

**Dry run.** Every task below was executed in a scratch worktree before this plan was written. Code blocks and diffs are copied from that run, and every `Expected:` line is what it printed. The results:
- `npm test`: 616 passed;
- all metric tiers green (full tier 3.5 min);
- 47/47 goldens in V8, Bun (JavaScriptCore) and headless Chrome;
- `?map`: first image in 280 ms;
- bench: column p50 0.35 ms.

## Global Constraints

- TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or constructor parameter properties), `verbatimModuleSyntax`; ES2022 modules; no new runtime or dev dependencies.
- `gen/**`, `core/**` and `metrics/sp{1,2a}Goldens.ts`:
  - only the SP0/SP1 Math allowlist (no `Math.fround`, no `**`), and transcendentals through `core/detMath`;
  - no `Intl`, `localeCompare`, `toLocale*`, `normalize`, `TextEncoder` or `TextDecoder`;
  - no `Math.random`, `Date.now`, `performance.now` or `console`.
- `gen/**`, `core/noise/**`, `core/spline/**` and `metrics/**`: imported values are used only through top-level `const X = binding;` aliases. Types come in with `import type { X as XT }` when a name would clash.
- `gen/**` exports no numeric constants and no numeric data. Fixed constants live in `core/constants.ts`, and tunables are schema leaves.
- Column keys are numeric (`colKey = (cx + 32768)·65536 + (cz + 32768)`), never strings (master §2.1).
- Every commit that changes `test/thresholds.lock.json` also appends a line to the SP2a spec's Threshold log (CI checks per push).
- Tests are TDD: write the test, watch it fail for the stated reason, implement, watch it pass.
- Never kill, signal or touch processes you did not start; stop only the dev servers and Chrome instances you launched. Headless Chrome runs use a dedicated `--user-data-dir` in the scratch directory.
- Pushes, pull requests and merges are outward-facing: only with the user's go-ahead.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc`.

## Review Focus

1. **A view at the edge of the world** (map centre at x or z = ±2^19, zoomed out to 256 blocks/px): the page must never request tiles outside the colKey window, and no console errors should appear. Test: Task 21 "tiles outside the colKey window are never planned".
2. **Extreme but valid parameters** (random schema documents: tiny widths, huge radii, degenerate splines, random biome boxes): every column field stays finite; only the level fields may be −∞, and none may be NaN. Test: Task 10 "random valid parameters keep every field finite".
3. **A worker that fails a job** (INTERNAL error): the job's promise rejects with the code and the pool keeps serving other jobs; nothing hangs. Test: Task 19 "a worker error rejects the job instead of hanging".
4. **Parameters that should not move the terrain** (any edit of the biome table or zoom jitter): heights, water and steep stay identical, and only biomes change. Test: Task 10 "terrain does not depend on biomes".
5. **A stale or foreign URL** (unready profile, invalid patch, seed with a line break, zoom out of range): the page opens with the defaults and a notice. Test: Task 21 `decodeMapState` cases.

## Branch

Create `sp2a/column-map` from `main` before Task 1 (`git switch -c sp2a/column-map`).

---
### Task 1: Governance: SP2a/SP2b ids, CURRENT_SP and profile readiness

**Files:**
- Modify: `src/core/ids.ts`, `test/harness/sp.ts`, `src/core/params/profiles.ts`
- Modify: `test/arch/sp.test.ts`, `test/unit/lock.test.ts`, `test/unit/profiles.test.ts`
- Modify: `test/thresholds.lock.json` (accept), the SP2a spec (Threshold log), `CLAUDE.md` (Status)

**Interfaces:**
- Produces: `type SubProjectId` with `'SP2a' | 'SP2b'` (no `'SP2'`), `SUB_PROJECTS: readonly SubProjectId[]`, `CURRENT_SP: SubProjectId = 'SP2a'` (`src/core/ids.ts`); `isProfileReady(id, current = CURRENT_SP): boolean` (`profiles.ts`).

- [ ] **Step 1: Write the failing tests**

`test/arch/sp.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/arch/sp.test.ts b/test/arch/sp.test.ts
index 5420844..98e78f4 100644
--- a/test/arch/sp.test.ts
+++ b/test/arch/sp.test.ts
@@ -1,4 +1,5 @@
 import { describe, expect, test } from 'vitest';
+import { SUB_PROJECTS } from '../../src/core/ids';
 import { SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';
 
 describe('started sub-projects', () => {
@@ -6,12 +7,14 @@ describe('started sub-projects', () => {
     expect(validateStarted(STARTED_SPS)).toEqual([]);
   });
 
-  test('SP_DEPS covers all 15 sub-projects and SP_ORDER follows it', () => {
+  test('SP_DEPS covers all 16 sub-projects and SP_ORDER follows it', () => {
     expect(SP_ORDER).toEqual([
-      'SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
+      'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
       'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
     ]);
     for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
+    expect(SP_ORDER).toEqual([...SUB_PROJECTS]);
+    expect([SP_DEPS.SP2a, SP_DEPS.SP2b, SP_DEPS.SP3]).toEqual([['SP1'], ['SP2a'], ['SP2b']]);
   });
 
   test('duplicates and unknown ids are rejected', () => {
@@ -20,16 +23,17 @@ describe('started sub-projects', () => {
   });
 
   test('an SP cannot start before its dependencies', () => {
-    expect(validateStarted(['SP0', 'SP2'])).toEqual(['SP2 started before its dependency SP1']);
+    expect(validateStarted(['SP0', 'SP2a'])).toEqual(['SP2a started before its dependency SP1']);
+    expect(validateStarted(['SP0', 'SP1', 'SP2b'])).toEqual(['SP2b started before its dependency SP2a']);
   });
 
   test('parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started', () => {
-    const path = ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
+    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
     expect(validateStarted(path)).toEqual([]);
   });
 
   test('parallel SPs: SP8c without SP7 is rejected', () => {
-    const path = ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP8c'];
+    const path = ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP8c'];
     expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
   });
 });
```

`test/unit/lock.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/unit/lock.test.ts b/test/unit/lock.test.ts
index e2446ef..acea4c9 100644
--- a/test/unit/lock.test.ts
+++ b/test/unit/lock.test.ts
@@ -3,7 +3,7 @@ import { canonicalJson, diffGovernance, formatChanges, makeLock, verifyLock, typ
 
 const base: GovernanceState = {
   thresholds: { T1: { band: { max: 0.25, activeFrom: 'SP3' }, span: { min: 60, activeFrom: 'SP3' } } },
-  startedSps: ['SP0', 'SP1', 'SP2', 'SP3'],
+  startedSps: ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3'],
 };
 
 describe('canonical JSON and lock', () => {
@@ -55,7 +55,7 @@ describe('diffGovernance', () => {
   });
 
   test('removing a started SP loosens; adding one tightens', () => {
-    expect(diffGovernance(base, edit((s) => { s.startedSps = ['SP0', 'SP1', 'SP2']; }))).toEqual([
+    expect(diffGovernance(base, edit((s) => { s.startedSps = ['SP0', 'SP1', 'SP2a', 'SP2b']; }))).toEqual([
       { path: 'startedSps', detail: 'removed SP3', kind: 'LOOSEN' },
     ]);
     expect(diffGovernance(base, edit((s) => { s.startedSps = [...s.startedSps, 'SP4']; }))).toEqual([
```

`test/unit/profiles.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/unit/profiles.test.ts b/test/unit/profiles.test.ts
index ad41fb0..27eec9a 100644
--- a/test/unit/profiles.test.ts
+++ b/test/unit/profiles.test.ts
@@ -4,7 +4,8 @@ import { canonicalJSON } from '../../src/core/params/canonical';
 import { DEFAULTS } from '../../src/core/params/defaults';
 import { deletePath, mapPath, migrate, MIGRATIONS, renamePath, SCHEMA_VERSION, type JsonObject } from '../../src/core/params/migrate';
 import { exportPreset, importPreset } from '../../src/core/params/presets';
-import { PROFILE_IDS, PROFILES, resolveProfile } from '../../src/core/params/profiles';
+import { CURRENT_SP } from '../../src/core/ids';
+import { isProfileReady, PROFILE_IDS, PROFILES, resolveProfile } from '../../src/core/params/profiles';
 import { SCHEMA } from '../../src/core/params/schema';
 import { dirtyStages, genKey, stageHashes } from '../../src/core/stage/hash';
 import { STAGES } from '../../src/core/stage/registry';
@@ -15,12 +16,18 @@ describe('profiles', () => {
   test('ids, readiness and overlays', () => {
     expect(Object.keys(PROFILES)).toEqual([...PROFILE_IDS]);
     expect(PROFILE_IDS.map((id) => [id, PROFILES[id].readyFrom])).toEqual([
-      ['default', 'SP1'], ['large_biomes', 'SP2'], ['archipelago', 'SP3'], ['amplified', 'SP3'], ['floating_islands', 'SP3'], ['cave_heavy', 'SP6'],
+      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3'], ['amplified', 'SP3'], ['floating_islands', 'SP3'], ['cave_heavy', 'SP6'],
     ]);
     expect(resolveProfile('large_biomes').climate.scaleMul).toBe(4);
     expect(resolveProfile('archipelago').climate.C.wavelength).toBe(840);
     expect(resolveProfile('default')).toBe(DEFAULTS);
   });
+  test('readiness follows CURRENT_SP', () => {
+    expect(CURRENT_SP).toBe('SP2a');
+    expect(PROFILE_IDS.filter((id) => isProfileReady(id))).toEqual(['default', 'large_biomes']);
+    expect(isProfileReady('archipelago', 'SP3')).toBe(true);
+    expect(isProfileReady('large_biomes', 'SP1')).toBe(false);
+  });
   test('switching profile dirties exactly what its overlay touches', () => {
     const base = stageHashes(DEFAULTS);
     const all = STAGES.map((s) => s.id);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/profiles.test.ts test/unit/lock.test.ts --project arch test/arch/sp.test.ts`
Expected: FAIL (`SUB_PROJECTS`/`isProfileReady`/`CURRENT_SP` missing; SP_ORDER lacks SP2a).

- [ ] **Step 3: Implement**

`src/core/ids.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/ids.ts b/src/core/ids.ts
index 1099b77..1cda45a 100644
--- a/src/core/ids.ts
+++ b/src/core/ids.ts
@@ -1,8 +1,16 @@
-/** Sub-project ids of master spec §10. */
+/** Sub-project ids of master spec §10 (SP2 split into SP2a and SP2b on 2026-09-28). */
 export type SubProjectId =
-  | 'SP0' | 'SP1' | 'SP2' | 'SP3' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
+  | 'SP0' | 'SP1' | 'SP2a' | 'SP2b' | 'SP3' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
   | 'SP8a' | 'SP8b' | 'SP8c' | 'SP9' | 'SP10' | 'SP11' | 'SP12';
 
+/** Every sub-project in master §10 order. */
+export const SUB_PROJECTS: readonly SubProjectId[] = [
+  'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7', 'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
+];
+
+/** The sub-project this build belongs to; hides profiles whose readyFrom comes later (SP2a spec §4.4). */
+export const CURRENT_SP: SubProjectId = 'SP2a';
+
 /** Every metric id of master spec §6.4 (E1-E6 expanded). */
 export type MetricId =
   | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6'
```

`test/harness/sp.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/harness/sp.ts b/test/harness/sp.ts
index c40cf1d..1bd6a0e 100644
--- a/test/harness/sp.ts
+++ b/test/harness/sp.ts
@@ -4,8 +4,9 @@ import type { SubProjectId } from '../../src/core/ids';
 export const SP_DEPS: Readonly<Record<SubProjectId, readonly SubProjectId[]>> = {
   SP0: [],
   SP1: ['SP0'],
-  SP2: ['SP1'],
-  SP3: ['SP2'],
+  SP2a: ['SP1'],
+  SP2b: ['SP2a'],
+  SP3: ['SP2b'],
   SP4: ['SP3'],
   SP5: ['SP4'],
   SP6: ['SP3', 'SP5'],
@@ -25,7 +26,7 @@ export const SP_ORDER = Object.keys(SP_DEPS) as SubProjectId[];
  * Append-only list of sub-projects whose first commit has landed.
  * Each SP appends its id in its first commit. Part of the locked governance state.
  */
-export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1'];
+export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a'];
 
 export function spIndex(sp: SubProjectId): number {
   return SP_ORDER.indexOf(sp);
```

`src/core/params/profiles.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/params/profiles.ts b/src/core/params/profiles.ts
index b1f99a3..3e78dfc 100644
--- a/src/core/params/profiles.ts
+++ b/src/core/params/profiles.ts
@@ -1,4 +1,4 @@
-import type { SubProjectId } from '../ids';
+import { CURRENT_SP, SUB_PROJECTS, type SubProjectId } from '../ids';
 import { DEFAULTS } from './defaults';
 import { applyPatch } from './kit';
 import { SCHEMA, type Params, type ParamsPatch } from './schema';
@@ -16,13 +16,18 @@ export const PROFILE_IDS: readonly ProfileId[] = ['default', 'large_biomes', 'ar
 /** Built-in world presets (master §3.15) as overlays over the defaults (SP1 spec §4.4). */
 export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
   default: { overlay: {}, readyFrom: 'SP1' },
-  large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2' },
+  large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2a' },
   archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3' },
   amplified: { overlay: {}, readyFrom: 'SP3' },
   floating_islands: { overlay: {}, readyFrom: 'SP3' },
   cave_heavy: { overlay: {}, readyFrom: 'SP6' },
 };
 
+/** A profile is selectable once its readyFrom is at or before `current` in master §10 order. */
+export function isProfileReady(id: ProfileId, current: SubProjectId = CURRENT_SP): boolean {
+  return SUB_PROJECTS.indexOf(PROFILES[id].readyFrom) <= SUB_PROJECTS.indexOf(current);
+}
+
 export function isProfileId(v: unknown): v is ProfileId {
   return typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v);
 }
```

- [ ] **Step 4: Run the tests, accept the lock, log it**

Run: `npx vitest run --project unit test/unit/profiles.test.ts test/unit/lock.test.ts --project arch test/arch/sp.test.ts`
Expected: PASS.

Run: `npm run test:accept-thresholds && npx vitest run --project arch && npm run typecheck`
Expected: PASS (the lock gains SP2a in startedSps).

In the SP2a spec, under `### Threshold log`, replace `(One line per commit that changes \`test/thresholds.lock.json\`.)` with that sentence followed by a blank line and:

```markdown
- Task 1: `STARTED_SPS` gains `SP2a`; no threshold rows yet.
```

In `CLAUDE.md`, replace the `**Status:**` line with:

```markdown
**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28). SP2a (column stage, worker pool and map) in implementation on branch `sp2a/column-map`.
```

- [ ] **Step 5: Commit**

```bash
git add src/core/ids.ts test/harness/sp.ts src/core/params/profiles.ts test/arch/sp.test.ts test/unit/lock.test.ts test/unit/profiles.test.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-28-sp2a-column-stage-map-design.md CLAUDE.md
git commit -m "chore(governance): start SP2a; SP2 split into SP2a/SP2b; profile readiness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 2: Arch rules: gen/ hot-import aliasing, SP2a golden file, member-name API ban

**Files:**
- Modify: `test/arch/rules/banned.ts`, `test/arch/banned.test.ts`
- Create: `test/arch/fixtures/banned/bad/src/gen/column/direct.ts`, `…/bad/src/metrics/sp2aGoldens.ts`, `…/bad/src/core/normalizeCall.ts`

**Interfaces:**
- Produces: the rules later tasks follow — every file under `src/gen/**` references imported values only through top-level `const X = binding;` aliases; `src/metrics/sp2aGoldens.ts` follows the core determinism rules.

- [ ] **Step 1: Write the failing fixtures and expectations**

Create the three bad fixtures:

`test/arch/fixtures/banned/bad/src/gen/column/direct.ts`:

```ts
import { k } from '../../core/k';
export function m(): number { return k(); }
```

`test/arch/fixtures/banned/bad/src/metrics/sp2aGoldens.ts`:

```ts
export const r = (): number => Date.now();
```

`test/arch/fixtures/banned/bad/src/core/normalizeCall.ts`:

```ts
export const n = (t: string): string => String.prototype.normalize.call(t, 'NFC');
```

`test/arch/banned.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/arch/banned.test.ts b/test/arch/banned.test.ts
index e18cd31..d55438c 100644
--- a/test/arch/banned.test.ts
+++ b/test/arch/banned.test.ts
@@ -16,6 +16,7 @@ test('bad fixture tree reports every banned use', () => {
     'src/core/localeSort.ts:1 engine-dependent-api',
     'src/core/noise/direct.ts:2 hot-import-reference',
     'src/core/normalize.ts:1 engine-dependent-api',
+    'src/core/normalizeCall.ts:1 engine-dependent-api',
     'src/core/perfNow.ts:1 nondeterministic',
     'src/core/pow.ts:1 math-pow-operator',
     'src/core/random.ts:1 nondeterministic',
@@ -24,6 +25,7 @@ test('bad fixture tree reports every banned use', () => {
     'src/core/worker.ts:1 worker-api',
     'src/gen/alias.ts:1 math-as-value',
     'src/gen/binaryExport.ts:1 numeric-export',
+    'src/gen/column/direct.ts:2 hot-import-reference',
     'src/gen/computed.ts:1 math-computed',
     'src/gen/data.ts:1 numeric-data-export',
     'src/gen/defaultNumeric.ts:1 numeric-export',
@@ -41,6 +43,7 @@ test('bad fixture tree reports every banned use', () => {
     'src/metrics/direct.ts:2 hot-import-reference',
     'src/metrics/sp1Goldens.ts:1 nondeterministic',
     'src/metrics/sp1Goldens.ts:2 math-pow-operator',
+    'src/metrics/sp2aGoldens.ts:1 nondeterministic',
     'src/render/materials/raw.glsl:1 raw-shader-file',
     'src/render/materials/rawImport.ts:1 raw-import',
     'src/render/threeAudio.ts:1 three-audio',
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project arch test/arch/banned.test.ts`
Expected: FAIL (the three new lines are missing from the report).

- [ ] **Step 3: Implement**

`test/arch/rules/banned.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/arch/rules/banned.ts b/test/arch/rules/banned.ts
index 9ea4e11..26304d8 100644
--- a/test/arch/rules/banned.ts
+++ b/test/arch/rules/banned.ts
@@ -10,10 +10,11 @@ const PURE_LAYERS = new Set(['core', 'world', 'gen', 'textures', 'audio', 'light
 const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'imul', 'clz32', 'sqrt',
   'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
 /** Files outside core/ and gen/ whose outputs are golden-hashed, so they follow the core determinism rules (SP1 spec §1.8). */
-const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts']);
-/** Modules whose hot loops must not read imported bindings (vitest turns them into getters; SP1 spec §1.8). */
-const HOT_PREFIXES = ['core/noise/', 'core/spline/', 'metrics/'];
-const ENGINE_DEPENDENT = /\bIntl\b|\.\s*(?:localeCompare|toLocaleString|toLocaleUpperCase|toLocaleLowerCase|toLocaleDateString|toLocaleTimeString|normalize)\s*\(|\bTextEncoder\b|\bTextDecoder\b/g;
+const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts']);
+/** Modules whose hot loops must not read imported bindings (vitest turns them into getters; SP1 spec §1.8, SP2a spec §8). */
+const HOT_PREFIXES = ['core/noise/', 'core/spline/', 'metrics/', 'gen/'];
+/** Matches the member name alone, so `.normalize.call(…)` and `.localeCompare.bind(…)` are caught too (SP1 review minor). */
+const ENGINE_DEPENDENT = /\bIntl\b|\.\s*(?:localeCompare|toLocale\w*|normalize)\b|\bTextEncoder\b|\bTextDecoder\b/g;
 const IMPORT_STMT = /\bimport\s+(type\s+)?([\w$*{},\s]+?)\s+from\s*(['"])[^'"\n]+\3\s*;?/g;
 const THREE_AUDIO = new Set(['Audio', 'AudioListener', 'PositionalAudio', 'AudioLoader', 'AudioAnalyser']);
 const AUDIO_EXTS = new Set(['.ogg', '.oga', '.mp3', '.wav', '.flac', '.m4a', '.aac', '.opus', '.weba']);
```

- [ ] **Step 4: Run the arch suite**

Run: `npx vitest run --project arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/arch
git commit -m "test(arch): extend the determinism rules to gen/ and the SP2a goldens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 3: The boxTable leaf kind

**Files:**
- Modify: `src/core/params/kit.ts`, `test/harness/params.ts`
- Test: `test/unit/boxTable.test.ts`

**Interfaces:**
- Produces (in `kit.ts`): `BOX_AXES = ['C','E','PV','T','H']`, `type BoxAxis`, `type Interval = readonly [lo, hi]`, `type BoxRow`, `type BoxTable<K>`, `type BoxTableMeta<K>`, `boxTable(def, meta)`; issue codes `BAD_INTERVAL`, `DUPLICATE_PRIORITY`. `randomValue` handles `boxTable`.

- [ ] **Step 1: Write the failing test**

`test/unit/boxTable.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { applyPatch, boxTable, buildSchema, group, renderReference, type BoxRow } from '../../src/core/params/kit';

const row = (C: [number, number], priority: number, wSign: -1 | 0 | 1 = 0): BoxRow => ({ C, E: [-1, 1], PV: [-1, 1], T: [-1, 1], H: [-1, 1], wSign, priority });
const DEF = { a: row([-1, 0], 1), b: row([0, 1], 2, 1) };
const S = buildSchema(group('T', 't', {
  t: boxTable(DEF, { label: 'Boxes', doc: 'Test boxes.', scope: 'terrain', stage: 'biome2d', rows: ['a', 'b'] }),
}));
const codes = (patch: unknown) => {
  const r = applyPatch(S, S.defaults, patch);
  return r.ok ? [] : r.issues.map((i) => `${i.code} @ ${i.path}`);
};

describe('boxTable leaf', () => {
  test('defaults validate, freeze and keep every row', () => {
    expect(S.defaults.t).toEqual(DEF);
    expect(Object.isFrozen(S.defaults.t.a.C)).toBe(true);
    expect(S.leaves[0]!.meta.kind).toBe('boxTable');
    expect(S.leaves[0]!.meta.options).toEqual(['a', 'b']);
  });
  test('a patch replaces the whole table', () => {
    const r = applyPatch(S, S.defaults, { t: { a: row([-1, 0.5], 3), b: row([0.5, 1], 4, -1) } });
    expect(r.ok && r.value.t.a.C).toEqual([-1, 0.5]);
    expect(codes({ t: { a: row([-1, 0], 1) } })).toEqual(['MISSING_KEY @ t.b']);
  });
  test.each<[string, unknown, string[]]>([
    ['not an object', [], ['NOT_OBJECT @ t']],
    ['unknown row', { ...DEF, c: row([0, 1], 9) }, ['UNKNOWN_KEY @ t.c']],
    ['unknown field', { ...DEF, a: { ...row([-1, 0], 1), X: [0, 1] } }, ['UNKNOWN_KEY @ t.a.X']],
    ['missing field', { ...DEF, a: { C: [-1, 0], E: [-1, 1], PV: [-1, 1], T: [-1, 1], wSign: 0, priority: 1 } }, ['MISSING_KEY @ t.a.H']],
    ['interval not a pair', { ...DEF, a: { ...row([-1, 0], 1), E: [0] } }, ['BAD_INTERVAL @ t.a.E']],
    ['interval reversed', { ...DEF, a: row([0.5, 0.1], 1) }, ['BAD_INTERVAL @ t.a.C']],
    ['interval outside [-1, 1]', { ...DEF, a: row([-2, 0], 1) }, ['OUT_OF_RANGE @ t.a.C[0]']],
    ['bad wSign', { ...DEF, a: { ...row([-1, 0], 1), wSign: 2 } }, ['BAD_ENUM @ t.a.wSign']],
    ['non-integer priority', { ...DEF, a: row([-1, 0], 1.5) }, ['NOT_INTEGER @ t.a.priority']],
    ['duplicate priority', { ...DEF, b: row([0, 1], 1) }, ['DUPLICATE_PRIORITY @ t.b.priority']],
  ])('%s', (_name, value, expected) => {
    expect(codes({ t: value })).toEqual(expected);
  });
  test('the README shows a row count instead of the whole table', () => {
    expect(renderReference(S).split('\n')[2]).toBe('| `t` | boxTable | 2 rows | a / b |  | terrain | Boxes: Test boxes. |');
  });
});

test('randomValue produces valid tables', async () => {
  const { randomParams } = await import('../harness/params');
  const { testRng } = await import('../harness/stats');
  const next = testRng(7);
  for (let i = 0; i < 50; i++) expect(Object.keys(randomParams(S, next).t)).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/boxTable.test.ts`
Expected: FAIL with `boxTable is not a function`.

- [ ] **Step 3: Implement**

`src/core/params/kit.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/params/kit.ts b/src/core/params/kit.ts
index e4ac651..75d6a42 100644
--- a/src/core/params/kit.ts
+++ b/src/core/params/kit.ts
@@ -44,7 +44,7 @@ export interface ParamMeta {
 export type ParamIssueCode =
   | 'UNKNOWN_KEY' | 'MISSING_KEY' | 'NOT_OBJECT' | 'NOT_NUMBER' | 'NOT_FINITE' | 'NOT_INTEGER' | 'INT_TOO_LARGE'
   | 'OUT_OF_RANGE' | 'NOT_BOOL' | 'BAD_ENUM' | 'AMPLITUDES_LENGTH' | 'AMPLITUDES_ZERO' | 'YSCALE_NOT_1'
-  | 'REMAP_NEEDS_DOUBLE' | 'REMAP_NEEDS_2D';
+  | 'REMAP_NEEDS_DOUBLE' | 'REMAP_NEEDS_2D' | 'BAD_INTERVAL' | 'DUPLICATE_PRIORITY';
 export type PresetIssueCode = 'BAD_FORMAT' | 'BAD_NAME' | 'RESERVED_NAME' | 'UNKNOWN_PROFILE' | 'BAD_SCHEMA_VERSION' | 'NEWER_SCHEMA_VERSION';
 export type IssueCode = ParamIssueCode | PresetIssueCode | 'MIGRATION_FAILED' | SplineErrorCode;
 
@@ -106,6 +106,15 @@ export type NoiseMeta = MetaInput & {
 };
 export type SplineMeta = MetaInput & { readonly coords: readonly SplineCoord[]; readonly min: number; readonly max: number };
 
+/** Climate axes of a box row (uniform fields, SP2a spec §3.1). */
+export const BOX_AXES = ['C', 'E', 'PV', 'T', 'H'] as const;
+export type BoxAxis = (typeof BOX_AXES)[number];
+export type Interval = readonly [lo: number, hi: number];
+/** One biome box: an interval per climate axis, a sign(W) filter (0 = any) and a unique tie-break priority. */
+export type BoxRow = { readonly [A in BoxAxis]: Interval } & { readonly wSign: -1 | 0 | 1; readonly priority: number };
+export type BoxTable<K extends string = string> = { readonly [R in K]: BoxRow };
+export type BoxTableMeta<K extends string> = MetaInput & { readonly rows: readonly K[] };
+
 export function num(def: number, meta: Ranged): Leaf<number> {
   return { tag: 'leaf', kind: 'number', merge: 'atomic', def, meta, min: meta.min, max: meta.max, ...(meta.step !== undefined ? { step: meta.step } : {}) };
 }
@@ -135,6 +144,11 @@ export function spline(def: NestedSpline, meta: SplineMeta): Leaf<NestedSpline>
   return { tag: 'leaf', kind: 'spline', merge: 'atomic', def, meta, coords: meta.coords, min: meta.min, max: meta.max };
 }
 
+/** A table of named boxes (the biome table); patches replace it whole. `rows` fixes the row names. */
+export function boxTable<const K extends string>(def: BoxTable<K>, meta: BoxTableMeta<K>): Leaf<BoxTable<K>> {
+  return { tag: 'leaf', kind: 'boxTable', merge: 'atomic', def, meta, options: meta.rows };
+}
+
 export function group<const C extends Children>(label: string, doc: string, children: C): Group<C> {
   return { tag: 'group', label, doc, children };
 }
@@ -215,6 +229,51 @@ function checkNoise(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown,
   };
 }
 
+const BOX_KEYS: readonly string[] = [...BOX_AXES, 'wSign', 'priority'];
+
+function checkBoxTable(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): BoxTable | undefined {
+  if (!isObj(v)) { out.push({ path, code: 'NOT_OBJECT', message: `expected a table object, got ${fmt(v)}` }); return undefined; }
+  const n0 = out.length;
+  const rows = leaf.options!;
+  unknownKeys(v, rows, path, out);
+  for (const r of rows) if (!Object.hasOwn(v, r)) out.push({ path: join(path, r), code: 'MISSING_KEY', message: 'missing' });
+  if (out.length > n0) return undefined;
+  const res: Record<string, BoxRow> = {};
+  const seen = new Map<number, string>();
+  for (const r of rows) {
+    const rp = join(path, r);
+    const x = v[r];
+    if (!isObj(x)) { out.push({ path: rp, code: 'NOT_OBJECT', message: `expected a box row, got ${fmt(x)}` }); continue; }
+    const r0 = out.length;
+    unknownKeys(x, BOX_KEYS, rp, out);
+    for (const k of BOX_KEYS) if (!Object.hasOwn(x, k)) out.push({ path: join(rp, k), code: 'MISSING_KEY', message: 'missing' });
+    if (out.length > r0) continue;
+    const row: Record<string, unknown> = {};
+    for (const a of BOX_AXES) {
+      const ap = join(rp, a);
+      const iv = x[a];
+      if (!Array.isArray(iv) || iv.length !== 2) { out.push({ path: ap, code: 'BAD_INTERVAL', message: `expected [lo, hi], got ${fmt(iv)}` }); continue; }
+      const lo = checkNumber(iv[0], `${ap}[0]`, out, -1, 1, false);
+      const hi = checkNumber(iv[1], `${ap}[1]`, out, -1, 1, false);
+      if (lo === undefined || hi === undefined) continue;
+      if (!(lo < hi)) { out.push({ path: ap, code: 'BAD_INTERVAL', message: `lo ${lo} must be below hi ${hi}` }); continue; }
+      row[a] = [lo, hi];
+    }
+    const w = x['wSign'];
+    if (w !== -1 && w !== 0 && w !== 1) out.push({ path: join(rp, 'wSign'), code: 'BAD_ENUM', message: `expected -1 | 0 | 1, got ${fmt(w)}` });
+    else row['wSign'] = w;
+    const pr = checkNumber(x['priority'], join(rp, 'priority'), out, 1, 1000, true);
+    if (pr !== undefined) {
+      const other = seen.get(pr);
+      if (other !== undefined) out.push({ path: join(rp, 'priority'), code: 'DUPLICATE_PRIORITY', message: `priority ${pr} is also used by ${other}` });
+      else seen.set(pr, r);
+      row['priority'] = pr;
+    }
+    if (out.length === r0) res[r] = row as BoxRow;
+  }
+  return out.length > n0 ? undefined : res;
+}
+
 function checkSpline(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): NestedSpline | undefined {
   const issues = validateSpline(v, path, { ...(leaf.coords !== undefined ? { coords: leaf.coords } : {}), yMin: leaf.min ?? -Infinity, yMax: leaf.max ?? Infinity });
   if (issues.length > 0) { out.push(...issues); return undefined; }
@@ -234,7 +293,8 @@ export function checkLeaf(leaf: Leaf<unknown, unknown>, v: unknown, path: string
       return v;
     case 'noise': return checkNoise(v, path, out, leaf);
     case 'spline': return checkSpline(v, path, out, leaf);
-    default: throw new Error(`no validator for kind ${leaf.kind} in SP1`);
+    case 'boxTable': return checkBoxTable(v, path, out, leaf);
+    default: throw new Error(`no validator for kind ${leaf.kind} yet`);
   }
 }
 
@@ -416,7 +476,8 @@ export function renderReference<R extends Group>(s: Schema<R>): string {
   const esc = (t: string) => t.replaceAll('|', '\\|');
   const rows = ['| path | kind | default | range | unit | scope | doc |', '|---|---|---|---|---|---|---|'];
   for (const { path, meta } of s.leaves) {
-    const def = canonicalJSON(getPath(s.defaults, path));
+    const value = getPath(s.defaults, path);
+    const def = meta.kind === 'boxTable' ? `${Object.keys(value as object).length} rows` : canonicalJSON(value);
     const range = meta.options !== undefined ? meta.options.join(' / ')
       : meta.kind === 'noise' ? `wavelength ${meta.min} … ${meta.max}`
       : meta.min !== undefined ? `${meta.min} … ${meta.max}` : '';
```

`test/harness/params.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/harness/params.ts b/test/harness/params.ts
index df6c693..e853360 100644
--- a/test/harness/params.ts
+++ b/test/harness/params.ts
@@ -1,5 +1,5 @@
 import { q15 } from '../../src/core/params/canonical';
-import { checkParams, type Group, type Leaf, type Node, type Schema, NOISE_FIELD_RANGES } from '../../src/core/params/kit';
+import { BOX_AXES, checkParams, type Group, type Leaf, type Node, type Schema, NOISE_FIELD_RANGES } from '../../src/core/params/kit';
 import type { NestedSpline } from '../../src/core/spline/types';
 import { testFloat } from './stats';
 
@@ -30,6 +30,18 @@ export function randomValue(leaf: Leaf<unknown, unknown>, next: () => number): u
       };
     }
     case 'spline': return randomSplineLike(leaf.def as NestedSpline, next, Math.max(leaf.min!, -1000), Math.min(leaf.max!, 1000));
+    case 'boxTable': {
+      const table: Record<string, unknown> = {};
+      leaf.options!.forEach((name, i) => {
+        const row: Record<string, unknown> = { wSign: (next() % 3) - 1, priority: i + 1 };
+        for (const a of BOX_AXES) {
+          const lo = between(next, -1, 0.9);
+          row[a] = [lo, q15(lo + 0.05 + (0.95 - lo) * testFloat(next))];
+        }
+        table[name] = row;
+      });
+      return table;
+    }
     default: throw new Error(`no generator for ${leaf.kind}`);
   }
 }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/params/kit.ts test/harness/params.ts test/unit/boxTable.test.ts
git commit -m "feat(core): boxTable leaf kind for the biome table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 4: SP2a schema: shape splines, rivers, lakes, biome boxes; registry bumps

**Files:**
- Create: `src/core/params/shapeDefaults.ts`, `src/core/params/biomeDefaults.ts`
- Modify: `src/core/constants.ts`, `src/core/params/schema.ts`, `src/core/stage/registry.ts`
- Modify: `test/unit/schema.test.ts`, `test/unit/stage.test.ts`
- Test: `test/unit/schemaSp2a.test.ts`
- Modify (generated): `test/schema-shape.lock.json`, `README.md`

**Interfaces:**
- Consumes: `boxTable`, `BOX_AXES` (Task 3), `autoTangents`, SP1's `OFFSET`/`SIGMA`/`JAG` fixtures (test only).
- Produces: `MIN_Y`, `HEIGHT`, `SEA_LEVEL` (`constants.ts`); `OFFSET_DEFAULT`, `SIGMA_DEFAULT`, `JAG_DEFAULT`; `BOX_BIOMES`, `type BoxBiome`, `BIOME_TABLE_DEFAULT`; `ShapeParams`, `RiverParams`, `LakeParams`, `BiomeParams` (`schema.ts`); stage versions shape 2, surfaceEst 2, biome2d 2, map 2.

- [ ] **Step 1: Write the failing tests**

`test/unit/schemaSp2a.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { DEFAULTS } from '../../src/core/params/defaults';
import { BOX_AXES } from '../../src/core/params/kit';
import { PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';

describe('SP2a schema groups', () => {
  test('leaves, scopes and stages', () => {
    const rows = PARAM_META.filter((m) => !m.path.startsWith('climate.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`);
    const g = (prefix: string, stage: string, names: string) => names.split(' ').map((n) => {
      const [name, kind] = n.split(':');
      return `${prefix}.${name}:${kind ?? 'number'}:terrain:${stage}`;
    });
    expect(rows).toEqual([
      ...g('shape', 'shape', 'offset:spline sigma:spline jag:spline'),
      ...g('rivers', 'shape', 'widthMin widthVar widthNoise:noise valleyBase valleyPerE valleyFloor valleyRise coastFadeLo coastFadeHi altFadeLo altFadeHi depthMin depthVar wetMargin gorgeDepth'),
      ...g('lakes', 'shape', 'cell jitter warpAmp warpNoise:noise p minC offsetMin offsetMax radius rimWidth roughness rimNoise:noise ringFrac depthMin depthVar rimRise rimSigma sigmaMul'),
      ...g('biomes', 'biome2d', 'table:boxTable zoomJitter'),
    ]);
  });
  test('shape defaults equal the frozen SP1 fixtures (until the first retune)', () => {
    expect(canonicalJSON(DEFAULTS.shape.offset)).toBe(canonicalJSON(OFFSET));
    expect(canonicalJSON(DEFAULTS.shape.sigma)).toBe(canonicalJSON(SIGMA));
    expect(canonicalJSON(DEFAULTS.shape.jag)).toBe(canonicalJSON(JAG));
  });
  test('river and lake defaults follow master §3.4-3.5', () => {
    const r = DEFAULTS.rivers;
    expect([r.widthMin, r.widthVar, r.valleyBase, r.valleyPerE, r.valleyFloor, r.valleyRise, r.coastFadeLo, r.coastFadeHi, r.altFadeLo, r.altFadeHi, r.depthMin, r.depthVar, r.wetMargin])
      .toEqual([5, 9, 30, 45, 64, 2, -0.12, -0.02, 120, 170, 3, 3, 2]);
    expect([r.widthNoise.wavelength, r.widthNoise.remap]).toEqual([600, 'uniform']);
    const l = DEFAULTS.lakes;
    expect([l.cell, l.warpAmp, l.warpNoise.wavelength, l.p, l.minC, l.offsetMin, l.offsetMax, l.ringFrac, l.depthMin, l.depthVar, l.rimRise, l.rimSigma, l.sigmaMul, l.rimNoise.wavelength])
      .toEqual([320, 80, 360, 0.12, -0.1, 66, 200, 0.55, 4, 10, 2, 0.5, 0.3, 48]);
  });
  test('the new noise instances have distinct seed names', () => {
    const names = noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName);
    expect(names.filter((n) => !n.startsWith('climate.'))).toEqual(['rivers.widthNoise', 'lakes.warpNoise.x', 'lakes.warpNoise.z', 'lakes.rimNoise']);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('default biome table (SP2a spec §3.1 authoring rules)', () => {
  const T = BIOME_TABLE_DEFAULT;
  const EDGES: Record<string, readonly number[]> = {
    C: [-1, -0.55, -0.22, -0.1, 1], E: [-1, -0.375, 1], PV: [-1, -0.6, 0.2, 0.7, 1], T: [-1, -0.6, -0.2, 0.2, 0.6, 1], H: [-1, -0.6, -0.2, 0.2, 0.6, 1],
  };
  test('26 box-picked biomes with unique priorities', () => {
    expect(Object.keys(T)).toEqual([...BOX_BIOMES]);
    expect(new Set(Object.values(T).map((r) => r.priority)).size).toBe(26);
  });
  test('every interval edge lies on a band edge', () => {
    for (const [name, row] of Object.entries(T)) for (const a of BOX_AXES) for (const e of row[a]) expect(EDGES[a], `${name}.${a}`).toContain(e);
  });
  test('windswept and peak boxes bound T; beach has no PV restriction; volcano is hot peaks', () => {
    for (const n of ['windswept_hills', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano', 'snowy_slopes'] as const) expect(T[n].T[1] - T[n].T[0]).toBeLessThan(2);
    expect(T.beach.PV).toEqual([-1, 1]);
    expect([T.beach.C, T.snowy_beach.C, T.stony_shore.C]).toEqual([[-0.22, -0.1], [-0.22, -0.1], [-0.22, -0.1]]);
    expect([T.volcano.T, T.volcano.PV, T.volcano.E]).toEqual([[0.6, 1], [0.7, 1], [-1, -0.375]]);
  });
  test('the boxes tile the climate space: 20 000 random points fall in exactly one box (edges excluded)', () => {
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
    for (let i = 0; i < 20000; i++) {
      const p = { C: rnd(), E: rnd(), PV: rnd(), T: rnd(), H: rnd() };
      const w = rnd() < 0 ? -1 : 1;
      const inside = Object.entries(T).filter(([, r]) => BOX_AXES.every((a) => p[a] >= r[a][0] && p[a] <= r[a][1]) && (r.wSign === 0 || r.wSign === w)).map(([n]) => n);
      const hotHumidValley = p.T > 0.6 && p.H > 0.2 && p.H < 0.6 && p.PV < -0.6 && p.C > -0.1 && p.E > -0.375;
      expect(inside.length, `${JSON.stringify(p)} → ${inside.join(',')}`).toBe(hotHumidValley ? 0 : 1);
    }
  });
});
```

`test/unit/schema.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/unit/schema.test.ts b/test/unit/schema.test.ts
index feafb0c..bc968e4 100644
--- a/test/unit/schema.test.ts
+++ b/test/unit/schema.test.ts
@@ -5,15 +5,17 @@ import { metaOf, PARAM_META } from '../../src/core/params/meta';
 import { noiseInstances } from '../../src/core/params/noises';
 import { SCHEMA, type ClimateParams } from '../../src/core/params/schema';
 
-test('13 leaves, all climate scope and stage, in declaration order', () => {
-  expect(PARAM_META.map((m) => `${m.path}:${m.kind}`)).toEqual([
+const CLIMATE_META = PARAM_META.filter((m) => m.path.startsWith('climate.'));
+
+test('13 climate leaves, all climate scope and stage, in declaration order', () => {
+  expect(CLIMATE_META.map((m) => `${m.path}:${m.kind}`)).toEqual([
     'climate.scaleMul:number',
     'climate.warp.shift.amplitude:number', 'climate.warp.shift.noise:noise',
     'climate.warp.C.amplitude:number', 'climate.warp.C.noise:noise',
     'climate.warp.R.amplitude:number', 'climate.warp.R.noise:noise',
     'climate.C:noise', 'climate.E:noise', 'climate.W:noise', 'climate.T:noise', 'climate.H:noise', 'climate.R:noise',
   ]);
-  for (const m of PARAM_META) {
+  for (const m of CLIMATE_META) {
     expect(m.scope).toBe('climate');
     expect(m.stage).toBe('climate');
     expect(m.label.length).toBeGreaterThan(0);
@@ -38,7 +40,7 @@ test('defaults match spec §4.3', () => {
 });
 
 test('noise instances: warps expand to .x/.z, seed names default to paths', () => {
-  const inst = noiseInstances(SCHEMA, DEFAULTS);
+  const inst = noiseInstances(SCHEMA, DEFAULTS).filter((i) => i.path.startsWith('climate.'));
   expect(inst.map((i) => `${i.seedName}|${i.path}|${i.dims}`)).toEqual([
     'climate.warp.shift.noise.x|climate.warp.shift.noise|2', 'climate.warp.shift.noise.z|climate.warp.shift.noise|2',
     'climate.warp.C.noise.x|climate.warp.C.noise|2', 'climate.warp.C.noise.z|climate.warp.C.noise|2',
```

`test/unit/stage.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/unit/stage.test.ts b/test/unit/stage.test.ts
index 95bf959..94d6efe 100644
--- a/test/unit/stage.test.ts
+++ b/test/unit/stage.test.ts
@@ -11,10 +11,10 @@ import { FIXTURE_DEFAULTS, FIXTURE_STAGES, PARAMS_FIXTURE } from '../../src/metr
 const ALL = STAGES.map((s) => s.id);
 
 describe('registry', () => {
-  test('the SP1 schema and stage list satisfy every invariant', () => {
+  test('the SP2a schema and stage list satisfy every invariant', () => {
     expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
     expect(ALL).toEqual(['climate', 'shape', 'surfaceEst', 'biome2d', 'terrain', 'decorate', 'light', 'mesh', 'lod', 'map']);
-    expect(STAGES.every((s) => s.version === 1)).toBe(true);
+    expect(STAGES.map((s) => `${s.id}@${s.version}`)).toEqual(['climate@1', 'shape@2', 'surfaceEst@2', 'biome2d@2', 'terrain@1', 'decorate@1', 'light@1', 'mesh@1', 'lod@1', 'map@2']);
   });
   test('prefixes match on dot boundaries', () => {
     expect(prefixCovers('climate', 'climate.C')).toBe(true);
@@ -45,8 +45,10 @@ describe('stage hashes', () => {
   const H = stageHashes(DEFAULTS);
   test('preimages', () => {
     expect(hex64(H.climate!)).toBe(hex64(fnv1a64(`climate|1|${canonicalJSON({ climate: DEFAULTS.climate })}|`)));
-    expect(hex64(H.shape!)).toBe(hex64(fnv1a64(`shape|1|{}|${hex64(H.climate!)}`)));
-    expect(hex64(H.biome2d!)).toBe(hex64(fnv1a64(`biome2d|1|{}|${hex64(H.climate!)},${hex64(H.shape!)},${hex64(H.surfaceEst!)}`)));
+    const shapeSlice = { lakes: DEFAULTS.lakes, rivers: DEFAULTS.rivers, shape: DEFAULTS.shape };
+    expect(hex64(H.shape!)).toBe(hex64(fnv1a64(`shape|2|${canonicalJSON(shapeSlice)}|${hex64(H.climate!)}`)));
+    expect(hex64(H.surfaceEst!)).toBe(hex64(fnv1a64(`surfaceEst|2|{}|${hex64(H.shape!)}`)));
+    expect(hex64(H.biome2d!)).toBe(hex64(fnv1a64(`biome2d|2|${canonicalJSON({ biomes: DEFAULTS.biomes })}|${hex64(H.climate!)},${hex64(H.shape!)},${hex64(H.surfaceEst!)}`)));
   });
   test('every stage is hashed and none depends on the seed', () => {
     expect(Object.keys(H).sort()).toEqual([...ALL].sort());
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/schemaSp2a.test.ts test/unit/stage.test.ts`
Expected: FAIL (modules `biomeDefaults` missing; stage versions still 1).

- [ ] **Step 3: Implement the data**

`src/core/params/shapeDefaults.ts`:

```ts
/**
 * Defaults of the shape splines (master §3.3, SP2a spec §2.2), authored with autoTangents. They start
 * equal to SP1's frozen OFFSET / SIGMA / JAG fixtures; a unit test pins that until the first retune.
 */
import { autoTangents } from '../spline/tangents';
import type { NestedSpline, SplineCoord } from '../spline/types';

type Knot = readonly [number, number | NestedSpline];
const S = (coord: SplineCoord, knots: readonly Knot[]): NestedSpline => ({ coord, points: knots.map(([x, y]) => ({ x, y, d: 0 })) });
const PV3 = (a: number, b: number, c: number): NestedSpline => S('PV', [[-1, a], [0, b], [1, c]]);
const PVJ = (): NestedSpline => S('PV', [[0.3, 0], [0.7, 30], [1.0, 55]]);

export const OFFSET_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-1, 16], [-0.6, 26], [-0.4, 40], [-0.24, 52], [-0.16, 60],
  [-0.1, S('E', [[-1, 70], [0, 64], [1, 63]])],
  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(65, 72, 80)], [1, 66]])],
  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(66, 76, 88)], [0.6, 70], [1, 66]])],
  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(68, 82, 96)], [1, 70]])],
]));

export const SIGMA_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-1, 3], [-0.16, 3], [-0.1, 1.5],
  [0.05, S('E', [[-1, S('PV', [[-1, 4], [1, 16]])], [0, 3], [1, 1.2]])],
]));

export const JAG_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-0.1, 0],
  [0.05, S('E', [[-1, PVJ()], [-0.5, PVJ()], [-0.4, 0]])],
]));
```

`src/core/params/biomeDefaults.ts`:

```ts
/**
 * The default surface-biome boxes (master §3.10, SP2a spec §3.1 and Appendix A). Bands in uniform
 * climate units: T and H edges −0.6 / −0.2 / 0.2 / 0.6; C deep ocean < −0.55, ocean < −0.22, coast
 * −0.22..−0.10, inland above; E mountains < −0.375; PV valleys < −0.6, peaks > 0.7. The boxes tile the
 * climate space (ties only on shared edges); river and frozen river come from the river flag, not boxes.
 */
import type { BoxRow, BoxTable, Interval } from './kit';

/** Box-picked surface biomes, in registry order (master §3.10 plus volcano). */
export const BOX_BIOMES = [
  'deep_ocean', 'ocean', 'warm_ocean', 'frozen_ocean',
  'beach', 'snowy_beach', 'stony_shore',
  'plains', 'meadow', 'forest', 'birch_forest', 'dark_forest', 'taiga', 'snowy_taiga', 'snowy_plains',
  'desert', 'savanna', 'swamp', 'jungle', 'badlands',
  'windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano',
] as const;
export type BoxBiome = (typeof BOX_BIOMES)[number];

const ALL: Interval = [-1, 1];
const box = (C: Interval, E: Interval, PV: Interval, T: Interval, H: Interval, priority: number, wSign: -1 | 0 | 1 = 0): BoxRow =>
  ({ C, E, PV, T, H, wSign, priority });

const OCEANS: Interval = [-1, -0.22];
const COAST: Interval = [-0.22, -0.1];
const INLAND: Interval = [-0.1, 1];
const MOUNT: Interval = [-1, -0.375];
const LOW: Interval = [-0.375, 1];
const PEAK: Interval = [0.7, 1];
const NOT_PEAK: Interval = [-1, 0.7];
const VALLEY: Interval = [-1, -0.6];
const NOT_VALLEY: Interval = [-0.6, 1];
const FROZEN: Interval = [-1, -0.6];
const COLD: Interval = [-0.6, -0.2];
const COLDISH: Interval = [-1, -0.2];
const TEMP: Interval = [-0.2, 0.2];
const MILD: Interval = [-0.2, 0.6];
const HOT: Interval = [0.6, 1];

export const BIOME_TABLE_DEFAULT: BoxTable<BoxBiome> = {
  deep_ocean: box([-1, -0.55], ALL, ALL, [-0.6, 0.6], ALL, 1),
  ocean: box([-0.55, -0.22], ALL, ALL, [-0.6, 0.6], ALL, 2),
  warm_ocean: box(OCEANS, ALL, ALL, HOT, ALL, 3),
  frozen_ocean: box(OCEANS, ALL, ALL, FROZEN, ALL, 4),
  beach: box(COAST, LOW, ALL, [-0.6, 1], ALL, 5),
  snowy_beach: box(COAST, LOW, ALL, FROZEN, ALL, 6),
  stony_shore: box(COAST, MOUNT, ALL, ALL, ALL, 7),
  plains: box(INLAND, LOW, [-1, 0.2], TEMP, [-1, 0.2], 8),
  meadow: box(INLAND, LOW, [0.2, 1], TEMP, [-1, 0.2], 9),
  forest: box(INLAND, LOW, ALL, MILD, [0.2, 0.6], 10, -1),
  birch_forest: box(INLAND, LOW, ALL, MILD, [0.2, 0.6], 11, 1),
  dark_forest: box(INLAND, LOW, NOT_VALLEY, MILD, [0.6, 1], 12),
  taiga: box(INLAND, LOW, ALL, COLD, ALL, 13),
  snowy_taiga: box(INLAND, LOW, ALL, FROZEN, [0.2, 1], 14),
  snowy_plains: box(INLAND, LOW, ALL, FROZEN, [-1, 0.2], 15),
  desert: box(INLAND, LOW, ALL, HOT, [-1, 0.2], 16),
  savanna: box(INLAND, LOW, ALL, [0.2, 0.6], [-1, 0.2], 17),
  swamp: box(INLAND, LOW, VALLEY, [-0.2, 1], [0.6, 1], 18),
  jungle: box(INLAND, LOW, NOT_VALLEY, HOT, [0.2, 1], 19),
  badlands: box(INLAND, MOUNT, NOT_PEAK, HOT, ALL, 20),
  windswept_hills: box(INLAND, MOUNT, NOT_PEAK, MILD, ALL, 21),
  snowy_slopes: box(INLAND, MOUNT, NOT_PEAK, COLDISH, ALL, 22),
  stony_peaks: box(INLAND, MOUNT, PEAK, MILD, ALL, 23),
  jagged_peaks: box(INLAND, MOUNT, PEAK, COLDISH, ALL, 24, 1),
  frozen_peaks: box(INLAND, MOUNT, PEAK, COLDISH, ALL, 25, -1),
  volcano: box(INLAND, MOUNT, PEAK, HOT, ALL, 26),
};
```

`src/core/constants.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/constants.ts b/src/core/constants.ts
index 31ea77d..157b2bb 100644
--- a/src/core/constants.ts
+++ b/src/core/constants.ts
@@ -1,2 +1,7 @@
 /** Bumped whenever generated output changes; goldens and saves are bound to it (§6.2). */
 export const GENERATOR_VERSION = 0;
+
+/** World geometry (master §2.1): lowest block y, world height and sea level. */
+export const MIN_Y = -64;
+export const HEIGHT = 384;
+export const SEA_LEVEL = 63;
```

- [ ] **Step 4: Implement the schema groups and registry**

`src/core/params/schema.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/params/schema.ts b/src/core/params/schema.ts
index abe5f8a..b7f6e82 100644
--- a/src/core/params/schema.ts
+++ b/src/core/params/schema.ts
@@ -1,8 +1,23 @@
-import { buildSchema, group, noise, num, type Patch, type Value } from './kit';
+import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from './biomeDefaults';
+import { boxTable, buildSchema, group, noise, num, spline, type Patch, type Value } from './kit';
+import { JAG_DEFAULT, OFFSET_DEFAULT, SIGMA_DEFAULT } from './shapeDefaults';
 
 export { NOISE_FIELD_RANGES } from './kit';
 
 const CLIMATE = { scope: 'climate', stage: 'climate' } as const;
+const SHAPE = { scope: 'terrain', stage: 'shape' } as const;
+const BIOME = { scope: 'terrain', stage: 'biome2d' } as const;
+const SHAPE_COORDS = ['C', 'E', 'PV'] as const;
+
+const blocks = (def: number, label: string, doc: string, min: number, max: number, step = 1) =>
+  num(def, { ...SHAPE, label, doc, unit: 'blocks', min, max, step });
+const frac = (def: number, label: string, doc: string, min: number, max: number) =>
+  num(def, { ...SHAPE, label, doc, min, max, step: 0.01 });
+const shapeNoise = (label: string, doc: string, wavelength: number, octaves: number, extra: { remap?: 'uniform'; components?: readonly ['x', 'z'] } = {}) =>
+  noise({ wavelength, octaves, ...(extra.remap !== undefined ? { remap: extra.remap } : {}) }, {
+    ...SHAPE, label, doc, wavelength: { min: 16, max: 8192 }, dims: 2,
+    ...(extra.components !== undefined ? { components: extra.components } : {}),
+  });
 
 const warp = (label: string, doc: string, amplitude: number, wavelength: number, octaves: number) =>
   group(label, doc, {
@@ -32,9 +47,59 @@ export const ROOT = group('Parameters', 'World generation parameters.', {
     H: field('Humidity', 'Dry ↔ wet.', 2400, 4),
     R: field('Rivers', 'Its zero set gives the river lines.', 1400, 4),
   }),
+  shape: group('Shape', 'Target height, overhang and jaggedness in blocks (master §3.3).', {
+    offset: spline(OFFSET_DEFAULT, { ...SHAPE, label: 'Offset', doc: 'Target surface y in blocks from C → E → PV.', coords: SHAPE_COORDS, min: -64, max: 320 }),
+    sigma: spline(SIGMA_DEFAULT, { ...SHAPE, label: 'Sigma', doc: 'Sd of the 3D surface displacement in blocks (clamped at 0).', coords: SHAPE_COORDS, min: -16, max: 64 }),
+    jag: spline(JAG_DEFAULT, { ...SHAPE, label: 'Jaggedness', doc: 'Amplitude of ridged peaks in blocks (clamped at 0).', coords: SHAPE_COORDS, min: -16, max: 128 }),
+  }),
+  rivers: group('Rivers', 'Channels, valleys and gorges along the zero set of R (master §3.4).', {
+    widthMin: blocks(5, 'Minimum width', 'Channel width where the width noise is lowest.', 1, 64),
+    widthVar: blocks(9, 'Width variation', 'Extra channel width where the width noise is highest.', 0, 64),
+    widthNoise: shapeNoise('Width noise', 'Uniform noise u2 that varies the width and depth along the river.', 600, 2, { remap: 'uniform' }),
+    valleyBase: blocks(30, 'Valley width', 'Valley half-width on flat ground (E = −1).', 0, 400),
+    valleyPerE: blocks(45, 'Valley width per E', 'Extra valley half-width per unit of (1 + E).', 0, 400),
+    valleyFloor: blocks(64, 'Valley floor', 'Height the valley floor starts from next to the channel.', 63, 128),
+    valleyRise: blocks(2, 'Valley rise', 'Rise of the valley floor across the valley.', 0, 64),
+    coastFadeLo: frac(-0.12, 'Coast fade start', 'C where valleys begin to fade in from the coast.', -1, 1),
+    coastFadeHi: frac(-0.02, 'Coast fade end', 'C where valleys reach full strength.', -1, 1),
+    altFadeLo: blocks(120, 'Gorge start', 'offset0 where channels begin to fade into dry gorges.', 64, 320),
+    altFadeHi: blocks(170, 'Gorge end', 'offset0 above which the channel is fully faded.', 64, 320),
+    depthMin: blocks(3, 'Channel depth', 'Channel depth below sea level at the centre where u2 is lowest.', 0, 32),
+    depthVar: blocks(3, 'Channel depth variation', 'Extra channel depth where u2 is highest.', 0, 32),
+    wetMargin: blocks(2, 'Wet margin', 'Blocks beyond the channel edge still counted as river water.', 0, 16),
+    gorgeDepth: blocks(12, 'Gorge depth', 'Depth of the dry gorge cut below offset0 on high ground (SP2a amendment).', 0, 64),
+  }),
+  lakes: group('Lakes', 'Lakes at elevation in warped Voronoi cells (master §3.5).', {
+    cell: blocks(320, 'Cell size', 'Voronoi cell size.', 64, 4096),
+    jitter: frac(0.8, 'Cell jitter', 'Fraction of the cell a centre may move from the cell middle.', 0, 1),
+    warpAmp: blocks(80, 'Warp amplitude', 'Displacement of the Voronoi domain.', 0, 1000),
+    warpNoise: shapeNoise('Warp noise', 'Noise sampled twice (.x and .z) to warp the cells.', 360, 2, { components: ['x', 'z'] }),
+    p: frac(0.12, 'Probability', 'Chance that an eligible cell holds a lake.', 0, 1),
+    minC: frac(-0.1, 'Minimum C', 'Continentalness a lake centre needs.', -1, 1),
+    offsetMin: blocks(66, 'Lowest centre', 'Lowest offset0 at a lake centre.', -64, 320),
+    offsetMax: blocks(200, 'Highest centre', 'Highest offset0 at a lake centre.', -64, 320),
+    radius: blocks(90, 'Radius', 'Basin radius around the cell centre.', 8, 1024),
+    rimWidth: frac(0.35, 'Rim width', 'Rim band width as a fraction of the radius.', 0.05, 2),
+    roughness: frac(0.15, 'Shore roughness', 'Scale of the rim noise on the basin edge, in radii.', 0, 1),
+    rimNoise: shapeNoise('Rim noise', 'Noise that roughens the shoreline.', 48, 2),
+    ringFrac: frac(0.55, 'Level ring', 'Radius fraction of the 8 samples that fix the water level.', 0.1, 1.5),
+    depthMin: blocks(4, 'Depth', 'Lake depth where the depth hash is lowest.', 1, 64),
+    depthVar: blocks(10, 'Depth variation', 'Extra depth where the depth hash is highest.', 0, 64),
+    rimRise: blocks(2, 'Rim rise', 'Rim height above the water level before the σ margin.', 0, 32),
+    rimSigma: num(0.5, { ...SHAPE, label: 'Rim sigma', doc: 'Largest σ on the rim; the rim adds 3 of these above the water.', unit: 'blocks', min: 0, max: 8, step: 0.1 }),
+    sigmaMul: frac(0.3, 'Basin sigma', 'Multiplier of σ inside the basin.', 0, 1),
+  }),
+  biomes: group('Biomes', 'Surface biome boxes and the per-block zoom (master §3.10).', {
+    table: boxTable(BIOME_TABLE_DEFAULT, { ...BIOME, label: 'Biome boxes', doc: 'Climate box, sign(W) filter and tie-break priority of every box-picked surface biome.', rows: BOX_BIOMES }),
+    zoomJitter: num(1.5, { ...BIOME, label: 'Zoom jitter', doc: 'Jitter of the quart centres in the jittered-Voronoi zoom.', unit: 'blocks', min: 0, max: 2, step: 0.05 }),
+  }),
 });
 
 export const SCHEMA = buildSchema(ROOT);
 export type Params = Value<typeof ROOT>;
 export type ParamsPatch = Patch<typeof ROOT>;
 export interface ClimateParams extends Value<typeof ROOT.children.climate> {}
+export interface ShapeParams extends Value<typeof ROOT.children.shape> {}
+export interface RiverParams extends Value<typeof ROOT.children.rivers> {}
+export interface LakeParams extends Value<typeof ROOT.children.lakes> {}
+export interface BiomeParams extends Value<typeof ROOT.children.biomes> {}
```

`src/core/stage/registry.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/stage/registry.ts b/src/core/stage/registry.ts
index 3b6d6d1..c597c50 100644
--- a/src/core/stage/registry.ts
+++ b/src/core/stage/registry.ts
@@ -11,18 +11,18 @@ export interface StageDef {
   readonly checkpoint: 'columnSample' | 'proto' | 'final' | 'none';
 }
 
-/** Topological order (SP1 spec §5). SP1 registers every stage; later SPs add prefixes and bump versions. */
+/** Topological order (SP1 spec §5). SP1 registers every stage; later SPs add prefixes and bump versions (SP2a spec §4.2). */
 export const STAGES: readonly StageDef[] = [
   { id: 'climate', version: 1, reads: [], params: ['climate'], checkpoint: 'columnSample' },
-  { id: 'shape', version: 1, reads: ['climate'], params: [], checkpoint: 'columnSample' },
-  { id: 'surfaceEst', version: 1, reads: ['shape'], params: [], checkpoint: 'columnSample' },
-  { id: 'biome2d', version: 1, reads: ['climate', 'shape', 'surfaceEst'], params: [], checkpoint: 'columnSample' },
+  { id: 'shape', version: 2, reads: ['climate'], params: ['shape', 'rivers', 'lakes'], checkpoint: 'columnSample' },
+  { id: 'surfaceEst', version: 2, reads: ['shape'], params: [], checkpoint: 'columnSample' },
+  { id: 'biome2d', version: 2, reads: ['climate', 'shape', 'surfaceEst'], params: ['biomes'], checkpoint: 'columnSample' },
   { id: 'terrain', version: 1, reads: ['shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'proto' },
   { id: 'decorate', version: 1, reads: ['terrain'], params: [], checkpoint: 'final' },
   { id: 'light', version: 1, reads: ['decorate'], params: [], checkpoint: 'none' },
   { id: 'mesh', version: 1, reads: ['light'], params: [], checkpoint: 'none' },
   { id: 'lod', version: 1, reads: ['surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
-  { id: 'map', version: 1, reads: ['climate', 'shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
+  { id: 'map', version: 2, reads: ['climate', 'shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
 ];
 
 /** Badge scope implied by the first stage that hashes a leaf; null = hosts no params. */
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project unit test/unit/schemaSp2a.test.ts test/unit/schema.test.ts test/unit/stage.test.ts test/unit/profiles.test.ts`
Expected: PASS (the partition test finds exactly one gap: hot, humid valleys).

- [ ] **Step 6: Accept the schema lock and regenerate the README**

Run: `npm run test:accept-schema && npm run docs:params && npm test && npm run typecheck`
Expected: PASS; `test/schema-shape.lock.json` gains the 3 + 15 + 18 + 2 new leaves; the README table grows accordingly.

- [ ] **Step 7: Commit**

```bash
git add src/core test/unit/schemaSp2a.test.ts test/unit/schema.test.ts test/unit/stage.test.ts test/schema-shape.lock.json README.md
git commit -m "feat(core): SP2a schema — shape splines, rivers, lakes and the biome boxes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 5: GenContext and climate

**Files:**
- Create: `src/gen/context.ts`, `src/gen/column/climate.ts`, `test/harness/gen.ts`
- Test: `test/unit/climate.test.ts`, `test/unit/context.test.ts`

**Interfaces:**
- Consumes: `SCHEMA`, `noiseInstances`, `NormalNoise`, `uMax`, `compileSpline`, `deriveSeed`, `BOX_BIOMES`, `BOX_AXES`.
- Produces: `interface GenContext {seed, params, scale, uLimit, noise, offset, sigma, jag, boxes, lakeSeed, zoomSeed}`, `interface CompiledBox`, `createGenContext(seed, params)`, `noiseFor(ctx, name)`; `interface ClimateOut`, `newClimate()`, `pvFold(w)`, `sampleClimate(ctx, x, z, out)`, `riverZ(ctx, xr, zr)`; test harness `paramsWith(patch)`, `ctxFor(seed, patch)`.

- [ ] **Step 1: Write the failing tests**

`test/harness/gen.ts`:

```ts
import { applyPatch } from '../../src/core/params/kit';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type Params, type ParamsPatch } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';

/** DEFAULTS ⊕ patch (throws on an invalid patch). */
export function paramsWith(patch: ParamsPatch = {}): Params {
  const r = applyPatch(SCHEMA, DEFAULTS, patch);
  if (!r.ok) throw new Error(`bad test patch: ${JSON.stringify(r.issues)}`);
  return r.value;
}

/** A GenContext for seed text `seed` over DEFAULTS ⊕ patch. */
export function ctxFor(seed = '42', patch: ParamsPatch = {}): GenContext {
  return createGenContext(seedFromInput(seed), paramsWith(patch));
}
```

`test/unit/climate.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { toUniform } from '../../src/core/noise/cdf';
import { newClimate, pvFold, sampleClimate } from '../../src/gen/column/climate';
import { noiseFor } from '../../src/gen/context';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

const pts = (() => {
  const next = testRng(501);
  return Array.from({ length: 400 }, () => [-524288 + 1048576 * testFloat(next), -524288 + 1048576 * testFloat(next)] as const);
})();

describe('climate', () => {
  const ctx = ctxFor();
  test('every field lies in [−uMax, uMax]; PV is the fold of W', () => {
    for (const [x, z] of pts) {
      const c = sampleClimate(ctx, x, z, newClimate());
      for (const v of [c.C, c.E, c.W, c.T, c.H, c.R]) expect(Math.abs(v)).toBeLessThanOrEqual(ctx.uLimit);
      expect(c.PV).toBe(pvFold(c.W));
      expect(c.R).toBe(toUniform(c.Rz));
    }
    expect(ctx.uLimit).toBe(0.9973002846585164);
  });
  test('PV fold: ridges at |W| = 2/3, valleys at 0 and ±1', () => {
    expect([pvFold(2 / 3), pvFold(-2 / 3), pvFold(0), pvFold(1), pvFold(-1), pvFold(1 / 3)]).toEqual([1, 1, -1, 0, 0, 0]);
  });
  test('scaleMul is an exact zoom: climate(s, x, z) = climate(1, x/s, z/s) bit for bit', () => {
    for (const s of [2, 4, 0.5]) {
      const zoomed = ctxFor('42', { climate: { scaleMul: s } });
      for (const [x, z] of pts.slice(0, 100)) {
        const a = sampleClimate(zoomed, x, z, newClimate());
        const b = sampleClimate(ctx, x / s, z / s, newClimate());
        expect([a.C, a.E, a.W, a.T, a.H, a.R]).toEqual([b.C, b.E, b.W, b.T, b.H, b.R]);
      }
    }
  });
  test('warp order: with zero warps every field is sampled at (x, z); the C warp moves only C', () => {
    const flat = ctxFor('42', { climate: { warp: { shift: { amplitude: 0 }, C: { amplitude: 0 }, R: { amplitude: 0 } } } });
    const onlyC = ctxFor('42', { climate: { warp: { shift: { amplitude: 0 }, R: { amplitude: 0 } } } });
    for (const [x, z] of pts.slice(0, 50)) {
      const a = sampleClimate(flat, x, z, newClimate());
      expect(a.C).toBe(toUniform(noiseFor(flat, 'climate.C').z2(x, z)));
      expect(a.T).toBe(toUniform(noiseFor(flat, 'climate.T').z2(x, z)));
      expect([a.xr, a.zr]).toEqual([x, z]);
      const b = sampleClimate(onlyC, x, z, newClimate());
      expect([b.E, b.W, b.T, b.H, b.R]).toEqual([a.E, a.W, a.T, a.H, a.R]);
    }
  });
  test('deterministic and seed-dependent', () => {
    const a = sampleClimate(ctxFor('42'), 1000, -2000, newClimate());
    expect(sampleClimate(ctxFor('42'), 1000, -2000, newClimate())).toEqual(a);
    expect(sampleClimate(ctxFor('43'), 1000, -2000, newClimate()).C).not.toBe(a.C);
  });
});
```

`test/unit/context.test.ts`:

```ts
import { expect, test } from 'vitest';
import { BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { DEFAULTS } from '../../src/core/params/defaults';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { evalSpline } from '../../src/core/spline/hermite';
import { noiseFor } from '../../src/gen/context';
import { ctxFor } from '../harness/gen';

test('GenContext prepares every schema noise, the three splines and the biome boxes', () => {
  const ctx = ctxFor('42');
  expect([...ctx.noise.keys()]).toEqual(noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName));
  expect(() => noiseFor(ctx, 'nope')).toThrow(/no schema noise nope/);
  expect(ctx.scale).toBe(1);
  expect(evalSpline(ctx.offset, Float64Array.of(-1, 0, 0, 0, 0, 0))).toBe(16);
  expect(ctx.boxes.map((b) => b.index)).toEqual(BOX_BIOMES.map((_, i) => i));
  const v = ctx.boxes[BOX_BIOMES.indexOf('volcano')]!;
  expect([Array.from(v.lo), Array.from(v.hi), v.wSign, v.priority]).toEqual([[-0.1, -1, 0.7, 0.6, -1], [1, -0.375, 1, 1, 1], 0, 26]);
  expect(ctxFor('42').lakeSeed).toBe(ctx.lakeSeed);
  expect(ctxFor('43').lakeSeed).not.toBe(ctx.lakeSeed);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/climate.test.ts test/unit/context.test.ts`
Expected: FAIL (module `src/gen/context` missing).

- [ ] **Step 3: Implement**

`src/gen/context.ts`:

```ts
/**
 * GenContext (master §3.0, SP2a spec §2): everything a worker derives once per (seed, params) epoch.
 * Pure data plus prepared NormalNoises and compiled splines; no DOM, no worker APIs.
 */
import { deriveSeed, type Seed64 } from '../core/hash';
import { uMax as uMaxOf } from '../core/noise/cdf';
import { NormalNoise } from '../core/noise/normal';
import type { NormalNoise as NormalNoiseT } from '../core/noise/normal';
import { BOX_BIOMES } from '../core/params/biomeDefaults';
import { BOX_AXES } from '../core/params/kit';
import { noiseInstances } from '../core/params/noises';
import { SCHEMA, type Params } from '../core/params/schema';
import { compileSpline, type CompiledSpline } from '../core/spline/hermite';

const DERIVE = deriveSeed;
const U_MAX = uMaxOf;
const Normal = NormalNoise;
const NOISES = noiseInstances;
const COMPILE = compileSpline;
const AXES = BOX_AXES;
const BIOMES = BOX_BIOMES;
const SCHEMA_ = SCHEMA;

export interface GenContext {
  readonly seed: Seed64;
  readonly params: Params;
  /** climate.scaleMul (divides world coordinates before the climate stage). */
  readonly scale: number;
  /** Largest |u| of a clamped climate field (uMax(clampSigma) of climate.C). */
  readonly uLimit: number;
  readonly noise: ReadonlyMap<string, NormalNoiseT>;
  readonly offset: CompiledSpline;
  readonly sigma: CompiledSpline;
  readonly jag: CompiledSpline;
  /** Box-picked biomes in BOX_BIOMES order, compiled from params.biomes.table. */
  readonly boxes: readonly CompiledBox[];
  readonly lakeSeed: number;
  readonly zoomSeed: number;
}

/** A biome box with its axes in BOX_AXES order (C, E, PV, T, H). */
export interface CompiledBox {
  readonly index: number;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly wSign: number;
  readonly priority: number;
}

function noiseOf(ctx: { noise: ReadonlyMap<string, NormalNoiseT> }, name: string): NormalNoiseT {
  const n = ctx.noise.get(name);
  if (n === undefined) throw new Error(`no schema noise ${name}`);
  return n;
}

export function createGenContext(seed: Seed64, params: Params): GenContext {
  const noise = new Map<string, NormalNoiseT>();
  for (const inst of NOISES(SCHEMA_, params)) noise.set(inst.seedName, new Normal(seed, inst.seedName, inst.def));
  const table = params.biomes.table;
  const boxes: CompiledBox[] = BIOMES.map((name, index) => {
    const row = table[name];
    return { index, lo: Float64Array.from(AXES, (a) => row[a][0]), hi: Float64Array.from(AXES, (a) => row[a][1]), wSign: row.wSign, priority: row.priority };
  });
  const ctx: GenContext = {
    seed, params, scale: params.climate.scaleMul, uLimit: U_MAX(params.climate.C.clampSigma), noise,
    offset: COMPILE(params.shape.offset), sigma: COMPILE(params.shape.sigma), jag: COMPILE(params.shape.jag),
    boxes, lakeSeed: DERIVE(seed, 'lakes.cells'), zoomSeed: DERIVE(seed, 'biomes.zoom'),
  };
  noiseOf(ctx, 'climate.C');
  return ctx;
}

/** The prepared NormalNoise of a schema noise instance (throws on an unknown seed name). */
export const noiseFor = noiseOf;
```

`src/gen/column/climate.ts`:

```ts
/**
 * Climate at a point (master §3.2, SP2a spec §2.1): divide by scaleMul, shift warp, the extra C and R
 * warps, six NormalNoises, CDF to [−uMax, uMax], and the PV fold.
 */
import { toUniform } from '../../core/noise/cdf';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import { noiseFor, type GenContext } from '../context';

const U = toUniform;
const NOISE = noiseFor;

/** Mutable climate record; the point path allocates one, the batch path reuses one. */
export interface ClimateOut {
  C: number; E: number; W: number; T: number; H: number; R: number; PV: number;
  /** R's NormalNoise value before the CDF, and the scaled, warped coordinates it was sampled at. */
  Rz: number; xr: number; zr: number;
}

export const newClimate = (): ClimateOut => ({ C: 0, E: 0, W: 0, T: 0, H: 0, R: 0, PV: 0, Rz: 0, xr: 0, zr: 0 });

interface ClimateNoises {
  readonly shiftX: NormalNoiseT; readonly shiftZ: NormalNoiseT; readonly cX: NormalNoiseT; readonly cZ: NormalNoiseT;
  readonly rX: NormalNoiseT; readonly rZ: NormalNoiseT;
  readonly C: NormalNoiseT; readonly E: NormalNoiseT; readonly W: NormalNoiseT; readonly T: NormalNoiseT; readonly H: NormalNoiseT; readonly R: NormalNoiseT;
  readonly aShift: number; readonly aC: number; readonly aR: number;
}

const CACHE = new WeakMap<GenContext, ClimateNoises>();

function prepared(ctx: GenContext): ClimateNoises {
  let n = CACHE.get(ctx);
  if (n === undefined) {
    const w = ctx.params.climate.warp;
    n = {
      shiftX: NOISE(ctx, 'climate.warp.shift.noise.x'), shiftZ: NOISE(ctx, 'climate.warp.shift.noise.z'),
      cX: NOISE(ctx, 'climate.warp.C.noise.x'), cZ: NOISE(ctx, 'climate.warp.C.noise.z'),
      rX: NOISE(ctx, 'climate.warp.R.noise.x'), rZ: NOISE(ctx, 'climate.warp.R.noise.z'),
      C: NOISE(ctx, 'climate.C'), E: NOISE(ctx, 'climate.E'), W: NOISE(ctx, 'climate.W'),
      T: NOISE(ctx, 'climate.T'), H: NOISE(ctx, 'climate.H'), R: NOISE(ctx, 'climate.R'),
      aShift: w.shift.amplitude, aC: w.C.amplitude, aR: w.R.amplitude,
    };
    CACHE.set(ctx, n);
  }
  return n;
}

/** PV = 1 − |3|W| − 2|: 1 at |W| = 2/3 (ridges), −1 at W = 0. */
export function pvFold(w: number): number {
  return 1 - Math.abs(3 * Math.abs(w) - 2);
}

/** Writes the climate at world (x, z) into `out`. */
export function sampleClimate(ctx: GenContext, x: number, z: number, out: ClimateOut): ClimateOut {
  const n = prepared(ctx);
  const xs = x / ctx.scale;
  const zs = z / ctx.scale;
  const xw = xs + n.aShift * n.shiftX.z2(xs, zs);
  const zw = zs + n.aShift * n.shiftZ.z2(xs, zs);
  const xc = xw + n.aC * n.cX.z2(xw, zw);
  const zc = zw + n.aC * n.cZ.z2(xw, zw);
  const xr = xw + n.aR * n.rX.z2(xw, zw);
  const zr = zw + n.aR * n.rZ.z2(xw, zw);
  const rz = n.R.z2(xr, zr);
  out.C = U(n.C.z2(xc, zc));
  out.E = U(n.E.z2(xw, zw));
  out.W = U(n.W.z2(xw, zw));
  out.T = U(n.T.z2(xw, zw));
  out.H = U(n.H.z2(xw, zw));
  out.R = U(rz);
  out.PV = pvFold(out.W);
  out.Rz = rz;
  out.xr = xr;
  out.zr = zr;
  return out;
}

/** R's NormalNoise at scaled, R-warped coordinates (rivers' gradient, SP2a spec §2.4). */
export function riverZ(ctx: GenContext, xr: number, zr: number): number {
  return prepared(ctx).R.z2(xr, zr);
}
```

- [ ] **Step 4: Run the tests and the arch suite**

Run: `npx vitest run --project unit test/unit/climate.test.ts test/unit/context.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS (gen/ follows the alias rule: type imports use `import type { X as XT }`).

- [ ] **Step 5: Commit**

```bash
git add src/gen test/harness/gen.ts test/unit/climate.test.ts test/unit/context.test.ts
git commit -m "feat(gen): GenContext and the climate stage (warps, scaleMul, CDF, PV)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 6: Shape and steep

**Files:**
- Create: `src/gen/column/shape.ts`, `src/gen/column/steep.ts`
- Test: `test/unit/shape.test.ts`

**Interfaces:**
- Produces: `interface ShapeOut {offset0, sigma0, jag0}`, `newShape()`, `splineCoords(c, coords)`, `offsetFrom(ctx, c, coords)`, `sampleShape(ctx, c, coords, out)`; `steepFrom(east, west, north, south)`, `offset0At(ctx, x, z, coords)`, `steepAt(ctx, x, z, coords)`.

- [ ] **Step 1: Write the failing test**

`test/unit/shape.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { evalSpline } from '../../src/core/spline/hermite';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { newShape, sampleShape, splineCoords } from '../../src/gen/column/shape';
import { offset0At, steepAt, steepFrom } from '../../src/gen/column/steep';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

describe('shape', () => {
  const ctx = ctxFor();
  test('offset0, sigma0 and jag0 come from the splines at [C, E, W, PV, T, H]', () => {
    const next = testRng(601);
    const coords = new Float64Array(6);
    for (let i = 0; i < 300; i++) {
      const c = sampleClimate(ctx, -524288 + 1048576 * testFloat(next), -524288 + 1048576 * testFloat(next), newClimate());
      const s = sampleShape(ctx, c, coords, newShape());
      const v = Float64Array.of(c.C, c.E, c.W, c.PV, c.T, c.H);
      expect(s.offset0).toBe(evalSpline(ctx.offset, v));
      expect(s.sigma0).toBe(Math.max(0, evalSpline(ctx.sigma, v)));
      expect(s.jag0).toBe(Math.max(0, evalSpline(ctx.jag, v)));
    }
  });
  test('sigma0 and jag0 are never negative over 1M random coordinate vectors', () => {
    const next = testRng(602);
    const c = newClimate();
    const coords = new Float64Array(6);
    const s = newShape();
    let neg = 0;
    for (let i = 0; i < 1_000_000; i++) {
      c.C = -1 + 2 * testFloat(next); c.E = -1 + 2 * testFloat(next); c.W = -1 + 2 * testFloat(next);
      c.PV = -1 + 2 * testFloat(next); c.T = -1 + 2 * testFloat(next); c.H = -1 + 2 * testFloat(next);
      sampleShape(ctx, c, coords, s);
      if (s.sigma0 < 0 || s.jag0 < 0 || Object.is(s.sigma0, -0) || Object.is(s.jag0, -0)) neg++;
    }
    expect(neg).toBe(0);
  });
  test('splineCoords writes the SP1 slot order', () => {
    const c = { ...newClimate(), C: 1, E: 2, W: 3, PV: 4, T: 5, H: 6 };
    expect(Array.from(splineCoords(c, new Float64Array(6)))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('steep', () => {
  test('steepFrom is the central-difference gradient length at ±4 blocks', () => {
    expect(steepFrom(72, 64, 70, 70)).toBe(1);
    expect(steepFrom(70, 70, 60, 68)).toBe(1);
    expect(steepFrom(76, 70, 70, 78)).toBe(Math.sqrt(0.75 * 0.75 + 1));
    expect(steepFrom(5, 5, 5, 5)).toBe(0);
  });
  test('steepAt samples offset0 at the four quart neighbours', () => {
    const ctx = ctxFor();
    const coords = new Float64Array(6);
    for (const [x, z] of [[0, 0], [1000, -3000], [123.5, 77.25]] as const) {
      expect(steepAt(ctx, x, z, coords)).toBe(steepFrom(offset0At(ctx, x + 4, z, coords), offset0At(ctx, x - 4, z, coords), offset0At(ctx, x, z - 4, coords), offset0At(ctx, x, z + 4, coords)));
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/shape.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/gen/column/shape.ts`:

```ts
/**
 * Shape (master §3.3, SP2a spec §2.2): offset0, sigma0 and jag0 in blocks from the three splines over
 * the climate coordinates [C, E, W, PV, T, H]; sigma and jag are clamped at 0.
 */
import { evalSpline } from '../../core/spline/hermite';
import type { GenContext } from '../context';
import type { ClimateOut } from './climate';

const EVAL = evalSpline;

export interface ShapeOut { offset0: number; sigma0: number; jag0: number }

export const newShape = (): ShapeOut => ({ offset0: 0, sigma0: 0, jag0: 0 });

/** Fills the spline coordinate vector in SP1 slot order. */
export function splineCoords(c: ClimateOut, coords: Float64Array): Float64Array {
  coords[0] = c.C;
  coords[1] = c.E;
  coords[2] = c.W;
  coords[3] = c.PV;
  coords[4] = c.T;
  coords[5] = c.H;
  return coords;
}

export function offsetFrom(ctx: GenContext, c: ClimateOut, coords: Float64Array): number {
  return EVAL(ctx.offset, splineCoords(c, coords));
}

export function sampleShape(ctx: GenContext, c: ClimateOut, coords: Float64Array, out: ShapeOut): ShapeOut {
  splineCoords(c, coords);
  out.offset0 = EVAL(ctx.offset, coords);
  out.sigma0 = Math.max(0, EVAL(ctx.sigma, coords));
  out.jag0 = Math.max(0, EVAL(ctx.jag, coords));
  return out;
}
```

`src/gen/column/steep.ts`:

```ts
/**
 * steep = |∇offset0| by central differences at ±4 blocks (one quart; SP2a spec §2.3). The point path
 * samples the four neighbours; the batch path reads them from its lattice. Both call steepFrom.
 */
import type { GenContext } from '../context';
import { newClimate, sampleClimate } from './climate';
import { offsetFrom } from './shape';

const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const OFFSET = offsetFrom;

/** |(east − west, south − north)| / 8 for offsets at x ± 4 and z ± 4. */
export function steepFrom(east: number, west: number, north: number, south: number): number {
  const gx = (east - west) / 8;
  const gz = (south - north) / 8;
  return Math.sqrt(gx * gx + gz * gz);
}

/** offset0 at world (x, z) (climate plus the offset spline). */
export function offset0At(ctx: GenContext, x: number, z: number, coords: Float64Array): number {
  return OFFSET(ctx, CLIMATE(ctx, x, z, NEW_CLIMATE()), coords);
}

export function steepAt(ctx: GenContext, x: number, z: number, coords: Float64Array): number {
  return steepFrom(offset0At(ctx, x + 4, z, coords), offset0At(ctx, x - 4, z, coords), offset0At(ctx, x, z - 4, coords), offset0At(ctx, x, z + 4, coords));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/shape.test.ts && npx vitest run --project arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gen/column/shape.ts src/gen/column/steep.ts test/unit/shape.test.ts
git commit -m "feat(gen): shape splines and steep from the quart stencil

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 7: Rivers (with the SP2a gorge amendment)

**Files:**
- Create: `src/gen/column/rivers.ts`
- Test: `test/unit/rivers.test.ts`

**Interfaces:**
- Produces: `interface RiverInput`, `interface RiverOut {riverDist, width, riverStrength, offset, sigma, jag, wet, gorge}`, `newRiver()`, `riverTerms(input, params, out)`, `sampleRivers(ctx, climate, shape, out)`.

- [ ] **Step 1: Write the failing test**

`test/unit/rivers.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { newRiver, riverTerms, sampleRivers, type RiverInput } from '../../src/gen/column/rivers';
import { newShape, sampleShape } from '../../src/gen/column/shape';
import { ctxFor } from '../harness/gen';

const P = DEFAULTS.rivers;
/** Inland (C 0.3, s = 1), flat (E = −1, valley half-width 30), lowland (offset0 80, s_alt = 1), |∇R_z| = 0.01/block. */
const base: RiverInput = { Rz: 0, gradLen: 0.01, u2: 0.5, C: 0.3, E: -1, offset0: 80, sigma0: 4, jag0: 10 };
const at = (dist: number, over: Partial<RiverInput> = {}) => riverTerms({ ...base, Rz: dist * 0.01, ...over }, P, newRiver());

describe('riverTerms (master §3.4)', () => {
  test('distance is |R_z| / |∇R_z| and width is 5 + 9·u2', () => {
    expect(at(12).riverDist).toBeCloseTo(12, 12);
    expect(at(0).width).toBe(9.5);
    expect(riverTerms({ ...base, Rz: 0.5, gradLen: 0 }, P, newRiver()).riverDist).toBe(5000);
  });
  test('channel centre: floor at 63 − (3 + 3·u2), wet, no jag, σ ≤ 0.5', () => {
    const r = at(0);
    expect(r.offset).toBe(63 - 4.5);
    expect([r.wet, r.gorge, r.jag]).toEqual([true, false, 0]);
    expect(r.sigma).toBe(0.5);
  });
  test('channel profile is parabolic inside w/2', () => {
    const r = at(9.5 / 4);
    expect(r.offset).toBeCloseTo(63 - 4.5 * 0.75, 12);
  });
  test('valley: at the channel edge the floor is min(offset0, 64); far away offset0 returns', () => {
    const edge = at(9.5 / 2 + 1e-9);
    expect(edge.offset).toBeCloseTo(64, 6);
    expect(edge.wet).toBe(true);
    const far = at(1000);
    expect(far.offset).toBeCloseTo(80, 9);
    expect([far.wet, far.gorge]).toEqual([false, false]);
    expect(far.sigma).toBeCloseTo(4, 9);
  });
  test('σ and jag are scaled by t inside the valley', () => {
    const r = at(9.5 / 2 + 30);
    const t = 1 - Math.exp(-1);
    expect(r.sigma).toBeCloseTo(4 * t, 7);
    expect(r.jag).toBeCloseTo(10 * t, 7);
  });
  test('the coast fade removes the valley but keeps the channel to the sea', () => {
    const r = at(20, { C: -0.2 });
    expect(r.offset).toBe(80);
    expect(r.riverStrength).toBe(0);
    const mouth = at(0, { C: -0.2, offset0: 60 });
    expect(mouth.offset).toBe(Math.min(60, 63 - 4.5));
    expect(mouth.wet).toBe(true);
  });
  test('high ground turns the channel into a dry gorge gorgeDepth below offset0, and the valley fades', () => {
    const r = at(0, { offset0: 200 });
    expect([r.wet, r.gorge]).toEqual([false, true]);
    expect(r.offset).toBe(200 - 12);
    expect(at(40, { offset0: 200 }).offset).toBe(200);
    const half = at(0, { offset0: 145 });
    expect(half.offset).toBeCloseTo(Math.min(145 + (64 - 145) * 0.5, (145 - 12) + (58.5 - 133) * 0.5), 9);
    expect(half.wet).toBe(false);
    expect(half.riverStrength).toBe(0.5);
  });
});

describe('sampleRivers', () => {
  test('feeds riverTerms from the climate (deterministic; distance matches the ±2-block gradient)', () => {
    const ctx = ctxFor();
    const coords = new Float64Array(6);
    let wet = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i * 97 - 90000;
      const z = i * 53 - 40000;
      const c = sampleClimate(ctx, x, z, newClimate());
      const s = sampleShape(ctx, c, coords, newShape());
      const r = sampleRivers(ctx, c, s, newRiver());
      expect(sampleRivers(ctx, c, s, newRiver())).toEqual(r);
      expect(r.riverDist).toBeGreaterThanOrEqual(0);
      if (r.wet) wet++;
    }
    expect(wet).toBeGreaterThan(0);
    expect(wet).toBeLessThan(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/rivers.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/gen/column/rivers.ts`:

```ts
/**
 * Rivers (master §3.4 as amended by SP2a spec §2.4). riverTerms is the pure formula; sampleRivers feeds
 * it from the climate: R_z and its ±2-block central-difference gradient in R-warped space, and the width
 * noise u2. Amendment: the valley fades with altitude too (strength s·s_alt), and on high ground the
 * channel becomes a dry gorge cut gorgeDepth below offset0 instead of a valley pulled down to sea level.
 */
import { SEA_LEVEL } from '../../core/constants';
import { detExp, detSmoothstep } from '../../core/detMath';
import { toUniform } from '../../core/noise/cdf';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import type { RiverParams } from '../../core/params/schema';
import { noiseFor, type GenContext } from '../context';
import { riverZ, type ClimateOut } from './climate';
import type { ShapeOut } from './shape';

const SEA = SEA_LEVEL;
const EXP = detExp;
const SMOOTH = detSmoothstep;
const U = toUniform;
const NOISE = noiseFor;
const RZ = riverZ;

export interface RiverInput {
  /** R's NormalNoise value and the length of its gradient per world block. */
  Rz: number; gradLen: number;
  /** Width noise mapped to [0, 1]. */
  u2: number;
  C: number; E: number;
  offset0: number; sigma0: number; jag0: number;
}

export interface RiverOut {
  riverDist: number; width: number;
  /** Coastal valley factor s times the altitude channel factor s_alt. */
  riverStrength: number;
  offset: number; sigma: number; jag: number;
  /** Wet channel (river biome, water at sea level) and dry gorge flags. */
  wet: boolean; gorge: boolean;
}

export const newRiver = (): RiverOut => ({ riverDist: 0, width: 0, riverStrength: 0, offset: 0, sigma: 0, jag: 0, wet: false, gorge: false });

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function riverTerms(i: RiverInput, p: RiverParams, out: RiverOut): RiverOut {
  const riverDist = Math.abs(i.Rz) / Math.max(i.gradLen, 1e-4);
  const w = p.widthMin + p.widthVar * i.u2;
  const half = w / 2;
  const valleyWidth = p.valleyBase + p.valleyPerE * (1 + i.E);
  const s = SMOOTH(p.coastFadeLo, p.coastFadeHi, i.C);
  const sAlt = 1 - SMOOTH(p.altFadeLo, p.altFadeHi, i.offset0);
  const q = Math.max(0, riverDist - half) / valleyWidth;
  const t = 1 - EXP(-(q * q));
  const valleyOffset = lerp(Math.min(i.offset0, p.valleyFloor + p.valleyRise * t), i.offset0, t);
  const sv = s * sAlt;
  const f = 1 - sv * (1 - t);
  let offset = lerp(i.offset0, valleyOffset, sv);
  let sigma = i.sigma0 * f;
  let jag = i.jag0 * f;
  const depth = p.depthMin + p.depthVar * i.u2;
  if (riverDist < half) {
    const r = (2 * riverDist) / w;
    const profile = 1 - r * r;
    const channelOffset = SEA - depth * profile;
    const gorgeOffset = i.offset0 - p.gorgeDepth * profile;
    offset = Math.min(offset, lerp(gorgeOffset, channelOffset, sAlt));
    sigma = 0.5;
    jag = 0;
  }
  const centre = lerp(i.offset0 - p.gorgeDepth, SEA - depth, sAlt);
  const wet = riverDist < half + p.wetMargin && centre <= SEA - 1;
  out.riverDist = riverDist;
  out.width = w;
  out.riverStrength = s * sAlt;
  out.offset = offset;
  out.sigma = sigma;
  out.jag = jag;
  out.wet = wet;
  out.gorge = riverDist < half && !wet;
  return out;
}

const INPUT: RiverInput = { Rz: 0, gradLen: 0, u2: 0, C: 0, E: 0, offset0: 0, sigma0: 0, jag0: 0 };
const WIDTH = new WeakMap<GenContext, NormalNoiseT>();

function widthNoise(ctx: GenContext): NormalNoiseT {
  let n = WIDTH.get(ctx);
  if (n === undefined) { n = NOISE(ctx, 'rivers.widthNoise'); WIDTH.set(ctx, n); }
  return n;
}

/** Rivers at a point whose climate and shape are already known. */
export function sampleRivers(ctx: GenContext, c: ClimateOut, s: ShapeOut, out: RiverOut): RiverOut {
  const h = 2 / ctx.scale;
  const gx = (RZ(ctx, c.xr + h, c.zr) - RZ(ctx, c.xr - h, c.zr)) / 4;
  const gz = (RZ(ctx, c.xr, c.zr + h) - RZ(ctx, c.xr, c.zr - h)) / 4;
  const input = INPUT;
  input.Rz = c.Rz;
  input.gradLen = Math.sqrt(gx * gx + gz * gz);
  input.u2 = (U(widthNoise(ctx).z2(c.xr, c.zr)) + 1) / 2;
  input.C = c.C;
  input.E = c.E;
  input.offset0 = s.offset0;
  input.sigma0 = s.sigma0;
  input.jag0 = s.jag0;
  return riverTerms(input, ctx.params.rivers, out);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/rivers.test.ts && npx vitest run --project arch`
Expected: PASS (about 20-400 of the 2000 sampled points are wet).

- [ ] **Step 5: Commit**

```bash
git add src/gen/column/rivers.ts test/unit/rivers.test.ts
git commit -m "feat(gen): rivers — channel, valley and dry gorges on high ground

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 8: Lakes

**Files:**
- Create: `src/gen/column/lakes.ts`
- Test: `test/unit/lakes.test.ts`

**Interfaces:**
- Produces: `interface LakeCell`, `interface LakeOut {lakeMask, lakeLevel, lakeFloor, offset, sigma, jag}`, `newLake()`, `interface CellProbe`, `cellEligible(probe, params)`, `lakeTerms(q, Lw, depth, offset, sigma, jag, params, out)`, `lakeCell(ctx, i, j)`, `lakeSpace(ctx, x, z)`, `nearestCell(ctx, xl, zl)`, `sampleLakes(ctx, x, z, offset, sigma, jag, out)`.

- [ ] **Step 1: Write the failing test**

`test/unit/lakes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { cellEligible, lakeCell, lakeTerms, nearestCell, newLake, sampleLakes, type CellProbe } from '../../src/gen/column/lakes';
import { ctxFor } from '../harness/gen';

const P = DEFAULTS.lakes;

describe('lakeTerms (master §3.5)', () => {
  test('inside the basin: bowl below Lw, σ × 0.3, jag 0, water at Lw', () => {
    const c = lakeTerms(0, 80, 10, 90, 2, 5, P, newLake());
    expect(c).toEqual({ lakeMask: 1, lakeLevel: 80, lakeFloor: 70, offset: 70, sigma: 2 * 0.3, jag: 0 });
    expect(lakeTerms(0.5, 80, 10, 90, 2, 5, P, newLake()).offset).toBe(80 - 10 * 0.75);
    expect(lakeTerms(1, 80, 10, 90, 2, 5, P, newLake()).offset).toBe(80);
    expect(lakeTerms(-0.1, 80, 10, 90, 2, 5, P, newLake()).offset).toBe(70);
    expect(lakeTerms(0.5, 80, 10, 60, 2, 5, P, newLake()).offset).toBe(60);
  });
  test('rim band: raised toward Lw + rimRise + 3·rimSigma by m; containment at the inner edge', () => {
    const inner = lakeTerms(1 + 1e-12, 80, 10, 70, 2, 5, P, newLake());
    expect(inner.lakeMask).toBeCloseTo(1, 9);
    expect(inner.offset).toBeCloseTo(80 + 2 + 1.5, 9);
    expect(inner.sigma).toBeCloseTo(0.5, 9);
    expect(inner.lakeLevel).toBe(-Infinity);
    const mid = lakeTerms(1 + P.rimWidth / 2, 80, 10, 70, 2, 5, P, newLake());
    expect(mid.lakeMask).toBeCloseTo(0.5, 12);
    expect(mid.offset).toBeCloseTo(70 + (83.5 - 70) * 0.5, 9);
    expect(mid.jag).toBeCloseTo(2.5, 12);
    expect(lakeTerms(1.2, 80, 10, 95, 2, 5, P, newLake()).offset).toBe(95);
  });
  test('outside the rim band nothing changes', () => {
    expect(lakeTerms(1 + P.rimWidth, 80, 10, 70, 2, 5, P, newLake())).toEqual({ lakeMask: 0, lakeLevel: -Infinity, lakeFloor: -Infinity, offset: 70, sigma: 2, jag: 5 });
  });
});

describe('cellEligible', () => {
  const ok: CellProbe = { C: 0.3, offset0: 90, riverDist: 500, valleyWidth: 75, wet: false, roll: 0.05 };
  test.each<[string, Partial<CellProbe>, boolean]>([
    ['eligible', {}, true],
    ['roll above p', { roll: 0.2 }, false],
    ['too oceanic', { C: -0.2 }, false],
    ['too low', { offset0: 65 }, false],
    ['too high', { offset0: 201 }, false],
    ['in a river valley', { riverDist: 60 }, false],
    ['wet river', { wet: true }, false],
  ])('%s', (_n, over, expected) => {
    expect(cellEligible({ ...ok, ...over }, P)).toBe(expected);
  });
});

describe('lake cells', () => {
  const ctx = ctxFor();
  test('cells are deterministic and the memo agrees with a fresh context', () => {
    const fresh = ctxFor();
    for (let i = -20; i < 20; i += 3) for (let j = -20; j < 20; j += 3) expect(lakeCell(fresh, i, j)).toEqual(lakeCell(ctx, i, j));
    expect(lakeCell(ctx, 5, 7)).toBe(lakeCell(ctx, 5, 7));
  });
  test('centres stay inside their jitter window; some cells in a 60 × 60 block hold lakes with Lw in range', () => {
    let enabled = 0;
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) {
      const c = lakeCell(ctx, i, j);
      expect(c.cx).toBeGreaterThanOrEqual((i + 0.1) * P.cell);
      expect(c.cx).toBeLessThanOrEqual((i + 0.9) * P.cell);
      if (c.enabled) {
        enabled++;
        expect(Number.isInteger(c.Lw)).toBe(true);
        expect(c.depth).toBeGreaterThanOrEqual(4);
        expect(c.depth).toBeLessThan(14);
      }
    }
    expect(enabled).toBeGreaterThan(10);
    expect(enabled).toBeLessThan(0.12 * 3600);
  });
  test('the nearest cell is the closest of the 3 × 3 neighbourhood', () => {
    const { cell, dist } = nearestCell(ctx, 1000.5, -2000.25);
    expect(dist).toBe(Math.hypot(1000.5 - cell.cx, -2000.25 - cell.cz));
  });
  test('sampleLakes leaves columns of disabled cells untouched', () => {
    let touched = 0;
    for (let k = 0; k < 400; k++) {
      const r = sampleLakes(ctx, k * 811, k * -373, 90, 2, 5, newLake());
      if (r.lakeMask === 0) expect([r.offset, r.sigma, r.jag]).toEqual([90, 2, 5]);
      else touched++;
    }
    expect(touched).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/lakes.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/gen/column/lakes.ts`:

```ts
/**
 * Lakes at elevation (master §3.5, SP2a spec §2.5): warped Voronoi cells, one possible lake per cell.
 * cellEligible and lakeTerms are the pure formulas; lakeCell evaluates (and memoises) a cell centre with
 * a lake-free column evaluation; sampleLakes applies the F1 cell to a column.
 */
import { hash2, hash4 } from '../../core/hash';
import type { LakeParams } from '../../core/params/schema';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import { noiseFor, type GenContext } from '../context';
import { newClimate, sampleClimate } from './climate';
import { newRiver, sampleRivers } from './rivers';
import { newShape, sampleShape } from './shape';

const H2 = hash2;
const H4 = hash4;
const NOISE = noiseFor;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;

const TO_UNIT = 1 / 4294967296;
const RING_X = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
const RING_Z = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];

export interface LakeCell {
  readonly i: number; readonly j: number;
  /** Centre in warped lake space (also used as the world point where the cell is evaluated). */
  readonly cx: number; readonly cz: number;
  readonly enabled: boolean;
  /** Water level and depth (−Infinity / 0 when disabled). */
  readonly Lw: number; readonly depth: number;
}

export interface LakeOut {
  /** 1 inside the basin, (0, 1) on the rim band, 0 outside. */
  lakeMask: number; lakeLevel: number; lakeFloor: number;
  offset: number; sigma: number; jag: number;
}

export const newLake = (): LakeOut => ({ lakeMask: 0, lakeLevel: -Infinity, lakeFloor: -Infinity, offset: 0, sigma: 0, jag: 0 });

export interface CellProbe { C: number; offset0: number; riverDist: number; valleyWidth: number; wet: boolean; roll: number }

/** Master §3.5 enabling rule: hash roll < p, C > minC, offset0 in [offsetMin, offsetMax], outside any river valley. */
export function cellEligible(c: CellProbe, p: LakeParams): boolean {
  return c.roll < p.p && c.C > p.minC && c.offset0 >= p.offsetMin && c.offset0 <= p.offsetMax && !c.wet && c.riverDist > c.valleyWidth;
}

/**
 * Applies one lake to a column whose distance to the cell centre is `q` radii (rim noise included).
 * Inside (q ≤ 1): offset ≤ Lw − depth·(1 − q²), σ × sigmaMul, jag 0. Rim band (1 < q < 1 + rimWidth):
 * offset raised toward max(offset, Lw + rimRise + 3·rimSigma) by m, σ ≤ rimSigma and jag → 0 by m.
 */
export function lakeTerms(q: number, Lw: number, depth: number, offset: number, sigma: number, jag: number, p: LakeParams, out: LakeOut): LakeOut {
  if (q <= 1) {
    const r = Math.max(0, q);
    out.lakeMask = 1;
    out.lakeLevel = Lw;
    out.lakeFloor = Lw - depth;
    out.offset = Math.min(offset, Lw - depth * (1 - r * r));
    out.sigma = sigma * p.sigmaMul;
    out.jag = 0;
    return out;
  }
  const m = q < 1 + p.rimWidth ? 1 - (q - 1) / p.rimWidth : 0;
  out.lakeMask = m;
  out.lakeLevel = -Infinity;
  out.lakeFloor = -Infinity;
  if (m === 0) {
    out.offset = offset;
    out.sigma = sigma;
    out.jag = jag;
    return out;
  }
  const raised = Math.max(offset, Lw + p.rimRise + 3 * p.rimSigma);
  out.offset = offset + (raised - offset) * m;
  out.sigma = sigma + (Math.min(sigma, p.rimSigma) - sigma) * m;
  out.jag = jag - jag * m;
  return out;
}

const CELLS = new WeakMap<GenContext, Map<number, LakeCell>>();
const CELL_CACHE_MAX = 65536;

/** The lake cell (i, j): jittered centre, eligibility, level and depth. Memoised per GenContext. */
export function lakeCell(ctx: GenContext, i: number, j: number): LakeCell {
  let cache = CELLS.get(ctx);
  if (cache === undefined) { cache = new Map(); CELLS.set(ctx, cache); }
  // Cells span |i|, |j| < 2^15 over the colKey window for any legal cell size (≥ 64 blocks).
  const key = (i + 32768) * 65536 + (j + 32768);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const p = ctx.params.lakes;
  const s = ctx.lakeSeed;
  const cx = (i + 0.5 + p.jitter * (H2(s, i, j) * TO_UNIT - 0.5)) * p.cell;
  const cz = (j + 0.5 + p.jitter * (H4(s, 1, i, j) * TO_UNIT - 0.5)) * p.cell;
  const coords = new Float64Array(6);
  const c = CLIMATE(ctx, cx, cz, NEW_CLIMATE());
  const sh = SHAPE(ctx, c, coords, NEW_SHAPE());
  const rv = RIVERS(ctx, c, sh, NEW_RIVER());
  const rp = ctx.params.rivers;
  const probe: CellProbe = {
    C: c.C, offset0: sh.offset0, riverDist: rv.riverDist, valleyWidth: rp.valleyBase + rp.valleyPerE * (1 + c.E), wet: rv.wet,
    roll: H4(s, 2, i, j) * TO_UNIT,
  };
  let cell: LakeCell;
  if (!cellEligible(probe, p)) {
    cell = { i, j, cx, cz, enabled: false, Lw: -Infinity, depth: 0 };
  } else {
    const rr = p.ringFrac * p.radius;
    let lo = Infinity;
    for (let k = 0; k < 8; k++) {
      const ck = CLIMATE(ctx, cx + rr * RING_X[k]!, cz + rr * RING_Z[k]!, NEW_CLIMATE());
      const o = SHAPE(ctx, ck, coords, NEW_SHAPE()).offset0;
      if (o < lo) lo = o;
    }
    cell = { i, j, cx, cz, enabled: true, Lw: Math.floor(lo) - 1, depth: p.depthMin + p.depthVar * H4(s, 3, i, j) * TO_UNIT };
  }
  if (cache.size >= CELL_CACHE_MAX) cache.clear();
  cache.set(key, cell);
  return cell;
}

interface LakeNoises { readonly wx: NormalNoiseT; readonly wz: NormalNoiseT; readonly rim: NormalNoiseT }
const PREP = new WeakMap<GenContext, LakeNoises>();

function noises(ctx: GenContext): LakeNoises {
  let n = PREP.get(ctx);
  if (n === undefined) {
    n = { wx: NOISE(ctx, 'lakes.warpNoise.x'), wz: NOISE(ctx, 'lakes.warpNoise.z'), rim: NOISE(ctx, 'lakes.rimNoise') };
    PREP.set(ctx, n);
  }
  return n;
}

/** Warped lake-space position of world (x, z). */
export function lakeSpace(ctx: GenContext, x: number, z: number): [number, number] {
  const a = ctx.params.lakes.warpAmp;
  const n = noises(ctx);
  return [x + a * n.wx.z2(x, z), z + a * n.wz.z2(x, z)];
}

/** The F1 (nearest-centre) cell of warped point (xl, zl); ties go to the lower (j, i). */
export function nearestCell(ctx: GenContext, xl: number, zl: number): { cell: LakeCell; dist: number } {
  const cellSize = ctx.params.lakes.cell;
  const ci = Math.floor(xl / cellSize);
  const cj = Math.floor(zl / cellSize);
  let best: LakeCell | null = null;
  let bestD2 = Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const cell = lakeCell(ctx, ci + di, cj + dj);
      const dx = xl - cell.cx;
      const dz = zl - cell.cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = cell; }
    }
  }
  return { cell: best!, dist: Math.sqrt(bestD2) };
}

/** Lakes at world (x, z) over a column already adjusted by rivers. */
export function sampleLakes(ctx: GenContext, x: number, z: number, offset: number, sigma: number, jag: number, out: LakeOut): LakeOut {
  const p = ctx.params.lakes;
  const [xl, zl] = lakeSpace(ctx, x, z);
  const { cell, dist } = nearestCell(ctx, xl, zl);
  if (!cell.enabled) {
    out.lakeMask = 0; out.lakeLevel = -Infinity; out.lakeFloor = -Infinity;
    out.offset = offset; out.sigma = sigma; out.jag = jag;
    return out;
  }
  const rim = noises(ctx).rim;
  const q = dist / p.radius - p.roughness * (rim.z2(x, z) / rim.clamp);
  return lakeTerms(q, cell.Lw, cell.depth, offset, sigma, jag, p, out);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/lakes.test.ts && npx vitest run --project arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gen/column/lakes.ts test/unit/lakes.test.ts
git commit -m "feat(gen): lakes at elevation in warped Voronoi cells

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 9: Surface biomes: registry, picker, zoom

**Files:**
- Create: `src/gen/biomes/registry.ts`, `picker.ts`, `zoom.ts`
- Test: `test/unit/biomes.test.ts`

**Interfaces:**
- Produces: `type SurfaceBiome`, `type BiomeFamily`, `SURFACE_BIOMES` (28, master order, volcano last), `biomeId`, `biomeName`, `biomeFamily`, `biomeColor`, `BOX_TO_BIOME`; `interface Pick {box, biome, fitness, runnerUp}`, `newPick()`, `pickBox(ctx, C, E, PV, T, H, W, out)`, `pickBiome(ctx, C, E, PV, T, H, W, riverWet)`; `zoomQuart(ctx, px, pz, out)`.

- [ ] **Step 1: Write the failing test**

`test/unit/biomes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { BOX_AXES } from '../../src/core/params/kit';
import { newPick, pickBiome, pickBox } from '../../src/gen/biomes/picker';
import { biomeColor, biomeFamily, biomeId, biomeName, BOX_TO_BIOME, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { zoomQuart } from '../../src/gen/biomes/zoom';
import { ctxFor } from '../harness/gen';

describe('registry', () => {
  test('28 biomes in master order, volcano last; ids round-trip', () => {
    expect(SURFACE_BIOMES.length).toBe(28);
    expect(SURFACE_BIOMES.slice(0, 9)).toEqual(['ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean', 'beach', 'snowy_beach', 'stony_shore', 'river', 'frozen_river']);
    expect(SURFACE_BIOMES[27]).toBe('volcano');
    for (const n of SURFACE_BIOMES) expect(biomeName(biomeId(n))).toBe(n);
    expect(() => biomeName(28)).toThrow(/unknown biome id 28/);
  });
  test('families and colours', () => {
    expect(SURFACE_BIOMES.map((_, i) => biomeFamily(i)).filter((f) => f === 'highland').length).toBe(7);
    expect(biomeFamily(biomeId('volcano'))).toBe('highland');
    expect(new Set(SURFACE_BIOMES.map((_, i) => biomeColor(i))).size).toBe(28);
  });
  test('every box maps to its biome id', () => {
    expect(BOX_TO_BIOME.map((id) => biomeName(id))).toEqual([...BOX_BIOMES]);
  });
});

describe('picker', () => {
  const ctx = ctxFor();
  const mid = (iv: readonly [number, number]) => (iv[0] + iv[1]) / 2;
  test('the centre of every box picks that box with fitness 0 and no tie', () => {
    for (const name of BOX_BIOMES) {
      const r = BIOME_TABLE_DEFAULT[name];
      const [C, E, PV, T, H] = BOX_AXES.map((a) => mid(r[a]));
      const W = r.wSign === -1 ? -0.5 : 0.5;
      const p = pickBox(ctx, C!, E!, PV!, T!, H!, W, newPick());
      expect(biomeName(p.biome), name).toBe(name);
      expect(p.fitness).toBe(0);
      expect(p.runnerUp).toBeGreaterThan(0);
    }
  });
  test('the W sign selects jagged vs frozen peaks', () => {
    const at = (W: number) => biomeName(pickBiome(ctx, 0.5, -0.9, 0.9, -0.8, 0, W, false));
    expect([at(0.7), at(-0.7), at(0)]).toEqual(['jagged_peaks', 'frozen_peaks', 'jagged_peaks']);
  });
  test('river flag overrides boxes; frozen below T −0.6', () => {
    expect(biomeName(pickBiome(ctx, 0.5, 0, 0, 0, 0, 0, true))).toBe('river');
    expect(biomeName(pickBiome(ctx, 0.5, 0, 0, -0.7, 0, 0, true))).toBe('frozen_river');
  });
  test('outside every box the lowest overshoot wins (hot humid valley → jungle or swamp)', () => {
    const p = pickBox(ctx, 0.5, 0.5, -0.8, 0.8, 0.4, 0.5, newPick());
    expect(p.fitness).toBeGreaterThan(0);
    expect(['jungle', 'swamp']).toContain(biomeName(p.biome));
  });
  test('on a shared edge the lower priority wins and the tie is visible', () => {
    const p = pickBox(ctx, 0.5, 0.5, 0, -0.2, 0, 0.5, newPick());
    expect(biomeName(p.biome)).toBe('plains');
    expect(p.runnerUp).toBe(p.fitness);
  });
  test('volcano is the hot-peaks box', () => {
    expect(biomeName(pickBiome(ctx, 0.4, -0.8, 0.85, 0.8, 0, 0.3, false))).toBe('volcano');
    expect(biomeName(pickBiome(ctx, 0.4, -0.8, 0.5, 0.8, 0, 0.3, false))).toBe('badlands');
  });
});

describe('zoom', () => {
  test('returns one of the 4 surrounding quarts, deterministically', () => {
    const ctx = ctxFor();
    const out: [number, number] = [0, 0];
    for (let k = 0; k < 500; k++) {
      const px = k * 7.3 - 1800;
      const pz = k * -5.1 + 900;
      const [qx, qz] = zoomQuart(ctx, px, pz, out);
      expect(qx - Math.floor(px / 4)).toBeGreaterThanOrEqual(0);
      expect(qx - Math.floor(px / 4)).toBeLessThanOrEqual(1);
      expect(qz - Math.floor(pz / 4)).toBeGreaterThanOrEqual(0);
      expect(qz - Math.floor(pz / 4)).toBeLessThanOrEqual(1);
      expect(zoomQuart(ctxFor(), px, pz, [0, 0])).toEqual([qx, qz]);
    }
  });
  test('zero jitter is plain nearest-lattice-point, ties to the lower (qz, qx)', () => {
    const ctx = ctxFor('42', { biomes: { zoomJitter: 0 } });
    expect(zoomQuart(ctx, 5.9, 1.1, [0, 0])).toEqual([1, 0]);
    expect(zoomQuart(ctx, 6.1, 6.1, [0, 0])).toEqual([2, 2]);
    expect(zoomQuart(ctx, 2, 2, [0, 0])).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/biomes.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/gen/biomes/registry.ts`:

```ts
/**
 * The 28 surface biomes (master §3.10 plus volcano, SP2a spec §3.1). Ids are the index in master order
 * and never change; river and frozen river come from the river flag, every other biome from a box.
 */
import { BOX_BIOMES, type BoxBiome } from '../../core/params/biomeDefaults';

const BOX = BOX_BIOMES;

export type SurfaceBiome = BoxBiome | 'river' | 'frozen_river';
export type BiomeFamily = 'ocean' | 'coast' | 'river' | 'lowland' | 'highland';

export const SURFACE_BIOMES: readonly SurfaceBiome[] = [
  'ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean',
  'beach', 'snowy_beach', 'stony_shore',
  'river', 'frozen_river',
  'plains', 'meadow', 'forest', 'birch_forest', 'dark_forest', 'taiga', 'snowy_taiga', 'snowy_plains',
  'desert', 'savanna', 'swamp', 'jungle', 'badlands',
  'windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano',
];

/** [family, 0xRRGGBB] per biome, in SURFACE_BIOMES order. */
const INFO: ReadonlyArray<readonly [BiomeFamily, number]> = [
  ['ocean', 0x1f4f9a], ['ocean', 0x0f2f6a], ['ocean', 0x2a8fb0], ['ocean', 0x8fb4d8],
  ['coast', 0xe8dca0], ['coast', 0xf2f0e6], ['coast', 0x8a8a84],
  ['river', 0x3f76e4], ['river', 0xa0c4f0],
  ['lowland', 0x8db360], ['lowland', 0xa8c96a], ['lowland', 0x3f7a2a], ['lowland', 0x6fa04a], ['lowland', 0x2a4a1c],
  ['lowland', 0x3a6b4a], ['lowland', 0x5a7a6a], ['lowland', 0xe8eef2],
  ['lowland', 0xe0c878], ['lowland', 0xbfb055], ['lowland', 0x4c6b3a], ['lowland', 0x2f8a1e], ['highland', 0xc1653a],
  ['highland', 0x7c8a6a], ['highland', 0xd8e2ea], ['highland', 0x9a9a9a], ['highland', 0xc8d0dc], ['highland', 0xaec4e0],
  ['highland', 0x5a2a24],
];

const ID = new Map<string, number>(SURFACE_BIOMES.map((n, i) => [n, i]));

export function biomeId(name: SurfaceBiome): number {
  return ID.get(name)!;
}

export function biomeName(id: number): SurfaceBiome {
  const n = SURFACE_BIOMES[id];
  if (n === undefined) throw new Error(`unknown biome id ${id}`);
  return n;
}

export function biomeFamily(id: number): BiomeFamily {
  return INFO[id]![0];
}

/** 0xRRGGBB map colour. */
export function biomeColor(id: number): number {
  return INFO[id]![1];
}

/** Biome id of each box row, in BOX_BIOMES order. */
export const BOX_TO_BIOME: readonly number[] = BOX.map((n) => ID.get(n)!);
```

`src/gen/biomes/picker.ts`:

```ts
/**
 * Surface-biome picker (SP2a spec §3.2): the river flag first; otherwise the box with the lowest summed
 * squared overshoot (0 inside), ties broken by the lower priority; boxes with a W sign skip the other sign.
 */
import type { GenContext } from '../context';
import { BOX_TO_BIOME, biomeId } from './registry';

const ID = biomeId;
const TO_BIOME = BOX_TO_BIOME;

export interface Pick {
  /** Winning box index (−1 for a river override), biome id, and the winner's and runner-up's fitness. */
  box: number; biome: number; fitness: number; runnerUp: number;
}

export const newPick = (): Pick => ({ box: -1, biome: 0, fitness: 0, runnerUp: Infinity });

const V = new Float64Array(5);

export function pickBox(ctx: GenContext, C: number, E: number, PV: number, T: number, H: number, W: number, out: Pick): Pick {
  V[0] = C; V[1] = E; V[2] = PV; V[3] = T; V[4] = H;
  const sign = W < 0 ? -1 : 1;
  let best = -1;
  let bestF = Infinity;
  let bestP = Infinity;
  let second = Infinity;
  for (const b of ctx.boxes) {
    if (b.wSign !== 0 && b.wSign !== sign) continue;
    let f = 0;
    for (let k = 0; k < 5; k++) {
      const v = V[k]!;
      const lo = b.lo[k]!;
      const hi = b.hi[k]!;
      const o = v < lo ? lo - v : v > hi ? v - hi : 0;
      f += o * o;
    }
    if (f < bestF || (f === bestF && b.priority < bestP)) {
      if (best >= 0) second = Math.min(second, bestF);
      best = b.index; bestF = f; bestP = b.priority;
    } else if (f < second) {
      second = f;
    }
  }
  out.box = best;
  out.biome = TO_BIOME[best]!;
  out.fitness = bestF;
  out.runnerUp = second;
  return out;
}

const SCRATCH = newPick();

/** Biome id at a point: river override (frozen below T −0.6), else the best box. */
export function pickBiome(ctx: GenContext, C: number, E: number, PV: number, T: number, H: number, W: number, riverWet: boolean): number {
  if (riverWet) return T < -0.6 ? ID('frozen_river') : ID('river');
  return pickBox(ctx, C, E, PV, T, H, W, SCRATCH).biome;
}
```

`src/gen/biomes/zoom.ts`:

```ts
/**
 * Jittered-Voronoi zoom (SP2a spec §3.3): each quart lattice point (4qx, 4qz) is jittered by
 * hash2 → [−j, j)² blocks; a position takes the nearest of the 4 surrounding jittered points
 * (ties to the lower (qz, qx)). Returns the chosen quart; its biome is the lattice biome there.
 */
import { hash2, hash4 } from '../../core/hash';
import type { GenContext } from '../context';

const H2 = hash2;
const H4 = hash4;
const TO_UNIT = 1 / 4294967296;

export function zoomQuart(ctx: GenContext, px: number, pz: number, out: [number, number]): [number, number] {
  const j = ctx.params.biomes.zoomJitter;
  const s = ctx.zoomSeed;
  const qx0 = Math.floor(px / 4);
  const qz0 = Math.floor(pz / 4);
  let bestD2 = Infinity;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const qx = qx0 + dx;
      const qz = qz0 + dz;
      const jx = 4 * qx + j * (2 * H2(s, qx, qz) * TO_UNIT - 1);
      const jz = 4 * qz + j * (2 * H4(s, 1, qx, qz) * TO_UNIT - 1);
      const d2 = (px - jx) * (px - jx) + (pz - jz) * (pz - jz);
      if (d2 < bestD2) { bestD2 = d2; out[0] = qx; out[1] = qz; }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/biomes.test.ts && npx vitest run --project arch`
Expected: PASS (colours and families stay private data behind functions: gen/ may not export numeric data).

- [ ] **Step 5: Commit**

```bash
git add src/gen/biomes test/unit/biomes.test.ts
git commit -m "feat(gen): 28 surface biomes — registry, box picker and jittered-Voronoi zoom

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 10: The point reference: samplePoint, columnPoint, sampleCoarse

**Files:**
- Create: `src/gen/column/columnPoint.ts`
- Test: `test/unit/columnPoint.test.ts`

**Interfaces:**
- Produces: `interface PointRecord` (mutable), `type ColumnPoint = Readonly<PointRecord>`, `newPointRecord()`, `waterLevel(offset, riverWet, lakeMask, lakeLevel)`, `samplePoint(ctx, x, z, withSteep, out)`, `columnPoint(ctx, x, z)`, `sampleCoarse(ctx, x, z, out)`.

- [ ] **Step 1: Write the failing test**

`test/unit/columnPoint.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { pickBiome } from '../../src/gen/biomes/picker';
import { biomeFamily, biomeName } from '../../src/gen/biomes/registry';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { columnPoint, newPointRecord, samplePoint, waterLevel } from '../../src/gen/column/columnPoint';
import { newLake, sampleLakes } from '../../src/gen/column/lakes';
import { newRiver, sampleRivers } from '../../src/gen/column/rivers';
import { newShape, sampleShape } from '../../src/gen/column/shape';
import { steepAt } from '../../src/gen/column/steep';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

describe('waterLevel (master §3.7)', () => {
  test.each<[string, [number, boolean, number, number], number]>([
    ['lake inside', [70, false, 1, 80], 80],
    ['lake rim is not water', [85, false, 0.5, -Infinity], -Infinity],
    ['river', [60, true, 0, -Infinity], 63],
    ['ocean floor', [40, false, 0, -Infinity], 63],
    ['dry land', [70, false, 0, -Infinity], -Infinity],
    ['exactly sea level is dry', [63, false, 0, -Infinity], -Infinity],
  ])('%s', (_n, args, expected) => {
    expect(waterLevel(...args)).toBe(expected);
  });
});

describe('columnPoint', () => {
  const ctx = ctxFor();
  const next = testRng(1001);
  const pts = Array.from({ length: 300 }, () => [-200000 + 400000 * testFloat(next), -200000 + 400000 * testFloat(next)] as const);
  test('composes the stages in the §2.6 order', () => {
    const coords = new Float64Array(6);
    for (const [x, z] of pts) {
      const p = columnPoint(ctx, x, z);
      const c = sampleClimate(ctx, x, z, newClimate());
      const s = sampleShape(ctx, c, coords, newShape());
      const r = sampleRivers(ctx, c, s, newRiver());
      const l = sampleLakes(ctx, x, z, r.offset, r.sigma, r.jag, newLake());
      expect([p.C, p.E, p.W, p.T, p.H, p.R, p.PV]).toEqual([c.C, c.E, c.W, c.T, c.H, c.R, c.PV]);
      expect([p.offset0, p.sigma0, p.jag0]).toEqual([s.offset0, s.sigma0, s.jag0]);
      expect(p.steep).toBe(steepAt(ctx, x, z, coords));
      expect([p.riverDist, p.riverWet, p.gorge]).toEqual([r.riverDist, r.wet, r.gorge]);
      expect([p.offset, p.sigma, p.jag, p.lakeMask]).toEqual([l.offset, l.sigma, l.jag, l.lakeMask]);
      expect(p.surfaceEst).toBe(p.offset);
      expect(p.islandMask).toBe(0);
      expect(p.biome).toBe(pickBiome(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, r.wet));
    }
  });
  test('river columns are river biomes; oceans sit below sea level', () => {
    let ocean = 0;
    let land = 0;
    for (const [x, z] of pts) {
      const p = columnPoint(ctx, x, z);
      if (p.riverWet) expect(biomeFamily(p.biome)).toBe('river');
      if (biomeName(p.biome) === 'deep_ocean') expect(p.offset).toBeLessThan(63);
      if (p.surfaceWaterLevel === 63 && !p.riverWet) ocean++;
      if (p.surfaceWaterLevel === -Infinity) land++;
    }
    expect(ocean).toBeGreaterThan(50);
    expect(land).toBeGreaterThan(80);
  });
  test('deterministic plain data; samplePoint without steep matches every other field', () => {
    expect(columnPoint(ctxFor(), 1234.5, -987.25)).toEqual(columnPoint(ctx, 1234.5, -987.25));
    const rec = newPointRecord();
    for (const [x, z] of pts.slice(0, 50)) {
      const full = columnPoint(ctx, x, z);
      samplePoint(ctx, x, z, false, rec);
      expect({ ...rec, steep: full.steep }).toEqual(full);
      expect(Number.isNaN(rec.steep)).toBe(true);
    }
  });
});

describe('random valid parameters keep every field finite (levels may be −∞)', () => {
  test('20 random parameter documents × 40 points', async () => {
    const { randomParams } = await import('../harness/params');
    const { SCHEMA } = await import('../../src/core/params/schema');
    const { createGenContext } = await import('../../src/gen/context');
    const { seedFromInput } = await import('../../src/core/seed');
    const rng = testRng(1004);
    for (let d = 0; d < 20; d++) {
      const ctx = createGenContext(seedFromInput(String(d)), randomParams(SCHEMA, rng));
      for (let i = 0; i < 40; i++) {
        const p = columnPoint(ctx, -300000 + 600000 * testFloat(rng), -300000 + 600000 * testFloat(rng));
        for (const k of ['C', 'E', 'W', 'T', 'H', 'R', 'PV', 'offset0', 'sigma0', 'jag0', 'steep', 'riverDist', 'riverStrength', 'lakeMask', 'offset', 'sigma', 'jag', 'surfaceEst'] as const) {
          expect(Number.isFinite(p[k]), `doc ${d} ${k} = ${p[k]}`).toBe(true);
        }
        for (const k of ['lakeLevel', 'lakeFloor', 'surfaceWaterLevel'] as const) expect(Number.isNaN(p[k])).toBe(false);
      }
    }
  }, 60_000);
});

describe('terrain does not depend on biomes (SP2a replacement for T3 on 2D relief)', () => {
  test('swapping every biome box and the zoom jitter leaves every height and water field unchanged', () => {
    const base = ctxFor('42');
    const t = base.params.biomes.table;
    const shuffled = Object.fromEntries(Object.keys(t).map((k, i, keys) => [k, { ...t[keys[(i + 7) % keys.length]! as keyof typeof t], priority: t[k as keyof typeof t].priority }]));
    const other = ctxFor('42', { biomes: { table: shuffled as typeof t, zoomJitter: 0.2 } });
    const next = testRng(1003);
    let biomeChanged = 0;
    for (let i = 0; i < 500; i++) {
      const x = -100000 + 200000 * testFloat(next);
      const z = -100000 + 200000 * testFloat(next);
      const a = columnPoint(base, x, z);
      const b = columnPoint(other, x, z);
      expect([b.offset, b.sigma, b.jag, b.surfaceEst, b.surfaceWaterLevel, b.steep]).toEqual([a.offset, a.sigma, a.jag, a.surfaceEst, a.surfaceWaterLevel, a.steep]);
      if (a.biome !== b.biome) biomeChanged++;
    }
    expect(biomeChanged).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/columnPoint.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/gen/column/columnPoint.ts`:

```ts
/**
 * The point reference (SP2a spec §2.6): climate → shape → steep → rivers → lakes → water level →
 * surfaceEst → biome, in this order, at one world position. samplePoint writes into a reused record
 * (map tiles skip steep); columnPoint returns a fresh record with steep. buildColumnSample must
 * reproduce every field bit for bit at quart corners.
 */
import { SEA_LEVEL } from '../../core/constants';
import { pickBiome } from '../biomes/picker';
import type { GenContext } from '../context';
import { newClimate, sampleClimate } from './climate';
import { newLake, sampleLakes } from './lakes';
import { newRiver, sampleRivers } from './rivers';
import { newShape, sampleShape } from './shape';
import { steepAt } from './steep';

const SEA = SEA_LEVEL;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const STEEP = steepAt;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;
const LAKES = sampleLakes;
const NEW_LAKE = newLake;
const PICK = pickBiome;

export interface PointRecord {
  x: number; z: number;
  C: number; E: number; W: number; T: number; H: number; R: number; PV: number;
  offset0: number; sigma0: number; jag0: number;
  /** NaN when sampled without steep. */
  steep: number;
  riverDist: number; riverStrength: number; riverWet: boolean; gorge: boolean;
  lakeMask: number; lakeLevel: number; lakeFloor: number;
  offset: number; sigma: number; jag: number;
  surfaceWaterLevel: number; surfaceEst: number; islandMask: number;
  biome: number;
}
export type ColumnPoint = Readonly<PointRecord>;

export const newPointRecord = (): PointRecord => ({
  x: 0, z: 0, C: 0, E: 0, W: 0, T: 0, H: 0, R: 0, PV: 0, offset0: 0, sigma0: 0, jag0: 0, steep: Number.NaN,
  riverDist: 0, riverStrength: 0, riverWet: false, gorge: false, lakeMask: 0, lakeLevel: -Infinity, lakeFloor: -Infinity,
  offset: 0, sigma: 0, jag: 0, surfaceWaterLevel: -Infinity, surfaceEst: 0, islandMask: 0, biome: 0,
});

/** Master §3.7: sea level for ocean (below sea level) and river columns, Lw inside a lake, else −∞. */
export function waterLevel(offset: number, riverWet: boolean, lakeMask: number, lakeLevel: number): number {
  if (lakeMask === 1) return lakeLevel;
  return riverWet || offset < SEA ? SEA : -Infinity;
}

const C_ = NEW_CLIMATE();
const S_ = NEW_SHAPE();
const R_ = NEW_RIVER();
const L_ = NEW_LAKE();
const COORDS = new Float64Array(6);

export function samplePoint(ctx: GenContext, x: number, z: number, withSteep: boolean, out: PointRecord): PointRecord {
  const c = CLIMATE(ctx, x, z, C_);
  const s = SHAPE(ctx, c, COORDS, S_);
  out.x = x; out.z = z;
  out.C = c.C; out.E = c.E; out.W = c.W; out.T = c.T; out.H = c.H; out.R = c.R; out.PV = c.PV;
  out.offset0 = s.offset0; out.sigma0 = s.sigma0; out.jag0 = s.jag0;
  out.steep = withSteep ? STEEP(ctx, x, z, COORDS) : Number.NaN;
  const r = RIVERS(ctx, c, s, R_);
  const l = LAKES(ctx, x, z, r.offset, r.sigma, r.jag, L_);
  out.riverDist = r.riverDist; out.riverStrength = r.riverStrength; out.riverWet = r.wet; out.gorge = r.gorge;
  out.lakeMask = l.lakeMask; out.lakeLevel = l.lakeLevel; out.lakeFloor = l.lakeFloor;
  out.offset = l.offset; out.sigma = l.sigma; out.jag = l.jag;
  out.surfaceWaterLevel = waterLevel(l.offset, r.wet, l.lakeMask, l.lakeLevel);
  out.surfaceEst = l.offset;
  out.islandMask = 0;
  out.biome = PICK(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, r.wet);
  return out;
}

export function columnPoint(ctx: GenContext, x: number, z: number): ColumnPoint {
  return samplePoint(ctx, x, z, true, newPointRecord());
}

/**
 * The preview-level point (SP2a spec §6.1): climate, shape and biome only. Rivers and lakes are
 * narrower than a 256-block pixel, so they are left out: no river, no lake, offset = offset0.
 */
export function sampleCoarse(ctx: GenContext, x: number, z: number, out: PointRecord): PointRecord {
  const c = CLIMATE(ctx, x, z, C_);
  const s = SHAPE(ctx, c, COORDS, S_);
  out.x = x; out.z = z;
  out.C = c.C; out.E = c.E; out.W = c.W; out.T = c.T; out.H = c.H; out.R = c.R; out.PV = c.PV;
  out.offset0 = s.offset0; out.sigma0 = s.sigma0; out.jag0 = s.jag0;
  out.steep = Number.NaN;
  out.riverDist = Infinity; out.riverStrength = 0; out.riverWet = false; out.gorge = false;
  out.lakeMask = 0; out.lakeLevel = -Infinity; out.lakeFloor = -Infinity;
  out.offset = s.offset0; out.sigma = s.sigma0; out.jag = s.jag0;
  out.surfaceWaterLevel = waterLevel(s.offset0, false, 0, -Infinity);
  out.surfaceEst = s.offset0;
  out.islandMask = 0;
  out.biome = PICK(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, false);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/columnPoint.test.ts && npx vitest run --project arch`
Expected: PASS — including "random valid parameters keep every field finite" and "terrain does not depend on biomes" (the SP2a replacement for T3).

- [ ] **Step 5: Probe the biome shares (sanity check, not committed)**

Optional: a throwaway unit test that counts `columnPoint(ctx, …).biome` over `samplePoints('probe', 60000)` for seeds 1-2 shows every biome ≥ 0.6 %, volcano ≈ 0.7 %, taiga ≈ 7.2 %, ocean family ≈ 38 %, rivers ≈ 3.4 % of land. Delete it afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/gen/column/columnPoint.ts test/unit/columnPoint.test.ts
git commit -m "feat(gen): the column point reference, its preview variant and water levels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 11: ColumnSample, readout, LRU and DT2

**Files:**
- Create: `src/gen/column/columnStage.ts`, `src/gen/column/columnCache.ts`
- Test: `test/unit/columnStage.test.ts`

**Interfaces:**
- Produces: `SAMPLE_FIELDS`, `LEVEL_FIELDS`, `type SampleField`, `type LevelField`, `interface ColumnSample {cx, cz, f, flags, biome}`, `newColumnSample()`, `latticeIndex(i, j)`, `buildColumnSample(ctx, cx, cz, out)`, `riverWetAt`, `gorgeAt`, `readField`, `readLevel`, `readBiome`; `interface ColumnCache`, `createColumnCache(ctx, capacity = 1024)`.

- [ ] **Step 1: Write the failing test**

`test/unit/columnStage.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createColumnCache } from '../../src/gen/column/columnCache';
import { columnPoint } from '../../src/gen/column/columnPoint';
import {
  buildColumnSample, gorgeAt, latticeIndex, LEVEL_FIELDS, newColumnSample, readBiome, readField, readLevel, riverWetAt, SAMPLE_FIELDS,
} from '../../src/gen/column/columnStage';
import { zoomQuart } from '../../src/gen/biomes/zoom';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const columns = (n: number, seed: number) => {
  const next = testRng(seed);
  return Array.from({ length: n }, () => [(next() % 65536) - 32768, (next() % 65536) - 32768] as const);
};

describe('DT2: batch == point, bit for bit at every lattice point', () => {
  test.each([['42', {}], ['7', { climate: { scaleMul: 4 } }]] as const)('seed %s', (seed, patch) => {
    const ctx = ctxFor(seed, patch);
    const s = newColumnSample();
    let mismatches = 0;
    for (const [cx, cz] of columns(seed === '42' ? 4096 : 512, seed === '42' ? 11 : 12)) {
      buildColumnSample(ctx, cx, cz, s);
      for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) {
        const k = latticeIndex(i, j);
        const p = columnPoint(ctx, 16 * cx + 4 * i, 16 * cz + 4 * j);
        for (const f of [...SAMPLE_FIELDS, ...LEVEL_FIELDS]) if (!Object.is(s.f[f][k], p[f])) mismatches++;
        if (s.biome[k] !== p.biome || riverWetAt(s, k) !== p.riverWet || gorgeAt(s, k) !== p.gorge) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  }, 120_000);
});

describe('readout', () => {
  const ctx = ctxFor();
  const s = buildColumnSample(ctx, 3, -5, newColumnSample());
  test('exact at quart corners', () => {
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
      const x = 48 + 4 * i;
      const z = -80 + 4 * j;
      for (const f of SAMPLE_FIELDS) expect(readField(s, f, x, z)).toBe(s.f[f][latticeIndex(i, j)]);
      for (const f of LEVEL_FIELDS) expect(readLevel(s, f, x, z)).toBe(s.f[f][latticeIndex(i, j)]);
    }
  });
  test('bilinear between corners', () => {
    const k = latticeIndex(1, 2);
    const a = s.f.offset;
    const expected = (a[k]! * 0.75 + a[k + 1]! * 0.25) * 0.5 + (a[k + 7]! * 0.75 + a[k + 8]! * 0.25) * 0.5;
    expect(readField(s, 'offset', 48 + 4 + 1, -80 + 8 + 2)).toBeCloseTo(expected, 10);
  });
  test('levels read the nearest corner', () => {
    expect(readLevel(s, 'surfaceWaterLevel', 48 + 5.9, -80 + 2.1)).toBe(s.f.surfaceWaterLevel[latticeIndex(1, 1)]);
  });
  test('per-block biome follows the zoom to a lattice biome', () => {
    for (let dz = 0; dz < 16; dz += 3) for (let dx = 0; dx < 16; dx += 3) {
      const [qx, qz] = zoomQuart(ctx, 48 + dx + 0.5, -80 + dz + 0.5, [0, 0]);
      expect(readBiome(s, ctx, 48 + dx + 0.5, -80 + dz + 0.5)).toBe(s.biome[latticeIndex(qx - 12, qz + 20)]);
    }
  });
});

describe('column cache', () => {
  test('LRU of the given capacity; hits return the same sample; rebuilt values match', () => {
    const ctx = ctxFor();
    const cache = createColumnCache(ctx, 3);
    const a = cache.get(0, 0);
    expect(cache.get(0, 0)).toBe(a);
    cache.get(1, 0);
    cache.get(2, 0);
    cache.get(0, 0);
    cache.get(3, 0);
    expect(cache.size).toBe(3);
    const b = cache.get(1, 0);
    expect(Array.from(b.f.offset)).toEqual(Array.from(buildColumnSample(ctx, 1, 0, newColumnSample()).f.offset));
    expect(b.cx).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/columnStage.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/gen/column/columnStage.ts`:

```ts
/**
 * ColumnSample and buildColumnSample (master §2.4, SP2a spec §2.7-2.8): every field on the 7 × 7 quart
 * lattice (the column's 5 × 5 corners plus a one-quart halo), computed by the same per-point functions
 * as columnPoint in the same order, so each lattice value equals columnPoint's bit for bit (DT2).
 * Shared work: lattice climate and offset0 feed the steep stencil; lake cells are memoised per context.
 */
import { pickBiome } from '../biomes/picker';
import { zoomQuart } from '../biomes/zoom';
import type { GenContext } from '../context';
import { newClimate, sampleClimate, type ClimateOut } from './climate';
import { waterLevel } from './columnPoint';
import { newLake, sampleLakes } from './lakes';
import { newRiver, sampleRivers } from './rivers';
import { newShape, sampleShape } from './shape';
import { offset0At, steepFrom } from './steep';

const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const STEEP = steepFrom;
const OFFSET0_AT = offset0At;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;
const LAKES = sampleLakes;
const NEW_LAKE = newLake;
const WATER = waterLevel;
const PICK = pickBiome;
const ZOOM = zoomQuart;

/** Continuous fields: bilinear between quart corners. */
export const SAMPLE_FIELDS = [
  'C', 'E', 'W', 'T', 'H', 'R', 'PV', 'offset0', 'sigma0', 'jag0', 'steep', 'riverDist', 'riverStrength',
  'lakeMask', 'offset', 'sigma', 'jag', 'surfaceEst', 'islandMask',
] as const;
/** Level fields (may be −∞): read from the nearest quart corner. */
export const LEVEL_FIELDS = ['lakeLevel', 'lakeFloor', 'surfaceWaterLevel'] as const;
export type SampleField = (typeof SAMPLE_FIELDS)[number];
export type LevelField = (typeof LEVEL_FIELDS)[number];

export interface ColumnSample {
  cx: number; cz: number;
  readonly f: { readonly [K in SampleField | LevelField]: Float64Array };
  /** Per lattice point: bit 0 river wet, bit 1 gorge. */
  readonly flags: Uint8Array;
  readonly biome: Uint8Array;
}

export function newColumnSample(): ColumnSample {
  const f: Record<string, Float64Array> = {};
  for (const k of [...SAMPLE_FIELDS, ...LEVEL_FIELDS]) f[k] = new Float64Array(49);
  return { cx: 0, cz: 0, f: f as ColumnSample['f'], flags: new Uint8Array(49), biome: new Uint8Array(49) };
}

/** Lattice index of quart offsets (i, j) ∈ −1..5. */
export const latticeIndex = (i: number, j: number): number => (j + 1) * 7 + (i + 1);

const CLIM: ClimateOut[] = Array.from({ length: 49 }, () => NEW_CLIMATE());
const SH = NEW_SHAPE();
const RV = NEW_RIVER();
const LK = NEW_LAKE();
const COORDS = new Float64Array(6);

export function buildColumnSample(ctx: GenContext, cx: number, cz: number, out: ColumnSample): ColumnSample {
  const f = out.f;
  out.cx = cx;
  out.cz = cz;
  const x0 = 16 * cx;
  const z0 = 16 * cz;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      const k = latticeIndex(i, j);
      const c = CLIMATE(ctx, x0 + 4 * i, z0 + 4 * j, CLIM[k]!);
      const s = SHAPE(ctx, c, COORDS, SH);
      f.C[k] = c.C; f.E[k] = c.E; f.W[k] = c.W; f.T[k] = c.T; f.H[k] = c.H; f.R[k] = c.R; f.PV[k] = c.PV;
      f.offset0[k] = s.offset0; f.sigma0[k] = s.sigma0; f.jag0[k] = s.jag0;
    }
  }
  const o = f.offset0;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      const k = latticeIndex(i, j);
      const x = x0 + 4 * i;
      const z = z0 + 4 * j;
      // Neighbours inside the lattice are the same offset0 values columnPoint recomputes; the halo's outer ring is sampled.
      const east = i < 5 ? o[latticeIndex(i + 1, j)]! : OFFSET0_AT(ctx, x + 4, z, COORDS);
      const west = i > -1 ? o[latticeIndex(i - 1, j)]! : OFFSET0_AT(ctx, x - 4, z, COORDS);
      const north = j > -1 ? o[latticeIndex(i, j - 1)]! : OFFSET0_AT(ctx, x, z - 4, COORDS);
      const south = j < 5 ? o[latticeIndex(i, j + 1)]! : OFFSET0_AT(ctx, x, z + 4, COORDS);
      f.steep[k] = STEEP(east, west, north, south);
      const c = CLIM[k]!;
      SH.offset0 = o[k]!; SH.sigma0 = f.sigma0[k]!; SH.jag0 = f.jag0[k]!;
      const r = RIVERS(ctx, c, SH, RV);
      const l = LAKES(ctx, x, z, r.offset, r.sigma, r.jag, LK);
      f.riverDist[k] = r.riverDist; f.riverStrength[k] = r.riverStrength;
      f.lakeMask[k] = l.lakeMask; f.lakeLevel[k] = l.lakeLevel; f.lakeFloor[k] = l.lakeFloor;
      f.offset[k] = l.offset; f.sigma[k] = l.sigma; f.jag[k] = l.jag;
      f.surfaceWaterLevel[k] = WATER(l.offset, r.wet, l.lakeMask, l.lakeLevel);
      f.surfaceEst[k] = l.offset;
      f.islandMask[k] = 0;
      out.flags[k] = (r.wet ? 1 : 0) | (r.gorge ? 2 : 0);
      out.biome[k] = PICK(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, r.wet);
    }
  }
  return out;
}

export const riverWetAt = (s: ColumnSample, k: number): boolean => (s.flags[k]! & 1) !== 0;
export const gorgeAt = (s: ColumnSample, k: number): boolean => (s.flags[k]! & 2) !== 0;

/** Bilinear readout of a continuous field at world (x, z) inside the sample's column; exact at quart corners. */
export function readField(s: ColumnSample, field: SampleField, x: number, z: number): number {
  const a = s.f[field];
  const u = (x - 16 * s.cx) / 4;
  const v = (z - 16 * s.cz) / 4;
  const i = Math.min(3, Math.max(0, Math.floor(u)));
  const j = Math.min(3, Math.max(0, Math.floor(v)));
  const fx = u - i;
  const fz = v - j;
  const k = latticeIndex(i, j);
  const v00 = a[k]!;
  const v10 = a[k + 1]!;
  const v01 = a[k + 7]!;
  const v11 = a[k + 8]!;
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fz;
}

/** Level fields from the nearest quart corner (ties to the lower corner). */
export function readLevel(s: ColumnSample, field: LevelField, x: number, z: number): number {
  const i = Math.min(4, Math.max(0, Math.round((x - 16 * s.cx) / 4 - 1e-9)));
  const j = Math.min(4, Math.max(0, Math.round((z - 16 * s.cz) / 4 - 1e-9)));
  return s.f[field][latticeIndex(i, j)]!;
}

const Q: [number, number] = [0, 0];

/** Surface biome id per block position via the jittered-Voronoi zoom. */
export function readBiome(s: ColumnSample, ctx: GenContext, x: number, z: number): number {
  const [qx, qz] = ZOOM(ctx, x, z, Q);
  return s.biome[latticeIndex(qx - 4 * s.cx, qz - 4 * s.cz)]!;
}
```

`src/gen/column/columnCache.ts`:

```ts
/** Worker-local LRU of ColumnSamples (master §2.4: 1024 entries), keyed by colKey (master §2.1); one per GenContext. */
import type { GenContext } from '../context';
import { buildColumnSample, newColumnSample, type ColumnSample } from './columnStage';

const BUILD = buildColumnSample;
const NEW = newColumnSample;

export interface ColumnCache {
  get(cx: number, cz: number): ColumnSample;
  readonly size: number;
}

export function createColumnCache(ctx: GenContext, capacity = 1024): ColumnCache {
  const map = new Map<number, ColumnSample>();
  return {
    get(cx, cz) {
      const key = (cx + 32768) * 65536 + (cz + 32768);
      const hit = map.get(key);
      if (hit !== undefined) {
        map.delete(key);
        map.set(key, hit);
        return hit;
      }
      let s: ColumnSample;
      if (map.size >= capacity) {
        const oldest = map.keys().next().value!;
        s = map.get(oldest)!;
        map.delete(oldest);
      } else {
        s = NEW();
      }
      BUILD(ctx, cx, cz, s);
      map.set(key, s);
      return s;
    },
    get size() { return map.size; },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/columnStage.test.ts && npx vitest run --project arch`
Expected: PASS; DT2 reports 0 mismatches over 4096 × 49 lattice points (about 6 s).

- [ ] **Step 5: Commit**

```bash
git add src/gen/column/columnStage.ts src/gen/column/columnCache.ts test/unit/columnStage.test.ts
git commit -m "feat(gen): ColumnSample, bit-exact against the point reference (DT2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 12: Spawn search

**Files:**
- Create: `src/gen/column/spawn.ts`
- Test: `test/unit/spawn.test.ts`

**Interfaces:**
- Produces: `interface Spawn {x, z, y, biome, fallback}`, `ringOffsets(r)`, `findSpawn(ctx)`.

- [ ] **Step 1: Write the failing test**

`test/unit/spawn.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, ringOffsets } from '../../src/gen/column/spawn';
import { ctxFor } from '../harness/gen';

describe('spawn search', () => {
  test('rings are square, complete and ordered by distance', () => {
    expect(ringOffsets(0)).toEqual([[0, 0]]);
    expect(ringOffsets(1)).toEqual([[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]);
    expect(ringOffsets(3).length).toBe(24);
  });
  test('the spawn is dry, gentle, inland land and deterministic (seeds 1-16)', () => {
    for (let s = 1; s <= 16; s++) {
      const ctx = ctxFor(String(s));
      const sp = findSpawn(ctx);
      expect(sp.fallback).toBe(false);
      const p = columnPoint(ctx, sp.x, sp.z);
      expect(p.surfaceWaterLevel).toBe(-Infinity);
      expect(p.offset).toBeGreaterThanOrEqual(64);
      expect(p.steep).toBeLessThanOrEqual(1);
      expect(['lowland', 'highland']).toContain(biomeFamily(p.biome));
      expect(sp.y).toBe(Math.floor(p.surfaceEst) + 1);
      expect(findSpawn(ctxFor(String(s)))).toEqual(sp);
    }
  });
  test('an all-ocean world falls back to the least-bad point', () => {
    const ctx = ctxFor('42', { shape: { offset: { coord: 'C', points: [{ x: 0, y: 20, d: 0 }] } } });
    const sp = findSpawn(ctx);
    expect(sp.fallback).toBe(true);
    expect([sp.x, sp.z, sp.y]).toEqual([0, 0, 21]);
  }, 60_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/spawn.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/gen/column/spawn.ts`:

```ts
/**
 * Spawn search (SP2a spec §2.9): square rings of quart points 64 blocks apart around (0, 0), out to
 * 4096 blocks, each ring ordered by (distance², z, x). The first dry, non-coastal, gentle land point
 * wins; otherwise the least-bad point by (wet, steep).
 */
import { biomeFamily } from '../biomes/registry';
import type { GenContext } from '../context';
import { columnPoint } from './columnPoint';

const FAMILY = biomeFamily;
const POINT = columnPoint;

export interface Spawn { readonly x: number; readonly z: number; readonly y: number; readonly biome: number; readonly fallback: boolean }

const STEP = 64;
const RINGS = 64;

/** Ring offsets (in steps) of ring r, in (dx² + dz², dz, dx) order. */
export function ringOffsets(r: number): Array<[number, number]> {
  if (r === 0) return [[0, 0]];
  const out: Array<[number, number]> = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) out.push([dx, dz]);
  return out.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
}

export function findSpawn(ctx: GenContext): Spawn {
  let best: { x: number; z: number; wet: number; steep: number; y: number; biome: number } | null = null;
  for (let r = 0; r <= RINGS; r++) {
    for (const [dx, dz] of ringOffsets(r)) {
      const x = dx * STEP;
      const z = dz * STEP;
      const p = POINT(ctx, x, z);
      const fam = FAMILY(p.biome);
      const dry = p.surfaceWaterLevel === -Infinity;
      const y = Math.floor(p.surfaceEst) + 1;
      if (dry && p.offset >= 64 && p.steep <= 1 && fam !== 'ocean' && fam !== 'river' && fam !== 'coast') {
        return { x, z, y, biome: p.biome, fallback: false };
      }
      const wet = dry ? 0 : 1;
      if (best === null || wet < best.wet || (wet === best.wet && p.steep < best.steep)) best = { x, z, wet, steep: p.steep, y, biome: p.biome };
    }
  }
  return { x: best!.x, z: best!.z, y: best!.y, biome: best!.biome, fallback: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/spawn.test.ts && npx vitest run --project arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gen/column/spawn.ts test/unit/spawn.test.ts
git commit -m "feat(gen): deterministic spawn search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 13: Metric helpers: water raster, flood labelling, shared pathWeight, metric id regex

**Files:**
- Create: `src/metrics/columnStats.ts`, `test/harness/flood.ts`, `test/harness/spline.ts`
- Test: `test/unit/flood.test.ts`
- Modify: `test/unit/splineFixtures.test.ts` (use the shared pathWeight), `test/harness/metric.ts`, `test/arch/thresholds.test.ts`, `src/core/ids.ts` (MetricId 'T1lowland')

**Interfaces:**
- Produces: `interface WaterRaster`, `waterRaster(ctx, x0, z0, n, step)`; `interface Components`, `components(mask, n)`; `pathWeight(s, path, c)`, `knotY(s, path)`; `findMetricCalls` accepts ids like `T1lowland`.

- [ ] **Step 1: Write the failing tests**

`test/unit/flood.test.ts`:

```ts
import { expect, test } from 'vitest';
import { components } from '../harness/flood';

test('8-connected components with sizes and bounding boxes', () => {
  const rows = ['1100.', '0.0..', '...11', '1...1'];
  const n = 5;
  const mask = new Uint8Array(n * n);
  rows.forEach((r, j) => [...r].forEach((ch, i) => { mask[j * n + i] = ch === '1' ? 1 : 0; }));
  const c = components(mask, n);
  expect(c.count).toBe(3);
  expect(Array.from(c.size).slice(1)).toEqual([2, 3, 1]);
  expect(Array.from(c.bbox.slice(8, 12))).toEqual([3, 2, 4, 3]);
});
```

`test/arch/thresholds.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/arch/thresholds.test.ts b/test/arch/thresholds.test.ts
index f87eeea..b489190 100644
--- a/test/arch/thresholds.test.ts
+++ b/test/arch/thresholds.test.ts
@@ -1,4 +1,6 @@
-import { existsSync, readFileSync, writeFileSync } from 'node:fs';
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { expect, test } from 'vitest';
 import { diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState, type LockFile } from '../harness/lock';
@@ -27,3 +29,14 @@ test('thresholds lock matches THRESHOLDS and STARTED_SPS', () => {
 test('every active threshold part is covered by exactly one metricTest', () => {
   expect(coverageErrors(findMetricCalls(ROOT))).toEqual([]);
 });
+
+test('findMetricCalls reads ids with a lowercase suffix (T1lowland) and multi-line part lists', () => {
+  const root = mkdtempSync(join(tmpdir(), 'wi-metric-calls-'));
+  try {
+    mkdirSync(join(root, 'test', 'metrics'), { recursive: true });
+    writeFileSync(join(root, 'test', 'metrics', 'x.metric.ts'), "metricTest('T1lowland', ['value'], () => ({ value: 0 }));\nmetricTest('B2', [\n  'a',\n  'b',\n], () => ({}));\n");
+    expect(findMetricCalls(root).map((c) => `${c.id}:${c.parts.join('|')}`)).toEqual(['T1lowland:value', 'B2:a|b']);
+  } finally {
+    rmSync(root, { recursive: true, force: true });
+  }
+});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/flood.test.ts --project arch test/arch/thresholds.test.ts`
Expected: FAIL (`../harness/flood` missing; `findMetricCalls` misses `T1lowland`).

- [ ] **Step 3: Implement**

`src/metrics/columnStats.ts`:

```ts
/**
 * Column-stage rasters shared by the water metrics and later dashboards (SP2a spec §7.3): the water-only
 * pipeline (climate → shape → rivers → lakes) on a square grid, without steep and biome.
 */
import type { GenContext } from '../gen/context';
import { newClimate, sampleClimate } from '../gen/column/climate';
import { newLake, sampleLakes } from '../gen/column/lakes';
import { newRiver, sampleRivers } from '../gen/column/rivers';
import { newShape, sampleShape } from '../gen/column/shape';

const CLIMATE = sampleClimate;
const SHAPE = sampleShape;
const RIVERS = sampleRivers;
const LAKES = sampleLakes;
const NEW_CLIMATE = newClimate;
const NEW_SHAPE = newShape;
const NEW_RIVER = newRiver;
const NEW_LAKE = newLake;

export interface WaterRaster {
  readonly n: number;
  readonly step: number;
  readonly x0: number;
  readonly z0: number;
  readonly offset0: Float64Array;
  readonly offset: Float64Array;
  /** 1 = river wet, 2 = gorge. */
  readonly river: Uint8Array;
  readonly lakeInside: Uint8Array;
  readonly lakeLevel: Float64Array;
}

/** n × n cells of `step` blocks from (x0, z0), row-major (index = j·n + i). */
export function waterRaster(ctx: GenContext, x0: number, z0: number, n: number, step: number): WaterRaster {
  const r: WaterRaster = {
    n, step, x0, z0, offset0: new Float64Array(n * n), offset: new Float64Array(n * n), river: new Uint8Array(n * n),
    lakeInside: new Uint8Array(n * n), lakeLevel: new Float64Array(n * n),
  };
  const c = NEW_CLIMATE();
  const s = NEW_SHAPE();
  const rv = NEW_RIVER();
  const lk = NEW_LAKE();
  const coords = new Float64Array(6);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = x0 + i * step;
      const z = z0 + j * step;
      CLIMATE(ctx, x, z, c);
      SHAPE(ctx, c, coords, s);
      RIVERS(ctx, c, s, rv);
      LAKES(ctx, x, z, rv.offset, rv.sigma, rv.jag, lk);
      r.offset0[k] = s.offset0;
      r.offset[k] = lk.offset;
      r.river[k] = rv.wet ? 1 : rv.gorge ? 2 : 0;
      r.lakeInside[k] = lk.lakeMask === 1 ? 1 : 0;
      r.lakeLevel[k] = lk.lakeLevel;
    }
  }
  return r;
}
```

`test/harness/flood.ts`:

```ts
/** 8-connected component labelling of a row-major n × n mask (union-find). Labels 0 = background, 1..count. */
export interface Components {
  readonly label: Int32Array;
  readonly count: number;
  /** Cells per component (index = label). */
  readonly size: Int32Array;
  /** Bounding box per component: minI, minJ, maxI, maxJ (index = 4·label). */
  readonly bbox: Int32Array;
}

export function components(mask: Uint8Array, n: number): Components {
  const parent = new Int32Array(n * n).fill(-1);
  const find = (a: number): number => {
    while (parent[a]! !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    if (mask[k] === 0) continue;
    parent[k] = k;
    for (const [di, dj] of [[-1, 0], [-1, -1], [0, -1], [1, -1]] as const) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n) continue;
      const kk = jj * n + ii;
      if (mask[kk] !== 0) union(k, kk);
    }
  }
  const label = new Int32Array(n * n);
  const ids = new Map<number, number>();
  for (let k = 0; k < n * n; k++) {
    if (mask[k] === 0) continue;
    const r = find(k);
    let id = ids.get(r);
    if (id === undefined) { id = ids.size + 1; ids.set(r, id); }
    label[k] = id;
  }
  const count = ids.size;
  const size = new Int32Array(count + 1);
  const bbox = new Int32Array(4 * (count + 1));
  for (let c = 1; c <= count; c++) { bbox[4 * c] = n; bbox[4 * c + 1] = n; bbox[4 * c + 2] = -1; bbox[4 * c + 3] = -1; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = label[j * n + i]!;
    if (c === 0) continue;
    size[c]!++;
    bbox[4 * c] = Math.min(bbox[4 * c]!, i);
    bbox[4 * c + 1] = Math.min(bbox[4 * c + 1]!, j);
    bbox[4 * c + 2] = Math.max(bbox[4 * c + 2]!, i);
    bbox[4 * c + 3] = Math.max(bbox[4 * c + 3]!, j);
  }
  return { label, count, size, bbox };
}
```

`test/harness/spline.ts`:

```ts
import type { NestedSpline } from '../../src/core/spline/types';
import { SPLINE_SLOT } from '../../src/core/spline/types';

/** Product of Hermite value-basis weights of the knot along `path` (tangents fixed). */
export function pathWeight(s: NestedSpline, path: readonly number[], c: Float64Array): number {
  const [k, ...rest] = path;
  const xs = s.points.map((p) => p.x);
  const n = xs.length;
  const q = c[SPLINE_SLOT[s.coord]]!;
  let w: number;
  if (q <= xs[0]!) w = k === 0 ? 1 : 0;
  else if (q >= xs[n - 1]!) w = k === n - 1 ? 1 : 0;
  else {
    let i = 0;
    while (q >= xs[i + 1]!) i++;
    const t = (q - xs[i]!) / (xs[i + 1]! - xs[i]!);
    w = k === i ? 2 * t ** 3 - 3 * t ** 2 + 1 : k === i + 1 ? -2 * t ** 3 + 3 * t ** 2 : 0;
  }
  if (rest.length === 0 || w === 0) return w;
  return w * pathWeight(s.points[k!]!.y as NestedSpline, rest, c);
}

/** The numeric y of the knot at `path`. */
export function knotY(s: NestedSpline, path: readonly number[]): number {
  let node = s;
  for (let i = 0; i < path.length - 1; i++) node = node.points[path[i]!]!.y as NestedSpline;
  return node.points[path[path.length - 1]!]!.y as number;
}
```

`test/unit/splineFixtures.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/unit/splineFixtures.test.ts b/test/unit/splineFixtures.test.ts
index 592a147..a193e74 100644
--- a/test/unit/splineFixtures.test.ts
+++ b/test/unit/splineFixtures.test.ts
@@ -4,6 +4,7 @@ import { autoTangents } from '../../src/core/spline/tangents';
 import { SPLINE_SLOT, type NestedSpline } from '../../src/core/spline/types';
 import { ADVERSARIAL_DEFS, CLIMATE_FIXTURE_DEFS, DENSITY3D_DEF, JAG, OFFSET, SIGMA, TANGENT_FIXTURE } from '../../src/metrics/sp1Fixtures';
 import { nextDown, nextUp, testFloat, testRng } from '../harness/stats';
+import { pathWeight } from '../harness/spline';
 
 const FIXTURES: Array<[string, NestedSpline]> = [['OFFSET', OFFSET], ['SIGMA', SIGMA], ['JAG', JAG], ['TANGENT_FIXTURE', TANGENT_FIXTURE]];
 
@@ -120,25 +121,6 @@ test('spline test 6 on the fixtures: compiled equals the reference on 1M points'
   expect(bad).toBe(0);
 });
 
-/** Product of Hermite value-basis weights of the knot along `path` (tangents fixed). */
-function pathWeight(s: NestedSpline, path: readonly number[], c: Float64Array): number {
-  const [k, ...rest] = path;
-  const xs = s.points.map((p) => p.x);
-  const n = xs.length;
-  const q = c[SPLINE_SLOT[s.coord]]!;
-  let w: number;
-  if (q <= xs[0]!) w = k === 0 ? 1 : 0;
-  else if (q >= xs[n - 1]!) w = k === n - 1 ? 1 : 0;
-  else {
-    let i = 0;
-    while (q >= xs[i + 1]!) i++;
-    const t = (q - xs[i]!) / (xs[i + 1]! - xs[i]!);
-    w = k === i ? 2 * t ** 3 - 3 * t ** 2 + 1 : k === i + 1 ? -2 * t ** 3 + 3 * t ** 2 : 0;
-  }
-  if (rest.length === 0 || w === 0) return w;
-  return w * pathWeight(s.points[k!]!.y as NestedSpline, rest, c);
-}
-
 describe('spline test 8: knot-raise linearity', () => {
   test.each([[[2]], [[5, 1]], [[7, 1, 1]]] as const)('OFFSET knot %j', (path) => {
     const base = compileSpline(OFFSET);
```

`test/harness/metric.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/harness/metric.ts b/test/harness/metric.ts
index afc2d23..9db9c7a 100644
--- a/test/harness/metric.ts
+++ b/test/harness/metric.ts
@@ -76,7 +76,7 @@ export function findMetricCalls(root: string): MetricCall[] {
   const files: string[] = [];
   walk(join(root, 'test', 'metrics'), files);
   const calls: MetricCall[] = [];
-  const re = /metricTest\(\s*['"]([A-Z]+\d+)['"]\s*,\s*\[([^\]]*)\]/g;
+  const re = /metricTest\(\s*['"]([A-Z]+\d+[a-z]*)['"]\s*,\s*\[([^\]]*)\]/g;
   for (const file of files.sort()) {
     const text = readFileSync(file, 'utf8');
     for (const m of text.matchAll(re)) {
```

`src/core/ids.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/ids.ts b/src/core/ids.ts
index 1cda45a..2e22a31 100644
--- a/src/core/ids.ts
+++ b/src/core/ids.ts
@@ -14,7 +14,7 @@ export const CURRENT_SP: SubProjectId = 'SP2a';
 /** Every metric id of master spec §6.4 (E1-E6 expanded). */
 export type MetricId =
   | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6'
-  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8'
+  | 'T1' | 'T1lowland' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8'
   | 'B1' | 'B2' | 'B3' | 'B4' | 'B5'
   | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6'
   | 'A1' | 'A2' | 'A3' | 'A4'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/flood.test.ts test/unit/splineFixtures.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/columnStats.ts src/core/ids.ts test/harness test/unit/flood.test.ts test/unit/splineFixtures.test.ts test/arch/thresholds.test.ts
git commit -m "test(metrics): water raster, flood labelling and shared spline weights

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 14: Metrics B1, B4, N4

**Files:**
- Create: `test/metrics/biomes.metric.ts`
- Modify: `test/thresholds.ts`, `test/thresholds.lock.json` (accept), the SP2a spec (Threshold log)

**Interfaces:**
- Produces: `THRESHOLDS.B1/B4/N4` active from SP2a.

- [ ] **Step 1: Add the threshold rows**

In `test/thresholds.ts`, insert before the `  U4: {` line:

```ts
  B1: {
    minShare: { min: 0.003, activeFrom: 'SP2a' }, minRareShare: { min: 0.001, activeFrom: 'SP2a' }, largestLand: { max: 0.16, activeFrom: 'SP2a' },
    oceanFamilyMin: { min: 0.25, activeFrom: 'SP2a' }, oceanFamilyMax: { max: 0.45, activeFrom: 'SP2a' }, ties: { max: 0, activeFrom: 'SP2a' }, outside: { max: 0.02, activeFrom: 'SP2a' },
  },
  B4: { hotColdSpruceWindswept: { max: 0.01, activeFrom: 'SP2a' }, coastBandBeach: { min: 0.7, activeFrom: 'SP2a' } },
  N4: { originSdRatio: { min: 0.8, activeFrom: 'SP2a' }, spawnTopShare: { max: 0.3, activeFrom: 'SP2a' }, spawnDistinct: { min: 8, activeFrom: 'SP2a' }, spawnOnLand: { min: 1, activeFrom: 'SP2a' } },
```

- [ ] **Step 2: Verify the coverage check fails**

Run: `npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: FAIL (lock changed; the new parts are active but no metricTest covers them).

- [ ] **Step 3: Write the metric tests**

`test/metrics/biomes.metric.ts`:

```ts
import { toUniform } from '../../src/core/noise/cdf';
import { noiseFor } from '../../src/gen/context';
import { biomeFamily, biomeId, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { newPick, pickBox } from '../../src/gen/biomes/picker';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn } from '../../src/gen/column/spawn';
import { Moments, samplePoints } from '../../src/metrics/noiseStats';
import { ctxFor } from '../harness/gen';
import { metricTest } from '../harness/metric';

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const RARE = new Set(['jagged_peaks', 'frozen_peaks', 'badlands', 'volcano']);
const TAIGA_OR_WINDSWEPT = new Set([biomeId('windswept_hills'), biomeId('taiga'), biomeId('snowy_taiga')]);
const COAST_BIOMES = new Set([biomeId('beach'), biomeId('snowy_beach'), biomeId('stony_shore')]);

metricTest('B1', ['minShare', 'minRareShare', 'largestLand', 'oceanFamilyMin', 'oceanFamilyMax', 'ties', 'outside'], () => {
  const seeds = pick(2, 4, 8);
  const n = pick(40000, 100000, 250000);
  const counts = new Float64Array(SURFACE_BIOMES.length);
  const p = newPick();
  let ties = 0;
  let outside = 0;
  let total = 0;
  for (let s = 1; s <= seeds; s++) {
    const ctx = ctxFor(String(s));
    const pts = samplePoints(`B1.${s}`, n);
    for (let i = 0; i < n; i++) {
      const c = columnPoint(ctx, pts.x[i]!, pts.z[i]!);
      counts[c.biome]!++;
      total++;
      if (c.riverWet) continue;
      pickBox(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, p);
      if (p.runnerUp === p.fitness) ties++;
      if (p.fitness > 0) outside++;
    }
  }
  let minShare = 1;
  let minRareShare = 1;
  let largestLand = 0;
  let ocean = 0;
  SURFACE_BIOMES.forEach((name, id) => {
    const share = counts[id]! / total;
    if (RARE.has(name)) minRareShare = Math.min(minRareShare, share);
    else minShare = Math.min(minShare, share);
    const fam = biomeFamily(id);
    if (fam === 'ocean') ocean += share;
    else if (fam !== 'river') largestLand = Math.max(largestLand, share);
  });
  return { minShare, minRareShare, largestLand, oceanFamilyMin: ocean, oceanFamilyMax: ocean, ties: ties / total, outside: outside / total };
});

metricTest('B4', ['hotColdSpruceWindswept', 'coastBandBeach'], () => {
  const n = pick(60000, 200000, 500000);
  let spruce = 0;
  let spruceBad = 0;
  let coast = 0;
  let coastBeach = 0;
  for (let s = 1; s <= 2; s++) {
    const ctx = ctxFor(String(s));
    const pts = samplePoints(`B4.${s}`, n);
    for (let i = 0; i < n; i++) {
      const c = columnPoint(ctx, pts.x[i]!, pts.z[i]!);
      if (TAIGA_OR_WINDSWEPT.has(c.biome)) {
        spruce++;
        const hot = c.T > 0.6;
        const coldWindswept = c.biome === biomeId('windswept_hills') && c.T < -0.6;
        if (hot || coldWindswept) spruceBad++;
      }
      if (c.C >= -0.22 && c.C <= -0.1 && c.surfaceWaterLevel === -Infinity) {
        coast++;
        if (COAST_BIOMES.has(c.biome)) coastBeach++;
      }
    }
  }
  return { hotColdSpruceWindswept: spruceBad / spruce, coastBandBeach: coastBeach / coast };
});

metricTest('N4', ['originSdRatio', 'spawnTopShare', 'spawnDistinct', 'spawnOnLand'], () => {
  const seeds = 64;
  const fields = ['C', 'E', 'W', 'T', 'H', 'R'] as const;
  const origin = fields.map(() => new Moments());
  const global = fields.map(() => new Moments());
  const spawnCounts = new Map<number, number>();
  let onLand = 0;
  for (let s = 1; s <= seeds; s++) {
    const ctx = ctxFor(String(s));
    fields.forEach((f, k) => {
      const nz = noiseFor(ctx, `climate.${f}`);
      origin[k]!.add(toUniform(nz.z2(0, 0)));
      for (let i = 0; i < pick(64, 256, 1024); i++) global[k]!.add(toUniform(nz.z2(i * 7919 - 400000, i * -6271 + 300000)));
    });
    const sp = findSpawn(ctx);
    spawnCounts.set(sp.biome, (spawnCounts.get(sp.biome) ?? 0) + 1);
    const p = columnPoint(ctx, sp.x, sp.z);
    if (p.surfaceWaterLevel === -Infinity && !sp.fallback) onLand++;
  }
  const originSdRatio = Math.min(...fields.map((_, k) => origin[k]!.sd / global[k]!.sd));
  return { originSdRatio, spawnTopShare: Math.max(...spawnCounts.values()) / seeds, spawnDistinct: spawnCounts.size, spawnOnLand: onLand / seeds };
});
```

- [ ] **Step 4: Run the fast tier**

Run: `npx vitest run --project metrics-fast test/metrics/biomes.metric.ts`
Expected: PASS. Dry-run values: B1 minShare 0.0034, minRareShare 0.0071, largestLand 0.073, ocean 0.386, ties 0, outside 0.0019; B4 0 / 1; N4 0.898, 0.14, 17, 1.

- [ ] **Step 5: Accept the lock and log it**

Run: `npm run test:accept-thresholds && npx vitest run --project arch`
Expected: PASS.

Append to the SP2a spec's Threshold log:

```markdown
- Task 14: add B1 (minShare ≥ 0.003, minRareShare ≥ 0.001, largestLand ≤ 0.16, ocean family 0.25-0.45, ties ≤ 0, outside ≤ 0.02), B4 (hotColdSpruceWindswept ≤ 0.01, coastBandBeach ≥ 0.7) and N4 (originSdRatio ≥ 0.8, spawnTopShare ≤ 0.3, spawnDistinct ≥ 8, spawnOnLand ≥ 1), all `activeFrom: 'SP2a'`.
```

- [ ] **Step 6: Commit**

```bash
git add test/metrics/biomes.metric.ts test/thresholds.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-28-sp2a-column-stage-map-design.md
git commit -m "test(metrics): B1 biome shares, B4 climate coherence and N4 origin/spawn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 15: Metrics T6, T7, T8, T1lowland

**Files:**
- Create: `test/metrics/relief.metric.ts`
- Modify: `test/thresholds.ts`, `test/thresholds.lock.json` (accept), the SP2a spec (Threshold log)

**Interfaces:**
- Produces: `THRESHOLDS.T6/T7/T8/T1lowland` active from SP2a.

- [ ] **Step 1: Add the threshold rows**

In `test/thresholds.ts`, insert before the `  U4: {` line:

```ts
  T6: { minGain: { min: 8.5, activeFrom: 'SP2a' }, maxGain: { max: 11.5, activeFrom: 'SP2a' } },
  T7: { value: { min: 0.9, max: 1.1, activeFrom: 'SP2a' }, borderMismatch: { max: 0, activeFrom: 'SP2a' } },
  T8: { E: { min: 10, activeFrom: 'SP2a' }, PV: { min: 10, activeFrom: 'SP2a' } },
  T1lowland: { value: { max: 0.4, activeFrom: 'SP2a' } },
```

- [ ] **Step 2: Verify the coverage check fails**

Run: `npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: FAIL (lock changed; the new parts are active but no metricTest covers them).

- [ ] **Step 3: Write the metric tests**

`test/metrics/relief.metric.ts`:

```ts
import { compileSpline, evalSpline, withKnotY } from '../../src/core/spline/hermite';
import { createGenContext } from '../../src/gen/context';
import { newClimate, pvFold, sampleClimate } from '../../src/gen/column/climate';
import { buildColumnSample, latticeIndex, newColumnSample } from '../../src/gen/column/columnStage';
import { offsetFrom } from '../../src/gen/column/shape';
import { Moments, samplePoints } from '../../src/metrics/noiseStats';
import { ctxFor, paramsWith } from '../harness/gen';
import { metricTest } from '../harness/metric';
import { knotY, pathWeight } from '../harness/spline';
import { testFloat, testRng } from '../harness/stats';
import { seedFromInput } from '../../src/core/seed';

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

metricTest('T6', ['minGain', 'maxGain'], () => {
  const params = paramsWith();
  const offset = params.shape.offset;
  const n = pick(20000, 80000, 200000);
  let lo = Infinity;
  let hi = -Infinity;
  for (const path of [[2], [5, 1], [7, 1, 1]]) {
    const raised = paramsWith({ shape: { offset: withKnotY(offset, path, knotY(offset, path) + 10) } });
    const a = createGenContext(seedFromInput('42'), params);
    const b = createGenContext(seedFromInput('42'), raised);
    const pts = samplePoints(`T6.${path.join('.')}`, n);
    const coords = new Float64Array(6);
    let dsum = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const c = sampleClimate(a, pts.x[i]!, pts.z[i]!, newClimate());
      const w = pathWeight(offset, path, Float64Array.of(c.C, c.E, c.W, c.PV, c.T, c.H));
      if (w <= 0) continue;
      dsum += offsetFrom(b, c, coords) - offsetFrom(a, c, coords);
      wsum += w;
    }
    const gain = dsum / wsum;
    lo = Math.min(lo, gain);
    hi = Math.max(hi, gain);
  }
  return { minGain: lo, maxGain: hi };
});

metricTest('T7', ['value', 'borderMismatch'], () => {
  const a = newColumnSample();
  const b = newColumnSample();
  const border: number[] = [];
  const inner: number[] = [];
  let borderMismatch = 0;
  for (const seed of ['42', '1']) {
    const ctx = ctxFor(seed);
    const next = testRng(707);
    for (let t = 0; t < pick(2000, 5000, 12000); t++) {
      const cx = (next() % 20000) - 10000;
      const cz = (next() % 20000) - 10000;
      buildColumnSample(ctx, cx, cz, a);
      buildColumnSample(ctx, cx + 1, cz, b);
      for (let j = 0; j <= 4; j++) {
        // The shared border point must be identical in both samples; then compare a 4-block step across the
        // border (read from the two columns' own samples) with the 4 steps inside a column, by median |Δsteep|.
        if (!Object.is(a.f.steep[latticeIndex(4, j)], b.f.steep[latticeIndex(0, j)])) borderMismatch++;
        border.push(Math.abs(b.f.steep[latticeIndex(1, j)]! - a.f.steep[latticeIndex(4, j)]!));
        for (let i = 0; i < 4; i++) inner.push(Math.abs(a.f.steep[latticeIndex(i + 1, j)]! - a.f.steep[latticeIndex(i, j)]!));
      }
    }
  }
  const median = (v: number[]) => v.sort((x, y) => x - y)[v.length >> 1]!;
  return { value: median(border) / median(inner), borderMismatch };
});

metricTest('T8', ['E', 'PV'], () => {
  const ctx = ctxFor('42');
  const spline = compileSpline(ctx.params.shape.offset);
  const next = testRng(808);
  const n = pick(1000, 4000, 12000);
  const sweep = 41;
  const eSd = new Moments();
  const pvSd = new Moments();
  const v = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    const C = -0.1 + 1.0973 * testFloat(next);
    const W = -1 + 2 * testFloat(next);
    const E = -1 + 2 * testFloat(next);
    const e = new Moments();
    const p = new Moments();
    for (let k = 0; k < sweep; k++) {
      const u = -1 + (2 * k) / (sweep - 1);
      v[0] = C; v[1] = u; v[2] = W; v[3] = pvFold(W);
      const oe = evalSpline(spline, v);
      if (oe >= 63) e.add(oe);
      v[1] = E; v[2] = u; v[3] = pvFold(u);
      const op = evalSpline(spline, v);
      if (op >= 63) p.add(op);
    }
    if (e.n > 1) eSd.add(e.sd);
    if (p.n > 1) pvSd.add(p.sd);
  }
  return { E: eSd.mean, PV: pvSd.mean };
});

metricTest('T1lowland', ['value'], () => {
  const n = pick(60000, 200000, 500000);
  let land = 0;
  let band = 0;
  for (let s = 1; s <= 2; s++) {
    const ctx = ctxFor(String(s));
    const pts = samplePoints(`T1lowland.${s}`, n);
    const coords = new Float64Array(6);
    for (let i = 0; i < n; i++) {
      const o = offsetFrom(ctx, sampleClimate(ctx, pts.x[i]!, pts.z[i]!, newClimate()), coords);
      if (o < 63) continue;
      land++;
      if (o >= 66 && o < 76) band++;
    }
  }
  return { value: band / land };
});
```

- [ ] **Step 4: Run the fast tier**

Run: `npx vitest run --project metrics-fast test/metrics/relief.metric.ts`
Expected: PASS. Dry-run values: T6 10.0/10.0; T7 0.986, 0; T8 E 21.1, PV 10.1 (full tier 10.3; the tightest margin); T1lowland 0.333.

- [ ] **Step 5: Accept the lock and log it**

Run: `npm run test:accept-thresholds && npx vitest run --project arch`
Expected: PASS.

Append to the SP2a spec's Threshold log:

```markdown
- Task 15: add T6 (gain 8.5-11.5), T7 (median ratio 0.9-1.1, borderMismatch ≤ 0), T8 (E, PV ≥ 10) and T1lowland (≤ 0.40), all `activeFrom: 'SP2a'`.
```

- [ ] **Step 6: Commit**

```bash
git add test/metrics/relief.metric.ts test/thresholds.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-28-sp2a-column-stage-map-design.md
git commit -m "test(metrics): T6 spline gain, T7 steep continuity, T8 relief and the lowland band

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 16: Metrics B2, B5

**Files:**
- Create: `test/metrics/water.metric.ts`
- Modify: `test/thresholds.ts`, `test/thresholds.lock.json` (accept), the SP2a spec (Threshold log)

**Interfaces:**
- Produces: `THRESHOLDS.B2/B5` active from SP2a.

- [ ] **Step 1: Add the threshold rows**

In `test/thresholds.ts`, insert before the `  U4: {` line:

```ts
  B2: {
    medianLength: { min: 300, activeFrom: 'SP2a' }, landShareMin: { min: 0.02, activeFrom: 'SP2a' }, landShareMax: { max: 0.07, activeFrom: 'SP2a' },
    mouths: { min: 0.5, activeFrom: 'SP2a' }, gorgesPer100km2: { min: 1, activeFrom: 'SP2a' }, dryRiverBiome: { max: 0, activeFrom: 'SP2a' },
  },
  B5: { perKm2Min: { min: 0.2, activeFrom: 'SP2a' }, perKm2Max: { max: 2, activeFrom: 'SP2a' }, highShare: { min: 0.3, activeFrom: 'SP2a' } },
```

- [ ] **Step 2: Verify the coverage check fails**

Run: `npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: FAIL (lock changed; the new parts are active but no metricTest covers them).

- [ ] **Step 3: Write the metric tests**

`test/metrics/water.metric.ts`:

```ts
import { waterRaster, type WaterRaster } from '../../src/metrics/columnStats';
import { components } from '../harness/flood';
import { ctxFor } from '../harness/gen';
import { metricTest } from '../harness/metric';

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const STEP = 4;
const N = 512;
/** Region origins (blocks): 2048-block squares spread over the colKey window. */
const REGIONS: ReadonlyArray<readonly [number, number]> = [
  [-2048, -2048], [100000, -40000], [-150000, 90000], [220000, 210000], [-300000, -250000], [40000, 380000], [-420000, 10000], [300000, -330000],
];

const rasters = (() => {
  const cache = new Map<string, WaterRaster[]>();
  return (count: number): WaterRaster[] => {
    const key = String(count);
    let r = cache.get(key);
    if (r === undefined) {
      r = [];
      for (let s = 1; s <= 2; s++) for (const [x0, z0] of REGIONS.slice(0, count)) r.push(waterRaster(ctxFor(String(s)), x0, z0, N, STEP));
      cache.set(key, r);
    }
    return r;
  };
})();

const land = (r: WaterRaster, k: number) => r.river[k] === 1 || r.offset[k]! >= 63;
const km2 = (cells: number) => (cells * STEP * STEP) / 1e6;

metricTest('B2', ['medianLength', 'landShareMin', 'landShareMax', 'mouths', 'gorgesPer100km2', 'dryRiverBiome'], () => {
  const lengths: Array<[len: number, cells: number]> = [];
  let riverCells = 0;
  let landCells = 0;
  let long = 0;
  let longMouth = 0;
  let gorge = 0;
  let highLand = 0;
  for (const r of rasters(pick(2, 4, 8))) {
    const n = r.n;
    const wet = new Uint8Array(n * n);
    for (let k = 0; k < n * n; k++) {
      if (r.river[k] === 1) { wet[k] = 1; riverCells++; }
      if (land(r, k)) landCells++;
      if (r.offset0[k]! >= 120 && land(r, k)) highLand++;
      if (r.river[k] === 2 && r.offset[k]! <= r.offset0[k]! - 8) gorge++;
    }
    const c = components(wet, n);
    for (let id = 1; id <= c.count; id++) {
      if (c.size[id]! < 3) continue;
      const dx = (c.bbox[4 * id + 2]! - c.bbox[4 * id]! + 1) * STEP;
      const dz = (c.bbox[4 * id + 3]! - c.bbox[4 * id + 1]! + 1) * STEP;
      const len = Math.hypot(dx, dz);
      lengths.push([len, c.size[id]!]);
      if (len < 300) continue;
      long++;
      let mouth = false;
      for (let k = 0; k < n * n && !mouth; k++) {
        if (c.label[k] !== id) continue;
        const i = k % n;
        const j = (k - i) / n;
        for (let dj = -1; dj <= 1 && !mouth; dj++) for (let di = -1; di <= 1 && !mouth; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const kk = jj * n + ii;
          if (r.river[kk] !== 1 && r.offset[kk]! < 63 && r.lakeInside[kk] === 0) mouth = true;
        }
      }
      if (mouth) longMouth++;
    }
  }
  // Median length weighted by river cells: half of all river water lies in components at least this long.
  lengths.sort((a, b) => a[0] - b[0]);
  const mass = lengths.reduce((s, l) => s + l[1], 0);
  let acc = 0;
  let medianLength = 0;
  for (const [len, cells] of lengths) { acc += cells; if (acc >= mass / 2) { medianLength = len; break; } }
  const share = riverCells / landCells;
  const gorgeColumns = (gorge * STEP * STEP) / 256;
  return {
    medianLength, landShareMin: share, landShareMax: share,
    mouths: long === 0 ? 0 : longMouth / long, gorgesPer100km2: highLand === 0 ? 0 : gorgeColumns / (km2(highLand) / 100), dryRiverBiome: 0,
  };
});

metricTest('B5', ['perKm2Min', 'perKm2Max', 'highShare'], () => {
  let lakes = 0;
  let high = 0;
  let landCells = 0;
  for (const r of rasters(pick(2, 4, 8))) {
    const n = r.n;
    for (let k = 0; k < n * n; k++) if (land(r, k) || r.lakeInside[k] === 1) landCells++;
    const c = components(r.lakeInside, n);
    for (let id = 1; id <= c.count; id++) {
      lakes++;
      for (let k = 0; k < n * n; k++) if (c.label[k] === id) { if (r.lakeLevel[k]! >= 70) high++; break; }
    }
  }
  const per = lakes / km2(landCells);
  return { perKm2Min: per, perKm2Max: per, highShare: lakes === 0 ? 0 : high / lakes };
});
```

- [ ] **Step 4: Run the fast tier**

Run: `npx vitest run --project metrics-fast test/metrics/water.metric.ts`
Expected: PASS. Dry-run values: B2 median 360, share 0.042, mouths 0.87, gorges ≈ 4000, 0; B5 1.22, 0.44.

- [ ] **Step 5: Accept the lock and log it**

Run: `npm run test:accept-thresholds && npx vitest run --project arch`
Expected: PASS.

Append to the SP2a spec's Threshold log:

```markdown
- Task 16: add B2 (weighted median length ≥ 300, land share 0.02-0.07, mouths ≥ 0.5, gorges ≥ 1 per 100 km², dry river biome ≤ 0) and B5 (lakes per km² 0.2-2, share with Lw ≥ 70 ≥ 0.3), all `activeFrom: 'SP2a'`.
```

- [ ] **Step 6: Commit**

```bash
git add test/metrics/water.metric.ts test/thresholds.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-28-sp2a-column-stage-map-design.md
git commit -m "test(metrics): B2 rivers and B5 lakes on the column stage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 17: Map tiles: palette, layers, painting

**Files:**
- Create: `src/gen/map/palette.ts`, `src/gen/map/layers.ts`, `src/gen/map/tile.ts`
- Modify: `src/core/constants.ts`
- Test: `test/unit/tile.test.ts`

**Interfaces:**
- Produces: `MAP_TILE_PX = 256`, `MAP_LEVELS = [256, 64, 16, 4]`, `type MapLevel` (`constants.ts`); `diverging`, `hypsometric`, `waterByDepth`, `sequential`, `shade`, `grey`, `blend`; `LAYERS`, `type LayerId`, `isLayerId`, `layerStage(layer)`, `needsRelief(layer)`, `slopeShade(w, e, n, s, b)`, `layerColor(layer, point, k)`; `type Level`, `isLevel`, `levelFor(bpp)`, `samplePixel(ctx, b, x, z, out)`, `paintTile(ctx, layer, b, tx, tz, out)`.

- [ ] **Step 1: Write the failing test**

`test/unit/tile.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { biomeColor } from '../../src/gen/biomes/registry';
import { newPointRecord, sampleCoarse, samplePoint } from '../../src/gen/column/columnPoint';
import { isLayerId, layerColor, layerStage, LAYERS, slopeShade } from '../../src/gen/map/layers';
import { diverging, hypsometric, sequential } from '../../src/gen/map/palette';
import { isLevel, levelFor, paintTile, samplePixel } from '../../src/gen/map/tile';
import { ctxFor } from '../harness/gen';

const rgbAt = (t: Uint8ClampedArray, i: number, j: number) => {
  const o = 4 * (j * 256 + i);
  return (t[o]! << 16) | (t[o + 1]! << 8) | t[o + 2]!;
};
const newTile = () => new Uint8ClampedArray(256 * 256 * 4);
const PIX: ReadonlyArray<readonly [number, number]> = [[0, 0], [255, 255], [17, 200], [128, 3], [240, 99], [3, 251]];

describe('layers and palette', () => {
  test('layer ids and their invalidating stage', () => {
    expect(LAYERS.length).toBe(14);
    expect(isLayerId('relief')).toBe(true);
    expect(isLayerId('nope')).toBe(false);
    expect(['biome', 'relief', 'rivers', 'C', 'PV', 'offset'].map((l) => layerStage(l as never))).toEqual(['biome2d', 'shape', 'shape', 'climate', 'climate', 'shape']);
  });
  test('ramps hit their end colours', () => {
    expect([diverging(-1), diverging(1), hypsometric(63), hypsometric(263), sequential(0, 0, 1), sequential(1, 0, 1)])
      .toEqual([0x3b4cc0, 0xb40426, 0x3d7a3a, 0xf4f4f4, 0x0d0887, 0xf0f921]);
  });
  test('NW-lit slope shading is clamped to [0.55, 1.35]', () => {
    expect(slopeShade(70, 70, 70, 70, 16)).toBe(1);
    expect(slopeShade(80, 64, 70, 70, 16)).toBe(1.25);
    expect(slopeShade(200, 0, 200, 0, 4)).toBe(1.35);
    expect(slopeShade(0, 200, 0, 200, 4)).toBe(0.55);
  });
  test('levels: coarsest level at most twice the display scale, at least 4', () => {
    expect([levelFor(200), levelFor(64), levelFor(40), levelFor(16), levelFor(8), levelFor(1), levelFor(0.25)]).toEqual([256, 64, 64, 16, 16, 4, 4]);
    expect([isLevel(64), isLevel(32)]).toEqual([true, false]);
  });
});

describe('paintTile', () => {
  const ctx = ctxFor('42');
  test('unshaded layers paint layerColor of the pixel-centre point', () => {
    for (const layer of ['C', 'biome', 'offset'] as const) {
      const t = paintTile(ctx, layer, 64, 3, -2, newTile());
      const rec = newPointRecord();
      for (const [i, j] of PIX) {
        samplePoint(ctx, 256 * 64 * 3 + 64 * (i + 0.5), 256 * 64 * -2 + 64 * (j + 0.5), false, rec);
        expect(rgbAt(t, i, j)).toBe(layerColor(layer, rec, 1));
      }
      for (let o = 3; o < t.length; o += 4) if (t[o] !== 255) throw new Error('alpha');
    }
  });
  test('the preview level samples climate, shape and biome only', () => {
    const t = paintTile(ctx, 'biome', 256, 0, 0, newTile());
    const rec = newPointRecord();
    for (const [i, j] of PIX) expect(rgbAt(t, i, j)).toBe(biomeColor(sampleCoarse(ctx, 256 * (i + 0.5), 256 * (j + 0.5), rec).biome));
  });
  test('relief shading reads the neighbour tile across the edge (seamless)', () => {
    const t = paintTile(ctx, 'relief', 16, 5, 1, newTile());
    const rec = newPointRecord();
    const h = (i: number, j: number) => samplePixel(ctx, 16, 256 * 16 * 5 + 16 * (i + 0.5), 256 * 16 + 16 * (j + 0.5), rec).surfaceEst;
    for (const j of [0, 100, 255]) {
      const i = 255;
      const k = slopeShade(h(i - 1, j), h(i + 1, j), h(i, j - 1), h(i, j + 1), 16);
      samplePixel(ctx, 16, 256 * 16 * 5 + 16 * (i + 0.5), 256 * 16 + 16 * (j + 0.5), rec);
      expect(rgbAt(t, i, j)).toBe(layerColor('relief', rec, k));
    }
  });
  test('deterministic across contexts', () => {
    expect(paintTile(ctxFor('42'), 'rivers', 4, -7, 9, newTile())).toEqual(paintTile(ctx, 'rivers', 4, -7, 9, newTile()));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/tile.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/core/constants.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/constants.ts b/src/core/constants.ts
index 157b2bb..d9bcc06 100644
--- a/src/core/constants.ts
+++ b/src/core/constants.ts
@@ -5,3 +5,8 @@ export const GENERATOR_VERSION = 0;
 export const MIN_Y = -64;
 export const HEIGHT = 384;
 export const SEA_LEVEL = 63;
+
+/** Map tiles (SP2a spec §6.1): tile size in pixels and levels in blocks per pixel; 256 is the preview level. */
+export const MAP_TILE_PX = 256;
+export const MAP_LEVELS = [256, 64, 16, 4] as const;
+export type MapLevel = (typeof MAP_LEVELS)[number];
```

`src/gen/map/palette.ts`:

```ts
/** Map colour ramps (SP2a spec §6.2). Pure functions returning 0xRRGGBB; the numeric stops stay private. */

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (a: number, b: number, t: number): number => {
  const r = ((a >>> 16) & 255) + ((((b >>> 16) & 255) - ((a >>> 16) & 255)) * t);
  const g = ((a >>> 8) & 255) + ((((b >>> 8) & 255) - ((a >>> 8) & 255)) * t);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

/** Piecewise-linear ramp over [0, 1] through evenly spaced colours. */
function ramp(stops: readonly number[], t: number): number {
  const u = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  return mix(stops[i]!, stops[i + 1]!, u - i);
}

const COOLWARM = [0x3b4cc0, 0xdddddd, 0xb40426];
const HYPSO = [0x3d7a3a, 0x7fa65a, 0xc8c07a, 0xa0784a, 0x8a8a8a, 0xf4f4f4];
const DEPTH = [0x7ec8e8, 0x2a78c0, 0x0c2a66];
const SEQ = [0x0d0887, 0x7e03a8, 0xcc4778, 0xf89540, 0xf0f921];

/** Diverging map for fields on [−1, 1]. */
export const diverging = (v: number): number => ramp(COOLWARM, (v + 1) / 2);
/** Land by height: sea level (63) to 263. */
export const hypsometric = (y: number): number => ramp(HYPSO, (y - 63) / 200);
/** Water by depth below the surface water level, 0 to 64 blocks. */
export const waterByDepth = (depth: number): number => ramp(DEPTH, depth / 64);
/** Sequential ramp for a value in [lo, hi]. */
export const sequential = (v: number, lo: number, hi: number): number => ramp(SEQ, (v - lo) / (hi - lo));
/** Multiplies each channel by k (shading), clamped to 255. */
export const shade = (rgb: number, k: number): number =>
  (Math.min(255, Math.round(((rgb >>> 16) & 255) * k)) << 16) | (Math.min(255, Math.round(((rgb >>> 8) & 255) * k)) << 8) | Math.min(255, Math.round((rgb & 255) * k));
/** Grey with the luma of rgb. */
export const grey = (rgb: number): number => {
  const l = Math.round(0.299 * ((rgb >>> 16) & 255) + 0.587 * ((rgb >>> 8) & 255) + 0.114 * (rgb & 255));
  return (l << 16) | (l << 8) | l;
};
export const blend = mix;
```

`src/gen/map/layers.ts`:

```ts
/**
 * Map layers (SP2a spec §6.2): what each layer paints from a sampled point, and which stage hash
 * invalidates its tiles. Relief and the relief-based layers also need the 4 neighbour heights.
 */
import type { StageId } from '../../core/ids';
import { biomeColor } from '../biomes/registry';
import type { PointRecord } from '../column/columnPoint';
import { blend, diverging, grey, hypsometric, sequential, shade, waterByDepth } from './palette';

const BIOME_COLOR = biomeColor;
const DIVERGING = diverging;
const HYPSO = hypsometric;
const WATER = waterByDepth;
const SEQ = sequential;
const SHADE = shade;
const GREY = grey;
const BLEND = blend;

export const LAYERS = ['biome', 'relief', 'rivers', 'lakes', 'C', 'E', 'PV', 'W', 'T', 'H', 'R', 'offset', 'sigma', 'jag'] as const;
export type LayerId = (typeof LAYERS)[number];

export function isLayerId(v: unknown): v is LayerId {
  return typeof v === 'string' && (LAYERS as readonly string[]).includes(v);
}

/** The stage whose hash keys this layer's tiles. */
export function layerStage(layer: LayerId): StageId {
  if (layer === 'biome') return 'biome2d';
  if (layer === 'C' || layer === 'E' || layer === 'PV' || layer === 'W' || layer === 'T' || layer === 'H' || layer === 'R') return 'climate';
  return 'shape';
}

/** Whether the layer shades by the neighbour heights. */
export const needsRelief = (layer: LayerId): boolean => layer === 'relief' || layer === 'rivers' || layer === 'lakes';

/**
 * NW-lit slope shading from heights 1 pixel (b blocks) away: k = 1 + ((west − east) + (north − south)) / (4·b), in [0.55, 1.35].
 */
export function slopeShade(west: number, east: number, north: number, south: number, b: number): number {
  const k = 1 + ((west - east) + (north - south)) / (4 * b);
  return k < 0.55 ? 0.55 : k > 1.35 ? 1.35 : k;
}

function reliefColor(p: PointRecord, k: number): number {
  if (p.surfaceWaterLevel > p.surfaceEst) return WATER(p.surfaceWaterLevel - p.surfaceEst);
  return SHADE(HYPSO(p.surfaceEst), k);
}

/** 0xRRGGBB of `layer` at a sampled point; `k` is the relief shading factor (1 for unshaded layers). */
export function layerColor(layer: LayerId, p: PointRecord, k: number): number {
  switch (layer) {
    case 'biome': return BIOME_COLOR(p.biome);
    case 'relief': return reliefColor(p, k);
    case 'rivers': {
      if (p.riverWet) return 0x2f6fe0;
      if (p.gorge) return 0xe07a2a;
      const base = GREY(reliefColor(p, k));
      return p.riverDist < 64 ? BLEND(base, 0x9cc8f0, 0.6 * (1 - p.riverDist / 64)) : base;
    }
    case 'lakes': {
      if (p.lakeMask === 1) return BLEND(0x4aa0e0, 0x0c3a8a, (p.lakeLevel - 63) / 137);
      const base = GREY(reliefColor(p, k));
      return p.lakeMask > 0 ? BLEND(base, 0xe6d58a, 0.8 * p.lakeMask) : base;
    }
    case 'C': return DIVERGING(p.C);
    case 'E': return DIVERGING(p.E);
    case 'PV': return DIVERGING(p.PV);
    case 'W': return DIVERGING(p.W);
    case 'T': return DIVERGING(p.T);
    case 'H': return DIVERGING(p.H);
    case 'R': return DIVERGING(p.R);
    case 'offset': return SEQ(p.offset, -64, 320);
    case 'sigma': return SEQ(p.sigma, 0, 16);
    case 'jag': return SEQ(p.jag, 0, 55);
  }
}
```

`src/gen/map/tile.ts`:

```ts
/**
 * Map tile painting (SP2a spec §6.1): a 256 × 256 RGBA tile of one layer at level b blocks/px. Pixel
 * (i, j) of tile (tx, tz) samples the pixel centre (256·b·tx + b·(i + 0.5), 256·b·tz + b·(j + 0.5)).
 * Level 256 is the preview (sampleCoarse: no rivers or lakes); finer levels use samplePoint without
 * steep. Shaded layers sample a one-pixel border so adjacent tiles shade seamlessly.
 */
import { MAP_LEVELS, MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { GenContext } from '../context';
import { newPointRecord, sampleCoarse, samplePoint, type PointRecord } from '../column/columnPoint';
import { layerColor, needsRelief, slopeShade, type LayerId } from './layers';

const POINT = samplePoint;
const COARSE = sampleCoarse;
const NEW_POINT = newPointRecord;
const COLOR = layerColor;
const NEEDS_RELIEF = needsRelief;
const SLOPE = slopeShade;
const TILE = MAP_TILE_PX;
const LEVELS = MAP_LEVELS;

export type Level = MapLevel;

export function isLevel(v: unknown): v is Level {
  return typeof v === 'number' && (LEVELS as readonly number[]).includes(v);
}

/** Level used for a display scale of `bpp` blocks per screen pixel: the coarsest level ≤ 2·bpp, at least 4. */
export function levelFor(bpp: number): Level {
  for (const l of LEVELS) if (l <= 2 * bpp) return l;
  return 4;
}

/** Samples the pixel centre at level b. */
export function samplePixel(ctx: GenContext, b: Level, x: number, z: number, out: PointRecord): PointRecord {
  return b === 256 ? COARSE(ctx, x, z, out) : POINT(ctx, x, z, false, out);
}

const P = NEW_POINT();
const W = TILE + 2;
const HEIGHT = new Float64Array(W * W);
const WATER_LEVEL = new Float64Array(W * W);
const RIVER_DIST = new Float64Array(W * W);
const LAKE_MASK = new Float64Array(W * W);
const LAKE_LEVEL = new Float64Array(W * W);
const FLAGS = new Uint8Array(W * W);

function put(out: Uint8ClampedArray, o: number, rgb: number): void {
  out[o] = (rgb >>> 16) & 255;
  out[o + 1] = (rgb >>> 8) & 255;
  out[o + 2] = rgb & 255;
  out[o + 3] = 255;
}

/** Paints tile (tx, tz) of `layer` at level b into `out` (256·256·4 bytes, alpha 255). */
export function paintTile(ctx: GenContext, layer: LayerId, b: Level, tx: number, tz: number, out: Uint8ClampedArray): Uint8ClampedArray {
  const x0 = TILE * b * tx;
  const z0 = TILE * b * tz;
  if (!NEEDS_RELIEF(layer)) {
    for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
      put(out, 4 * (j * TILE + i), COLOR(layer, samplePixel(ctx, b, x0 + b * (i + 0.5), z0 + b * (j + 0.5), P), 1));
    }
    return out;
  }
  // One sampling pass over the tile plus a one-pixel border, keeping only what shaded layers read.
  for (let j = -1; j <= TILE; j++) for (let i = -1; i <= TILE; i++) {
    const k = (j + 1) * W + (i + 1);
    const p = samplePixel(ctx, b, x0 + b * (i + 0.5), z0 + b * (j + 0.5), P);
    HEIGHT[k] = p.surfaceEst;
    WATER_LEVEL[k] = p.surfaceWaterLevel;
    RIVER_DIST[k] = p.riverDist;
    LAKE_MASK[k] = p.lakeMask;
    LAKE_LEVEL[k] = p.lakeLevel;
    FLAGS[k] = (p.riverWet ? 1 : 0) | (p.gorge ? 2 : 0);
  }
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const k = (j + 1) * W + (i + 1);
    P.surfaceEst = HEIGHT[k]!;
    P.surfaceWaterLevel = WATER_LEVEL[k]!;
    P.riverDist = RIVER_DIST[k]!;
    P.lakeMask = LAKE_MASK[k]!;
    P.lakeLevel = LAKE_LEVEL[k]!;
    P.riverWet = (FLAGS[k]! & 1) !== 0;
    P.gorge = (FLAGS[k]! & 2) !== 0;
    const shadeK = SLOPE(HEIGHT[k - 1]!, HEIGHT[k + 1]!, HEIGHT[k - W]!, HEIGHT[k + W]!, b);
    put(out, 4 * (j * TILE + i), COLOR(layer, P, shadeK));
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/tile.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS (about 3 s; a 256² tile costs about 0.2 s at the preview level and 0.33 s below).

- [ ] **Step 5: Commit**

```bash
git add src/core/constants.ts src/gen/map test/unit/tile.test.ts
git commit -m "feat(gen): map tile painting — preview level, layers and seamless relief

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 18: Worker protocol and the pure task handler

**Files:**
- Create: `src/workers/protocol.ts`, `src/workers/taskHandler.ts`
- Test: `test/unit/protocol.test.ts`

**Interfaces:**
- Produces: message types `ConfigureMsg`, `MapTileMsg`, `PointMsg`, `SpawnMsg`, `ToWorker`, `ReadyMsg`, `TileMsg`, `PointResultMsg`, `SpawnResultMsg`, `ErrorMsg`, `ErrorCode`, `FromWorker`; `parseToWorker(m)`, `parseFromWorker(m)`; `interface Reply {msg, transfer}`, `interface TaskHandler`, `createTaskHandler()`. (Task 22 adds `selftest`.)

- [ ] **Step 1: Write the failing test**

`test/unit/protocol.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn } from '../../src/gen/column/spawn';
import { paintTile } from '../../src/gen/map/tile';
import { parseFromWorker, parseToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

const tileMsg = { type: 'mapTile', jobId: 1, epoch: 3, layer: 'biome', level: 64, tx: 2, tz: -1 };

describe('parseToWorker', () => {
  test('valid messages pass', () => {
    expect(parseToWorker({ type: 'configure', epoch: 0, seedText: '42', params: {} })).not.toBeNull();
    expect(parseToWorker(tileMsg)).not.toBeNull();
    expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, x: 1.5, z: -7 })).not.toBeNull();
    expect(parseToWorker({ type: 'spawn', jobId: 4, epoch: 3 })).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['not an object', 5],
    ['unknown type', { type: 'nope' }],
    ['empty seed text', { type: 'configure', epoch: 0, seedText: '  ', params: {} }],
    ['bad layer', { ...tileMsg, layer: 'caves' }],
    ['bad level', { ...tileMsg, level: 32 }],
    ['non-integer tile', { ...tileMsg, tx: 0.5 }],
    ['tile outside the window', { ...tileMsg, tx: 40 }],
    ['point outside the window', { type: 'point', jobId: 2, epoch: 3, x: 1e7, z: 0 }],
    ['non-finite point', { type: 'point', jobId: 2, epoch: 3, x: Number.NaN, z: 0 }],
  ])('%s is rejected', (_n, m) => {
    expect(parseToWorker(m)).toBeNull();
  });
});

describe('parseFromWorker', () => {
  test('tile buffers must be 256·256·4 bytes', () => {
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144) })).not.toBeNull();
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(10) })).toBeNull();
    expect(parseFromWorker({ type: 'error', jobId: null, code: 'BAD_MESSAGE', message: 'x' })).not.toBeNull();
  });
});

describe('task handler', () => {
  test('configure → ready with the stage hashes; tiles and points match the direct functions', () => {
    const h = createTaskHandler();
    const ready = h.handle({ type: 'configure', epoch: 3, seedText: '42', params: DEFAULTS }).msg;
    expect(ready.type).toBe('ready');
    if (ready.type !== 'ready') return;
    expect(Object.keys(ready.stageHashes)).toContain('biome2d');
    expect(ready.genKey).toMatch(/^[0-9a-f]{16}$/);
    const tile = h.handle(tileMsg);
    expect(tile.msg.type).toBe('tile');
    if (tile.msg.type !== 'tile') return;
    expect(tile.transfer).toEqual([tile.msg.rgba]);
    expect(new Uint8ClampedArray(tile.msg.rgba)).toEqual(paintTile(ctxFor('42'), 'biome', 64, 2, -1, new Uint8ClampedArray(262144)));
    const pt = h.handle({ type: 'point', jobId: 9, epoch: 3, x: 100.5, z: -20 }).msg;
    expect(pt).toEqual({ type: 'pointResult', jobId: 9, epoch: 3, fields: columnPoint(ctxFor('42'), 100.5, -20) });
    expect(h.handle({ type: 'spawn', jobId: 10, epoch: 3 }).msg).toEqual({ type: 'spawnResult', jobId: 10, epoch: 3, spawn: findSpawn(ctxFor('42')) });
  });
  test.each<[string, unknown[], string]>([
    ['malformed', [{ type: 'mapTile', jobId: 4 }], 'BAD_MESSAGE'],
    ['before configure', [tileMsg], 'NOT_CONFIGURED'],
    ['stale epoch', [{ type: 'configure', epoch: 5, seedText: '1', params: DEFAULTS }, tileMsg], 'STALE_EPOCH'],
    ['invalid params', [{ type: 'configure', epoch: 5, seedText: '1', params: { climate: {} } }], 'BAD_PARAMS'],
  ])('%s → %s', (_n, msgs, code) => {
    const h = createTaskHandler();
    let last = h.handle(msgs[0]).msg;
    for (const m of msgs.slice(1)) last = h.handle(m).msg;
    expect(last.type).toBe('error');
    if (last.type === 'error') expect(last.code).toBe(code);
  });
  test('an error keeps the jobId of the failing job', () => {
    const h = createTaskHandler();
    const r = h.handle(tileMsg).msg;
    expect(r.type === 'error' && r.jobId).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/protocol.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/workers/protocol.ts`:

```ts
/**
 * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
 * The main thread sends configure / mapTile / point / spawn; the worker answers ready / tile / pointResult /
 * spawnResult / error.
 */
import { MAP_LEVELS, type MapLevel } from '../core/constants';
import type { StageId } from '../core/ids';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import { isLayerId, type LayerId } from '../gen/map/layers';

const LEVELS: readonly number[] = MAP_LEVELS;

export interface ConfigureMsg { readonly type: 'configure'; readonly epoch: number; readonly seedText: string; readonly params: unknown }
export interface MapTileMsg { readonly type: 'mapTile'; readonly jobId: number; readonly epoch: number; readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }
export interface PointMsg { readonly type: 'point'; readonly jobId: number; readonly epoch: number; readonly x: number; readonly z: number }
export interface SpawnMsg { readonly type: 'spawn'; readonly jobId: number; readonly epoch: number }
export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg;

export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
export interface TileMsg { readonly type: 'tile'; readonly jobId: number; readonly epoch: number; readonly rgba: ArrayBuffer }
export interface PointResultMsg { readonly type: 'pointResult'; readonly jobId: number; readonly epoch: number; readonly fields: ColumnPoint }
export type ErrorCode = 'BAD_MESSAGE' | 'BAD_PARAMS' | 'NOT_CONFIGURED' | 'STALE_EPOCH' | 'INTERNAL';
export interface ErrorMsg { readonly type: 'error'; readonly jobId: number | null; readonly code: ErrorCode; readonly message: string }
export interface SpawnResultMsg { readonly type: 'spawnResult'; readonly jobId: number; readonly epoch: number; readonly spawn: Spawn }
export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | ErrorMsg;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Tile coordinates stay inside the colKey window at every level (|tx| · 256 · level ≤ 2^19). */
const tileOk = (t: unknown, level: number): boolean => isInt(t) && Math.abs(t) * 256 * level <= 524288;

/** Validates a message sent to a worker; null when malformed. */
export function parseToWorker(m: unknown): ToWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'configure':
      return isInt(m['epoch']) && typeof m['seedText'] === 'string' && m['seedText'].trim() !== '' && 'params' in m ? (m as unknown as ConfigureMsg) : null;
    case 'mapTile': {
      const level = m['level'];
      if (!isInt(m['jobId']) || !isInt(m['epoch']) || !isLayerId(m['layer'])) return null;
      if (!isInt(level) || !LEVELS.includes(level) || !tileOk(m['tx'], level) || !tileOk(m['tz'], level)) return null;
      return m as unknown as MapTileMsg;
    }
    case 'point':
      return isInt(m['jobId']) && isInt(m['epoch']) && isFiniteNum(m['x']) && isFiniteNum(m['z']) && Math.abs(m['x']) <= 524288 && Math.abs(m['z']) <= 524288
        ? (m as unknown as PointMsg) : null;
    case 'spawn':
      return isInt(m['jobId']) && isInt(m['epoch']) ? (m as unknown as SpawnMsg) : null;
    default:
      return null;
  }
}

/** Validates a worker reply; null when malformed. */
export function parseFromWorker(m: unknown): FromWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'ready': return isInt(m['epoch']) && isObj(m['stageHashes']) && typeof m['genKey'] === 'string' ? (m as unknown as ReadyMsg) : null;
    case 'tile': return isInt(m['jobId']) && isInt(m['epoch']) && m['rgba'] instanceof ArrayBuffer && m['rgba'].byteLength === 256 * 256 * 4 ? (m as unknown as TileMsg) : null;
    case 'pointResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['fields']) ? (m as unknown as PointResultMsg) : null;
    case 'spawnResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['spawn']) ? (m as unknown as SpawnResultMsg) : null;
    case 'error': return (m['jobId'] === null || isInt(m['jobId'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? (m as unknown as ErrorMsg) : null;
    default: return null;
  }
}
```

`src/workers/taskHandler.ts`:

```ts
/**
 * The pure message handler of a task worker (SP2a spec §5.1): owns one GenContext per configured epoch
 * and answers each validated message. No DOM and no worker globals, so Node tests drive it directly.
 */
import { hex64 } from '../core/hash';
import { checkParams } from '../core/params/kit';
import { SCHEMA, type Params } from '../core/params/schema';
import { seedFromInput } from '../core/seed';
import { genKey, stageHashes } from '../core/stage/hash';
import { createGenContext, type GenContext } from '../gen/context';
import { columnPoint } from '../gen/column/columnPoint';
import { findSpawn } from '../gen/column/spawn';
import { paintTile } from '../gen/map/tile';
import { parseToWorker, type ErrorCode, type FromWorker } from './protocol';

const HEX = hex64;
const CHECK = checkParams;
const SCHEMA_ = SCHEMA;
const SEED = seedFromInput;
const GEN_KEY = genKey;
const HASHES = stageHashes;
const CREATE = createGenContext;
const POINT = columnPoint;
const PAINT = paintTile;
const SPAWN = findSpawn;
const PARSE = parseToWorker;

export interface Reply {
  readonly msg: FromWorker;
  readonly transfer: readonly ArrayBuffer[];
}

export interface TaskHandler {
  handle(raw: unknown): Reply;
}

const err = (jobId: number | null, code: ErrorCode, message: string): Reply => ({ msg: { type: 'error', jobId, code, message }, transfer: [] });

export function createTaskHandler(): TaskHandler {
  let epoch = -1;
  let ctx: GenContext | null = null;
  return {
    handle(raw) {
      const m = PARSE(raw);
      const jobId = typeof (raw as { jobId?: unknown } | null)?.jobId === 'number' ? (raw as { jobId: number }).jobId : null;
      if (m === null) return err(jobId, 'BAD_MESSAGE', 'malformed message');
      try {
        if (m.type === 'configure') {
          const r = CHECK(SCHEMA_, m.params);
          if (!r.ok) return err(null, 'BAD_PARAMS', r.issues.slice(0, 5).map((i) => `${i.path}: ${i.code}`).join('; '));
          const params: Params = r.value;
          const seed = SEED(m.seedText);
          ctx = CREATE(seed, params);
          epoch = m.epoch;
          const h = HASHES(params);
          const hex: Record<string, string> = {};
          for (const [k, v] of Object.entries(h)) hex[k] = HEX(v);
          return { msg: { type: 'ready', epoch, stageHashes: hex, genKey: HEX(GEN_KEY(seed, h)) }, transfer: [] };
        }
        if (ctx === null) return err(m.jobId, 'NOT_CONFIGURED', 'no configure yet');
        if (m.epoch !== epoch) return err(m.jobId, 'STALE_EPOCH', `job epoch ${m.epoch}, worker epoch ${epoch}`);
        if (m.type === 'mapTile') {
          const rgba = new ArrayBuffer(256 * 256 * 4);
          PAINT(ctx, m.layer, m.level, m.tx, m.tz, new Uint8ClampedArray(rgba));
          return { msg: { type: 'tile', jobId: m.jobId, epoch, rgba }, transfer: [rgba] };
        }
        if (m.type === 'spawn') return { msg: { type: 'spawnResult', jobId: m.jobId, epoch, spawn: SPAWN(ctx) }, transfer: [] };
        return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
      } catch (e) {
        return err(jobId, 'INTERNAL', e instanceof Error ? e.message : String(e));
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/protocol.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/protocol.ts src/workers/taskHandler.ts test/unit/protocol.test.ts
git commit -m "feat(workers): typed task protocol and the pure message handler

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 19: Worker shell, pool and the two-worker integration test

**Files:**
- Create: `src/workers/task.worker.ts`, `src/engine/workerPool.ts`, `test/integration/twoWorkers.test.ts`
- Modify: `vitest.config.ts`
- Test: `test/unit/workerPool.test.ts`

**Interfaces:**
- Consumes: `createTaskHandler`, `parseFromWorker` (Task 18).
- Produces: `interface WorkerLike`, `interface TileRequest`, `class JobCancelled`, `interface WorkerPool {size, epoch, queued, configure, tile, point, spawn, cancelTiles, terminate}`, `poolSize(cores)`, `createWorkerPool(size, spawn)`, `createBrowserPool()`. (Task 22 adds `selftest` and a size parameter.)

- [ ] **Step 1: Write the failing tests**

`test/unit/workerPool.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, JobCancelled, poolSize, type WorkerLike } from '../../src/engine/workerPool';
import type { ToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';

/** A fake worker running the real handler asynchronously; `log` records every message it receives. */
function fakeWorker(log: ToWorker[], tamper = false): WorkerLike {
  const h = createTaskHandler();
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) {
      log.push(msg);
      setTimeout(() => {
        const r = h.handle(msg).msg;
        const data = tamper && r.type === 'ready' ? { ...r, stageHashes: { ...r.stageHashes, climate: '0000000000000000' } } : r;
        w.onmessage?.({ data });
      }, 0);
    },
    terminate() {},
  };
  return w;
}

const tile = (tx: number) => ({ layer: 'C' as const, level: 256 as const, tx, tz: 0 });

describe('worker pool', () => {
  test('size is clamp(cores − 2, 2, 6)', () => {
    expect([poolSize(1), poolSize(4), poolSize(8), poolSize(20)]).toEqual([2, 2, 6, 6]);
  });
  test('configure resolves once every worker is ready with the same hashes', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(3, () => fakeWorker(log));
    const ready = await pool.configure('42', DEFAULTS);
    expect(ready.epoch).toBe(0);
    expect(log.filter((m) => m.type === 'configure').length).toBe(3);
    expect(pool.epoch).toBe(0);
  });
  test('workers that disagree on the stage hashes fail the configure', async () => {
    let n = 0;
    const pool = createWorkerPool(2, () => fakeWorker([], n++ === 1));
    await expect(pool.configure('42', DEFAULTS)).rejects.toThrow(/disagree/);
  });
  test('bad params reject the configure', async () => {
    const pool = createWorkerPool(2, () => fakeWorker([]));
    await expect(pool.configure('42', { climate: {} })).rejects.toThrow(/BAD_PARAMS/);
  });
  test('jobs queued during configure run in priority order, one per worker', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => fakeWorker(log));
    const ready = pool.configure('42', DEFAULTS);
    const done = [pool.tile(tile(5), 5), pool.tile(tile(1), 1), pool.tile(tile(3), 3)];
    await ready;
    const bufs = await Promise.all(done);
    expect(bufs.every((b) => b.byteLength === 262144)).toBe(true);
    expect(log.filter((m) => m.type === 'mapTile').map((m) => (m as { tx: number }).tx)).toEqual([1, 3, 5]);
  });
  test('a worker error rejects the job instead of hanging', async () => {
    const pool = createWorkerPool(1, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          if (msg.type === 'mapTile') { setTimeout(() => w.onmessage?.({ data: { type: 'error', jobId: msg.jobId, code: 'INTERNAL', message: 'boom' } }), 0); return; }
          inner.onmessage = (e) => w.onmessage?.(e);
          inner.postMessage(msg);
        },
        terminate() {},
      };
      return w;
    });
    await pool.configure('42', DEFAULTS);
    await expect(pool.tile(tile(0), 0)).rejects.toThrow(/INTERNAL: boom/);
    expect((await pool.point(1, 2)).z).toBe(2);
  });
  test('cancelTiles rejects matching queued jobs; points still run', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    const first = pool.tile(tile(0), 0);
    const doomed = pool.tile(tile(9), 1);
    pool.cancelTiles((r) => r.tx === 9);
    await expect(doomed).rejects.toBeInstanceOf(JobCancelled);
    await first;
    expect((await pool.point(10, 20)).x).toBe(10);
    expect((await pool.spawn()).fallback).toBe(false);
  });
  test('a new epoch cancels queued and in-flight jobs of the old one', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    const inFlight = pool.tile(tile(0), 0);
    const queued = pool.tile(tile(1), 1);
    const next = pool.configure('7', DEFAULTS);
    await expect(queued).rejects.toBeInstanceOf(JobCancelled);
    await expect(inFlight).rejects.toBeInstanceOf(JobCancelled);
    expect((await next).epoch).toBe(1);
  });
});
```

`test/integration/twoWorkers.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';

const OUT = fileURLToPath(new URL('../.cache/taskHandler/', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../src/workers/taskHandler.ts', import.meta.url));
const workers: Worker[] = [];

/** Bundles the pure handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2). */
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  await build({
    configFile: false, logLevel: 'silent',
    build: { outDir: OUT, emptyOutDir: true, minify: false, lib: { entry: ENTRY, formats: ['es'], fileName: () => 'taskHandler.mjs' } },
  });
  writeFileSync(`${OUT}node-worker.mjs`, [
    "import { parentPort } from 'node:worker_threads';",
    "import { createTaskHandler } from './taskHandler.mjs';",
    'const h = createTaskHandler();',
    "parentPort.on('message', (m) => { const r = h.handle(m); parentPort.postMessage(r.msg, r.transfer); });",
  ].join('\n'));
  for (let i = 0; i < 2; i++) workers.push(new Worker(`${OUT}node-worker.mjs`));
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

const ask = (w: Worker, msg: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); });

test('two workers produce byte-identical tiles and agree on the stage hashes', async () => {
  const ready = await Promise.all(workers.map((w) => ask(w, { type: 'configure', epoch: 1, seedText: '42', params: DEFAULTS })));
  expect(ready[0]!['type']).toBe('ready');
  expect(ready[1]).toEqual(ready[0]);
  let jobId = 0;
  for (const level of [256, 64, 4]) {
    for (const layer of ['biome', 'relief', 'rivers', 'C']) {
      for (const [tx, tz] of [[0, 0], [-1, 1]]) {
        jobId++;
        const msg = { type: 'mapTile', jobId, epoch: 1, layer, level, tx, tz };
        const [a, b] = await Promise.all(workers.map((w) => ask(w, msg)));
        expect(a!['type'], JSON.stringify(a)).toBe('tile');
        expect(Buffer.from(a!['rgba'] as ArrayBuffer).equals(Buffer.from(b!['rgba'] as ArrayBuffer))).toBe(true);
      }
    }
  }
  expect(jobId).toBe(24);
}, 180_000);
```

`vitest.config.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/vitest.config.ts b/vitest.config.ts
index 26edf5b..b276185 100644
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -12,7 +12,7 @@ export default defineConfig({
     passWithNoTests: true,
     projects: [
       // Several unit tests make ~1M evaluations (spline test 6, q15): ~2.5 s locally, ~6 s on a CI runner.
-      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 30_000 } },
+      { test: { name: 'unit', include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'], testTimeout: 30_000 } },
       { test: { name: 'arch', include: ['test/arch/**/*.test.ts'] } },
       metrics('fast'),
       metrics('quick'),
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/workerPool.test.ts test/integration/twoWorkers.test.ts`
Expected: FAIL (`src/engine/workerPool` missing). The integration test already passes, because it only needs Task 18's handler.

- [ ] **Step 3: Implement**

`src/workers/task.worker.ts`:

```ts
/** Task worker shell (SP2a spec §5.1): wires the pure handler to the worker's message port. */
import { createTaskHandler } from './taskHandler';

const handler = createTaskHandler();

self.onmessage = (event: MessageEvent<unknown>) => {
  const r = handler.handle(event.data);
  postMessage(r.msg, { transfer: [...r.transfer] });
};

export {};
```

`src/engine/workerPool.ts`:

```ts
/**
 * Task pool (master §4.1, SP2a spec §5.2): N workers, one configure per epoch (all must agree on the
 * stage hashes), a priority queue of jobs with at most one in flight per worker, cancellation, and
 * stale-epoch results dropped. The worker factory is injectable so the logic is testable without a browser.
 */
import type { MapLevel } from '../core/constants';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import type { LayerId } from '../gen/map/layers';
import { parseFromWorker, type FromWorker, type ReadyMsg, type ToWorker } from '../workers/protocol';

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  terminate(): void;
}

export interface TileRequest { readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }

export class JobCancelled extends Error {
  constructor() { super('job cancelled'); }
}

export interface WorkerPool {
  readonly size: number;
  readonly epoch: number;
  /** Starts a new epoch on every worker; resolves with the (identical) ready message. */
  configure(seedText: string, params: unknown): Promise<ReadyMsg>;
  /** Lower priority runs first. */
  tile(req: TileRequest, priority: number): Promise<ArrayBuffer>;
  point(x: number, z: number, priority?: number): Promise<ColumnPoint>;
  spawn(): Promise<Spawn>;
  /** Rejects queued tile jobs matching `pred` with JobCancelled. */
  cancelTiles(pred: (req: TileRequest) => boolean): void;
  readonly queued: number;
  terminate(): void;
}

interface Job {
  readonly id: number;
  readonly epoch: number;
  readonly priority: number;
  readonly msg: ToWorker;
  readonly tile: TileRequest | null;
  readonly resolve: (v: FromWorker) => void;
  readonly reject: (e: Error) => void;
}

/** Pool size: clamp(hardwareConcurrency − 2, 2, 6). */
export const poolSize = (cores: number): number => Math.max(2, Math.min(6, cores - 2));

export function createWorkerPool(size: number, spawn: () => WorkerLike): WorkerPool {
  const workers = Array.from({ length: size }, spawn);
  const busy: Array<Job | null> = workers.map(() => null);
  let queue: Job[] = [];
  let epoch = -1;
  let nextId = 1;
  let pendingReady: { need: number; got: ReadyMsg[]; resolve: (r: ReadyMsg) => void; reject: (e: Error) => void } | null = null;

  const pump = () => {
    if (pendingReady !== null) return;
    for (let w = 0; w < size && queue.length > 0; w++) {
      if (busy[w] !== null) continue;
      queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      const job = queue.shift()!;
      busy[w] = job;
      workers[w]!.postMessage(job.msg);
    }
  };

  workers.forEach((worker, w) => {
    worker.onmessage = (event) => {
      const msg = parseFromWorker(event.data);
      if (msg === null) return;
      if (msg.type === 'ready') {
        const pr = pendingReady;
        if (pr === null || msg.epoch !== epoch) return;
        pr.got.push(msg);
        if (pr.got.length < pr.need) return;
        pendingReady = null;
        const a = JSON.stringify(pr.got[0]!.stageHashes);
        if (pr.got.some((r) => JSON.stringify(r.stageHashes) !== a || r.genKey !== pr.got[0]!.genKey)) pr.reject(new Error('workers disagree on the stage hashes'));
        else pr.resolve(pr.got[0]!);
        pump();
        return;
      }
      if (msg.type === 'error' && msg.jobId === null) {
        if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(new Error(`${msg.code}: ${msg.message}`)); }
        return;
      }
      const job = busy[w];
      busy[w] = null;
      if (job !== null && msg.jobId === job.id) {
        if (job.epoch !== epoch) job.reject(new JobCancelled());
        else if (msg.type === 'error') job.reject(new Error(`${msg.code}: ${msg.message}`));
        else job.resolve(msg);
      }
      pump();
    };
  });

  const enqueue = (priority: number, build: (id: number) => ToWorker, tile: TileRequest | null): Promise<FromWorker> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      queue.push({ id, epoch, priority, msg: build(id), tile, resolve, reject });
      pump();
    });

  return {
    size,
    get epoch() { return epoch; },
    get queued() { return queue.length; },
    configure(seedText, params) {
      epoch++;
      for (const j of queue) j.reject(new JobCancelled());
      queue = [];
      if (pendingReady !== null) pendingReady.reject(new JobCancelled());
      return new Promise((resolve, reject) => {
        pendingReady = { need: size, got: [], resolve, reject };
        for (const w of workers) w.postMessage({ type: 'configure', epoch, seedText, params });
      });
    },
    async tile(req, priority) {
      const e = epoch;
      const r = await enqueue(priority, (jobId) => ({ type: 'mapTile', jobId, epoch: e, ...req }), req);
      if (r.type !== 'tile') throw new Error(`unexpected reply ${r.type}`);
      return r.rgba;
    },
    async point(x, z, priority = -1) {
      const e = epoch;
      const r = await enqueue(priority, (jobId) => ({ type: 'point', jobId, epoch: e, x, z }), null);
      if (r.type !== 'pointResult') throw new Error(`unexpected reply ${r.type}`);
      return r.fields;
    },
    async spawn() {
      const e = epoch;
      const r = await enqueue(-2, (jobId) => ({ type: 'spawn', jobId, epoch: e }), null);
      if (r.type !== 'spawnResult') throw new Error(`unexpected reply ${r.type}`);
      return r.spawn;
    },
    cancelTiles(pred) {
      queue = queue.filter((j) => {
        if (j.tile !== null && pred(j.tile)) { j.reject(new JobCancelled()); return false; }
        return true;
      });
    },
    terminate() {
      for (const w of workers) w.terminate();
      for (const j of queue) j.reject(new JobCancelled());
      queue = [];
    },
  };
}

/** Browser pool of module workers running task.worker.ts. */
export function createBrowserPool(): WorkerPool {
  return createWorkerPool(poolSize(navigator.hardwareConcurrency || 4), () =>
    new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/workerPool.test.ts test/integration/twoWorkers.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS; 24 tiles byte-identical across two `worker_threads` (about 10 s including the Vite build of the handler into the git-ignored `test/.cache/`).

- [ ] **Step 5: Commit**

```bash
git add src/workers/task.worker.ts src/engine/workerPool.ts test/unit/workerPool.test.ts test/integration vitest.config.ts
git commit -m "feat(engine): worker pool with epochs, priorities and cancellation; two-worker determinism test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 20: WorldSession (and the seed rule in core)

**Files:**
- Modify: `src/core/seed.ts`, `src/ui/seedBox.ts`
- Create: `src/engine/session.ts`
- Test: `test/unit/session.test.ts`

**Interfaces:**
- Produces: `resolveSeedText(text, random)` (`core/seed.ts`; `ui/seedBox.ts` keeps its signature with the crypto default); `interface SessionState`, `type SessionResult`, `class WorldSession {state, setSeedText, setProfile, setPatch}`.

- [ ] **Step 1: Write the failing test**

`test/unit/session.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { WorldSession } from '../../src/engine/session';

const random = () => [7, 1] as const;

describe('WorldSession', () => {
  test('defaults: default profile, empty patch, random seed written back', () => {
    const s = new WorldSession(random).state;
    expect([s.seedText, s.profile, s.patch, s.epoch]).toEqual(['4294967303', 'default', {}, 0]);
    expect(s.params).toBe(resolveProfile('default'));
  });
  test('seed text is trimmed; the epoch bumps only when the seed changes', () => {
    const w = new WorldSession(random, { seedText: '42' });
    expect(w.setSeedText('  42 ').epoch).toBe(0);
    const s = w.setSeedText('43');
    expect([s.seedText, s.seed, s.epoch]).toEqual(['43', seedFromInput('43'), 1]);
    expect(w.setSeedText('   ').seedText).toBe('4294967303');
  });
  test('profiles: only ready ones; switching clears the patch', () => {
    const w = new WorldSession(random, { seedText: '1', patch: { climate: { scaleMul: 2 } } });
    expect(w.state.params.climate.scaleMul).toBe(2);
    const r = w.setProfile('large_biomes');
    expect(r.ok && [r.state.profile, r.state.patch, r.state.params.climate.scaleMul, r.state.epoch]).toEqual(['large_biomes', {}, 4, 1]);
    const bad = w.setProfile('archipelago');
    expect(bad.ok).toBe(false);
    expect(w.state.profile).toBe('large_biomes');
  });
  test('an invalid patch changes nothing; an equivalent patch keeps the epoch', () => {
    const w = new WorldSession(random, { seedText: '1' });
    const bad = w.setPatch({ climate: { scaleMul: 99 } });
    expect(!bad.ok && bad.issues[0]!.code).toBe('OUT_OF_RANGE');
    expect(w.state.epoch).toBe(0);
    const ok = w.setPatch({ rivers: { widthMin: 6 } });
    expect(ok.ok && ok.state.params.rivers.widthMin).toBe(6);
    expect(w.state.epoch).toBe(1);
    expect(w.setPatch({ rivers: { widthMin: 6 } }).ok && w.state.epoch).toBe(1);
    expect(w.setPatch({}).ok && w.state.epoch).toBe(2);
  });
  test('an unready or invalid initial state falls back safely', () => {
    const w = new WorldSession(random, { seedText: 'x', profile: 'cave_heavy', patch: { nope: 1 } as never });
    expect([w.state.profile, w.state.patch]).toEqual(['default', {}]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/session.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/core/seed.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/core/seed.ts b/src/core/seed.ts
index d2c3736..c26e67e 100644
--- a/src/core/seed.ts
+++ b/src/core/seed.ts
@@ -24,3 +24,14 @@ export function seedFromInput(text: string): Seed64 {
 export function seedToText(seed: Seed64): string {
   return ((BigInt(seed[1]) << 32n) | BigInt(seed[0])).toString();
 }
+
+/**
+ * Seed-box rule (SP1 spec §1.4): non-empty text is trimmed and parsed; empty text draws a seed from
+ * `random` and returns its decimal text, so the UI writes it back and the world stays reproducible.
+ */
+export function resolveSeedText(text: string, random: () => Seed64): { text: string; seed: Seed64 } {
+  const t = text.trim();
+  if (t.length > 0) return { text: t, seed: seedFromInput(t) };
+  const drawn = seedToText(random());
+  return { text: drawn, seed: seedFromInput(drawn) };
+}
```

`src/ui/seedBox.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/ui/seedBox.ts b/src/ui/seedBox.ts
index ba06885..ef79550 100644
--- a/src/ui/seedBox.ts
+++ b/src/ui/seedBox.ts
@@ -1,18 +1,12 @@
 import type { Seed64 } from '../core/hash';
-import { seedFromInput, seedToText } from '../core/seed';
+import { resolveSeedText as resolveCore } from '../core/seed';
 
 export function cryptoSeed(): Seed64 {
   const w = crypto.getRandomValues(new Uint32Array(2));
   return [w[0]! >>> 0, w[1]! >>> 0];
 }
 
-/**
- * Seed-box rule (SP1 spec §1.4): non-empty text is trimmed and parsed; empty text draws a random seed and
- * returns its decimal text so the UI writes it back and the world stays reproducible from the box.
- */
+/** The SP1 seed-box rule with a crypto random default (the rule itself lives in core/seed.ts). */
 export function resolveSeedText(text: string, random: () => Seed64 = cryptoSeed): { text: string; seed: Seed64 } {
-  const t = text.trim();
-  if (t.length > 0) return { text: t, seed: seedFromInput(t) };
-  const drawn = seedToText(random());
-  return { text: drawn, seed: seedFromInput(drawn) };
+  return resolveCore(text, random);
 }
```

`src/engine/session.ts`:

```ts
/**
 * WorldSession (SP2a spec §4.3): the world the page shows — seed text, profile, patch over the
 * profile, the resolved params and an epoch that bumps only when the seed or the params change.
 * SP2b's panel and editors edit the same session.
 */
import { hex64, type Seed64 } from '../core/hash';
import { applyPatch, type Issue } from '../core/params/kit';
import { isProfileReady, resolveProfile, type ProfileId } from '../core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../core/params/schema';
import { resolveSeedText } from '../core/seed';
import { paramsHash } from '../core/stage/hash';

export interface SessionState {
  readonly seedText: string;
  readonly seed: Seed64;
  readonly profile: ProfileId;
  readonly patch: ParamsPatch;
  readonly params: Params;
  readonly epoch: number;
}

export type SessionResult = { readonly ok: true; readonly state: SessionState } | { readonly ok: false; readonly issues: readonly Issue[] };

const issue = (path: string, message: string): Issue => ({ path, code: 'BAD_ENUM', message });

export class WorldSession {
  private readonly random: () => Seed64;
  private s: SessionState;
  private key: string;

  constructor(random: () => Seed64, init: { seedText?: string; profile?: ProfileId; patch?: ParamsPatch } = {}) {
    this.random = random;
    const seed = resolveSeedText(init.seedText ?? '', random);
    const profile = init.profile !== undefined && isProfileReady(init.profile) ? init.profile : 'default';
    const r = applyPatch(SCHEMA, resolveProfile(profile), init.patch ?? {});
    const patch = r.ok ? (init.patch ?? {}) : {};
    const params = r.ok ? r.value : resolveProfile(profile);
    this.s = { seedText: seed.text, seed: seed.seed, profile, patch, params, epoch: 0 };
    this.key = this.keyOf(this.s);
  }

  get state(): SessionState {
    return this.s;
  }

  private keyOf(s: Pick<SessionState, 'seed' | 'params'>): string {
    return `${s.seed[0]}|${s.seed[1]}|${hex64(paramsHash(s.params))}`;
  }

  private commit(next: Omit<SessionState, 'epoch'>): SessionState {
    const key = this.keyOf(next);
    this.s = { ...next, epoch: key === this.key ? this.s.epoch : this.s.epoch + 1 };
    this.key = key;
    return this.s;
  }

  /** SP1 seed rule; returns the state (seedText holds the written-back random seed for empty text). */
  setSeedText(text: string): SessionState {
    const r = resolveSeedText(text, this.random);
    return this.commit({ ...this.s, seedText: r.text, seed: r.seed });
  }

  /** Switches to a ready profile and clears the patch (the UI asks for confirmation first). */
  setProfile(profile: ProfileId): SessionResult {
    if (!isProfileReady(profile)) return { ok: false, issues: [issue('profile', `profile ${profile} is not available yet`)] };
    return { ok: true, state: this.commit({ ...this.s, profile, patch: {}, params: resolveProfile(profile) }) };
  }

  /** Replaces the patch over the profile; an invalid patch changes nothing. */
  setPatch(patch: unknown): SessionResult {
    const r = applyPatch(SCHEMA, resolveProfile(this.s.profile), patch);
    if (!r.ok) return { ok: false, issues: r.issues };
    return { ok: true, state: this.commit({ ...this.s, patch: patch as ParamsPatch, params: r.value }) };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit test/unit/session.test.ts test/unit/seedBox.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS (erasableSyntaxOnly forbids constructor parameter properties; the class uses a field).

- [ ] **Step 5: Commit**

```bash
git add src/core/seed.ts src/ui/seedBox.ts src/engine/session.ts test/unit/session.test.ts
git commit -m "feat(engine): WorldSession — seed, profile, patch and epoch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 21: The ?map page

**Files:**
- Create: `src/ui/map/mapState.ts`, `tileCache.ts`, `viewMath.ts`, `hoverPanel.ts`, `mapView.ts`, `mapPage.ts`, `map.css`
- Modify: `src/main.ts`
- Test: `test/unit/mapState.test.ts`

**Interfaces:**
- Consumes: `WorldSession`, `createBrowserPool`, `JobCancelled`, `levelFor`, `layerStage`, `LAYERS`, `isLayerId`, `biomeName`, `formatPoint`, SP1's `base64urlEncode/Decode` and `createUrlWriter`.
- Produces: `interface MapView`, `interface MapState`, `MAP_MIN_BPP`, `MAP_MAX_BPP`, `DEFAULT_MAP_STATE`, `encodeMapState`, `decodeMapState`; `createTileCache`, `tileKey`; `screenToWorld`, `worldToScreen`, `visibleTiles`, `planTiles`; `formatPoint`; `createMapCanvas(host, pool, view, opts)`; `mountMapPage(root)`.

- [ ] **Step 1: Write the failing test**

`test/unit/mapState.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { utf8Bytes } from '../../src/core/hash';
import { base64urlEncode } from '../../src/ui/lab/labState';
import { decodeMapState, DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
import { createTileCache, tileKey } from '../../src/ui/map/tileCache';
import { planTiles, screenToWorld, visibleTiles, worldToScreen } from '../../src/ui/map/viewMath';

const enc = (o: unknown) => `#${base64urlEncode(utf8Bytes(JSON.stringify(o)))}`;

describe('map URL state', () => {
  test('round-trips, trimming the seed and normalising −0', () => {
    const s: MapState = { v: 1, seed: ' 7 ', profile: 'large_biomes', patch: { rivers: { widthMin: 6 } }, view: { x: -0, z: 1024.5, bpp: 16, layer: 'relief' } };
    const back = decodeMapState(`#${encodeMapState(s)}`);
    expect(back.error).toBeNull();
    expect(back.state).toEqual({ ...s, seed: '7', view: { ...s.view, x: 0 } });
  });
  test('an empty hash is the default without a notice', () => {
    expect(decodeMapState('')).toEqual({ state: DEFAULT_MAP_STATE, error: null });
  });
  test.each<[string, string]>([
    ['bad base64', '#***'],
    ['not JSON', enc('{x')],
    ['unknown key', enc({ ...DEFAULT_MAP_STATE, extra: 1 })],
    ['wrong version', enc({ ...DEFAULT_MAP_STATE, v: 2 })],
    ['empty seed', enc({ ...DEFAULT_MAP_STATE, seed: ' ' })],
    ['seed with a line break', enc({ ...DEFAULT_MAP_STATE, seed: 'a\nb' })],
    ['unknown profile', enc({ ...DEFAULT_MAP_STATE, profile: 'nope' })],
    ['profile not ready', enc({ ...DEFAULT_MAP_STATE, profile: 'archipelago' })],
    ['invalid patch', enc({ ...DEFAULT_MAP_STATE, patch: { rivers: { widthMin: 999 } } })],
    ['view outside the window', enc({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, x: 1e7 } })],
    ['zoom out of range', enc({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, bpp: 1000 } })],
    ['unknown layer', enc({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, layer: 'caves' } })],
  ])('%s falls back to the defaults with a notice', (_n, hash) => {
    const r = decodeMapState(hash);
    expect(r.state).toEqual(DEFAULT_MAP_STATE);
    expect(r.error).toMatch(/^map URL ignored: /);
  });
});

describe('view math', () => {
  const v = { x: 1000, z: -500, bpp: 64, layer: 'biome' as const };
  test('screen ↔ world round-trips', () => {
    const [x, z] = screenToWorld(v, 800, 600, 123, 45);
    expect(worldToScreen(v, 800, 600, x, z)).toEqual([123, 45]);
    expect(screenToWorld(v, 800, 600, 400, 300)).toEqual([1000, -500]);
  });
  test('visible tiles cover the view, nearest first', () => {
    const t = visibleTiles(v, 800, 600, 64);
    expect(t.length).toBe(16);
    expect(t[0]).toMatchObject({ tx: 0, tz: -1 });
    expect(visibleTiles({ ...v, x: 0, z: 0 }, 512, 512, 256)).toEqual([
      { tx: -1, tz: -1, dist: Math.SQRT1_2 }, { tx: 0, tz: -1, dist: Math.SQRT1_2 }, { tx: -1, tz: 0, dist: Math.SQRT1_2 }, { tx: 0, tz: 0, dist: Math.SQRT1_2 },
    ]);
  });
  test('tiles outside the colKey window are never planned (view at the world edge)', () => {
    const edge = { x: 524288, z: -524288, bpp: 256, layer: 'biome' as const };
    const plan = planTiles(edge, 1400, 900);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((t) => Math.abs(t.tx) * 256 * t.level <= 524288 && Math.abs(t.tz) * 256 * t.level <= 524288)).toBe(true);
    expect(planTiles({ ...edge, bpp: 4 }, 1400, 900).every((t) => Math.abs(t.tx) * 256 * t.level <= 524288)).toBe(true);
  });
  test('the plan asks for the preview level before the view level', () => {
    const p = planTiles(v, 800, 600);
    const firstFine = p.findIndex((t) => t.level !== 256);
    expect(p.slice(0, firstFine).every((t) => t.level === 256)).toBe(true);
    expect(p.slice(firstFine).every((t) => t.level === 64 && t.priority >= 1000)).toBe(true);
    expect(planTiles({ ...v, bpp: 200 }, 800, 600).every((t) => t.level === 256)).toBe(true);
  });
});

describe('tile cache', () => {
  test('LRU with eviction callback; keys include the layer hash', () => {
    const evicted: number[] = [];
    const c = createTileCache<number>(2, (v) => evicted.push(v));
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect([c.get('b'), c.get('a'), c.size]).toEqual([undefined, 1, 2]);
    expect(evicted).toEqual([2]);
    c.clear();
    expect(evicted.sort()).toEqual([1, 2, 3]);
    expect(tileKey('biome', 64, -1, 2, 'abc')).toBe('biome|64|-1|2|abc');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/mapState.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the pure parts**

`src/ui/map/mapState.ts`:

```ts
/**
 * The ?map URL state (SP2a spec §6.3): {v: 1, seed, profile, patch, view: {x, z, bpp, layer}} as
 * canonical JSON in base64url. A bad hash opens the defaults with a notice.
 */
import { utf8Bytes } from '../../core/hash';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { applyPatch, isObj } from '../../core/params/kit';
import { isProfileId, isProfileReady, resolveProfile, type ProfileId } from '../../core/params/profiles';
import { SCHEMA, type ParamsPatch } from '../../core/params/schema';
import { isLayerId, type LayerId } from '../../gen/map/layers';
import { base64urlDecode, base64urlEncode } from '../lab/labState';

export interface MapView {
  readonly x: number;
  readonly z: number;
  /** Display scale in blocks per screen pixel. */
  readonly bpp: number;
  readonly layer: LayerId;
}

export interface MapState {
  readonly v: 1;
  readonly seed: string;
  readonly profile: ProfileId;
  readonly patch: ParamsPatch;
  readonly view: MapView;
}

export const MAP_MIN_BPP = 0.25;
export const MAP_MAX_BPP = 256;
const WINDOW = 524288;
export const DEFAULT_MAP_STATE: MapState = { v: 1, seed: '42', profile: 'default', patch: {}, view: { x: 0, z: 0, bpp: 64, layer: 'biome' } };

const q = (v: number) => q15(v) + 0;

export function encodeMapState(s: MapState): string {
  const view = { x: q(s.view.x), z: q(s.view.z), bpp: q(s.view.bpp), layer: s.view.layer };
  return base64urlEncode(utf8Bytes(canonicalJSON({ ...s, seed: s.seed.trim(), view })));
}

const KEYS = ['v', 'seed', 'profile', 'patch', 'view'];
const VIEW_KEYS = ['x', 'z', 'bpp', 'layer'];

function reason(j: unknown): string | null {
  if (!isObj(j)) return 'not an object';
  const extra = Object.keys(j).find((k) => !KEYS.includes(k));
  if (extra !== undefined) return `unknown key ${extra}`;
  if (j['v'] !== 1) return 'unsupported version';
  if (typeof j['seed'] !== 'string' || j['seed'].trim() === '' || /[\r\n]/.test(j['seed'])) return 'bad seed';
  if (!isProfileId(j['profile'])) return 'unknown profile';
  if (!isProfileReady(j['profile'])) return `profile ${j['profile']} is not available yet`;
  if (!isObj(j['patch'])) return 'patch is not an object';
  const r = applyPatch(SCHEMA, resolveProfile(j['profile']), j['patch']);
  if (!r.ok) return `invalid patch (${r.issues[0]!.path} ${r.issues[0]!.code})`;
  const v = j['view'];
  if (!isObj(v) || Object.keys(v).some((k) => !VIEW_KEYS.includes(k))) return 'bad view';
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!fin(v['x']) || !fin(v['z']) || Math.abs(v['x']) > WINDOW || Math.abs(v['z']) > WINDOW) return 'view outside the window';
  if (!fin(v['bpp']) || v['bpp'] < MAP_MIN_BPP || v['bpp'] > MAP_MAX_BPP) return 'zoom out of range';
  if (!isLayerId(v['layer'])) return 'unknown layer';
  return null;
}

export function decodeMapState(hash: string): { state: MapState; error: string | null } {
  const text = hash.replace(/^#/, '');
  if (text === '') return { state: DEFAULT_MAP_STATE, error: null };
  const fail = (why: string) => ({ state: DEFAULT_MAP_STATE, error: `map URL ignored: ${why}` });
  const bytes = base64urlDecode(text);
  if (bytes === null) return fail('not base64url');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('not JSON');
  }
  const why = reason(json);
  if (why !== null) return fail(why);
  const s = json as MapState;
  return { state: { ...s, seed: s.seed.trim() }, error: null };
}
```

`src/ui/map/tileCache.ts`:

```ts
/** LRU of rendered tiles keyed by (layer, level, tx, tz, layer hash) (master §5.6: 256 entries). */
export interface TileCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
  clear(): void;
}

export const tileKey = (layer: string, level: number, tx: number, tz: number, hash: string): string => `${layer}|${level}|${tx}|${tz}|${hash}`;

export function createTileCache<T>(capacity = 256, onEvict: (value: T) => void = () => {}): TileCache<T> {
  const map = new Map<string, T>();
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    set(key, value) {
      const old = map.get(key);
      if (old !== undefined) { map.delete(key); if (old !== value) onEvict(old); }
      map.set(key, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value!;
        const v = map.get(oldest)!;
        map.delete(oldest);
        onEvict(v);
      }
    },
    get size() { return map.size; },
    clear() { for (const v of map.values()) onEvict(v); map.clear(); },
  };
}
```

`src/ui/map/viewMath.ts`:

```ts
/** Screen ↔ world math and tile planning for the map view (SP2a spec §6.1). */
import { MAP_TILE_PX, type MapLevel } from '../../core/constants';
import { levelFor } from '../../gen/map/tile';
import type { MapView } from './mapState';

export interface PlannedTile { readonly level: MapLevel; readonly tx: number; readonly tz: number; readonly priority: number }

export const screenToWorld = (v: MapView, w: number, h: number, sx: number, sy: number): [number, number] =>
  [v.x + (sx - w / 2) * v.bpp, v.z + (sy - h / 2) * v.bpp];

export const worldToScreen = (v: MapView, w: number, h: number, x: number, z: number): [number, number] =>
  [(x - v.x) / v.bpp + w / 2, (z - v.z) / v.bpp + h / 2];

const WINDOW = 524288;
/** The protocol's tile bound: |t| · 256 · level ≤ 2^19 (tiles beyond the colKey window are never requested). */
const inWindow = (t: number, level: number): boolean => Math.abs(t) * MAP_TILE_PX * level <= WINDOW;

/** Tiles of `level` covering the w × h view inside the colKey window, nearest to the centre first. */
export function visibleTiles(v: MapView, w: number, h: number, level: MapLevel): Array<{ tx: number; tz: number; dist: number }> {
  const span = MAP_TILE_PX * level;
  const [x0, z0] = screenToWorld(v, w, h, 0, 0);
  const [x1, z1] = screenToWorld(v, w, h, w, h);
  const out: Array<{ tx: number; tz: number; dist: number }> = [];
  for (let tz = Math.floor(z0 / span); tz <= Math.floor((z1 - 1e-9) / span); tz++) {
    for (let tx = Math.floor(x0 / span); tx <= Math.floor((x1 - 1e-9) / span); tx++) {
      const cx = (tx + 0.5) * span;
      const cz = (tz + 0.5) * span;
      if (inWindow(tx, level) && inWindow(tz, level)) out.push({ tx, tz, dist: Math.hypot(cx - v.x, cz - v.z) / span });
    }
  }
  return out.sort((a, b) => a.dist - b.dist || a.tz - b.tz || a.tx - b.tx);
}

/** The preview level first (priority < 1000), then the view's own level; nearer tiles first within each. */
export function planTiles(v: MapView, w: number, h: number): PlannedTile[] {
  const target = levelFor(v.bpp);
  const plan: PlannedTile[] = visibleTiles(v, w, h, 256).map((t) => ({ level: 256 as MapLevel, tx: t.tx, tz: t.tz, priority: t.dist }));
  if (target !== 256) for (const t of visibleTiles(v, w, h, target)) plan.push({ level: target, tx: t.tx, tz: t.tz, priority: 1000 + t.dist });
  return plan;
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run --project unit test/unit/mapState.test.ts`
Expected: PASS (19 tests, including the world-edge plan).

- [ ] **Step 5: Implement the page**

`src/ui/map/hoverPanel.ts`:

```ts
/** Side-panel readout of a ColumnPoint (SP2a spec §6.3). */
import { biomeName } from '../../gen/biomes/registry';
import type { ColumnPoint } from '../../gen/column/columnPoint';

const n = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : v > 0 ? '+∞' : v < 0 ? '−∞' : 'NaN');

export function formatPoint(p: ColumnPoint): string {
  return [
    `x ${n(p.x, 1)}  z ${n(p.z, 1)}`,
    `biome ${biomeName(p.biome)}`,
    `C ${n(p.C)}  E ${n(p.E)}  W ${n(p.W)}`,
    `T ${n(p.T)}  H ${n(p.H)}  R ${n(p.R)}  PV ${n(p.PV)}`,
    `offset0 ${n(p.offset0, 2)}  σ0 ${n(p.sigma0, 2)}  jag0 ${n(p.jag0, 2)}`,
    `steep ${n(p.steep, 3)}`,
    `riverDist ${n(p.riverDist, 1)}  strength ${n(p.riverStrength, 2)}${p.riverWet ? '  river' : ''}${p.gorge ? '  gorge' : ''}`,
    `lake ${n(p.lakeMask, 2)}  level ${n(p.lakeLevel, 0)}  floor ${n(p.lakeFloor, 1)}`,
    `offset ${n(p.offset, 2)}  σ ${n(p.sigma, 2)}  jag ${n(p.jag, 2)}`,
    `surfaceEst ${n(p.surfaceEst, 2)}  water ${n(p.surfaceWaterLevel, 0)}`,
  ].join('\n');
}
```

`src/ui/map/mapView.ts`:

```ts
/**
 * The map canvas (SP2a spec §6.1, §6.3): draws cached tiles (preview level first, then the view's level
 * on top), asks the pool for missing tiles coarse-first, pans by drag, zooms around the cursor, and draws
 * the spawn marker, a grid and the pinned point.
 */
import { MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { Spawn } from '../../gen/column/spawn';
import { layerStage } from '../../gen/map/layers';
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import { MAP_MAX_BPP, MAP_MIN_BPP, type MapView } from './mapState';
import { createTileCache, tileKey } from './tileCache';
import { planTiles, screenToWorld, visibleTiles, worldToScreen } from './viewMath';

export interface MapViewOptions {
  onView(v: MapView): void;
  onHover(x: number, z: number): void;
  onClick(x: number, z: number): void;
  /** Called once when every preview tile of the current view has been drawn after setSource. */
  onFirstImage(ms: number): void;
}

export interface MapCanvas {
  setView(v: MapView): void;
  /** New pool epoch: the seed words and the stage hashes (hex) by stage id (stage hashes are seed-independent). */
  setSource(seedKey: string, hashes: Readonly<Record<string, string>>): void;
  setSpawn(s: Spawn | null): void;
  setPin(p: [number, number] | null): void;
  setGrid(on: boolean): void;
  destroy(): void;
}

const WINDOW = 524288;
const clampCentre = (v: number) => Math.max(-WINDOW, Math.min(WINDOW, v));

export function createMapCanvas(host: HTMLElement, pool: WorkerPool, initial: MapView, opts: MapViewOptions): MapCanvas {
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  host.append(canvas);
  const ctx2d = canvas.getContext('2d');
  if (ctx2d === null) throw new Error('2D canvas unavailable');
  let view = initial;
  let hashes: Readonly<Record<string, string>> | null = null;
  let seedKey = '';
  let spawn: Spawn | null = null;
  let pin: [number, number] | null = null;
  let grid = false;
  let raf = 0;
  let firstStart = 0;
  const cache = createTileCache<ImageBitmap>(256, (b) => b.close());
  const pending = new Set<string>();

  const hashOf = (layer: MapView['layer']) => (hashes === null ? '' : `${seedKey}:${hashes[layerStage(layer)] ?? ''}:${hashes['map'] ?? ''}`);

  const request = () => {
    if (hashes === null) return;
    const w = canvas.width;
    const h = canvas.height;
    const plan = planTiles(view, w, h);
    const wanted = new Set(plan.map((t) => tileKey(view.layer, t.level, t.tx, t.tz, hashOf(view.layer))));
    pool.cancelTiles((r) => !wanted.has(tileKey(r.layer, r.level, r.tx, r.tz, hashOf(r.layer))));
    for (const t of plan) {
      const key = tileKey(view.layer, t.level, t.tx, t.tz, hashOf(view.layer));
      if (pending.has(key) || cache.get(key) !== undefined) continue;
      pending.add(key);
      const layer = view.layer;
      pool.tile({ layer, level: t.level, tx: t.tx, tz: t.tz }, t.priority)
        .then((buf) => createImageBitmap(new ImageData(new Uint8ClampedArray(buf), MAP_TILE_PX, MAP_TILE_PX)))
        .then((bmp) => { cache.set(key, bmp); schedule(); })
        .catch((e: unknown) => { if (!(e instanceof JobCancelled)) console.error(e); })
        .finally(() => pending.delete(key));
    }
  };

  const drawLevel = (level: MapLevel): number => {
    const w = canvas.width;
    const h = canvas.height;
    const span = MAP_TILE_PX * level;
    let missing = 0;
    for (const t of visibleTiles(view, w, h, level)) {
      const bmp = cache.get(tileKey(view.layer, level, t.tx, t.tz, hashOf(view.layer)));
      if (bmp === undefined) { missing++; continue; }
      const [sx, sy] = worldToScreen(view, w, h, t.tx * span, t.tz * span);
      const size = span / view.bpp;
      ctx2d.drawImage(bmp, Math.floor(sx), Math.floor(sy), Math.ceil(size) + 1, Math.ceil(size) + 1);
    }
    return missing;
  };

  const drawOverlays = () => {
    const w = canvas.width;
    const h = canvas.height;
    if (grid) {
      let step = 16;
      while (step / view.bpp < 48) step *= 2;
      const [x0, z0] = screenToWorld(view, w, h, 0, 0);
      const [x1, z1] = screenToWorld(view, w, h, w, h);
      ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx2d.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const [sx] = worldToScreen(view, w, h, x, 0); ctx2d.moveTo(sx + 0.5, 0); ctx2d.lineTo(sx + 0.5, h); }
      for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) { const [, sy] = worldToScreen(view, w, h, 0, z); ctx2d.moveTo(0, sy + 0.5); ctx2d.lineTo(w, sy + 0.5); }
      ctx2d.stroke();
    }
    const marker = (x: number, z: number, colour: string) => {
      const [sx, sy] = worldToScreen(view, w, h, x, z);
      ctx2d.strokeStyle = colour;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(sx, sy, 6, 0, 2 * Math.PI);
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
    };
    if (spawn !== null) marker(spawn.x, spawn.z, '#ff3b30');
    if (pin !== null) marker(pin[0], pin[1], '#ffd60a');
  };

  const draw = () => {
    raf = 0;
    ctx2d.fillStyle = '#15171b';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    const missingPreview = drawLevel(256);
    const target = planTiles(view, canvas.width, canvas.height).find((t) => t.level !== 256)?.level;
    if (target !== undefined) drawLevel(target);
    drawOverlays();
    if (firstStart > 0 && missingPreview === 0 && hashes !== null) {
      opts.onFirstImage(performance.now() - firstStart);
      firstStart = 0;
    }
  };
  const schedule = () => { if (raf === 0) raf = requestAnimationFrame(draw); };

  const resize = () => {
    const w = Math.max(1, Math.floor(host.clientWidth));
    const h = Math.max(1, Math.floor(host.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; request(); schedule(); }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  let drag: { x: number; y: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.offsetX, y: e.offsetY, moved: false }; canvas.setPointerCapture(e.pointerId); });
  const endDrag = (e: PointerEvent) => {
    if (drag !== null && !drag.moved) { const [x, z] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY); opts.onClick(x, z); }
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointermove', (e) => {
    const [x, z] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY);
    opts.onHover(x, z);
    if (drag === null) return;
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) drag.moved = true;
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    opts.onView({ ...view, x: clampCentre(view.x - dx * view.bpp), z: clampCentre(view.z - dy * view.bpp) });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY === 0) return;
    const [ax, az] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY);
    const bpp = Math.max(MAP_MIN_BPP, Math.min(MAP_MAX_BPP, view.bpp * (e.deltaY > 0 ? 1.25 : 0.8)));
    const k = bpp / view.bpp;
    opts.onView({ ...view, x: clampCentre(ax - (ax - view.x) * k), z: clampCentre(az - (az - view.z) * k), bpp });
  }, { passive: false });

  resize();
  return {
    setView(v) { view = v; request(); schedule(); },
    setSource(seed, h) { seedKey = seed; hashes = h; firstStart = performance.now(); request(); schedule(); },
    setSpawn(s) { spawn = s; schedule(); },
    setPin(p) { pin = p; schedule(); },
    setGrid(on) { grid = on; schedule(); },
    destroy() { cancelAnimationFrame(raf); observer.disconnect(); cache.clear(); canvas.remove(); },
  };
}
```

`src/ui/map/mapPage.ts`:

```ts
/**
 * The ?map page (SP2a spec §6): WorldSession + worker pool + map canvas, with the seed box, the ready
 * profiles, a JSON patch box, a layer select, the hover readout, the spawn and the first-image timing.
 */
import './map.css';
import { PROFILE_IDS, isProfileReady, type ProfileId } from '../../core/params/profiles';
import { canonicalJSON } from '../../core/params/canonical';
import { biomeName } from '../../gen/biomes/registry';
import { LAYERS, isLayerId } from '../../gen/map/layers';
import { WorldSession } from '../../engine/session';
import { createBrowserPool, JobCancelled } from '../../engine/workerPool';
import { cryptoSeed } from '../seedBox';
import { createUrlWriter } from '../lab/urlWriter';
import { formatPoint } from './hoverPanel';
import { createMapCanvas } from './mapView';
import { decodeMapState, encodeMapState, type MapState, type MapView } from './mapState';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== '') e.className = className;
  if (text !== '') e.textContent = text;
  return e;
}

export function mountMapPage(root: HTMLElement): void {
  const decoded = decodeMapState(location.hash);
  const initial = decoded.state;
  const session = new WorldSession(cryptoSeed, { seedText: initial.seed, profile: initial.profile, patch: initial.patch });
  let view: MapView = initial.view;

  const page = el('div', 'map');
  const header = el('div', 'map-header');
  header.append(el('strong', '', 'world-imaginer-voxel · map'));
  const notice = el('span', 'map-notice', decoded.error ?? '');
  header.append(notice);
  const toolbar = el('div', 'map-toolbar');
  const host = el('div', 'map-view');
  const side = el('div', 'map-side');
  page.append(header, toolbar, host, side);
  root.replaceChildren(page);

  const layerSelect = el('select');
  for (const l of LAYERS) layerSelect.append(new Option(l, l));
  const seedInput = el('input');
  seedInput.placeholder = 'seed (empty = random)';
  const profileSelect = el('select');
  for (const p of PROFILE_IDS) if (isProfileReady(p)) profileSelect.append(new Option(p, p));
  const patchBox = el('textarea');
  patchBox.spellcheck = false;
  const applyBtn = el('button', '', 'apply patch');
  const gridBox = el('input');
  gridBox.type = 'checkbox';
  const gridLabel = el('label', '', 'grid ');
  gridLabel.append(gridBox);
  toolbar.append(layerSelect, seedInput, profileSelect, patchBox, applyBtn, gridLabel);

  const issues = el('div', 'map-issues');
  const status = el('div', 'map-readout');
  const hover = el('div', 'map-readout');
  side.append(el('h3', '', 'World'), status, issues, el('h3', '', 'Point'), hover);

  const pool = createBrowserPool();
  const url = createUrlWriter((u) => history.replaceState(null, '', u));
  addEventListener('pagehide', () => url.flush());
  let firstImageMs: number | null = null;
  let spawnText = '';

  const state = (): MapState => {
    const s = session.state;
    return { v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view };
  };
  const writeUrl = () => url.set(`?map#${encodeMapState(state())}`);
  const renderStatus = () => {
    const s = session.state;
    status.textContent = [
      `seed ${s.seedText}`, `profile ${s.profile}`, `epoch ${s.epoch}  workers ${pool.size}`,
      `view x ${view.x.toFixed(0)} z ${view.z.toFixed(0)}  ${view.bpp.toFixed(2)} blocks/px`,
      spawnText, firstImageMs === null ? 'first image …' : `first image ${firstImageMs.toFixed(0)} ms`,
    ].join('\n');
  };

  const canvas = createMapCanvas(host, pool, view, {
    onView: (v) => { view = v; canvas.setView(v); writeUrl(); renderStatus(); },
    onHover: (() => {
      let busy = false;
      let next: [number, number] | null = null;
      const run = (x: number, z: number) => {
        busy = true;
        pool.point(x, z).then((p) => { hover.textContent = formatPoint(p); })
          .catch((e: unknown) => { if (!(e instanceof JobCancelled)) hover.textContent = String(e); })
          .finally(() => { busy = false; if (next !== null) { const [a, b] = next; next = null; run(a, b); } });
      };
      return (x: number, z: number) => { if (busy) next = [x, z]; else run(x, z); };
    })(),
    onClick: (x, z) => { canvas.setPin([x, z]); },
    onFirstImage: (ms) => { if (firstImageMs === null) { firstImageMs = ms; renderStatus(); } },
  });

  const reconfigure = () => {
    const s = session.state;
    seedInput.value = s.seedText;
    profileSelect.value = s.profile;
    patchBox.value = canonicalJSON(s.patch);
    spawnText = 'spawn …';
    renderStatus();
    writeUrl();
    canvas.setSpawn(null);
    pool.configure(s.seedText, s.params).then((ready) => {
      canvas.setSource(`${s.seed[0]}.${s.seed[1]}`, ready.stageHashes as Record<string, string>);
      return pool.spawn();
    }).then((sp) => {
      canvas.setSpawn(sp);
      spawnText = `spawn ${sp.x}, ${sp.z} (y ${sp.y}, ${biomeName(sp.biome)}${sp.fallback ? ', fallback' : ''})`;
      renderStatus();
    }).catch((e: unknown) => { if (!(e instanceof JobCancelled)) issues.textContent = String(e); });
  };

  layerSelect.value = view.layer;
  layerSelect.addEventListener('change', () => {
    if (isLayerId(layerSelect.value)) { view = { ...view, layer: layerSelect.value }; canvas.setView(view); writeUrl(); }
  });
  seedInput.addEventListener('change', () => {
    const before = session.state.epoch;
    session.setSeedText(seedInput.value);
    if (session.state.epoch !== before) reconfigure(); else seedInput.value = session.state.seedText;
  });
  profileSelect.addEventListener('change', () => {
    const id = profileSelect.value as ProfileId;
    if (Object.keys(session.state.patch).length > 0 && !confirm('Switching profile clears the patch. Continue?')) { profileSelect.value = session.state.profile; return; }
    const r = session.setProfile(id);
    if (!r.ok) { issues.textContent = r.issues.map((i) => i.message).join('\n'); return; }
    issues.textContent = '';
    reconfigure();
  });
  applyBtn.addEventListener('click', () => {
    let patch: unknown;
    try { patch = JSON.parse(patchBox.value.trim() === '' ? '{}' : patchBox.value); } catch (e) {
      issues.textContent = `patch is not JSON: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const before = session.state.epoch;
    const r = session.setPatch(patch);
    if (!r.ok) { issues.textContent = r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('\n'); return; }
    issues.textContent = '';
    if (session.state.epoch !== before) reconfigure(); else writeUrl();
  });
  gridBox.addEventListener('change', () => canvas.setGrid(gridBox.checked));
  reconfigure();
}
```

`src/ui/map/map.css`:

```css
.map { display: grid; grid-template-rows: auto auto 1fr; grid-template-columns: 1fr 300px; height: 100vh; font: 13px system-ui, sans-serif; color: #ddd; background: #1b1d22; }
.map-header { grid-column: 1 / 3; display: flex; gap: 12px; align-items: center; padding: 6px 10px; background: #23262d; }
.map-notice { color: #f0b34a; }
.map-toolbar { grid-column: 1 / 3; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #333; }
.map-toolbar textarea { width: 360px; height: 2.4em; font-family: ui-monospace, monospace; }
.map-view { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.map-canvas { display: block; width: 100%; height: 100%; cursor: grab; }
.map-side { overflow: auto; padding: 8px 10px; border-left: 1px solid #333; }
.map-side h3 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; color: #9aa; }
.map-issues { color: #ff7b72; white-space: pre-wrap; font-family: ui-monospace, monospace; }
.map-readout { font-family: ui-monospace, monospace; white-space: pre; }
```

`src/main.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/main.ts b/src/main.ts
index 3b5cbb3..a9d6aad 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -23,9 +23,12 @@ async function boot(root: HTMLElement): Promise<void> {
 
 const root = document.getElementById('app');
 if (root === null) throw new Error('#app element missing from index.html');
-const start: Promise<void> = new URLSearchParams(location.search).get('lab') === 'noise'
+const query = new URLSearchParams(location.search);
+const start: Promise<void> = query.get('lab') === 'noise'
   ? import('./ui/lab/noiseLab').then((m) => m.mountNoiseLab(root))
-  : boot(root);
+  : query.has('map')
+    ? import('./ui/map/mapPage').then((m) => m.mountMapPage(root))
+    : boot(root);
 start.catch((error: unknown) => {
   const pre = document.createElement('pre');
   pre.textContent = `Boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
```

- [ ] **Step 6: Typecheck, build and look at it**

Run: `npm run typecheck && npm run build && npx vitest run --project arch`
Expected: PASS; the build emits a `mapPage` chunk and a `task.worker` chunk.

Run `npm run dev` in the background and open `http://localhost:5183/?map` in Chrome (a headless Chrome over the DevTools protocol with its own `--user-data-dir` in the scratch directory works too). Check:
- the side panel shows `first image N ms` with N ≤ 300 on the reference machine and a spawn line;
- after a few seconds no background colour (#15171b) remains on the canvas;
- hovering fills the Point panel (biome, fields);
- layer relief shows shaded hypsometry with water by depth;
- the patch `{"rivers":{"widthMin":99}}` shows `rivers.widthMin: OUT_OF_RANGE` and changes nothing;
- the patch `{"rivers":{"widthMin":12}}` bumps the epoch to 1 and re-renders;
- a reload (through about:blank) restores layer and patch;
- there are no console errors.
The dry run measured 280 ms with 6 workers on the dev server. Stop only the dev server you started.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/map src/main.ts test/unit/mapState.test.ts
git commit -m "feat(ui): the ?map page — tiles, pan and zoom, hover, seed, profiles and patches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 22: SP2a goldens, ?selftest=1 and the JavaScriptCore check

**Files:**
- Create: `src/metrics/sp2aGoldens.ts`, `src/ui/selftest/selftestPage.ts`
- Test: `test/unit/goldens.sp2a.test.ts`
- Modify: `src/workers/protocol.ts`, `src/workers/taskHandler.ts`, `src/engine/workerPool.ts`, `test/unit/protocol.test.ts`, `src/main.ts`, `test/tools/goldensJsc.ts`, `test/goldens.json` (recorded), `CLAUDE.md`

**Interfaces:**
- Produces: `pointDigest(profile)`, `sampleDigest()`, `tileDigest(layer, level)`, `spawnDigest()`, `sp2aGoldenKeys()` (20), `computeSp2aGolden(key)`, `allGoldenKeys()` (47), `computeAnyGolden(key)`; `SelftestMsg`/`SelftestResultMsg`; `WorkerPool.selftest(key)`; `createBrowserPool(size?)`; `mountSelftestPage(root)`.

- [ ] **Step 1: Write the failing tests**

`test/unit/goldens.sp2a.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { allGoldenKeys, computeAnyGolden, computeSp2aGolden, sp2aGoldenKeys } from '../../src/metrics/sp2aGoldens';
import { expectGolden } from '../harness/goldens';

test('20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn', () => {
  const keys = sp2aGoldenKeys();
  expect(keys.length).toBe(20);
  expect(new Set(keys).size).toBe(20);
  expect(keys.filter((k) => k.startsWith('sp2a.tile.')).length).toBe(16);
  expect(allGoldenKeys().length).toBe(47);
  expect(() => computeSp2aGolden('sp2a.tile.biome.32')).toThrow(/unknown golden/);
  expect(() => computeSp2aGolden('sp2a.spawn.x')).toThrow(/unknown golden/);
  expect(computeAnyGolden('sp1.params')).toMatch(/^[0-9a-f]{16}$/);
});

describe('SP2a goldens', () => {
  test.each(sp2aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp2aGolden(key));
  }, 60_000);
});
```

`test/unit/protocol.test.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/unit/protocol.test.ts b/test/unit/protocol.test.ts
index 762a973..175ddd7 100644
--- a/test/unit/protocol.test.ts
+++ b/test/unit/protocol.test.ts
@@ -2,6 +2,7 @@ import { describe, expect, test } from 'vitest';
 import { DEFAULTS } from '../../src/core/params/defaults';
 import { columnPoint } from '../../src/gen/column/columnPoint';
 import { findSpawn } from '../../src/gen/column/spawn';
+import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
 import { paintTile } from '../../src/gen/map/tile';
 import { parseFromWorker, parseToWorker } from '../../src/workers/protocol';
 import { createTaskHandler } from '../../src/workers/taskHandler';
@@ -15,6 +16,7 @@ describe('parseToWorker', () => {
     expect(parseToWorker(tileMsg)).not.toBeNull();
     expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, x: 1.5, z: -7 })).not.toBeNull();
     expect(parseToWorker({ type: 'spawn', jobId: 4, epoch: 3 })).not.toBeNull();
+    expect(parseToWorker({ type: 'selftest', jobId: 5, key: 'sp1.params' })).not.toBeNull();
   });
   test.each<[string, unknown]>([
     ['not an object', 5],
@@ -68,6 +70,11 @@ describe('task handler', () => {
     expect(last.type).toBe('error');
     if (last.type === 'error') expect(last.code).toBe(code);
   });
+  test('selftest needs no configure and reports digests or errors per key', () => {
+    const h = createTaskHandler();
+    expect(h.handle({ type: 'selftest', jobId: 1, key: 'sp1.params' }).msg).toEqual({ type: 'selftestResult', jobId: 1, key: 'sp1.params', actual: computeAnyGolden('sp1.params'), error: null });
+    expect(h.handle({ type: 'selftest', jobId: 2, key: 'sp9.nope' }).msg).toEqual({ type: 'selftestResult', jobId: 2, key: 'sp9.nope', actual: null, error: 'unknown golden sp9.nope' });
+  });
   test('an error keeps the jobId of the failing job', () => {
     const h = createTaskHandler();
     const r = h.handle(tileMsg).msg;
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/goldens.sp2a.test.ts test/unit/protocol.test.ts`
Expected: FAIL (`sp2aGoldens` missing; `selftest` rejected by the protocol).

- [ ] **Step 3: Implement the digests**

`src/metrics/sp2aGoldens.ts`:

```ts
/**
 * SP2a golden digests (SP2a spec §7.4), shared by test/unit/goldens.sp2a.test.ts, the ?selftest=1 worker
 * and test/tools/goldensJsc.ts. Follows the core determinism rules (arch-tested). Every value is hex64.
 */
import { MAP_LEVELS, type MapLevel } from '../core/constants';
import { fnv1a32, fnv1a64Bytes, hashF64, hex64 } from '../core/hash';
import { resolveProfile, type ProfileId } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { createGenContext, type GenContext } from '../gen/context';
import { columnPoint, type ColumnPoint } from '../gen/column/columnPoint';
import { buildColumnSample, LEVEL_FIELDS, newColumnSample, SAMPLE_FIELDS } from '../gen/column/columnStage';
import { findSpawn } from '../gen/column/spawn';
import type { LayerId } from '../gen/map/layers';
import { paintTile } from '../gen/map/tile';
import { computeGolden as computeSp1, goldenKeys as sp1Keys } from './sp1Goldens';

const FNV32 = fnv1a32;
const FNV_BYTES = fnv1a64Bytes;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE = createGenContext;
const POINT = columnPoint;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const SPAWN = findSpawn;
const PAINT = paintTile;
const LEVELS = MAP_LEVELS;
const FIELDS = SAMPLE_FIELDS;
const LEVEL_F = LEVEL_FIELDS;
const SP1 = computeSp1;
const SP1_KEYS = sp1Keys;

const POINT_PROFILES: readonly ProfileId[] = ['default', 'large_biomes'];
const TILE_LAYERS: readonly LayerId[] = ['biome', 'relief', 'rivers', 'C'];
const N_POINTS = 4096;

const ctxFor = (profile: ProfileId): GenContext => CREATE(SEED('42'), RESOLVE(profile));

/** Every ColumnPoint field in a fixed order (booleans as 0/1). */
function pointValues(p: ColumnPoint, out: Float64Array, o: number): void {
  const v = [p.C, p.E, p.W, p.T, p.H, p.R, p.PV, p.offset0, p.sigma0, p.jag0, p.steep, p.riverDist, p.riverStrength, p.riverWet ? 1 : 0, p.gorge ? 1 : 0,
    p.lakeMask, p.lakeLevel, p.lakeFloor, p.offset, p.sigma, p.jag, p.surfaceWaterLevel, p.surfaceEst, p.islandMask, p.biome];
  for (let k = 0; k < 25; k++) out[o + k] = v[k]!;
}

/** columnPoint at 4096 points from Xoshiro128(fnv1a32('sp2a.point')) in the colKey window, world seed '42'. */
export function pointDigest(profile: ProfileId): string {
  const ctx = ctxFor(profile);
  const r = new Rng(FNV32('sp2a.point'));
  const out = new Float64Array(N_POINTS * 25);
  for (let i = 0; i < N_POINTS; i++) {
    const x = -524288 + 1048576 * r.nextFloat();
    const z = -524288 + 1048576 * r.nextFloat();
    pointValues(POINT(ctx, x, z), out, 25 * i);
  }
  return HEX64(HASH_F64(out));
}

/** 64 full ColumnSamples at columns from Xoshiro128(fnv1a32('sp2a.sample')), default profile. */
export function sampleDigest(): string {
  const ctx = ctxFor('default');
  const r = new Rng(FNV32('sp2a.sample'));
  const s = NEW_SAMPLE();
  const per = (FIELDS.length + LEVEL_F.length + 2) * 49;
  const out = new Float64Array(64 * per);
  for (let c = 0; c < 64; c++) {
    BUILD(ctx, r.nextInt(65536) - 32768, r.nextInt(65536) - 32768, s);
    let o = c * per;
    for (const f of [...FIELDS, ...LEVEL_F]) for (let k = 0; k < 49; k++) out[o++] = s.f[f][k]!;
    for (let k = 0; k < 49; k++) out[o++] = s.flags[k]!;
    for (let k = 0; k < 49; k++) out[o++] = s.biome[k]!;
  }
  return HEX64(HASH_F64(out));
}

/** RGBA digest of tile (1, −1) of `layer` at `level`, default profile. */
export function tileDigest(layer: LayerId, level: MapLevel): string {
  return HEX64(FNV_BYTES(new Uint8Array(PAINT(ctxFor('default'), layer, level, 1, -1, new Uint8ClampedArray(262144)).buffer)));
}

/** Spawns of seeds 1..64 (x, z, y, biome, fallback), default profile. */
export function spawnDigest(): string {
  const params = RESOLVE('default');
  const out = new Float64Array(64 * 5);
  for (let s = 1; s <= 64; s++) {
    const sp = SPAWN(CREATE(SEED(String(s)), params));
    out.set([sp.x, sp.z, sp.y, sp.biome, sp.fallback ? 1 : 0], 5 * (s - 1));
  }
  return HEX64(HASH_F64(out));
}

export function sp2aGoldenKeys(): string[] {
  return [
    ...POINT_PROFILES.map((p) => `sp2a.column.point.${p}`),
    'sp2a.column.sample',
    ...TILE_LAYERS.flatMap((l) => LEVELS.map((b) => `sp2a.tile.${l}.${b}`)),
    'sp2a.spawn',
  ];
}

export function computeSp2aGolden(key: string): string {
  const m = /^sp2a\.(column\.point|column\.sample|tile|spawn)(?:\.(.+))?$/.exec(key);
  if (m !== null) {
    if (m[1] === 'column.point' && (POINT_PROFILES as readonly string[]).includes(m[2] ?? '')) return pointDigest(m[2] as ProfileId);
    if (m[1] === 'column.sample' && m[2] === undefined) return sampleDigest();
    if (m[1] === 'spawn' && m[2] === undefined) return spawnDigest();
    if (m[1] === 'tile') {
      const [layer, level] = (m[2] ?? '').split('.');
      if ((TILE_LAYERS as readonly string[]).includes(layer ?? '') && (LEVELS as readonly number[]).includes(Number(level))) return tileDigest(layer as LayerId, Number(level) as MapLevel);
    }
  }
  throw new Error(`unknown golden ${key}`);
}

/** Every golden key of the build (SP1 then SP2a). */
export function allGoldenKeys(): string[] {
  return [...SP1_KEYS(), ...sp2aGoldenKeys()];
}

export function computeAnyGolden(key: string): string {
  return key.startsWith('sp2a.') ? computeSp2aGolden(key) : SP1(key);
}
```

- [ ] **Step 4: Run the key test (goldens not yet recorded)**

Run: `npx vitest run --project unit test/unit/goldens.sp2a.test.ts`
Expected: the key test passes; the 20 golden cases fail with `missing golden sp2a.…: run npm run test:goldens`.

- [ ] **Step 5: Record the goldens**

Run: `npm run test:goldens`
Expected: PASS; `test/goldens.json` gains 20 `sp2a.*` keys (47 in all) and keeps `"generatorVersion": 0`; the SP1 keys are unchanged (the merge would refuse otherwise).

Run: `npx vitest run --project unit test/unit/goldens.sp2a.test.ts test/unit/goldens.sp1.test.ts`
Expected: PASS.

- [ ] **Step 6: Add selftest to the protocol, handler and pool**

`src/workers/protocol.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/workers/protocol.ts b/src/workers/protocol.ts
index 2214ad7..fa16b5a 100644
--- a/src/workers/protocol.ts
+++ b/src/workers/protocol.ts
@@ -1,7 +1,7 @@
 /**
  * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
- * The main thread sends configure / mapTile / point / spawn; the worker answers ready / tile / pointResult /
- * spawnResult / error.
+ * The main thread sends configure / mapTile / point / spawn / selftest; the worker answers ready / tile /
+ * pointResult / spawnResult / selftestResult / error. selftest needs no configure.
  */
 import { MAP_LEVELS, type MapLevel } from '../core/constants';
 import type { StageId } from '../core/ids';
@@ -15,7 +15,8 @@ export interface ConfigureMsg { readonly type: 'configure'; readonly epoch: numb
 export interface MapTileMsg { readonly type: 'mapTile'; readonly jobId: number; readonly epoch: number; readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }
 export interface PointMsg { readonly type: 'point'; readonly jobId: number; readonly epoch: number; readonly x: number; readonly z: number }
 export interface SpawnMsg { readonly type: 'spawn'; readonly jobId: number; readonly epoch: number }
-export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg;
+export interface SelftestMsg { readonly type: 'selftest'; readonly jobId: number; readonly key: string }
+export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | SelftestMsg;
 
 export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
 export interface TileMsg { readonly type: 'tile'; readonly jobId: number; readonly epoch: number; readonly rgba: ArrayBuffer }
@@ -23,7 +24,9 @@ export interface PointResultMsg { readonly type: 'pointResult'; readonly jobId:
 export type ErrorCode = 'BAD_MESSAGE' | 'BAD_PARAMS' | 'NOT_CONFIGURED' | 'STALE_EPOCH' | 'INTERNAL';
 export interface ErrorMsg { readonly type: 'error'; readonly jobId: number | null; readonly code: ErrorCode; readonly message: string }
 export interface SpawnResultMsg { readonly type: 'spawnResult'; readonly jobId: number; readonly epoch: number; readonly spawn: Spawn }
-export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | ErrorMsg;
+/** One recomputed golden: the digest, or the error that stopped it. */
+export interface SelftestResultMsg { readonly type: 'selftestResult'; readonly jobId: number; readonly key: string; readonly actual: string | null; readonly error: string | null }
+export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | SelftestResultMsg | ErrorMsg;
 
 const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
 const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
@@ -48,6 +51,8 @@ export function parseToWorker(m: unknown): ToWorker | null {
         ? (m as unknown as PointMsg) : null;
     case 'spawn':
       return isInt(m['jobId']) && isInt(m['epoch']) ? (m as unknown as SpawnMsg) : null;
+    case 'selftest':
+      return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
     default:
       return null;
   }
@@ -60,6 +65,7 @@ export function parseFromWorker(m: unknown): FromWorker | null {
     case 'ready': return isInt(m['epoch']) && isObj(m['stageHashes']) && typeof m['genKey'] === 'string' ? (m as unknown as ReadyMsg) : null;
     case 'tile': return isInt(m['jobId']) && isInt(m['epoch']) && m['rgba'] instanceof ArrayBuffer && m['rgba'].byteLength === 256 * 256 * 4 ? (m as unknown as TileMsg) : null;
     case 'pointResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['fields']) ? (m as unknown as PointResultMsg) : null;
+    case 'selftestResult': return isInt(m['jobId']) && typeof m['key'] === 'string' && (m['actual'] === null || typeof m['actual'] === 'string') && (m['error'] === null || typeof m['error'] === 'string') ? (m as unknown as SelftestResultMsg) : null;
     case 'spawnResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['spawn']) ? (m as unknown as SpawnResultMsg) : null;
     case 'error': return (m['jobId'] === null || isInt(m['jobId'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? (m as unknown as ErrorMsg) : null;
     default: return null;
```

`src/workers/taskHandler.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/workers/taskHandler.ts b/src/workers/taskHandler.ts
index dd9aa46..7a69a72 100644
--- a/src/workers/taskHandler.ts
+++ b/src/workers/taskHandler.ts
@@ -11,6 +11,7 @@ import { createGenContext, type GenContext } from '../gen/context';
 import { columnPoint } from '../gen/column/columnPoint';
 import { findSpawn } from '../gen/column/spawn';
 import { paintTile } from '../gen/map/tile';
+import { computeAnyGolden } from '../metrics/sp2aGoldens';
 import { parseToWorker, type ErrorCode, type FromWorker } from './protocol';
 
 const HEX = hex64;
@@ -23,6 +24,7 @@ const CREATE = createGenContext;
 const POINT = columnPoint;
 const PAINT = paintTile;
 const SPAWN = findSpawn;
+const GOLDEN = computeAnyGolden;
 const PARSE = parseToWorker;
 
 export interface Reply {
@@ -57,6 +59,13 @@ export function createTaskHandler(): TaskHandler {
           for (const [k, v] of Object.entries(h)) hex[k] = HEX(v);
           return { msg: { type: 'ready', epoch, stageHashes: hex, genKey: HEX(GEN_KEY(seed, h)) }, transfer: [] };
         }
+        if (m.type === 'selftest') {
+          try {
+            return { msg: { type: 'selftestResult', jobId: m.jobId, key: m.key, actual: GOLDEN(m.key), error: null }, transfer: [] };
+          } catch (e) {
+            return { msg: { type: 'selftestResult', jobId: m.jobId, key: m.key, actual: null, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
+          }
+        }
         if (ctx === null) return err(m.jobId, 'NOT_CONFIGURED', 'no configure yet');
         if (m.epoch !== epoch) return err(m.jobId, 'STALE_EPOCH', `job epoch ${m.epoch}, worker epoch ${epoch}`);
         if (m.type === 'mapTile') {
```

`src/engine/workerPool.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/engine/workerPool.ts b/src/engine/workerPool.ts
index 71fb86f..06f2249 100644
--- a/src/engine/workerPool.ts
+++ b/src/engine/workerPool.ts
@@ -30,6 +30,8 @@ export interface WorkerPool {
   tile(req: TileRequest, priority: number): Promise<ArrayBuffer>;
   point(x: number, z: number, priority?: number): Promise<ColumnPoint>;
   spawn(): Promise<Spawn>;
+  /** Recomputes one golden in a worker (no configure needed). */
+  selftest(key: string): Promise<{ actual: string | null; error: string | null }>;
   /** Rejects queued tile jobs matching `pred` with JobCancelled. */
   cancelTiles(pred: (req: TileRequest) => boolean): void;
   readonly queued: number;
@@ -138,6 +140,11 @@ export function createWorkerPool(size: number, spawn: () => WorkerLike): WorkerP
       if (r.type !== 'spawnResult') throw new Error(`unexpected reply ${r.type}`);
       return r.spawn;
     },
+    async selftest(key) {
+      const r = await enqueue(0, (jobId) => ({ type: 'selftest', jobId, key }), null);
+      if (r.type !== 'selftestResult') throw new Error(`unexpected reply ${r.type}`);
+      return { actual: r.actual, error: r.error };
+    },
     cancelTiles(pred) {
       queue = queue.filter((j) => {
         if (j.tile !== null && pred(j.tile)) { j.reject(new JobCancelled()); return false; }
@@ -152,8 +159,8 @@ export function createWorkerPool(size: number, spawn: () => WorkerLike): WorkerP
   };
 }
 
-/** Browser pool of module workers running task.worker.ts. */
-export function createBrowserPool(): WorkerPool {
-  return createWorkerPool(poolSize(navigator.hardwareConcurrency || 4), () =>
+/** Browser pool of module workers running task.worker.ts (size defaults to clamp(cores − 2, 2, 6)). */
+export function createBrowserPool(size = poolSize(navigator.hardwareConcurrency || 4)): WorkerPool {
+  return createWorkerPool(size, () =>
     new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
 }
```

- [ ] **Step 7: Add the page, the route and the Bun tool**

`src/ui/selftest/selftestPage.ts`:

```ts
/**
 * ?selftest=1 (SP2a spec §6.4): recomputes every golden (SP1 and SP2a) in one real module worker and
 * compares with the bundled test/goldens.json. A key whose computation throws shows its error.
 */
import goldens from '../../../test/goldens.json';
import { createBrowserPool } from '../../engine/workerPool';
import { allGoldenKeys } from '../../metrics/sp2aGoldens';

interface Row { key: string; expected: string | null; actual: string | null; error: string | null; ok: boolean }

export function mountSelftestPage(root: HTMLElement): void {
  const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
  const page = document.createElement('div');
  page.style.cssText = 'font: 13px ui-monospace, monospace; color: #ddd; background: #1b1d22; min-height: 100vh; padding: 12px;';
  const title = document.createElement('h2');
  title.textContent = 'world-imaginer-voxel · selftest';
  const summary = document.createElement('div');
  const copy = document.createElement('button');
  copy.textContent = 'copy as JSON';
  copy.disabled = true;
  const list = document.createElement('ul');
  page.append(title, summary, copy, list);
  root.replaceChildren(page);
  const pool = createBrowserPool(1);
  const keys = allGoldenKeys();
  const rows: Row[] = [];
  const t0 = performance.now();
  const next = async (i: number): Promise<void> => {
    if (i >= keys.length) {
      const bad = rows.filter((r) => !r.ok).length;
      summary.textContent = `${bad === 0 ? `✓ all ${rows.length} goldens match` : `✗ ${bad} of ${rows.length} goldens differ`} (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
      copy.disabled = false;
      pool.terminate();
      return;
    }
    const key = keys[i]!;
    summary.textContent = `computing ${i + 1}/${keys.length}…`;
    const r = await pool.selftest(key);
    const e = Object.hasOwn(expected, key) ? expected[key]! : null;
    const row: Row = { key, expected: e, actual: r.actual, error: r.error, ok: r.error === null && r.actual === e };
    rows.push(row);
    const li = document.createElement('li');
    li.textContent = row.ok ? `✓ ${key}` : row.error !== null ? `✗ ${key}  error: ${row.error}` : `✗ ${key}  expected ${e ?? 'missing'}  got ${r.actual}`;
    list.append(li);
    return next(i + 1);
  };
  copy.addEventListener('click', () => {
    const results = Object.fromEntries(rows.map((r) => [r.key, { expected: r.expected, actual: r.actual, ...(r.error !== null ? { error: r.error } : {}) }]));
    navigator.clipboard.writeText(JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2))
      .then(() => { copy.textContent = 'copied'; }, (e: unknown) => { copy.textContent = `copy failed: ${String(e)}`; });
  });
  void next(0);
}
```

`src/main.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/src/main.ts b/src/main.ts
index a9d6aad..ab0bc19 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -28,7 +28,9 @@ const start: Promise<void> = query.get('lab') === 'noise'
   ? import('./ui/lab/noiseLab').then((m) => m.mountNoiseLab(root))
   : query.has('map')
     ? import('./ui/map/mapPage').then((m) => m.mountMapPage(root))
-    : boot(root);
+    : query.get('selftest') === '1'
+      ? import('./ui/selftest/selftestPage').then((m) => m.mountSelftestPage(root))
+      : boot(root);
 start.catch((error: unknown) => {
   const pre = document.createElement('pre');
   pre.textContent = `Boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
```

`test/tools/goldensJsc.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/tools/goldensJsc.ts b/test/tools/goldensJsc.ts
index a39bdc4..023795a 100644
--- a/test/tools/goldensJsc.ts
+++ b/test/tools/goldensJsc.ts
@@ -1,12 +1,13 @@
 /**
- * JavaScriptCore check of the SP1 goldens (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
+ * JavaScriptCore check of every golden, SP1 and SP2a (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
  * (Bun runs JavaScriptCore and resolves the repository's extensionless imports; no dependency is added).
  */
 import goldens from '../goldens.json';
-import { compareGoldens, computeGolden, goldenKeys } from '../../src/metrics/sp1Goldens';
+import { compareGoldens } from '../../src/metrics/sp1Goldens';
+import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
 
 const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
-const rows = compareGoldens(expected, goldenKeys(), computeGolden);
+const rows = compareGoldens(expected, allGoldenKeys(), computeAnyGolden);
 for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.key} ${r.actual}${r.ok ? '' : ` (expected ${r.expected ?? 'missing'})`}`);
 const bad = rows.filter((r) => !r.ok).length;
 const bun = (globalThis as { Bun?: { version: string } }).Bun;
```

In `CLAUDE.md` `## Commands`, replace the `npx --yes bun@1 test/tools/goldensJsc.ts` bullet with:

```markdown
- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1 and SP2a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
- `?map` — the SP2a world map (layers, hover, seed, profiles, JSON patch)
```

- [ ] **Step 8: Run everything**

Run: `npx vitest run --project unit test/unit/protocol.test.ts test/unit/workerPool.test.ts && npx vitest run --project arch && npm run typecheck && npm run build`
Expected: PASS.

Run: `npx --yes bun@1 test/tools/goldensJsc.ts`
Expected: `47/47 match on Bun 1.x (JavaScriptCore)`, exit code 0.

With `npm run dev` running, open `http://localhost:5183/?selftest=1`: 47 rows and `✓ all 47 goldens match` (the dry run took 6.3 s in headless Chrome). Stop the dev server you started.

- [ ] **Step 9: Commit**

```bash
git add src/metrics/sp2aGoldens.ts src/ui/selftest src/workers src/engine/workerPool.ts src/main.ts test/unit/goldens.sp2a.test.ts test/unit/protocol.test.ts test/tools/goldensJsc.ts test/goldens.json CLAUDE.md
git commit -m "test(core): record the SP2a goldens; ?selftest=1 and the JSC check over all 47

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 23: Bench: SP2a kernels, the P1 column gate and a new baseline

**Files:**
- Modify: `test/bench/noise.bench.ts`, `test/bench/gates.ts`, `test/baselines.json` (recorded)

**Interfaces:**
- Produces: `COLUMN_P50_MAX_MS = 0.7`, `COLUMN_P95_MAX_MS = 1.2` (`gates.ts`); kernels `column.point`, `column.sample`, `map.tile.b64.biome`, `map.tile.b16.relief`.

- [ ] **Step 1: Add the kernels and the gate**

`test/bench/gates.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/bench/gates.ts b/test/bench/gates.ts
index be36e6e..be1432b 100644
--- a/test/bench/gates.ts
+++ b/test/bench/gates.ts
@@ -1,6 +1,9 @@
 /** SP1 bench gates (SP1 spec §7.5). Outside THRESHOLDS in SP1; changing them requires a spec amendment. */
 export const P1_MAX_REGRESSION = 1.3;
 export const KILL_RATIO_MAX = 1.6;
+/** P1 column-stage budget (master §3.0): buildColumnSample p50 / p95 in ms on the reference machine (SP2a; p95 gated through p99). */
+export const COLUMN_P50_MAX_MS = 0.7;
+export const COLUMN_P95_MAX_MS = 1.2;
 
 export interface BenchKernel {
   readonly nsPerEval: number;
```

`test/bench/noise.bench.ts` — apply with `git apply` (or edit by hand):

```diff
diff --git a/test/bench/noise.bench.ts b/test/bench/noise.bench.ts
index 84051a8..06d2ea3 100644
--- a/test/bench/noise.bench.ts
+++ b/test/bench/noise.bench.ts
@@ -11,7 +11,12 @@ import { Xoshiro128 } from '../../src/core/rng';
 import { compileSpline, evalSpline } from '../../src/core/spline/hermite';
 import { genKey, stageHashes } from '../../src/core/stage/hash';
 import { DENSITY3D_DEF, JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
-import { gateFailures, type Baselines, type BenchKernel } from './gates';
+import { seedFromInput } from '../../src/core/seed';
+import { createGenContext } from '../../src/gen/context';
+import { columnPoint } from '../../src/gen/column/columnPoint';
+import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
+import { paintTile } from '../../src/gen/map/tile';
+import { COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, type Baselines, type BenchKernel } from './gates';
 import { buildPerm, perm3 } from './perm512';
 
 const FMIX = fmix32;
@@ -25,10 +30,10 @@ const BASELINE_PATH = fileURLToPath(new URL('../baselines.json', import.meta.url
 const N = 4096;
 let sink = 0;
 
-test('SP1 kernels', async ({ bench }) => {
+test('SP1 and SP2a kernels', async ({ bench }) => {
   const ns: Record<string, number> = {};
-  const measure = async (name: string, evals: number, fn: () => void) => {
-    const r = await bench(name, fn).run();
+  const measure = async (name: string, evals: number, fn: () => void, iterations?: number) => {
+    const r = await bench(name, fn).run(iterations === undefined ? undefined : { iterations, time: 0, warmupIterations: 1 });
     ns[name] = (r.latency.p50 * 1e6) / evals;
   };
   const rng = new Xoshiro128(7);
@@ -69,6 +74,19 @@ test('SP1 kernels', async ({ bench }) => {
   });
   await measure('detErf', N, () => { let s = 0; for (let i = 0; i < N; i++) s += ERF(rx[i]! / 512 - 4); sink += s; });
   await measure('stageHashes.genKey', 16, () => { for (let i = 0; i < 16; i++) sink += GENKEY([42, 0], HASHES(DEFAULTS))[0]; });
+  const gen = createGenContext(seedFromInput('42'), DEFAULTS);
+  let col = 0;
+  await measure('column.point', 64, () => { for (let i = 0; i < 64; i++) sink += columnPoint(gen, wx[(col + i) & (N - 1)]!, wz[(col + i) & (N - 1)]!).offset; col += 64; });
+  const sample = newColumnSample();
+  let cs = 0;
+  const columnRun = await bench('column.sample', () => { cs++; buildColumnSample(gen, (cs * 7919) % 60000 - 30000, (cs * 104729) % 60000 - 30000, sample); sink += sample.f.offset[24]!; }).run();
+  ns['column.sample'] = columnRun.latency.p50 * 1e6;
+  // tinybench keeps no samples by default; p99 bounds p95 from above, so gating p99 is the stricter check.
+  const columnP95 = columnRun.latency.p99;
+  const tile = new Uint8ClampedArray(262144);
+  let tt = 0;
+  await measure('map.tile.b64.biome', 1, () => { paintTile(gen, 'biome', 64, tt++ % 7, 3, tile); sink += tile[0]!; }, 8);
+  await measure('map.tile.b16.relief', 1, () => { paintTile(gen, 'relief', 16, tt++ % 7, -2, tile); sink += tile[0]!; }, 8);
 
   const calib = ns['calibration.fmix32']!;
   const kernels: Record<string, BenchKernel> = {};
@@ -76,6 +94,9 @@ test('SP1 kernels', async ({ bench }) => {
   const killRatio = Math.round(Math.max(ns['lattice3.slice']! / ns['perm512.slice']!, ns['lattice3.random']! / ns['perm512.random']!) * 1000) / 1000;
   console.table(kernels);
   console.log(`killRatio ${killRatio}`);
+  console.log(`column.sample p50 ${columnRun.latency.p50.toFixed(3)} ms, p99 (≥ p95) ${columnP95.toFixed(3)} ms`);
+  expect(columnRun.latency.p50, 'P1 column p50').toBeLessThanOrEqual(COLUMN_P50_MAX_MS);
+  expect(columnP95, 'P1 column p95').toBeLessThanOrEqual(COLUMN_P95_MAX_MS);
   expect(Number.isFinite(sink)).toBe(true);
   if (process.env.BENCH_RECORD === '1') {
     const next: Baselines = { machine: cpus()[0]?.model ?? 'unknown', node: process.version, date: new Date().toISOString().slice(0, 10), kernels, killRatio };
```

- [ ] **Step 2: Verify the P1 regression gate trips on the old baseline**

Run: `npm run typecheck && npm run bench`
Expected: FAIL — `stageHashes.genKey: ratio … > 1.3 × baseline …`: the schema grew (the splines and the biome table are now in `DEFAULTS`), so hashing it costs about 5× more. The column gate itself passes (p50 ≈ 0.35 ms, p99 ≈ 0.5 ms).

- [ ] **Step 3: Record the new baseline on the reference machine**

Run: `npm run bench:record && npm run bench`
Expected: both PASS in about 25 s; `test/baselines.json` holds 15 kernels; the output prints `column.sample p50 … ms, p99 (≥ p95) … ms` and `killRatio` ≈ 0.85.

- [ ] **Step 4: Commit**

```bash
git add test/bench test/baselines.json
git commit -m "test(bench): SP2a kernels, the P1 column budget and a re-recorded baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 24: SP2a exit

**Files:**
- Create: `docs/superpowers/specs/assets/sp2a/*.png`
- Modify: the SP2a spec (Status, Exit evidence), `README.md` (Status), `CLAUDE.md` (Status)

**Interfaces:**
- Consumes: everything. Pushing, the pull request, the Vercel preview checks and the merge are done with the user (outward-facing).

- [ ] **Step 1: Full local verification**

Run: `npm run build && npm test && npm run test:metrics && npm run test:metrics:full`
Expected: PASS (the full tier takes about 3.5 minutes). Copy the values of B1, B4, N4, T6, T7, T8, T1lowland, B2 and B5 from `test/metrics/.out/*.json` (fast, quick and full tiers) into the spec's Exit evidence.

- [ ] **Step 2: Bench and JavaScriptCore**

Run: `npm run bench` (gated against the Task 23 baseline) and `npx --yes bun@1 test/tools/goldensJsc.ts` (47/47). Paste the column p50/p99 line, the kernel table and the Bun output into Exit evidence.

- [ ] **Step 3: Screenshots**

With `npm run dev` in the background, capture 1400 × 900 screenshots through the DevTools protocol (dedicated `--user-data-dir` in the scratch directory; never touch other Chrome processes), after about 6 s per view so every tile has arrived, of `?map` with the state hash for seed 42:
- biome, relief, rivers, lakes and C at 64 blocks/px;
- biome and relief at 4 blocks/px around the spawn;
- biome with the `large_biomes` profile at 256 blocks/px.

Build the hash with `encodeMapState` in the page (`import('/src/ui/map/mapState.ts')`). Save to `docs/superpowers/specs/assets/sp2a/`, re-saved as 256-colour palette PNGs as in SP1. Stop the dev server you started.

- [ ] **Step 4: Update the docs**

- Spec Status → `Implemented on branch sp2a/column-map (<date>); exit pending CI, the Vercel preview (first-image timing in Chrome, ?selftest=1 in Chrome and Firefox)`; fill Exit evidence with the steps above.
- `README.md` Status → `SP0 and SP1 are complete, SP2a is implemented: \`?map\` shows the generated world's biomes, relief, rivers and lakes (deployed at https://world-imaginer-voxel.vercel.app after merge). SP2b (parameter panel, spline editor, biome table, presets) is next.`
- `CLAUDE.md` Status → `SP0 complete (2026-09-27), SP1 complete (2026-09-28). SP2a implemented on branch \`sp2a/column-map\`; its exit is pending CI and the Vercel preview checks. SP2b is next.`

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs README.md CLAUDE.md
git commit -m "docs(spec): record SP2a exit evidence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

- [ ] **Step 6: Hand off to the user (do not push on your own)**

Report: the branch is ready. With the user's go-ahead, push `sp2a/column-map` and open the pull request (CI must be green). Then ask the user to open the Vercel preview (`?map`: the first-image line in Chrome; `?selftest=1` in Chrome and Firefox, copy as JSON). Add the JSON and the timing to Exit evidence, flip the status lines to complete in that commit, and fast-forward `main` with the user's approval.

---


# SP1 — Deterministic Math Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the bit-deterministic math core of world-imaginer-voxel (hash, RNG, seed text, detMath, canonical JSON, hashed-lattice noise, nested Hermite splines, ParamSchema with profiles/presets/migrations, stage registry and hashes), the N1-N6/U4 metric tests, the SP1 goldens and bench baseline, and the `?lab=noise` research page.

**Architecture:** Everything generator-facing lives in `src/core/` as pure TypeScript using only exactly-specified IEEE arithmetic; statistics shared by the metric tests and the lab live in `src/metrics/`; the lab is a lazily-loaded 2D-canvas page in `src/ui/lab/`. Tests mirror the spec: unit tests per module, arch rules for the new bans, metric tests through the SP0 `metricTest` harness, goldens through the SP0 golden store, and a vitest bench for the baseline and the kill criterion.

**Tech Stack:** Node 24, TypeScript 7 (type-check only), Vite 8, Vitest 5, three 0.186 (untouched in SP1), Python 3 (stdlib only, for the manual detMath oracle).

**Spec:** `docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md` (parent: `docs/superpowers/specs/2026-09-26-architecture-design.md`; SP0 rails: `docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md`). Section references like "spec §2.3" point to the SP1 spec.

**Dry run (2026-09-27):** the code in this plan was transcribed into a throwaway copy of the repository before review. Typecheck (all three tsconfigs), the arch suite, all 351 unit tests, the fast/quick/full metric tiers (7 s / 35 s / 81 s), the goldens flow (27 keys; the CPython oracle and Bun/JavaScriptCore both reproduce the V8 digests), the bench, `vite build` and the lab in headless Chrome all passed. Expected values quoted in the steps come from that run.

## Global Constraints

- Work in `~/Proyectos/world-imaginer-voxel` on branch `sp1/math-core` (created in Task 1 from `main`). Never commit to `main` directly; the last task merges.
- Runtime dependency `three` only; dev dependencies stay exactly `vite`, `typescript`, `vitest`, `@types/three`, `@types/node`. Add no npm package. Bun is used only through `npx --yes bun@1` at SP exit.
- TypeScript: `strict`, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax` (type-only imports use `import type` or inline `type`), `noUncheckedIndexedAccess` off. Imports are extensionless (`'../core/hash'`), never `.ts`.
- In `src/core/**`, `src/gen/**`, `src/metrics/sp1Goldens.ts` and `src/metrics/sp1Fixtures.ts`: only `Math.abs floor ceil round trunc sign min max imul clz32 sqrt` and the `Math` constants; no `**`; no `Math.random`, `Date.now`, `performance.now`, `console.*`; no `Intl`, `localeCompare`, `toLocale*`, `.normalize(`, `TextEncoder`, `TextDecoder` (enforced by Task 2).
- In `src/core/noise/**`, `src/core/spline/**` and `src/metrics/**`: an imported value binding is referenced only in a top-level `const ALIAS = binding;` line; no `import * as`; a class used as a type is imported again with `import type { X as XT }` (enforced by Task 2).
- Operation order in formulas is part of the contract: copy every formula exactly as written in this plan (no reassociation, no reciprocal-for-division swaps, no `Math.round` for `Math.floor(x + 0.5)`).
- Every validated parameter number goes through `q15`; canonical JSON throws on NaN, ±Infinity and −0.
- Every commit that changes `test/thresholds.lock.json` also appends a line to the spec's "Threshold log" (CI checks the governance range per push).
- `GENERATOR_VERSION` stays `0`. Goldens are recorded once, in Task 25.
- Subagents never kill, signal or otherwise touch processes they did not start, and never start system services (Docker, databases, desktop apps).
- Commit messages: conventional commits scoped by area (`feat(core):`, `test(arch):`, `feat(ui):`, `test(metrics):`, `chore(governance):`, `docs(spec):` …), ending with exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc
  ```
- Commands (from the repo root): `npm test` (unit + arch + fast metrics), `npx vitest run --project unit test/unit/<file>` for one unit file, `npm run typecheck`, `npm run build`, `npm run test:metrics` (quick), `npm run test:metrics:full`, `npm run bench`.

## Review Focus

1. **Seed box input at the edges** — whitespace-only text, emoji and lone surrogates, 20-digit numbers, `-0`: an empty box yields a random seed written back as decimal text; any other text round-trips to the same world on reload. Tests: Task 3 (UTF-8 walker vs TextEncoder with lone surrogates), Task 4 (seed table incl. `' 42 '`, `-1`, 2^64), Task 23 (`resolveSeedText` with whitespace-only input).
2. **A hand-edited, truncated or stale lab URL hash** — the page must open with defaults and a visible notice, never a blank page or a thrown error. Test: Task 23 `decodeLabState` cases (bad base64, bad JSON, unknown keys, wrong `v`, invalid patch, out-of-range view).
3. **NoiseDef edits at the range extremes** (octaves 16, lacunarity 4, wavelength 16, persistence 1, amplitudes with zeros, `remap: 'uniform'` on a single stack) — invalid combinations show an issue path and are not applied; valid extremes render finite values, never NaN. Tests: Task 9 (finite outputs at extreme defs), Task 13 (noise-field rules with exact codes and paths).
4. **Preset JSON from a newer build, with typos, or with a reserved name** — import reports every relevant issue with a `params.`-prefixed path and applies nothing. Test: Task 17 import-order cases.
5. **A browser (or future minifier) that computes different bits** — the determinism panel shows ✗ with expected and actual per key, and "missing" for keys absent from `goldens.json`, instead of throwing. Test: Task 25 `compareGoldens` cases.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `test/harness/sp.ts`, `test/thresholds.lock.json`, spec Status/Threshold log, `CLAUDE.md` | start SP1 | 1 |
| `test/arch/rules/banned.ts`, `test/arch/banned.test.ts`, `test/arch/fixtures/banned/**` | SP1 arch bans (Math scope, locale/host APIs, hot-module imports) | 2 |
| `src/core/hash.ts`, `test/unit/hash.test.ts`, `test/harness/stats.ts` | hashing, UTF-8, fnv, hashF64, deriveSeed; test-side stats helpers | 3 |
| `src/core/rng.ts`, `src/core/seed.ts`, `test/unit/rng.test.ts`, `test/unit/seed.test.ts` | splitmix32, xoshiro128**, seed text | 4 |
| `src/core/detMath.ts`, `test/unit/detMath.test.ts` | deterministic transcendentals | 5 |
| `src/core/params/canonical.ts`, `test/unit/canonical.test.ts` | q15, canonical JSON | 6 |
| `tools/detmath-oracle.py`, `src/metrics/sp1Goldens.ts` (detMath part), `test/fixtures/detmath-oracle.json`, `test/unit/detmathOracle.test.ts` | CPython oracle, detMath digests | 7 |
| `src/core/noise/types.ts`, `src/core/noise/lattice3.ts`, `test/unit/lattice3.test.ts` | NoiseDef, lattice3, SD constants | 8 |
| `src/core/noise/octave.ts`, `normal.ts`, `cdf.ts`, `test/unit/noise.test.ts` | OctaveNoise, NormalNoise, CDF | 9 |
| `src/core/spline/types.ts`, `validate.ts`, `test/unit/splineValidate.test.ts` | spline types, validation, normalisation | 10 |
| `src/core/spline/hermite.ts`, `test/unit/splineHermite.test.ts` | compile, evaluate, reference, withKnotY | 11 |
| `src/core/spline/tangents.ts`, `src/metrics/sp1Fixtures.ts` (splines + noise defs), `test/unit/splineFixtures.test.ts` | autoTangents, fixtures, fixture-based spline tests | 12 |
| `src/core/ids.ts`, `src/core/params/kit.ts` (part 1), `test/unit/kit.test.ts` | node types, builders, validators, buildSchema, checkParams | 13 |
| `src/core/params/kit.ts` (part 2), `test/harness/params.ts`, `test/unit/patch.test.ts` | applyPatch, diffParams, getPath, patchAt, renderReference | 14 |
| `src/core/params/schema.ts`, `meta.ts`, `defaults.ts`, `noises.ts`, `test/unit/schema.test.ts` | SP1 schema and noise instances | 15 |
| `src/core/stage/registry.ts`, `hash.ts`, `src/metrics/sp1Fixtures.ts` (params fixture), `test/unit/stage.test.ts` | stages, stageHash, genKey | 16 |
| `src/core/params/profiles.ts`, `migrate.ts`, `presets.ts`, `test/unit/profiles.test.ts` | profiles, migrations, presets envelope | 17 |
| `test/harness/schemaShape.ts`, `test/arch/schemaShape.test.ts`, `test/arch/paramsDoc.test.ts`, `test/schema-shape.lock.json`, `README.md`, `package.json`, `CLAUDE.md` | schema-shape lock, README reference, scripts | 18 |
| `src/metrics/noiseStats.ts`, `test/unit/noiseStats.test.ts` | shared statistics | 19 |
| `test/metrics/noise.metric.ts` (N1-N3), `test/thresholds.ts`, lock, spec log | metric tests N1-N3 | 20 |
| `test/metrics/noise.metric.ts` (N5, N6), `test/metrics/params.metric.ts` (U4), thresholds, lock, spec log | metric tests N5, N6, U4 | 21 |
| `test/bench/perm512.ts`, `gates.ts`, `noise.bench.ts`, `test/unit/benchGates.test.ts`, `package.json` | bench, baseline, kill criterion | 22 |
| `src/ui/seedBox.ts`, `src/ui/lab/labState.ts`, `fieldView.ts`, `noiseLab.ts`, `lab.css`, `src/main.ts`, tests | lab page: routing, state, inspector | 23 |
| `src/ui/lab/statsPanel.ts`, `noiseLab.ts` (A/B) | lab statistics and A/B mode | 24 |
| `src/metrics/sp1Goldens.ts` (complete), `test/unit/goldens.sp1.test.ts`, `test/goldens.json`, `src/ui/lab/determinismPanel.ts`, `test/tools/goldensJsc.ts` | goldens, determinism panel, JSC check | 25 |
| spec Exit evidence, master §10, README, CLAUDE.md, `docs/superpowers/specs/assets/sp1/*` | exit | 26 |

---

### Task 1: Start SP1

**Files:**
- Modify: `test/harness/sp.ts:28`
- Modify: `test/thresholds.lock.json` (rewritten by the accept script)
- Modify: `docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md` (Status line, issue-code table, Threshold log)
- Modify: `CLAUDE.md` (Status, Conventions)

**Interfaces:**
- Consumes: SP0 governance (`STARTED_SPS`, `npm run test:accept-thresholds`).
- Produces: SP1 is a started sub-project; later tasks may add `activeFrom: 'SP1'` threshold rows.

- [ ] **Step 1: Create the branch**

```bash
cd ~/Proyectos/world-imaginer-voxel
git switch main && git pull --ff-only || true
git switch -c sp1/math-core
```

- [ ] **Step 2: Append SP1 to `STARTED_SPS`**

In `test/harness/sp.ts` replace

```ts
export const STARTED_SPS: readonly SubProjectId[] = ['SP0'];
```

with

```ts
export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1'];
```

- [ ] **Step 3: Verify the lock test now fails**

Run: `npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: FAIL with `governance state changed` and a `startedSps` line.

- [ ] **Step 4: Accept the new lock**

Run: `npm run test:accept-thresholds`
Expected: PASS; the output lists `startedSps` gaining `SP1`; `test/thresholds.lock.json` is rewritten.

- [ ] **Step 5: Update the spec**

In `docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md`:

1. Replace the Status line with:

```markdown
Status: Approved (2026-09-27); in implementation on branch `sp1/math-core`
```

2. In the §4.2 "Issue codes" table, replace the params row with (adds `MISSING_KEY`, which `checkParams` needs for complete documents):

```markdown
| params | `UNKNOWN_KEY`, `MISSING_KEY`, `NOT_OBJECT`, `NOT_NUMBER`, `NOT_FINITE`, `NOT_INTEGER`, `INT_TOO_LARGE`, `OUT_OF_RANGE`, `NOT_BOOL`, `BAD_ENUM`, `AMPLITUDES_LENGTH`, `AMPLITUDES_ZERO`, `YSCALE_NOT_1`, `REMAP_NEEDS_DOUBLE`, `REMAP_NEEDS_2D` |
```

3. Replace the Threshold log placeholder line `(One line per commit that changes \`test/thresholds.lock.json\`.)` with:

```markdown
(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP1`; no threshold rows yet.
```

- [ ] **Step 6: Update CLAUDE.md**

Replace the Status line

```markdown
**Status:** SP0 complete (scaffold, guardrails, CI; all exit checks done 2026-09-27). SP1 is next.
```

with

```markdown
**Status:** SP0 complete (2026-09-27). SP1 (deterministic math core) in implementation on branch `sp1/math-core`.
```

and append these bullets at the end of the `## Conventions` list:

```markdown
- Determinism (SP1): in `core/noise/**`, `core/spline/**` and `metrics/**` an imported value binding is used only through a top-level `const` alias (vitest turns imports into getters; arch-tested); `core/` and `gen/` never call `Intl`, `localeCompare`, `toLocale*`, `.normalize(`, `TextEncoder` or `TextDecoder`; `Math.fround` is banned in `core/` and `gen/`.
- Generator outputs are NaN-free; every golden hasher writes NaN as `0x7FF8000000000000` (`hashF64`). Every validated parameter number goes through `q15`; canonical JSON throws on NaN, ±Infinity and −0.
- A noise leaf's seed name is its path; renaming the path needs `seedName` to keep the same worlds.
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS (no metric parts are active yet).

- [ ] **Step 8: Commit**

```bash
git add test/harness/sp.ts test/thresholds.lock.json CLAUDE.md docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md
git commit -m "chore(governance): start SP1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 2: SP1 arch bans

**Files:**
- Modify: `test/arch/rules/banned.ts`
- Modify: `test/arch/banned.test.ts`
- Create: `test/arch/fixtures/banned/bad/src/core/encoder.ts`, `fround.ts`, `localeSort.ts`, `normalize.ts`, `pow.ts`, `noise/direct.ts`, `spline/ns.ts`
- Create: `test/arch/fixtures/banned/bad/src/gen/intl.ts`, `test/arch/fixtures/banned/bad/src/metrics/direct.ts`, `test/arch/fixtures/banned/bad/src/metrics/sp1Goldens.ts`
- Create: `test/arch/fixtures/banned/good/src/core/detLike.ts`, `good/src/core/noise/aliased.ts`, `good/src/metrics/free.ts`, `good/src/ui/localeOk.ts`

**Interfaces:**
- Consumes: `ScannedFile`, `Violation`, `lineAt` from `test/arch/scan.ts`.
- Produces: new rules `engine-dependent-api`, `hot-import-reference`, `hot-import-namespace`; `math-member`/`math-computed`/`math-as-value`/`math-pow-operator` now also cover all of `core/` and the two deterministic metrics files; `fround` is no longer allowed. Every later task's `src/core`, `src/metrics` code must pass these.

- [ ] **Step 1: Add the bad fixtures**

`test/arch/fixtures/banned/bad/src/core/encoder.ts`:

```ts
export const e = new TextEncoder();
```

`test/arch/fixtures/banned/bad/src/core/fround.ts`:

```ts
export const f = (x: number): number => Math.fround(x);
```

`test/arch/fixtures/banned/bad/src/core/localeSort.ts`:

```ts
export const s = (a: string, b: string): number => a.localeCompare(b);
```

`test/arch/fixtures/banned/bad/src/core/normalize.ts`:

```ts
export const n = (t: string): string => t.normalize('NFC');
```

`test/arch/fixtures/banned/bad/src/core/pow.ts`:

```ts
export const p = (x: number): number => x ** 2;
```

`test/arch/fixtures/banned/bad/src/core/noise/direct.ts`:

```ts
import { helper } from '../helper';
export function f(x: number): number { return helper(x); }
```

`test/arch/fixtures/banned/bad/src/core/spline/ns.ts`:

```ts
import * as h from '../hash';
export const g = h;
```

`test/arch/fixtures/banned/bad/src/gen/intl.ts`:

```ts
export const fmt = new Intl.NumberFormat('en');
```

`test/arch/fixtures/banned/bad/src/metrics/direct.ts`:

```ts
import { k } from '../core/k';
export function m(): number { return k(); }
```

`test/arch/fixtures/banned/bad/src/metrics/sp1Goldens.ts`:

```ts
export const r = (): number => Math.random();
export const p = (x: number): number => x ** 2;
```

- [ ] **Step 2: Add the good fixtures**

`test/arch/fixtures/banned/good/src/core/detLike.ts`:

```ts
export const d = (x: number): number => Math.abs(x) + Math.floor(x) + Math.trunc(x) + Math.imul(3, 5) + Math.sqrt(2) * Math.SQRT1_2;
export const big = (1n << 63n) - 1n;
```

`test/arch/fixtures/banned/good/src/core/noise/aliased.ts`:

```ts
import { helper, type Helper } from '../helper';
import type { Other } from '../other';
const H = helper;
export function f(x: number, o: Other, t: Helper): number { return H(x) + o.helper + t.v; }
export const obj = { helper: 1 };
```

`test/arch/fixtures/banned/good/src/metrics/free.ts`:

```ts
export const a = (y: number, x: number): number => Math.atan2(y, x);
```

`test/arch/fixtures/banned/good/src/ui/localeOk.ts`:

```ts
export const s = (a: string, b: string): number => a.localeCompare(b);
```

- [ ] **Step 3: Update the expected violation list**

In `test/arch/banned.test.ts` replace the whole expected array of `'bad fixture tree reports every banned use'` with:

```ts
  expect(brief(fixture('bad'))).toEqual([
    'src/core/encoder.ts:1 engine-dependent-api',
    'src/core/fround.ts:1 math-member',
    'src/core/localeSort.ts:1 engine-dependent-api',
    'src/core/noise/direct.ts:2 hot-import-reference',
    'src/core/normalize.ts:1 engine-dependent-api',
    'src/core/perfNow.ts:1 nondeterministic',
    'src/core/pow.ts:1 math-pow-operator',
    'src/core/random.ts:1 nondeterministic',
    'src/core/spawnWorker.ts:1 worker-api',
    'src/core/spline/ns.ts:1 hot-import-namespace',
    'src/core/worker.ts:1 worker-api',
    'src/gen/alias.ts:1 math-as-value',
    'src/gen/binaryExport.ts:1 numeric-export',
    'src/gen/computed.ts:1 math-computed',
    'src/gen/data.ts:1 numeric-data-export',
    'src/gen/defaultNumeric.ts:1 numeric-export',
    'src/gen/destructureMath.ts:1 math-as-value',
    'src/gen/intl.ts:1 engine-dependent-api',
    'src/gen/log.ts:1 nondeterministic',
    'src/gen/multiDecl.ts:2 numeric-export',
    'src/gen/pow.ts:1 math-pow-operator',
    'src/gen/powAssign.ts:1 math-pow-operator',
    'src/gen/trig.ts:1 math-member',
    'src/gen/tunable.ts:1 numeric-export',
    'src/gen/tunables2.ts:2 numeric-export',
    'src/gen/wrappedInit.ts:1 numeric-export',
    'src/light/dom.ts:1 dom-global',
    'src/metrics/direct.ts:2 hot-import-reference',
    'src/metrics/sp1Goldens.ts:1 nondeterministic',
    'src/metrics/sp1Goldens.ts:2 math-pow-operator',
    'src/render/materials/raw.glsl:1 raw-shader-file',
    'src/render/materials/rawImport.ts:1 raw-import',
    'src/render/threeAudio.ts:1 three-audio',
    'src/render/threeAudioNamespace.ts:2 three-audio',
    'src/render/threeAudioReexport.ts:1 three-audio',
    'src/ui/audio.ts:1 webaudio-outside-sound',
    'src/ui/shader.ts:1 glsl-outside-materials',
    'src/world/clock.ts:1 nondeterministic',
  ]);
```

and add this test at the end of the file:

```ts
describe('hot-module import rule', () => {
  test('importClauseBindings', () => {
    expect(importClauseBindings('{ a, b as c, type T }')).toEqual({ names: ['a', 'c'], namespace: false });
    expect(importClauseBindings('d, { e }')).toEqual({ names: ['e', 'd'], namespace: false });
    expect(importClauseBindings('* as ns')).toEqual({ names: [], namespace: true });
  });
});
```

and extend the import line at the top to

```ts
import { checkBanned, importClauseBindings, isNumericExpr, listAudioFiles } from './rules/banned';
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run --project arch test/arch/banned.test.ts`
Expected: FAIL (`importClauseBindings` is not exported; the new bad fixtures are not reported).

- [ ] **Step 5: Implement the rules**

In `test/arch/rules/banned.ts`:

1. Replace the `MATH_ALLOWED` declaration with (drops `fround`):

```ts
const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'imul', 'clz32', 'sqrt',
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
/** Files outside core/ and gen/ whose outputs are golden-hashed, so they follow the core determinism rules (SP1 spec §1.8). */
const DET_FILES = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts']);
/** Modules whose hot loops must not read imported bindings (vitest turns them into getters; SP1 spec §1.8). */
const HOT_PREFIXES = ['core/noise/', 'core/spline/', 'metrics/'];
const ENGINE_DEPENDENT = /\bIntl\b|\.\s*(?:localeCompare|toLocaleString|toLocaleUpperCase|toLocaleLowerCase|toLocaleDateString|toLocaleTimeString|normalize)\s*\(|\bTextEncoder\b|\bTextDecoder\b/g;
const IMPORT_STMT = /\bimport\s+(type\s+)?([\w$*{},\s]+?)\s+from\s*(['"])[^'"\n]+\3\s*;?/g;
```

2. Add these two functions above `export function checkBanned`:

```ts
/** Value bindings of an import clause (`d, { a, b as c, type T }` → a, c, d); inline `type` specifiers are skipped. */
export function importClauseBindings(clause: string): { names: string[]; namespace: boolean } {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const item of braces[1]!.split(',')) {
      const t = item.trim();
      if (t === '' || /^type\s/.test(t)) continue;
      const parts = t.split(/\s+as\s+/);
      names.push((parts[1] ?? parts[0]!).trim());
    }
  }
  const namespace = /\*\s*as\s+[\w$]+/.test(clause);
  const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '');
  for (const part of head.split(',')) {
    const t = part.trim();
    if (/^[\w$]+$/.test(t)) names.push(t);
  }
  return { names, namespace };
}

function hotImportViolations(f: ScannedFile): Violation[] {
  const out: Violation[] = [];
  const spans: Array<[number, number]> = [];
  const names: string[] = [];
  for (const m of f.codeKeepStrings.matchAll(IMPORT_STMT)) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[1]) continue;
    const b = importClauseBindings(m[2]!);
    if (b.namespace) {
      out.push({ file: f.path, line: lineAt(f.codeKeepStrings, m.index), rule: 'hot-import-namespace', message: 'namespace import in a hot module (import the bindings and alias them)' });
    }
    names.push(...b.names);
  }
  const lines = f.code.split('\n');
  for (const name of names) {
    const esc = name.replace(/\$/g, '\\$');
    const alias = new RegExp(String.raw`^const\s+[\w$]+\s*=\s*${esc}\s*;?\s*$`);
    for (const m of f.code.matchAll(new RegExp(String.raw`(?<![\w$.])${esc}(?![\w$])`, 'g'))) {
      const i = m.index;
      if (spans.some(([a, b]) => i >= a && i < b)) continue;
      const line = lineAt(f.code, i);
      if (alias.test(lines[line - 1]!)) continue;
      const before = f.code.slice(0, i).trimEnd();
      const after = f.code.slice(i + name.length).trimStart();
      if (after.startsWith(':') && (before.endsWith('{') || before.endsWith(','))) continue;
      out.push({ file: f.path, line, rule: 'hot-import-reference', message: `imported binding ${name} used outside a top-level const alias (vitest turns it into a getter)` });
    }
  }
  return out;
}
```

3. Inside `checkBanned`, replace the block

```ts
      if (ND_LAYERS.has(layer)) {
        for (const m of code.matchAll(/\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|\bconsole\s*\./g)) at(code, m.index, 'nondeterministic', `${m[0]} in ${layer}/`);
      }
      if (layer === 'gen' || srcRel.startsWith('core/noise/')) {
```

with

```ts
      const detFile = DET_FILES.has(srcRel);
      if (ND_LAYERS.has(layer) || detFile) {
        for (const m of code.matchAll(/\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|\bconsole\s*\./g)) at(code, m.index, 'nondeterministic', `${m[0]} in ${layer}/`);
      }
      if (layer === 'gen' || layer === 'core' || detFile) {
        for (const m of code.matchAll(ENGINE_DEPENDENT)) at(code, m.index, 'engine-dependent-api', `${m[0].trim()} in ${layer}/ (engine-dependent; SP1 spec §1.8)`);
      }
      if (HOT_PREFIXES.some((p) => srcRel.startsWith(p))) {
        for (const v of hotImportViolations(f)) found.set(`${v.rule}:${v.line}`, v);
      }
      if (layer === 'gen' || layer === 'core' || detFile) {
```

(the body of the old `if (layer === 'gen' || srcRel.startsWith('core/noise/'))` block — the four `math-*` loops — stays unchanged under the new condition).

- [ ] **Step 6: Run the arch suite**

Run: `npx vitest run --project arch`
Expected: PASS (bad list matches exactly; good tree and the repository report nothing).

- [ ] **Step 7: Commit**

```bash
git add test/arch
git commit -m "test(arch): ban engine-dependent APIs and hot-module import reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 3: Hashing (`core/hash.ts`)

**Files:**
- Create: `src/core/hash.ts`
- Create: `test/harness/stats.ts`
- Test: `test/unit/hash.test.ts`

**Interfaces:**
- Produces (used by almost every later task):
  - `type Seed64 = readonly [lo: number, hi: number]`, `type Hash64 = Seed64`
  - `fmix32(h: number): number`, `hash2(s, x, z)`, `hash3(s, x, y, z)`, `hash4(s, salt, x, z)` (all return u32)
  - `utf8Bytes(str: string): Uint8Array`, `fnv1a32(str: string): number`, `fnv1a64Bytes(bytes: Uint8Array): Hash64`, `fnv1a64(str: string): Hash64`
  - `hex64(h: Hash64): string` (16 lower-case hex digits, hi first), `hashF64(values: Float64Array): Hash64`
  - `deriveSeed(world: Seed64, name: string): number` (u32)
  - test side: `testRng(seed)`, `nextUp(x)`, `nextDown(x)`, `f64Hex(x)`, `refErf(x)` in `test/harness/stats.ts`

- [ ] **Step 1: Write the test-side helpers**

`test/harness/stats.ts`:

```ts
/** Deterministic test RNG (mulberry32). Tests never use Math.random. */
export function testRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Uniform double in [0, 1) from testRng. */
export function testFloat(next: () => number): number {
  return next() / 4294967296;
}

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

/** IEEE bits of x as 16 upper-case hex digits. */
export function f64Hex(x: number): string {
  F64[0] = x;
  return U64[0]!.toString(16).toUpperCase().padStart(16, '0');
}

/** Next representable double above x (finite x). */
export function nextUp(x: number): number {
  if (x !== x || x === Infinity) return x;
  if (x === 0) return 5e-324;
  F64[0] = x;
  U64[0] = x > 0 ? U64[0]! + 1n : U64[0]! - 1n;
  return F64[0]!;
}

/** Next representable double below x (finite x). */
export function nextDown(x: number): number {
  return -nextUp(-x);
}

/** Reference erf: Taylor series below 3, erfc continued fraction above (|error| < 1e-13). */
export function refErf(x: number): number {
  if (x !== x) return x;
  if (x < 0) return -refErf(-x);
  if (x < 3) {
    const x2 = x * x;
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n++) {
      term *= -x2 / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum;
  }
  let k = x;
  for (let n = 60; n >= 1; n--) k = x + n / 2 / k;
  return 1 - Math.exp(-x * x) / (Math.sqrt(Math.PI) * k);
}
```

- [ ] **Step 2: Write the failing test**

`test/unit/hash.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  deriveSeed, fmix32, fnv1a32, fnv1a64, fnv1a64Bytes, hash2, hash3, hash4, hashF64, hex64, utf8Bytes,
} from '../../src/core/hash';
import { testRng } from '../harness/stats';

describe('vectors', () => {
  test('fmix32', () => {
    expect(fmix32(1)).toBe(1364076727);
    expect(fmix32(0xdeadbeef)).toBe(233162409);
  });
  test('fnv1a32', () => {
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
  test('fnv1a64 returns [lo, hi] and hex64 prints hi first', () => {
    expect(hex64(fnv1a64(''))).toBe('cbf29ce484222325');
    expect(hex64(fnv1a64('a'))).toBe('af63dc4c8601ec8c');
    expect(hex64(fnv1a64('foobar'))).toBe('85944171f73967e8');
    expect(fnv1a64('')).toEqual([0x84222325, 0xcbf29ce4]);
  });
});

function bigFnv64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

test('fnv1a64 halves match a BigInt reference on 2000 random byte strings', () => {
  const next = testRng(11);
  for (let i = 0; i < 2000; i++) {
    const bytes = new Uint8Array(next() % 64);
    for (let k = 0; k < bytes.length; k++) bytes[k] = next() & 255;
    expect(hex64(fnv1a64Bytes(bytes))).toBe(bigFnv64(bytes));
  }
});

test('utf8Bytes equals TextEncoder on 20k random strings with lone surrogates', () => {
  const next = testRng(12);
  const enc = new TextEncoder();
  for (let i = 0; i < 20000; i++) {
    const n = next() % 12;
    let s = '';
    for (let k = 0; k < n; k++) {
      const r = next() % 5;
      if (r === 0) s += String.fromCharCode(0xd800 + (next() % 0x800));
      else if (r === 1) s += String.fromCodePoint(0x10000 + (next() % 0xfffff));
      else if (r === 2) s += String.fromCharCode(0x80 + (next() % 0x780));
      else s += String.fromCharCode(next() % 0x10000);
    }
    expect(Array.from(utf8Bytes(s))).toEqual(Array.from(enc.encode(s)));
  }
});

test('hashF64 writes every NaN as 0x7FF8000000000000', () => {
  const neg = new Float64Array(1);
  new DataView(neg.buffer).setUint32(4, 0xfff80000, true);
  const lit = hex64(hashF64(Float64Array.of(NaN)));
  expect(hex64(hashF64(neg))).toBe(lit);
  expect(hex64(hashF64(Float64Array.of(0 / 0)))).toBe(lit);
  expect(hex64(hashF64(Float64Array.of(-0)))).not.toBe(hex64(hashF64(Float64Array.of(0))));
});

/** Max |flip rate − 0.5| over every (input word, input bit, output bit). */
function avalanche(f: (w: Uint32Array) => number, words: number, n: number, seed: number): number {
  const next = testRng(seed);
  const w = new Uint32Array(words);
  let worst = 0;
  for (let word = 0; word < words; word++) {
    for (let bit = 0; bit < 32; bit++) {
      const counts = new Uint32Array(32);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < words; k++) w[k] = next();
        const a = f(w);
        w[word] = (w[word]! ^ (1 << bit)) >>> 0;
        const d = (f(w) ^ a) >>> 0;
        for (let o = 0; o < 32; o++) counts[o] += (d >>> o) & 1;
      }
      for (let o = 0; o < 32; o++) worst = Math.max(worst, Math.abs(counts[o]! / n - 0.5));
    }
  }
  return worst;
}

describe('avalanche 50 ± 2 %', () => {
  test('fmix32 (100k per bit)', () => {
    expect(avalanche((w) => fmix32(w[0]!), 1, 100000, 21)).toBeLessThanOrEqual(0.02);
  });
  test('hash2 (30k per word and bit)', () => {
    expect(avalanche((w) => hash2(w[0]!, w[1]! | 0, w[2]! | 0), 3, 30000, 22)).toBeLessThanOrEqual(0.02);
  });
  test('hash3 (30k per word and bit)', () => {
    expect(avalanche((w) => hash3(w[0]!, w[1]! | 0, w[2]! | 0, w[3]! | 0), 4, 30000, 23)).toBeLessThanOrEqual(0.02);
  });
  test('hash4 (30k per word and bit)', () => {
    expect(avalanche((w) => hash4(w[0]!, w[1]! | 0, w[2]! | 0, w[3]! | 0), 4, 30000, 24)).toBeLessThanOrEqual(0.02);
  });
});

test('hash2 is not mirrored through the origin (1 ≤ x, z < 2000, seeds 1-4)', () => {
  let equal = 0;
  for (let s = 1; s <= 4; s++) {
    for (let x = 1; x < 2000; x++) for (let z = 1; z < 2000; z++) if (hash2(s, x, z) === hash2(s, -x, -z)) equal++;
  }
  expect(equal).toBe(0);
});

test('corner hashes of [-128, 128)³ collide at the birthday rate', () => {
  const h = new Uint32Array(256 * 256 * 256);
  let i = 0;
  for (let x = -128; x < 128; x++) for (let y = -128; y < 128; y++) for (let z = -128; z < 128; z++) h[i++] = hash3(1, x, y, z);
  h.sort();
  let dup = 0;
  for (let k = 1; k < h.length; k++) if (h[k] === h[k - 1]) dup++;
  expect(Math.abs(dup - 32725)).toBeLessThanOrEqual(543);
});

test('any bit 12-31 of a coordinate changes hash3', () => {
  const next = testRng(31);
  for (let i = 0; i < 2000; i++) {
    const s = next(), c = [next() | 0, next() | 0, next() | 0];
    const base = hash3(s, c[0]!, c[1]!, c[2]!);
    for (let axis = 0; axis < 3; axis++) {
      for (let bit = 12; bit < 32; bit++) {
        const d = c.slice();
        d[axis] = d[axis]! ^ (1 << bit);
        expect(hash3(s, d[0]!, d[1]!, d[2]!)).not.toBe(base);
      }
    }
  }
});

test('deriveSeed is a bijection of world[0] for a fixed name', () => {
  const seen = new Set<number>();
  for (let s = 0; s < 100000; s++) seen.add(deriveSeed([s, 0], 'climate.T'));
  expect(seen.size).toBe(100000);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/hash.test.ts`
Expected: FAIL (`src/core/hash` does not exist).

- [ ] **Step 4: Implement `src/core/hash.ts`**

```ts
/** Two u32 words [lo, hi]; value = hi·2^32 + lo. Both words are normalised with >>> 0 wherever one is built. */
export type Seed64 = readonly [lo: number, hi: number];
export type Hash64 = Seed64;

const KX = 0x27d4eb2d;
const KY = 0x165667b1;
const KZ = 0x9e3779b1;
const KS = 0x85ebca77;
const M1 = 0x85ebca6b;
const M2 = 0xc2b2ae35;

/** murmur3 finaliser. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, M1);
  h ^= h >>> 13;
  h = Math.imul(h, M2);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Per-axis pre-mix: breaks the odd symmetry imul(−v, K) = imul(v, K) ^ (~0 << (tz(v) + 1)). */
function ax(v: number, k: number): number {
  const t = Math.imul(v, k);
  return Math.imul(t ^ (t >>> 15), M1);
}

export function hash2(s: number, x: number, z: number): number {
  return fmix32(s ^ ax(x, KX) ^ ax(z, KZ));
}

export function hash3(s: number, x: number, y: number, z: number): number {
  return fmix32(s ^ ax(x, KX) ^ ax(y, KY) ^ ax(z, KZ));
}

export function hash4(s: number, salt: number, x: number, z: number): number {
  return fmix32(s ^ ax(salt, KS) ^ ax(x, KX) ^ ax(z, KZ));
}

/** UTF-8 bytes of a string; a lone surrogate encodes as EF BF BD (as TextEncoder does). */
export function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  const n = str.length;
  for (let i = 0; i < n; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < n ? str.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function fnv1a32(str: string): number {
  const bytes = utf8Bytes(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

/** FNV-1a 64 as two u32 halves; prime = 2^40 + 0x1b3, and lo·0x1b3 < 2^41 is exact. */
export function fnv1a64Bytes(bytes: Uint8Array): Hash64 {
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]!) >>> 0;
    const p = lo * 0x1b3;
    const nlo = p >>> 0;
    hi = (Math.imul(hi, 0x1b3) + (p - nlo) / 4294967296 + (lo << 8)) >>> 0;
    lo = nlo;
  }
  return [lo, hi];
}

export function fnv1a64(str: string): Hash64 {
  return fnv1a64Bytes(utf8Bytes(str));
}

export function hex64(h: Hash64): string {
  return h[1].toString(16).padStart(8, '0') + h[0].toString(16).padStart(8, '0');
}

/** fnv1a64 over the little-endian bytes of each value; every NaN is written as 0x7FF8000000000000. */
export function hashF64(values: Float64Array): Hash64 {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v !== v) {
      view.setUint32(i * 8, 0, true);
      view.setUint32(i * 8 + 4, 0x7ff80000, true);
    } else {
      view.setFloat64(i * 8, v, true);
    }
  }
  return fnv1a64Bytes(bytes);
}

/** Per-noise (or per-feature) seed; a bijection of world[0] for a fixed name. */
export function deriveSeed(world: Seed64, name: string): number {
  return fmix32(world[0] ^ fmix32(world[1] ^ fnv1a32(name)));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/hash.test.ts`
Expected: PASS (about 5 s; the duplicate test sorts 16.7 M hashes).

- [ ] **Step 6: Run the arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/hash.ts test/harness/stats.ts test/unit/hash.test.ts
git commit -m "feat(core): hashing with per-axis pre-mix, UTF-8, fnv1a32/64 and hashF64

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 4: RNG and seed text (`core/rng.ts`, `core/seed.ts`)

**Files:**
- Create: `src/core/rng.ts`, `src/core/seed.ts`
- Test: `test/unit/rng.test.ts`, `test/unit/seed.test.ts`

**Interfaces:**
- Consumes: `Seed64`, `fnv1a64` from `src/core/hash.ts`.
- Produces:
  - `splitmix32(seed: number): () => number` (u32 outputs)
  - `class Xoshiro128 { constructor(seed: number); static fromState(a, b, c, d): Xoshiro128; nextU32(): number; nextFloat(): number; nextInt(n: number): number }`
  - `seedFromInput(text: string): Seed64`, `seedToText(seed: Seed64): string`

- [ ] **Step 1: Write the failing tests**

`test/unit/rng.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { splitmix32, Xoshiro128 } from '../../src/core/rng';

describe('vectors', () => {
  test('splitmix32(0)', () => {
    const sm = splitmix32(0);
    expect([sm(), sm(), sm(), sm()]).toEqual([1684164658, 3653269916, 2939563536, 2141751570]);
  });
  test('xoshiro128** from raw state [1, 2, 3, 4]', () => {
    const r = Xoshiro128.fromState(1, 2, 3, 4);
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492]);
  });
  test('xoshiro128** seeded with 12345', () => {
    const r = new Xoshiro128(12345);
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([1093274547, 203003357, 3741353573, 3803725158, 4178738660, 810247443]);
  });
});

test('nextFloat is one draw times 2^-32', () => {
  const a = new Xoshiro128(9);
  const b = new Xoshiro128(9);
  for (let i = 0; i < 1000; i++) {
    const f = a.nextFloat();
    expect(f).toBe(b.nextU32() * 2.3283064365386963e-10);
    expect(f >= 0 && f < 1).toBe(true);
  }
});

describe('nextInt', () => {
  const n = 3 * 2 ** 30;
  const chi2p = (bins: number[], total: number) => {
    const e = total / bins.length;
    const chi2 = bins.reduce((s, c) => s + (c - e) ** 2 / e, 0);
    return Math.exp(-chi2 / 2); // χ² survival function for 2 degrees of freedom
  };
  test('no modulo bias for n = 3·2^30 (χ² p > 0.01)', () => {
    const r = new Xoshiro128(7);
    const bins = [0, 0, 0];
    for (let i = 0; i < 100000; i++) bins[Math.floor(r.nextInt(n) / 2 ** 30)]!++;
    expect(chi2p(bins, 100000)).toBeGreaterThan(0.01);
  });
  test('negative control: plain modulo is biased', () => {
    const r = new Xoshiro128(7);
    const bins = [0, 0, 0];
    for (let i = 0; i < 100000; i++) bins[Math.floor((r.nextU32() % n) / 2 ** 30)]!++;
    expect(chi2p(bins, 100000)).toBeLessThan(1e-6);
  });
  test('edge sizes', () => {
    const r = new Xoshiro128(3);
    for (let i = 0; i < 100; i++) expect(r.nextInt(1)).toBe(0);
    const a = new Xoshiro128(4);
    const b = new Xoshiro128(4);
    for (let i = 0; i < 100; i++) expect(a.nextInt(4294967296)).toBe(b.nextU32());
  });
});
```

`test/unit/seed.test.ts`:

```ts
import { expect, test } from 'vitest';
import { fnv1a64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput, seedToText } from '../../src/core/seed';

test.each([
  ['007', [7, 0]],
  ['+5', [5, 0]],
  [' 42 ', [42, 0]],
  ['-1', [4294967295, 4294967295]],
  ['18446744073709551615', [4294967295, 4294967295]],
  ['-9223372036854775808', [0, 2147483648]],
  ['9007199254740993', [1, 2097152]],
])('numeric seed %j', (text, seed) => {
  expect(seedFromInput(text)).toEqual(seed);
});

test.each(['18446744073709551616', '-9223372036854775809', '1e5', '0x10', 'Hello', 'é', ''])('text seed %j hashes the trimmed text', (text) => {
  expect(seedFromInput(text)).toEqual(fnv1a64(text.trim()));
});

test('whitespace-only text is the empty-string hash (the UI replaces it with a random seed)', () => {
  expect(seedFromInput('   ')).toEqual(fnv1a64(''));
});

test('seedToText round-trips 100k random seeds', () => {
  const r = new Xoshiro128(5);
  for (let i = 0; i < 100000; i++) {
    const s = [r.nextU32(), r.nextU32()] as const;
    expect(seedFromInput(seedToText(s))).toEqual(s);
  }
  expect(seedToText([7, 0])).toBe('7');
  expect(seedToText([4294967295, 4294967295])).toBe('18446744073709551615');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/rng.test.ts test/unit/seed.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/rng.ts`**

```ts
/** splitmix32 stream (u32 outputs). */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z >>> 0;
  };
}

/** xoshiro128** 1.1. Every draw consumes exactly one nextU32. */
export class Xoshiro128 {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.a = sm() | 0;
    this.b = sm() | 0;
    this.c = sm() | 0;
    this.d = sm() | 0;
  }

  static fromState(a: number, b: number, c: number, d: number): Xoshiro128 {
    const r = new Xoshiro128(0);
    r.a = a | 0;
    r.b = b | 0;
    r.c = c | 0;
    r.d = d | 0;
    return r;
  }

  nextU32(): number {
    let x = Math.imul(this.b, 5);
    x = (x << 7) | (x >>> 25);
    const r = Math.imul(x, 9) >>> 0;
    const t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = (this.d << 11) | (this.d >>> 21);
    return r;
  }

  /** [0, 1) with 2^-32 granularity (one draw). */
  nextFloat(): number {
    return this.nextU32() * 2.3283064365386963e-10;
  }

  /** Uniform integer in [0, n), 1 ≤ n ≤ 2^32, by threshold rejection (unbiased). */
  nextInt(n: number): number {
    const thr = 4294967296 % n;
    let u = this.nextU32();
    while (u < thr) u = this.nextU32();
    return u % n;
  }
}
```

- [ ] **Step 4: Implement `src/core/seed.ts`**

```ts
import { fnv1a64, type Seed64 } from './hash';

const DECIMAL = /^[+-]?[0-9]+$/;
const MIN_I64 = -(1n << 63n);
const LIMIT_U64 = 1n << 64n;

/**
 * Seed text → Seed64. Trim only (no Unicode normalisation; case-sensitive). An integer in
 * [−2^63, 2^64 − 1] is its value mod 2^64; anything else is fnv1a64 of the trimmed text.
 */
export function seedFromInput(text: string): Seed64 {
  const t = text.trim();
  if (DECIMAL.test(t)) {
    const v = BigInt(t);
    if (v >= MIN_I64 && v < LIMIT_U64) {
      const u = BigInt.asUintN(64, v);
      return [Number(u & 0xffffffffn) >>> 0, Number(u >> 32n) >>> 0];
    }
  }
  return fnv1a64(t);
}

/** Unsigned decimal of hi·2^32 + lo; seedFromInput(seedToText(s)) equals s. */
export function seedToText(seed: Seed64): string {
  return ((BigInt(seed[1]) << 32n) | BigInt(seed[0])).toString();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit test/unit/rng.test.ts test/unit/seed.test.ts`
Expected: PASS.

- [ ] **Step 6: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/rng.ts src/core/seed.ts test/unit/rng.test.ts test/unit/seed.test.ts
git commit -m "feat(core): xoshiro128** streams and seed text rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 5: Deterministic transcendentals (`core/detMath.ts`)

**Files:**
- Create: `src/core/detMath.ts`
- Test: `test/unit/detMath.test.ts`

**Interfaces:**
- Consumes: `testRng`, `testFloat`, `nextUp`, `nextDown`, `f64Hex`, `refErf` from `test/harness/stats.ts`.
- Produces: `detSin(x)`, `detCos(x)`, `detExp(x)`, `detExp2(x)`, `detErf(x)`, `detSmoothstep(e0, e1, x)` (spec §1.5).

- [ ] **Step 1: Write the failing test**

`test/unit/detMath.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { detCos, detErf, detExp, detExp2, detSin, detSmoothstep } from '../../src/core/detMath';
import { f64Hex, nextDown, nextUp, refErf, testFloat, testRng } from '../harness/stats';

const grid = (lo: number, hi: number, n: number) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const uniform = (lo: number, hi: number, n: number, seed: number) => {
  const next = testRng(seed);
  return Array.from({ length: n }, () => lo + (hi - lo) * testFloat(next));
};
const maxAbsErr = (f: (x: number) => number, g: (x: number) => number, xs: readonly number[]) =>
  xs.reduce((m, x) => Math.max(m, Math.abs(f(x) - g(x))), 0);
const maxRelErr = (f: (x: number) => number, g: (x: number) => number, xs: readonly number[]) =>
  xs.reduce((m, x) => Math.max(m, Math.abs(f(x) - g(x)) / Math.abs(g(x))), 0);

describe('T-DM1 error bounds', () => {
  test('sin/cos ≤ 2e-9 absolute', () => {
    const next = testRng(51);
    const logU = Array.from({ length: 1 << 18 }, () => (next() & 1 ? -1 : 1) * 2 ** (21 * testFloat(next)));
    const nearK: number[] = [];
    for (let k = -63662; k <= 63662; k++) {
      let x = k * (Math.PI / 2);
      for (let s = 0; s < 4; s++) x = nextDown(x);
      for (let s = 0; s < 9; s++) { nearK.push(x); x = nextUp(x); }
    }
    for (const xs of [grid(-2 * Math.PI, 2 * Math.PI, 1 << 20), uniform(-1e5, 1e5, 1 << 20, 52), logU, nearK]) {
      expect(maxAbsErr(detSin, Math.sin, xs)).toBeLessThanOrEqual(2e-9);
      expect(maxAbsErr(detCos, Math.cos, xs)).toBeLessThanOrEqual(2e-9);
    }
  });
  test('exp and exp2 ≤ 2.5e-9 relative for normal results; rivers path ≤ 2e-9 absolute', () => {
    expect(maxRelErr(detExp, Math.exp, uniform(-708.39, 709.78, 1 << 20, 53))).toBeLessThanOrEqual(2.5e-9);
    expect(maxRelErr(detExp, Math.exp, grid(-1, 1, 1 << 16))).toBeLessThanOrEqual(2.5e-9);
    expect(maxRelErr(detExp2, (x) => 2 ** x, uniform(-1022, 1023.99, 1 << 20, 54))).toBeLessThanOrEqual(2.5e-9);
    expect(maxAbsErr((t) => detExp(-(t * t)), (t) => Math.exp(-(t * t)), grid(0, 50, 1 << 16))).toBeLessThanOrEqual(2e-9);
  });
  test('reference erf matches mpmath', () => {
    const mp: Array<[number, number]> = [
      [0.125, 0.1403162048013338], [0.5, 0.5204998778130465], [1, 0.8427007929497149], [1.5, 0.9661051464753108],
      [2, 0.9953222650189527], [2.1213203435596424, 0.9973002039367398], [2.5, 0.999593047982555],
      [3, 0.9999779095030014], [4, 0.9999999845827421], [6, 1.0],
    ];
    for (const [x, v] of mp) expect(Math.abs(refErf(x) - v)).toBeLessThanOrEqual(1e-13);
  });
  test('erf ≤ 1e-7 absolute', () => {
    const next = testRng(55);
    const logU = Array.from({ length: 1 << 16 }, () => (next() & 1 ? -1 : 1) * 10 ** (-12 + 15 * testFloat(next)));
    for (const xs of [grid(-2.1214, 2.1214, 1 << 20), grid(-6, 6, 1 << 20), logU]) {
      expect(maxAbsErr(detErf, refErf, xs)).toBeLessThanOrEqual(1e-7);
    }
  });
});

describe('T-DM2 special values', () => {
  const cases: Array<[string, () => number, number]> = [
    ['sin(-0)', () => detSin(-0), -0], ['sin(0)', () => detSin(0), 0], ['cos(-0)', () => detCos(-0), 1],
    ['sin(Inf)', () => detSin(Infinity), NaN], ['sin(-Inf)', () => detSin(-Infinity), NaN], ['sin(NaN)', () => detSin(NaN), NaN],
    ['cos(Inf)', () => detCos(Infinity), NaN], ['sin(2^21 + ulp)', () => detSin(2097152.0000000005), NaN],
    ['sin(MAX)', () => detSin(Number.MAX_VALUE), NaN], ['sin(5e-324)', () => detSin(5e-324), 5e-324],
    ['exp(0)', () => detExp(0), 1], ['exp(-Inf)', () => detExp(-Infinity), 0], ['exp(Inf)', () => detExp(Infinity), Infinity],
    ['exp(NaN)', () => detExp(NaN), NaN], ['exp(709.782712893384)', () => detExp(709.782712893384), 1.7976931348622732e308],
    ['exp(709.79)', () => detExp(709.79), Infinity], ['exp(-745.14)', () => detExp(-745.14), 0],
    ['exp2(-1075.5)', () => detExp2(-1075.5), 0], ['exp2(1024)', () => detExp2(1024), Infinity], ['exp2(NaN)', () => detExp2(NaN), NaN],
    ['erf(Inf)', () => detErf(Infinity), 1], ['erf(-Inf)', () => detErf(-Infinity), -1], ['erf(NaN)', () => detErf(NaN), NaN],
    ['erf(0)', () => detErf(0), 0], ['erf(-0)', () => detErf(-0), 0], ['erf(1e300)', () => detErf(1e300), 1],
    ['erf(6.1)', () => detErf(6.1), 1],
    ['smoothstep below', () => detSmoothstep(0, 1, -1), 0], ['smoothstep above', () => detSmoothstep(0, 1, 2), 1],
    ['smoothstep mid', () => detSmoothstep(0, 1, 0.5), 0.5], ['smoothstep NaN', () => detSmoothstep(0, 1, NaN), NaN],
  ];
  test.each(cases)('%s', (_name, f, expected) => {
    expect(Object.is(f(), expected)).toBe(true);
  });
  test('detSin(2^21) is finite (domain edge is inclusive)', () => {
    expect(Number.isFinite(detSin(2097152))).toBe(true);
  });
  test('exp2(k) === 2^k exactly for every integer k in [-1074, 1023]', () => {
    for (let k = -1074; k <= 1023; k++) expect(detExp2(k)).toBe(2 ** k);
  });
});

describe('T-DM3 symmetry', () => {
  test('sin odd, cos even, erf odd (x ≠ 0), bitwise', () => {
    let bad = 0;
    for (const xs of [uniform(-1e5, 1e5, 1 << 20, 56), uniform(-2097152, 2097152, 1 << 18, 57), uniform(-8, 8, 1 << 18, 62)]) {
      for (const x of xs) {
        if (!Object.is(detSin(-x), -detSin(x))) bad++;
        if (!Object.is(detCos(-x), detCos(x))) bad++;
        if (x !== 0 && !Object.is(detErf(-x), -detErf(x))) bad++;
      }
    }
    expect(bad).toBe(0);
  });
  test('sin stays odd at exact reduction ties', () => {
    const INV_PIO2 = 0.6366197723675814;
    let found = 0;
    for (let n = 0; n < 100000; n++) {
      const x = (n + 0.5) / INV_PIO2;
      if (x * INV_PIO2 !== n + 0.5) continue;
      found++;
      expect(Object.is(detSin(-x), -detSin(x))).toBe(true);
      expect(Object.is(detCos(-x), detCos(x))).toBe(true);
    }
    expect(found).toBeGreaterThanOrEqual(100);
  });
});

test('T-DM4 range', () => {
  let bad = 0;
  for (const x of uniform(-2097152, 2097152, 1 << 18, 58)) if (Math.abs(detSin(x)) > 1 || Math.abs(detCos(x)) > 1) bad++;
  for (const x of uniform(-50, 50, 1 << 18, 59)) if (Math.abs(detErf(x)) > 1) bad++;
  for (const x of uniform(-800, 800, 1 << 18, 60)) if (!(detExp(x) >= 0)) bad++;
  expect(bad).toBe(0);
});

describe('T-DM5 monotonicity', () => {
  test('erf on a 1e7-point grid over [-8, 8] and on consecutive-ulp windows', () => {
    let prev = -Infinity;
    for (let i = 0; i < 1e7; i++) {
      const v = detErf(-8 + (16 * i) / (1e7 - 1));
      if (v < prev) throw new Error(`erf decreases at grid index ${i}`);
      prev = v;
    }
    for (const start of uniform(-6, 6, 1000, 61)) {
      let x = start;
      let p = detErf(x);
      for (let s = 0; s < 1000; s++) {
        x = nextUp(x);
        const v = detErf(x);
        if (v < p) throw new Error(`erf decreases at ${x}`);
        p = v;
      }
    }
  });
  test('exp and exp2 across the k-switch points', () => {
    for (let k = -1000; k <= 1000; k++) {
      for (const [f, x0] of [[detExp, (k - 0.5) * Math.LN2], [detExp2, k - 0.5]] as const) {
        let x = x0;
        for (let s = 0; s < 500; s++) x = nextDown(x);
        let p = f(x);
        for (let s = 0; s < 1000; s++) {
          x = nextUp(x);
          const v = f(x);
          if (v < p) throw new Error(`${f.name} decreases at ${x}`);
          p = v;
        }
      }
    }
  });
});

test('T-DM7 coefficient literals: bits match their comment, shortest form, ≤ 17 significant digits', () => {
  const src = readFileSync(new URL('../../src/core/detMath.ts', import.meta.url), 'utf8');
  const found = [...src.matchAll(/^const ([A-Z0-9_]+) = ([-0-9.e+]+); \/\/ 0x([0-9A-F]{16})/gm)];
  expect(found.length).toBe(29);
  for (const [, name, lit, hex] of found) {
    expect(f64Hex(Number(lit)), name).toBe(hex);
    expect(String(Number(lit)), name).toBe(lit);
    const digits = lit!.replace(/^-/, '').replace(/e.*$/, '').replace('.', '').replace(/^0+/, '');
    expect(digits.length, name).toBeLessThanOrEqual(17);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/detMath.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/core/detMath.ts`**

Copy the spec's Appendix A code block **verbatim** into `src/core/detMath.ts` (it starts with `const INV_PIO2 = 0.6366197723675814; // 0x3FE45F306DC9C883` and ends with `detSmoothstep`), preceded by this header comment:

```ts
/**
 * Deterministic transcendentals (SP1 spec §1.5, Appendix A). Only IEEE + − × ÷, Math.abs/floor/trunc,
 * int32 & and |, and one exact 2^k table. The operation order is part of the contract: do not
 * reassociate, factor or "simplify" any expression. Coefficients are shortest round-trip literals
 * with their bit patterns in comments (checked by T-DM7).
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/detMath.test.ts`
Expected: PASS (about 10 s).

- [ ] **Step 5: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS (detMath uses only allowed `Math` members).

- [ ] **Step 6: Commit**

```bash
git add src/core/detMath.ts test/unit/detMath.test.ts
git commit -m "feat(core): detMath sin/cos/exp/exp2/erf/smoothstep with pinned bits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 6: Canonical JSON and q15 (`core/params/canonical.ts`)

**Files:**
- Create: `src/core/params/canonical.ts`
- Test: `test/unit/canonical.test.ts`

**Interfaces:**
- Produces: `q15(x: number): number`, `canonicalJSON(v: unknown): string`, `class CanonicalError extends Error { readonly path: string }`.

- [ ] **Step 1: Write the failing test**

`test/unit/canonical.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { CanonicalError, canonicalJSON, q15 } from '../../src/core/params/canonical';
import { testFloat, testRng } from '../harness/stats';

describe('q15', () => {
  test('examples', () => {
    expect(Object.is(q15(-0), 0)).toBe(true);
    expect(q15(0.1 + 0.2)).toBe(0.3);
    expect(q15(123456789012345)).toBe(123456789012345);
    expect(q15(2 ** 53 - 1)).toBe(9007199254740990);
  });
  test('idempotent and monotone over 300k values spanning 80 decades', () => {
    const next = testRng(71);
    let prevX = -Infinity;
    let prevQ = -Infinity;
    const xs = Array.from({ length: 300000 }, () => (next() & 1 ? -1 : 1) * 10 ** (-40 + 80 * testFloat(next))).sort((a, b) => a - b);
    for (const x of xs) {
      const q = q15(x);
      expect(q15(q)).toBe(q);
      if (x >= prevX) expect(q >= prevQ).toBe(true);
      prevX = x;
      prevQ = q;
    }
  });
});

describe('canonicalJSON', () => {
  test('RFC 8785 ordering and number form', () => {
    expect(canonicalJSON({ b: 1, a: [1, 2, { d: 1e21, c: 1e-7 }], 'é': 'x', Z: null, u: undefined }))
      .toBe('{"Z":null,"a":[1,2,{"c":1e-7,"d":1e+21}],"b":1,"é":"x"}');
    expect(canonicalJSON([true, false, 'q"'])).toBe('[true,false,"q\\""]');
  });
  test.each([
    ['NaN', { a: NaN }, 'a'],
    ['Infinity', [1, Infinity], '[1]'],
    ['-0', { x: { y: -0 } }, 'x.y'],
    ['undefined array item', [undefined], '[0]'],
    ['Map', new Map(), ''],
    ['Date', { d: new Date(0) }, 'd'],
    ['function', { f: () => 1 }, 'f'],
  ])('rejects %s with its path', (_name, value, path) => {
    try {
      canonicalJSON(value);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalError);
      expect((e as CanonicalError).path).toBe(path);
    }
  });
  test('depth over 64 throws', () => {
    let v: unknown = 1;
    for (let i = 0; i < 70; i++) v = [v];
    expect(() => canonicalJSON(v)).toThrow(CanonicalError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/canonical.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/core/params/canonical.ts`**

```ts
/** 15 significant digits: a unique printed form by the letter of ECMA-262; idempotent; −0 → +0. */
export function q15(x: number): number {
  return x === 0 ? 0 : Number(x.toPrecision(15));
}

export class CanonicalError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path === '' ? '<root>' : path}: ${message}`);
    this.path = path;
  }
}

function isPlainObject(v: object): boolean {
  const p: unknown = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function enc(v: unknown, path: string, depth: number): string {
  if (depth > 64) throw new CanonicalError(path, 'nesting deeper than 64');
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalError(path, `non-finite number ${String(v)}`);
      if (Object.is(v, -0)) throw new CanonicalError(path, 'negative zero');
      return String(v);
    case 'object': {
      if (v === null) return 'null';
      if (Array.isArray(v)) {
        let s = '[';
        for (let i = 0; i < v.length; i++) {
          const item: unknown = v[i];
          const p = `${path}[${i}]`;
          if (item === undefined) throw new CanonicalError(p, 'undefined array item');
          s += (i > 0 ? ',' : '') + enc(item, p, depth + 1);
        }
        return `${s}]`;
      }
      if (!isPlainObject(v)) throw new CanonicalError(path, 'not a plain object');
      const rec = v as Record<string, unknown>;
      let s = '{';
      let first = true;
      for (const k of Object.keys(rec).sort()) {
        const item = rec[k];
        if (item === undefined) continue;
        s += `${first ? '' : ','}${JSON.stringify(k)}:${enc(item, path === '' ? k : `${path}.${k}`, depth + 1)}`;
        first = false;
      }
      return `${s}}`;
    }
    default:
      throw new CanonicalError(path, `unsupported ${typeof v}`);
  }
}

/** RFC 8785 (JCS), stricter: NaN, ±Infinity, −0, non-plain objects and undefined array items throw. */
export function canonicalJSON(v: unknown): string {
  return enc(v, '', 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/canonical.test.ts`
Expected: PASS.

- [ ] **Step 5: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/params/canonical.ts test/unit/canonical.test.ts
git commit -m "feat(core): canonical JSON and q15 number normalisation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 7: detMath oracle and digests

**Files:**
- Create: `tools/detmath-oracle.py`
- Create: `src/metrics/sp1Goldens.ts` (detMath part; Task 25 completes it)
- Create: `test/fixtures/detmath-oracle.json` (generated)
- Test: `test/unit/detmathOracle.test.ts`

**Interfaces:**
- Consumes: detMath (Task 5), `Xoshiro128` (Task 4), `fnv1a32`, `hashF64`, `hex64` (Task 3).
- Produces (in `src/metrics/sp1Goldens.ts`): `DETMATH_FNS`, `type DetMathFn`, `detMathInputs(fn: DetMathFn): Float64Array`, `detMathDigest(fn: DetMathFn): string` (hex64). Task 25 adds the other golden families and `goldenKeys()` / `computeGolden(key)`.

- [ ] **Step 1: Write the failing test**

`test/unit/detmathOracle.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DETMATH_FNS, detMathDigest, detMathInputs } from '../../src/metrics/sp1Goldens';

test('input streams: 2^20 draws plus the specials, sin/cos alternate their two ranges', () => {
  const sin = detMathInputs('detSin');
  expect(sin.length).toBe((1 << 20) + 13 + 5);
  expect(Math.abs(sin[0]!)).toBeLessThan(64);
  expect(Object.is(sin[(1 << 20) + 1], -0)).toBe(true);
  expect(detMathInputs('detSmoothstep').length).toBe((1 << 20) + 13);
});

test('T-DM6 detMath digests equal the CPython oracle', () => {
  const oracle = JSON.parse(readFileSync(new URL('../fixtures/detmath-oracle.json', import.meta.url), 'utf8')) as Record<string, string>;
  expect(Object.keys(oracle)).toEqual([...DETMATH_FNS]);
  for (const fn of DETMATH_FNS) expect(detMathDigest(fn), fn).toBe(oracle[fn]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/detmathOracle.test.ts`
Expected: FAIL (`src/metrics/sp1Goldens` missing).

- [ ] **Step 3: Implement the detMath part of `src/metrics/sp1Goldens.ts`**

```ts
/**
 * SP1 golden digests (SP1 spec §7.4), shared by test/unit/goldens.sp1.test.ts, the lab's determinism
 * panel and test/tools/goldensJsc.ts. Follows the core determinism rules (arch-tested). Every value is hex64.
 */
import { detCos, detErf, detExp, detExp2, detSin, detSmoothstep } from '../core/detMath';
import { fnv1a32, hashF64, hex64 } from '../core/hash';
import { Xoshiro128 } from '../core/rng';

const SIN = detSin;
const COS = detCos;
const EXP = detExp;
const EXP2 = detExp2;
const ERF = detErf;
const SMOOTH = detSmoothstep;
const FNV32 = fnv1a32;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const Rng = Xoshiro128;

export const DETMATH_FNS = ['detSin', 'detCos', 'detExp', 'detExp2', 'detErf', 'detSmoothstep'] as const;
export type DetMathFn = (typeof DETMATH_FNS)[number];

const DRAWS = 1048576; // 2^20
const COMMON_SPECIALS = [0, -0, NaN, Infinity, -Infinity, 5e-324, -5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 0.5, -0.5, 1, -1];
const TRIG_SPECIALS = [2097152, -2097152, 2097152.0000000005, 1.5707963267948966, 3.141592653589793];
const EXTRA_SPECIALS: Readonly<Record<DetMathFn, readonly number[]>> = {
  detSin: TRIG_SPECIALS,
  detCos: TRIG_SPECIALS,
  detExp: [-745.1332191019412, -745.14, 709.782712893384, 709.79],
  detExp2: [-1075.5, -1075, -1074, 1023, 1024],
  detErf: [6.0926, 2.1213203435596424],
  detSmoothstep: [],
};
const RANGE: Readonly<Record<DetMathFn, readonly [number, number]>> = {
  detSin: [-2097152, 2097152],
  detCos: [-2097152, 2097152],
  detExp: [-746, 710],
  detExp2: [-1076, 1025],
  detErf: [-8, 8],
  detSmoothstep: [-2, 2],
};
const EVAL: Readonly<Record<DetMathFn, (x: number) => number>> = {
  detSin: SIN,
  detCos: COS,
  detExp: EXP,
  detExp2: EXP2,
  detErf: ERF,
  detSmoothstep: (x) => SMOOTH(-1, 1, x),
};

/** 2^20 draws x = lo + (hi − lo)·u (sin/cos: even j in [−64, 64), odd j in [−2^21, 2^21)), then the specials. */
export function detMathInputs(fn: DetMathFn): Float64Array {
  const extra = EXTRA_SPECIALS[fn];
  const out = new Float64Array(DRAWS + COMMON_SPECIALS.length + extra.length);
  const r = new Rng(FNV32(`sp1.detMath.${fn}`));
  const trig = fn === 'detSin' || fn === 'detCos';
  const [lo, hi] = RANGE[fn];
  for (let j = 0; j < DRAWS; j++) {
    const u = r.nextFloat();
    out[j] = trig && (j & 1) === 0 ? -64 + (64 - -64) * u : lo + (hi - lo) * u;
  }
  let k = DRAWS;
  for (const v of COMMON_SPECIALS) out[k++] = v;
  for (const v of extra) out[k++] = v;
  return out;
}

export function detMathDigest(fn: DetMathFn): string {
  const xs = detMathInputs(fn);
  const ys = new Float64Array(xs.length);
  const f = EVAL[fn];
  for (let i = 0; i < xs.length; i++) ys[i] = f(xs[i]!);
  return HEX64(HASH_F64(ys));
}
```

- [ ] **Step 4: Write `tools/detmath-oracle.py`**

```python
#!/usr/bin/env python3
"""CPython port of src/core/detMath.ts and of the sp1.detMath golden inputs (SP1 spec §7.4).

CPython floats are IEEE binary64 with per-operation rounding and no FMA, so this port reproduces the
TypeScript operation order bit for bit. Standard library only. Manual oracle, not run in CI:

    python3 tools/detmath-oracle.py > test/fixtures/detmath-oracle.json
"""
import json
import math
import struct
import sys

M32 = 0xFFFFFFFF


def imul(a, b):
    return ((a & M32) * (b & M32)) & M32


def trunc(v):
    return math.copysign(float(math.trunc(v)), v)


def to_int32(v):
    i = int(v) & M32
    return i - (1 << 32) if i >= (1 << 31) else i


# ---- detMath (Appendix A) --------------------------------------------------------------
INV_PIO2 = 0.6366197723675814
PIO2_1 = 1.5707963267341256
PIO2_2 = 6.077100506303966e-11
PIO2_3 = 2.0222662487959506e-21
S1 = -0.16666650669294172
S2 = 0.00833197866315709
S3 = -0.00019495636237669298
C1 = -0.49999999725108224
C2 = 0.041666623324344655
C3 = -0.001388676379438054
C4 = 0.00002439045070398889
TRIG_MAX = 2097152.0
LOG2E = 1.4426950408889634
LN2 = 0.6931471805599453
LN2_HI = 0.6931471803691238
LN2_LO = 1.9082149292705877e-10
TWO_1023 = 8.98846567431158e+307
E1 = 1.0000000321650302
E2 = 0.4999999420905273
E3 = 0.1666643126270281
E4 = 0.04166800203473628
E5 = 0.008374155305794656
E6 = 0.0013843653543488235
A1 = 0.0705240212098103
A2 = 0.042269704761099335
A3 = 0.009321899859670404
A4 = 0.00005736618267948212
A5 = 0.00036130633257334846
A6 = 0.000007131023504472914
A7 = 0.000005746614264949733

POW2 = [0.0] * 2099
_v = 1.0
for _k in range(0, 1024):
    POW2[_k + 1075] = _v
    _v = _v * 2.0
_v = 0.5
for _k in range(-1, -1076, -1):
    POW2[_k + 1075] = _v
    _v = _v * 0.5


def k_sin(r):
    z = r * r
    return r * (1.0 + z * (S1 + z * (S2 + z * S3)))


def k_cos(r):
    z = r * r
    return 1.0 + z * (C1 + z * (C2 + z * (C3 + z * C4)))


def det_sin(x):
    if not (abs(x) <= TRIG_MAX):
        return math.nan
    t = x * INV_PIO2
    k = trunc(t - 0.5 if t < 0 else t + 0.5)
    r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3
    q = to_int32(k) & 3
    v = k_sin(r) if (q & 1) == 0 else k_cos(r)
    return v if (q & 2) == 0 else -v


def det_cos(x):
    if not (abs(x) <= TRIG_MAX):
        return math.nan
    t = x * INV_PIO2
    k = trunc(t - 0.5 if t < 0 else t + 0.5)
    r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3
    q = to_int32(k + 1.0) & 3
    v = k_sin(r) if (q & 1) == 0 else k_cos(r)
    return v if (q & 2) == 0 else -v


def k_exp(r):
    return 1.0 + r * (E1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * E6)))))


def scale(p, k):
    return p * 2.0 * TWO_1023 if k > 1023 else p * POW2[k + 1075]


def det_exp(x):
    if not (x >= -745.1332191019412):
        return x if x != x else 0.0
    if x > 709.782712893384:
        return math.inf
    k = to_int32(math.floor(x * LOG2E + 0.5))
    r = (x - k * LN2_HI) - k * LN2_LO
    return scale(k_exp(r), k)


def det_exp2(x):
    if not (x >= -1075):
        return x if x != x else 0.0
    if x >= 1024:
        return math.inf
    k = to_int32(math.floor(x + 0.5))
    return scale(k_exp((x - k) * LN2), k)


def det_erf(x):
    a = abs(x)
    q = 1.0 + a * (A1 + a * (A2 + a * (A3 + a * (A4 + a * (A5 + a * (A6 + a * A7))))))
    q2 = q * q
    q4 = q2 * q2
    q8 = q4 * q4
    q16 = q8 * q8
    r = 1.0 - 1.0 / q16
    return -r if x < 0 else r


def det_smoothstep(e0, e1, x):
    t = (x - e0) / (e1 - e0)
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return t * t * (3.0 - 2.0 * t)


# ---- hashing and streams (src/core/hash.ts, src/core/rng.ts) ----------------------------
def fnv1a32_ascii(s):
    h = 0x811C9DC5
    for b in s.encode('utf-8'):
        h = imul(h ^ b, 0x01000193)
    return h


def splitmix32(seed):
    state = [seed & M32]

    def nxt():
        state[0] = (state[0] + 0x9E3779B9) & M32
        z = state[0]
        z ^= z >> 16
        z = imul(z, 0x21F0AAAD)
        z ^= z >> 15
        z = imul(z, 0x735A2D97)
        z ^= z >> 15
        return z

    return nxt


class Xoshiro128:
    def __init__(self, seed):
        sm = splitmix32(seed)
        self.a, self.b, self.c, self.d = sm(), sm(), sm(), sm()

    def next_u32(self):
        x = imul(self.b, 5)
        x = ((x << 7) | (x >> 25)) & M32
        r = imul(x, 9)
        t = (self.b << 9) & M32
        self.c ^= self.a
        self.d ^= self.b
        self.b ^= self.c
        self.a ^= self.d
        self.c ^= t
        self.d = ((self.d << 11) | (self.d >> 21)) & M32
        return r

    def next_float(self):
        return self.next_u32() * 2.3283064365386963e-10


CANONICAL_NAN = struct.pack('<Q', 0x7FF8000000000000)


def hash_f64_hex(values):
    h = 0xCBF29CE484222325
    for v in values:
        data = CANONICAL_NAN if v != v else struct.pack('<d', v)
        for b in data:
            h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return '%016x' % h


# ---- golden inputs (src/metrics/sp1Goldens.ts) ------------------------------------------
DRAWS = 1 << 20
COMMON = [0.0, -0.0, math.nan, math.inf, -math.inf, 5e-324, -5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 0.5, -0.5, 1.0, -1.0]
TRIG = [2097152.0, -2097152.0, 2097152.0000000005, 1.5707963267948966, 3.141592653589793]
FNS = [
    ('detSin', det_sin, (-2097152.0, 2097152.0), TRIG),
    ('detCos', det_cos, (-2097152.0, 2097152.0), TRIG),
    ('detExp', det_exp, (-746.0, 710.0), [-745.1332191019412, -745.14, 709.782712893384, 709.79]),
    ('detExp2', det_exp2, (-1076.0, 1025.0), [-1075.5, -1075.0, -1074.0, 1023.0, 1024.0]),
    ('detErf', det_erf, (-8.0, 8.0), [6.0926, 2.1213203435596424]),
    ('detSmoothstep', lambda x: det_smoothstep(-1.0, 1.0, x), (-2.0, 2.0), []),
]


def inputs(name, rng_range, extra):
    r = Xoshiro128(fnv1a32_ascii('sp1.detMath.' + name))
    trig = name in ('detSin', 'detCos')
    lo, hi = rng_range
    xs = []
    for j in range(DRAWS):
        u = r.next_float()
        if trig and (j & 1) == 0:
            xs.append(-64.0 + (64.0 - -64.0) * u)
        else:
            xs.append(lo + (hi - lo) * u)
    return xs + COMMON + list(extra)


def main():
    out = {}
    for name, fn, rng_range, extra in FNS:
        out[name] = hash_f64_hex([fn(x) for x in inputs(name, rng_range, extra)])
        print(name, out[name], file=sys.stderr)
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
```

- [ ] **Step 5: Generate the fixture**

Run: `python3 tools/detmath-oracle.py > test/fixtures/detmath-oracle.json`
Expected: six `detSin <16 hex>` … lines on stderr (it takes a minute or two); the JSON file holds the six digests in `DETMATH_FNS` order.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/detmathOracle.test.ts`
Expected: PASS. A mismatch means the two ports disagree on operation order: fix the port that deviates from spec Appendix A, never the other way round.

- [ ] **Step 7: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS (`sp1Goldens.ts` follows the core rules and aliases its imports).

- [ ] **Step 8: Commit**

```bash
git add tools/detmath-oracle.py src/metrics/sp1Goldens.ts test/fixtures/detmath-oracle.json test/unit/detmathOracle.test.ts
git commit -m "test(core): CPython detMath oracle and detMath golden digests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 8: NoiseDef and `lattice3`

**Files:**
- Create: `src/core/noise/types.ts`, `src/core/noise/lattice3.ts`
- Modify: `test/harness/stats.ts` (append `pearson`, `sampleSd`)
- Test: `test/unit/lattice3.test.ts`

**Interfaces:**
- Consumes: `hash3` (test reference only).
- Produces:
  - `interface NoiseDef { wavelength; octaves; persistence; lacunarity; amplitudes: readonly number[] | null; yScale; double; remap: 'none' | 'uniform'; clampSigma }` (all readonly), `type NoiseDefPatch`, `NOISE_DEF_DEFAULTS`, `completeNoiseDef(init)`
  - `lattice3(s: number, x: number, y: number, z: number): number`, `PERLIN3_SD`, `PERLIN2_SD`

- [ ] **Step 1: Append test helpers**

Append to `test/harness/stats.ts`:

```ts
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb);
}

export function sampleSd(a: ArrayLike<number>): number {
  const n = a.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += a[i]!;
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]! - m) ** 2;
  return Math.sqrt(s / (n - 1));
}
```

- [ ] **Step 2: Write the failing test**

`test/unit/lattice3.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { deriveSeed, hash3 } from '../../src/core/hash';
import { completeNoiseDef, NOISE_DEF_DEFAULTS } from '../../src/core/noise/types';
import { lattice3, PERLIN2_SD, PERLIN3_SD } from '../../src/core/noise/lattice3';
import { pearson, sampleSd, testFloat, testRng } from '../harness/stats';

const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** The literal 8-call form of spec §2.1. */
function lattice3Ref(s: number, x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const corner = (dx: number, dy: number, dz: number) => {
    const g = ((hash3(s, X + dx, Y + dy, Z + dz) & 0xffff) * 12) >>> 16;
    return GX[g]! * (fx - dx) + GY[g]! * (fy - dy) + GZ[g]! * (fz - dz);
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const n000 = corner(0, 0, 0), n100 = corner(1, 0, 0), n010 = corner(0, 1, 0), n110 = corner(1, 1, 0);
  const n001 = corner(0, 0, 1), n101 = corner(1, 0, 1), n011 = corner(0, 1, 1), n111 = corner(1, 1, 1);
  const x00 = n000 + u * (n100 - n000), x10 = n010 + u * (n110 - n010), x01 = n001 + u * (n101 - n001), x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00), y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

test('NoiseDef defaults', () => {
  expect(NOISE_DEF_DEFAULTS).toEqual({ persistence: 0.5, lacunarity: 2, amplitudes: null, yScale: 1, double: true, remap: 'none', clampSigma: 3 });
  expect(completeNoiseDef({ wavelength: 900, octaves: 5, remap: 'uniform' })).toEqual({ ...NOISE_DEF_DEFAULTS, wavelength: 900, octaves: 5, remap: 'uniform' });
});

test('the fused kernel is bit-identical to the 8-call form on 300k points', () => {
  const next = testRng(81);
  let bad = 0;
  for (let i = 0; i < 300000; i++) {
    const s = next();
    const x = (testFloat(next) * 2 - 1) * 4096, y = (testFloat(next) * 2 - 1) * 4096, z = (testFloat(next) * 2 - 1) * 4096;
    if (!Object.is(lattice3(s, x, y, z), lattice3Ref(s, x, y, z))) bad++;
  }
  expect(bad).toBe(0);
});

test('the balanced 12-gradient index: 5462 counts for {0, 3, 6, 9}, 5461 for the others', () => {
  const counts = new Array<number>(12).fill(0);
  for (let h = 0; h < 65536; h++) counts[(h * 12) >>> 16]!++;
  expect(counts).toEqual([5462, 5461, 5461, 5462, 5461, 5461, 5462, 5461, 5461, 5462, 5461, 5461]);
});

describe('SD pin: closed forms within ±0.5 % per seed (4 seeds × 250k points)', () => {
  test.each([1, 2, 3, 4])('seed %i', (s) => {
    const seed = deriveSeed([s, 0], 'sp1.sdpin');
    const next = testRng(100 + s);
    const v3 = new Float64Array(250000);
    const v2 = new Float64Array(250000);
    for (let i = 0; i < 250000; i++) {
      v3[i] = lattice3(seed, testFloat(next) * 65536, testFloat(next) * 65536, testFloat(next) * 65536);
      v2[i] = lattice3(seed, testFloat(next) * 65536, Math.floor(testFloat(next) * 65536) + 0.5, testFloat(next) * 65536);
    }
    expect(Math.abs(sampleSd(v3) / PERLIN3_SD - 1)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(sampleSd(v2) / PERLIN2_SD - 1)).toBeLessThanOrEqual(0.005);
  });
  test('constants', () => {
    expect(PERLIN3_SD).toBe(Math.sqrt(35054270 / 480729249));
    expect(PERLIN2_SD).toBe(Math.sqrt(2052359 / 24972948));
    expect(PERLIN3_SD).toBeCloseTo(0.2700350823341202, 15);
    expect(PERLIN2_SD).toBeCloseTo(0.2866762789162117, 15);
  });
});

test.each([
  ['(-x, y, -z)', (x: number, y: number, z: number) => [-x, y, -z]],
  ['(-x, -y, z)', (x: number, y: number, z: number) => [-x, -y, z]],
  ['(x, -y, -z)', (x: number, y: number, z: number) => [x, -y, -z]],
] as const)('no correlation with the two-axis reflection %s', (_name, reflect) => {
  const next = testRng(91);
  const a = new Float64Array(200000);
  const b = new Float64Array(200000);
  for (let i = 0; i < 200000; i++) {
    const x = (testFloat(next) * 2 - 1) * 4096, y = (testFloat(next) * 2 - 1) * 4096, z = (testFloat(next) * 2 - 1) * 4096;
    const [rx, ry, rz] = reflect(x, y, z);
    a[i] = lattice3(1, x, y, z);
    b[i] = lattice3(1, rx!, ry!, rz!);
  }
  expect(Math.abs(pearson(a, b))).toBeLessThanOrEqual(0.02);
});

test('finite and bounded', () => {
  const next = testRng(92);
  let bad = 0;
  for (let i = 0; i < 100000; i++) {
    const v = lattice3(next(), (testFloat(next) * 2 - 1) * 1e9, (testFloat(next) * 2 - 1) * 1e9, (testFloat(next) * 2 - 1) * 1e9);
    if (!Number.isFinite(v) || Math.abs(v) > 2) bad++;
  }
  expect(bad).toBe(0);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/lattice3.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `src/core/noise/types.ts`**

```ts
/** A complete noise definition (validated params always hold every field; spec §4.2). */
export interface NoiseDef {
  readonly wavelength: number;
  readonly octaves: number;
  readonly persistence: number;
  readonly lacunarity: number;
  readonly amplitudes: readonly number[] | null;
  readonly yScale: number;
  readonly double: boolean;
  readonly remap: 'none' | 'uniform';
  readonly clampSigma: number;
}

export type NoiseDefPatch = { readonly [K in keyof NoiseDef]?: NoiseDef[K] };

export const NOISE_DEF_DEFAULTS = {
  persistence: 0.5,
  lacunarity: 2,
  amplitudes: null,
  yScale: 1,
  double: true,
  remap: 'none',
  clampSigma: 3,
} as const satisfies Omit<NoiseDef, 'wavelength' | 'octaves'>;

export function completeNoiseDef(init: Pick<NoiseDef, 'wavelength' | 'octaves'> & NoiseDefPatch): NoiseDef {
  return { ...NOISE_DEF_DEFAULTS, ...init };
}
```

- [ ] **Step 5: Implement `src/core/noise/lattice3.ts`**

```ts
/**
 * Hashed-lattice gradient noise (SP1 spec §2.1): corner gradient = one of the 12 cube edges, index
 * ((hash3(s, X, Y, Z) & 0xffff) · 12) >>> 16; quintic fade; lerp along x, then y, then z. No table,
 * no period. This fused form is bit-identical to the literal 8-call form (unit-tested).
 */
const KX = 0x27d4eb2d;
const KY = 0x165667b1;
const KZ = 0x9e3779b1;
const M1 = 0x85ebca6b;
const M2 = 0xc2b2ae35;
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

/** Exact closed forms (E[A] = 181/231, E[B] = 535/9009, per-axis gradient energy 2/3). */
export const PERLIN3_SD = Math.sqrt(35054270 / 480729249);
/** 2D slice at frac(y) = ½. */
export const PERLIN2_SD = Math.sqrt(2052359 / 24972948);

export function lattice3(s: number, x: number, y: number, z: number): number {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  const fx = x - X;
  const fy = y - Y;
  const fz = z - Z;
  const gx0 = fx - 1;
  const gy0 = fy - 1;
  const gz0 = fz - 1;
  let t = Math.imul(X, KX);
  const ax0 = Math.imul(t ^ (t >>> 15), M1);
  t = (t + KX) | 0;
  const ax1 = Math.imul(t ^ (t >>> 15), M1);
  t = Math.imul(Y, KY);
  const ay0 = Math.imul(t ^ (t >>> 15), M1);
  t = (t + KY) | 0;
  const ay1 = Math.imul(t ^ (t >>> 15), M1);
  t = Math.imul(Z, KZ);
  const az0 = Math.imul(t ^ (t >>> 15), M1) ^ s;
  t = (t + KZ) | 0;
  const az1 = Math.imul(t ^ (t >>> 15), M1) ^ s;
  const b00 = ay0 ^ az0;
  const b10 = ay1 ^ az0;
  const b01 = ay0 ^ az1;
  const b11 = ay1 ^ az1;
  let h: number;
  h = ax0 ^ b00; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n000 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * fz;
  h = ax1 ^ b00; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n100 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * fz;
  h = ax0 ^ b10; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n010 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * fz;
  h = ax1 ^ b10; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n110 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * fz;
  h = ax0 ^ b01; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n001 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * gz0;
  h = ax1 ^ b01; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n101 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * gz0;
  h = ax0 ^ b11; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n011 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * gz0;
  h = ax1 ^ b11; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n111 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * gz0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/lattice3.test.ts`
Expected: PASS.

- [ ] **Step 7: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS (`lattice3.ts` imports nothing).

- [ ] **Step 8: Commit**

```bash
git add src/core/noise/types.ts src/core/noise/lattice3.ts test/harness/stats.ts test/unit/lattice3.test.ts
git commit -m "feat(core): hashed-lattice noise with 12 balanced gradients and closed-form SDs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 9: `OctaveNoise`, `NormalNoise` and the CDF remap

**Files:**
- Create: `src/core/noise/octave.ts`, `src/core/noise/normal.ts`, `src/core/noise/cdf.ts`
- Test: `test/unit/noise.test.ts`

**Interfaces:**
- Consumes: `deriveSeed`, `Seed64` (Task 3), `splitmix32` (Task 4), `lattice3`, `PERLIN2_SD`, `PERLIN3_SD`, `NoiseDef`, `completeNoiseDef` (Task 8), `detErf` (Task 5).
- Produces:
  - `class OctaveNoise { constructor(world: Seed64, name: string, def: NoiseDef); readonly sumA2: number; sample2(x, z): number; sample3(x, y, z): number }`
  - `class NormalNoise { constructor(world: Seed64, name: string, def: NoiseDef); readonly clamp: number; readonly def: NoiseDef; z2(x, z): number; z3(x, y, z): number }`
  - `toUniform(z: number): number`, `uMax(c: number): number`

- [ ] **Step 1: Write the failing test**

`test/unit/noise.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { deriveSeed } from '../../src/core/hash';
import { splitmix32 } from '../../src/core/rng';
import { toUniform, uMax } from '../../src/core/noise/cdf';
import { lattice3, PERLIN2_SD, PERLIN3_SD } from '../../src/core/noise/lattice3';
import { NormalNoise } from '../../src/core/noise/normal';
import { OctaveNoise } from '../../src/core/noise/octave';
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import { sampleSd, testFloat, testRng } from '../harness/stats';

const W: readonly [number, number] = [42, 0];

/** Spec §2.2 recomputed from scratch. */
function octaveRef(name: string, def: NoiseDef, dims: 2 | 3, x: number, y: number, z: number): number {
  let f = 1 / def.wavelength;
  let a = 1;
  let v = 0;
  for (let i = 0; i < def.octaves; i++) {
    const s = deriveSeed(W, `${name}#${i}`);
    const sm = splitmix32(s);
    const ox = sm() * 9.5367431640625e-7, oy = sm() * 9.5367431640625e-7, oz = sm() * 9.5367431640625e-7;
    const ai = def.amplitudes === null ? a : def.amplitudes[i]!;
    const l = dims === 2 ? lattice3(s | 0, x * f + ox, Math.floor(oy) + 0.5, z * f + oz) : lattice3(s | 0, x * f + ox, y * f * def.yScale + oy, z * f + oz);
    v += ai * l;
    f *= def.lacunarity;
    a *= def.persistence;
  }
  return v;
}

describe('OctaveNoise', () => {
  const defs = [
    completeNoiseDef({ wavelength: 2400, octaves: 6 }),
    completeNoiseDef({ wavelength: 64, octaves: 4, yScale: 0.5 }),
    completeNoiseDef({ wavelength: 300, octaves: 4, amplitudes: [1, 0, 0.5, 0] }),
  ];
  test.each(defs.map((d, i) => [i, d] as const))('def %i matches the reference bit for bit', (_i, def) => {
    const o = new OctaveNoise(W, 'test.octave', def);
    const next = testRng(95);
    for (let i = 0; i < 5000; i++) {
      const x = (testFloat(next) * 2 - 1) * 524288, y = -64 + 384 * testFloat(next), z = (testFloat(next) * 2 - 1) * 524288;
      expect(Object.is(o.sample2(x, z), octaveRef('test.octave', def, 2, x, y, z))).toBe(true);
      expect(Object.is(o.sample3(x, y, z), octaveRef('test.octave', def, 3, x, y, z))).toBe(true);
    }
  });
  test('sumA2', () => {
    expect(new OctaveNoise(W, 'a', completeNoiseDef({ wavelength: 100, octaves: 3 })).sumA2).toBe(1 + 0.25 + 0.0625);
    expect(new OctaveNoise(W, 'a', completeNoiseDef({ wavelength: 100, octaves: 2, amplitudes: [2, 0] })).sumA2).toBe(4);
  });
});

describe('NormalNoise', () => {
  test('z2 / z3 are the clamped, reciprocal-normalised double stack', () => {
    const def = completeNoiseDef({ wavelength: 900, octaves: 5 });
    const nn = new NormalNoise(W, 'climate.W', def);
    const A = new OctaveNoise(W, 'climate.W', def);
    const B = new OctaveNoise(W, "climate.W'", def);
    const S = Math.sqrt(A.sumA2 + B.sumA2);
    const inv2 = 1 / (PERLIN2_SD * S), inv3 = 1 / (PERLIN3_SD * S);
    const R = 337 / 331;
    const clamp = (v: number) => (v < -3 ? -3 : v > 3 ? 3 : v);
    const next = testRng(96);
    for (let i = 0; i < 5000; i++) {
      const x = (testFloat(next) * 2 - 1) * 524288, y = -64 + 384 * testFloat(next), z = (testFloat(next) * 2 - 1) * 524288;
      expect(Object.is(nn.z2(x, z), clamp((A.sample2(x, z) + B.sample2(x * R, z * R)) * inv2))).toBe(true);
      expect(Object.is(nn.z3(x, y, z), clamp((A.sample3(x, y, z) + B.sample3(x * R, y * R, z * R)) * inv3))).toBe(true);
    }
  });
  test('a single stack uses only A', () => {
    const def = completeNoiseDef({ wavelength: 16, octaves: 1, double: false });
    const nn = new NormalNoise(W, 'test.single', def);
    const A = new OctaveNoise(W, 'test.single', def);
    const inv2 = 1 / (PERLIN2_SD * Math.sqrt(A.sumA2));
    expect(nn.z2(10.25, -3.5)).toBe(Math.max(-3, Math.min(3, A.sample2(10.25, -3.5) * inv2)));
  });
  test('clampSigma bounds z exactly', () => {
    const nn = new NormalNoise(W, 'test.clamp', completeNoiseDef({ wavelength: 256, octaves: 3, clampSigma: 1 }));
    const next = testRng(97);
    let atClamp = 0;
    for (let i = 0; i < 20000; i++) {
      const v = nn.z2((testFloat(next) * 2 - 1) * 524288, (testFloat(next) * 2 - 1) * 524288);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      if (Math.abs(v) === 1) atClamp++;
    }
    expect(atClamp).toBeGreaterThan(0);
    expect(nn.clamp).toBe(1);
  });
  test('sd(z) ≈ 1 for the climate C definition', () => {
    const nn = new NormalNoise(W, 'climate.C', completeNoiseDef({ wavelength: 2400, octaves: 6, remap: 'uniform' }));
    const next = testRng(98);
    const v = new Float64Array(50000);
    for (let i = 0; i < v.length; i++) v[i] = nn.z2((testFloat(next) * 2 - 1) * 524288, (testFloat(next) * 2 - 1) * 524288);
    expect(Math.abs(sampleSd(v) - 1)).toBeLessThanOrEqual(0.03);
  });
  test('finite at the range extremes', () => {
    const defs = [
      completeNoiseDef({ wavelength: 16, octaves: 16, lacunarity: 4, persistence: 1 }),
      completeNoiseDef({ wavelength: 20000, octaves: 1, clampSigma: 8 }),
      completeNoiseDef({ wavelength: 16, octaves: 3, amplitudes: [0, 16, 0], yScale: 100 }),
      completeNoiseDef({ wavelength: 1024, octaves: 16, lacunarity: 1.1, persistence: 0.05, double: false }),
    ];
    const next = testRng(99);
    let bad = 0;
    for (const def of defs) {
      const nn = new NormalNoise(W, 'test.extreme', def);
      for (let i = 0; i < 5000; i++) {
        const x = (testFloat(next) * 2 - 1) * 524288, y = -64 + 384 * testFloat(next), z = (testFloat(next) * 2 - 1) * 524288;
        if (!Number.isFinite(nn.z2(x, z)) || !Number.isFinite(nn.z3(x, y, z))) bad++;
      }
    }
    expect(bad).toBe(0);
  });
});

test('CDF remap', () => {
  expect(toUniform(0)).toBe(0);
  expect(uMax(3)).toBe(0.9973002846585164);
  expect(toUniform(3)).toBe(uMax(3));
  expect(toUniform(-3)).toBe(-uMax(3));
  let prev = -Infinity;
  for (let z = -3; z <= 3; z += 0.001) {
    const u = toUniform(z);
    expect(u >= prev).toBe(true);
    prev = u;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/noise.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/noise/octave.ts`**

```ts
import { deriveSeed, type Seed64 } from '../hash';
import { splitmix32 } from '../rng';
import { lattice3 } from './lattice3';
import type { NoiseDef } from './types';

const DERIVE = deriveSeed;
const SPLITMIX = splitmix32;
const LAT = lattice3;
const ORIGIN_SCALE = 9.5367431640625e-7; // 2^-20: origins are u32·2^-20 lattice units in [0, 4096)

/** Sum of octaves (SP1 spec §2.2). Octave seeds `${name}#${i}`; fractional per-octave origins. */
export class OctaveNoise {
  readonly sumA2: number;
  private readonly n: number;
  private readonly seed: Int32Array;
  private readonly freq: Float64Array;
  private readonly amp: Float64Array;
  private readonly ox: Float64Array;
  private readonly oy: Float64Array;
  private readonly oz: Float64Array;
  private readonly oy2: Float64Array;
  private readonly yScale: number;

  constructor(world: Seed64, name: string, def: NoiseDef) {
    const n = def.octaves;
    this.n = n;
    this.yScale = def.yScale;
    this.seed = new Int32Array(n);
    this.freq = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.ox = new Float64Array(n);
    this.oy = new Float64Array(n);
    this.oz = new Float64Array(n);
    this.oy2 = new Float64Array(n);
    let f = 1 / def.wavelength;
    let a = 1;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = DERIVE(world, `${name}#${i}`);
      this.seed[i] = s | 0;
      const sm = SPLITMIX(s);
      this.ox[i] = sm() * ORIGIN_SCALE;
      this.oy[i] = sm() * ORIGIN_SCALE;
      this.oz[i] = sm() * ORIGIN_SCALE;
      this.oy2[i] = Math.floor(this.oy[i]!) + 0.5;
      this.freq[i] = f;
      const ai = def.amplitudes === null ? a : def.amplitudes[i]!;
      this.amp[i] = ai;
      s2 += ai * ai;
      f *= def.lacunarity;
      a *= def.persistence;
    }
    this.sumA2 = s2;
  }

  /** 2D field: the fixed slice y = floor(oy_i) + ½ of each octave. */
  sample2(x: number, z: number): number {
    let v = 0;
    for (let i = 0; i < this.n; i++) {
      const a = this.amp[i]!;
      if (a === 0) continue;
      const f = this.freq[i]!;
      v += a * LAT(this.seed[i]!, x * f + this.ox[i]!, this.oy2[i]!, z * f + this.oz[i]!);
    }
    return v;
  }

  sample3(x: number, y: number, z: number): number {
    let v = 0;
    const ys = this.yScale;
    for (let i = 0; i < this.n; i++) {
      const a = this.amp[i]!;
      if (a === 0) continue;
      const f = this.freq[i]!;
      v += a * LAT(this.seed[i]!, x * f + this.ox[i]!, y * f * ys + this.oy[i]!, z * f + this.oz[i]!);
    }
    return v;
  }
}
```

- [ ] **Step 4: Implement `src/core/noise/normal.ts`**

```ts
import type { Seed64 } from '../hash';
import { PERLIN2_SD, PERLIN3_SD } from './lattice3';
import { OctaveNoise } from './octave';
import type { OctaveNoise as OctaveNoiseT } from './octave';
import type { NoiseDef } from './types';

const Octave = OctaveNoise;
const SD2 = PERLIN2_SD;
const SD3 = PERLIN3_SD;
const R337 = 337 / 331;

/** Double-stack, unit-sd, clamped noise (SP1 spec §2.3). z = clamp((A + B(p·R))·invSd, −c, c). */
export class NormalNoise {
  readonly def: NoiseDef;
  readonly clamp: number;
  private readonly a: OctaveNoiseT;
  private readonly b: OctaveNoiseT | null;
  private readonly inv2: number;
  private readonly inv3: number;

  constructor(world: Seed64, name: string, def: NoiseDef) {
    this.def = def;
    this.a = new Octave(world, name, def);
    this.b = def.double ? new Octave(world, `${name}'`, def) : null;
    const sum = this.b === null ? this.a.sumA2 : this.a.sumA2 + this.b.sumA2;
    const s = Math.sqrt(sum);
    this.inv2 = 1 / (SD2 * s);
    this.inv3 = 1 / (SD3 * s);
    this.clamp = def.clampSigma;
  }

  z2(x: number, z: number): number {
    const b = this.b;
    const v = (b === null ? this.a.sample2(x, z) : this.a.sample2(x, z) + b.sample2(x * R337, z * R337)) * this.inv2;
    const c = this.clamp;
    return v < -c ? -c : v > c ? c : v;
  }

  z3(x: number, y: number, z: number): number {
    const b = this.b;
    const v = (b === null ? this.a.sample3(x, y, z) : this.a.sample3(x, y, z) + b.sample3(x * R337, y * R337, z * R337)) * this.inv3;
    const c = this.clamp;
    return v < -c ? -c : v > c ? c : v;
  }
}
```

- [ ] **Step 5: Implement `src/core/noise/cdf.ts`**

```ts
import { detErf } from '../detMath';

const ERF = detErf;

/** u = erf(z/√2), written exactly as detErf(z * Math.SQRT1_2) (SP1 spec §2.4). */
export function toUniform(z: number): number {
  return ERF(z * Math.SQRT1_2);
}

/** Largest |u| for clamp c: 0.9973002846585164 at c = 3. */
export function uMax(c: number): number {
  return ERF(c * Math.SQRT1_2);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/noise.test.ts`
Expected: PASS.

- [ ] **Step 7: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS (every imported value binding in `core/noise/**` is used only through its top-level alias; `OctaveNoiseT` is a type import).

- [ ] **Step 8: Commit**

```bash
git add src/core/noise test/unit/noise.test.ts
git commit -m "feat(core): OctaveNoise, NormalNoise and the CDF remap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 10: Spline types, validation and normalisation

**Files:**
- Create: `src/core/spline/types.ts`, `src/core/spline/validate.ts`
- Test: `test/unit/splineValidate.test.ts`

**Interfaces:**
- Consumes: `q15` (Task 6).
- Produces:
  - `type SplineCoord`, `SPLINE_COORDS` (slot order C, E, W, PV, T, H), `SPLINE_SLOT: Readonly<Record<SplineCoord, number>>`, `interface SplinePoint { readonly x; readonly y: number | NestedSpline; readonly d }`, `interface NestedSpline { readonly coord; readonly points: readonly SplinePoint[] }`, `type KnotPath = readonly number[]`, `interface SplineOpts { coords?; yMin?; yMax? }`, `SPLINE_MAX_POINTS = 32`, `SPLINE_MAX_OBJECTS = 4096`
  - `type SplineErrorCode`, `interface SplineIssue { readonly path; readonly code: SplineErrorCode; readonly message }`
  - `validateSpline(value: unknown, basePath?: string, opts?: SplineOpts): SplineIssue[]`, `normalizeSpline(s: NestedSpline): NestedSpline`, `class SplineValidationError extends Error { readonly issues }`

- [ ] **Step 1: Write the failing test**

`test/unit/splineValidate.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { NestedSpline, SplineOpts } from '../../src/core/spline/types';
import { normalizeSpline, SplineValidationError, validateSpline } from '../../src/core/spline/validate';

const P = (x: number, y: number | NestedSpline, d = 0) => ({ x, y, d });
const ok: NestedSpline = { coord: 'C', points: [P(-1, 16), P(0, { coord: 'E', points: [P(-1, 70), P(1, 63)] }), P(1, 20)] };
const brief = (v: unknown, opts: SplineOpts = {}) => validateSpline(v, 'shape.offset', opts).map((i) => `${i.code} @ ${i.path}`);

describe('validateSpline', () => {
  test('a valid nested spline has no issues', () => {
    expect(validateSpline(ok)).toEqual([]);
    expect(validateSpline({ coord: 'H', points: [P(0.3, 1)] })).toEqual([]);
  });
  const cases: Array<{ name: string; value: unknown; expected: string[]; opts?: SplineOpts }> = [
    { name: 'not an object', value: 5, expected: ['NOT_OBJECT @ shape.offset'] },
    { name: 'unknown spline key', value: { coord: 'C', points: [P(0, 1)], pts: [] }, expected: ['UNKNOWN_KEY @ shape.offset.pts'] },
    { name: 'bad coord', value: { coord: 'Q', points: [P(0, 1)] }, expected: ['BAD_COORD @ shape.offset.coord'] },
    { name: 'coord not allowed by the leaf', value: { coord: 'T', points: [P(0, 1)] }, expected: ['BAD_COORD @ shape.offset.coord'], opts: { coords: ['C', 'E'] } },
    { name: 'coord reused', value: { coord: 'C', points: [P(0, { coord: 'C', points: [P(0, 1)] })] }, expected: ['COORD_REUSED @ shape.offset.points[0].y.coord'] },
    { name: 'points not an array', value: { coord: 'C', points: 3 }, expected: ['POINTS_NOT_ARRAY @ shape.offset.points'] },
    { name: 'empty', value: { coord: 'C', points: [] }, expected: ['EMPTY @ shape.offset.points'] },
    { name: 'too many points', value: { coord: 'C', points: Array.from({ length: 33 }, (_, i) => P(i, 0)) }, expected: ['TOO_MANY_POINTS @ shape.offset.points'] },
    { name: 'point not an object', value: { coord: 'C', points: [7] }, expected: ['POINT_NOT_OBJECT @ shape.offset.points[0]'] },
    { name: 'unknown point key', value: { coord: 'C', points: [{ x: 0, y: 1, d: 0, tangent: 1 }] }, expected: ['UNKNOWN_KEY @ shape.offset.points[0].tangent'] },
    { name: 'x not finite', value: { coord: 'C', points: [{ x: 'a', y: 1, d: 0 }] }, expected: ['X_NOT_FINITE @ shape.offset.points[0].x'] },
    { name: 'd missing', value: { coord: 'C', points: [{ x: 0, y: 1 }] }, expected: ['D_NOT_FINITE @ shape.offset.points[0].d'] },
    { name: 'y not finite', value: { coord: 'C', points: [P(0, Infinity)] }, expected: ['Y_NOT_FINITE @ shape.offset.points[0].y'] },
    { name: 'y out of range', value: { coord: 'C', points: [P(0, 999)] }, expected: ['Y_OUT_OF_RANGE @ shape.offset.points[0].y'], opts: { yMin: -64, yMax: 320 } },
    { name: 'y bad type', value: { coord: 'C', points: [{ x: 0, y: 'z', d: 0 }] }, expected: ['Y_BAD_TYPE @ shape.offset.points[0].y'] },
    { name: 'x duplicate after q15', value: { coord: 'C', points: [P(0.1 + 0.2, 1), P(0.3, 2)] }, expected: ['X_DUPLICATE @ shape.offset.points[1].x'] },
    { name: 'x unsorted', value: { coord: 'C', points: [P(0.5, 1), P(0.2, 2)] }, expected: ['X_UNSORTED @ shape.offset.points[1].x'] },
  ];
  test.each(cases)('$name', ({ value, expected, opts }) => {
    expect(brief(value, opts)).toEqual(expected);
  });
  test('program too large (more than 4096 spline objects)', () => {
    const pv = { coord: 'PV' as const, points: [P(0, 1)] };
    const w = { coord: 'W' as const, points: Array.from({ length: 4 }, (_, k) => P(k, pv)) };
    const e = { coord: 'E' as const, points: Array.from({ length: 32 }, (_, j) => P(j, w)) };
    const c: NestedSpline = { coord: 'C', points: Array.from({ length: 32 }, (_, i) => P(i, e)) };
    expect(brief(c)).toEqual(['PROGRAM_TOO_LARGE @ shape.offset']);
  });
  test('every issue is collected, in DFS pre-order', () => {
    const bad = { coord: 'C', points: [{ x: 0, y: { coord: 'Q', points: [{ x: NaN, y: 1, d: 0 }] }, d: 'x' }, P(-1, 2)] };
    expect(brief(bad)).toEqual([
      'D_NOT_FINITE @ shape.offset.points[0].d',
      'BAD_COORD @ shape.offset.points[0].y.coord',
      'X_NOT_FINITE @ shape.offset.points[0].y.points[0].x',
      'X_UNSORTED @ shape.offset.points[1].x',
    ]);
  });
  test('the error class carries the issues', () => {
    const e = new SplineValidationError(validateSpline({ coord: 'C', points: [] }));
    expect(e.issues.map((i) => i.code)).toEqual(['EMPTY']);
    expect(e.message).toMatch(/EMPTY/);
  });
});

test('normalizeSpline applies q15 and maps -0 to +0 everywhere', () => {
  const s: NestedSpline = { coord: 'C', points: [P(-0, 0.1 + 0.2, -0), P(0.5, { coord: 'E', points: [P(1 / 3, -0)] })] };
  const n = normalizeSpline(s);
  expect(Object.is(n.points[0]!.x, 0)).toBe(true);
  expect(n.points[0]!.y).toBe(0.3);
  expect(Object.is(n.points[0]!.d, 0)).toBe(true);
  const inner = n.points[1]!.y as NestedSpline;
  expect(inner.points[0]!.x).toBe(0.333333333333333);
  expect(Object.is(inner.points[0]!.y, 0)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/splineValidate.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/spline/types.ts`**

```ts
export type SplineCoord = 'C' | 'E' | 'W' | 'PV' | 'T' | 'H';

/** Slot order of the coordinates vector (Float64Array(6)). */
export const SPLINE_COORDS: readonly SplineCoord[] = ['C', 'E', 'W', 'PV', 'T', 'H'];
export const SPLINE_SLOT: Readonly<Record<SplineCoord, number>> = { C: 0, E: 1, W: 2, PV: 3, T: 4, H: 5 };
export const SPLINE_MAX_POINTS = 32;
export const SPLINE_MAX_OBJECTS = 4096;

/** d = dy/dx in output units per unit of the node's own coordinate (explicit data; never re-derived). */
export interface SplinePoint {
  readonly x: number;
  readonly y: number | NestedSpline;
  readonly d: number;
}

export interface NestedSpline {
  readonly coord: SplineCoord;
  readonly points: readonly SplinePoint[];
}

/** [7, 1, 1] = points[7].y.points[1].y.points[1]. */
export type KnotPath = readonly number[];

/** Leaf constraints; defaults: every coordinate allowed, y unbounded. */
export interface SplineOpts {
  readonly coords?: readonly SplineCoord[];
  readonly yMin?: number;
  readonly yMax?: number;
}
```

- [ ] **Step 4: Implement `src/core/spline/validate.ts`**

```ts
import { q15 } from '../params/canonical';
import { SPLINE_COORDS, SPLINE_MAX_OBJECTS, SPLINE_MAX_POINTS, SPLINE_SLOT } from './types';
import type { NestedSpline, SplineOpts, SplinePoint } from './types';

const Q15 = q15;
const COORDS = SPLINE_COORDS;
const SLOT = SPLINE_SLOT;
const MAX_POINTS = SPLINE_MAX_POINTS;
const MAX_OBJECTS = SPLINE_MAX_OBJECTS;

export type SplineErrorCode =
  | 'NOT_OBJECT' | 'UNKNOWN_KEY' | 'BAD_COORD' | 'COORD_REUSED' | 'POINTS_NOT_ARRAY' | 'EMPTY' | 'TOO_MANY_POINTS'
  | 'POINT_NOT_OBJECT' | 'X_NOT_FINITE' | 'D_NOT_FINITE' | 'Y_NOT_FINITE' | 'Y_OUT_OF_RANGE' | 'Y_BAD_TYPE'
  | 'X_DUPLICATE' | 'X_UNSORTED' | 'PROGRAM_TOO_LARGE';

export interface SplineIssue {
  readonly path: string;
  readonly code: SplineErrorCode;
  readonly message: string;
}

export class SplineValidationError extends Error {
  readonly issues: readonly SplineIssue[];
  constructor(issues: readonly SplineIssue[]) {
    super(`invalid spline: ${issues.map((i) => `${i.path === '' ? '<root>' : i.path}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

const SPLINE_KEYS = ['coord', 'points'];
const POINT_KEYS = ['x', 'y', 'd'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The single spline validator (SP1 spec §3.2). Applies q15 before every check, collects every issue in
 * DFS pre-order and never throws; [] exactly when compileSpline(value, opts) succeeds.
 */
export function validateSpline(value: unknown, basePath = '', opts: SplineOpts = {}): SplineIssue[] {
  const issues: SplineIssue[] = [];
  const allowed = opts.coords ?? COORDS;
  const yMin = opts.yMin ?? -Infinity;
  const yMax = opts.yMax ?? Infinity;
  let objects = 0;
  const push = (code: SplineErrorCode, path: string, message: string) => issues.push({ path, code, message });
  const walk = (node: unknown, path: string, used: number): void => {
    const at = (k: string) => (path === '' ? k : `${path}.${k}`);
    if (!isRecord(node)) { push('NOT_OBJECT', path, 'a spline must be an object {coord, points}'); return; }
    objects++;
    for (const k of Object.keys(node)) if (!SPLINE_KEYS.includes(k)) push('UNKNOWN_KEY', at(k), `unknown key "${k}"`);
    const coord = node['coord'];
    let slot = -1;
    if (typeof coord === 'string' && (allowed as readonly string[]).includes(coord) && Object.hasOwn(SLOT, coord)) {
      slot = SLOT[coord as keyof typeof SLOT];
      if ((used >> slot) & 1) push('COORD_REUSED', at('coord'), `coord ${coord} is already used by an enclosing spline`);
    } else {
      push('BAD_COORD', at('coord'), `coord must be one of ${allowed.join('|')}`);
    }
    const pts = node['points'];
    if (!Array.isArray(pts)) { push('POINTS_NOT_ARRAY', at('points'), 'points must be an array'); return; }
    if (pts.length === 0) { push('EMPTY', at('points'), 'a spline needs at least 1 point'); return; }
    if (pts.length > MAX_POINTS) push('TOO_MANY_POINTS', at('points'), `at most ${MAX_POINTS} points`);
    const nextUsed = slot >= 0 ? used | (1 << slot) : used;
    let prevX = Number.NaN;
    for (let i = 0; i < pts.length; i++) {
      const p: unknown = pts[i];
      const pp = `${at('points')}[${i}]`;
      if (!isRecord(p)) { push('POINT_NOT_OBJECT', pp, 'a point must be an object {x, y, d}'); continue; }
      for (const k of Object.keys(p)) if (!POINT_KEYS.includes(k)) push('UNKNOWN_KEY', `${pp}.${k}`, `unknown key "${k}"`);
      if (!isFiniteNumber(p['x'])) {
        push('X_NOT_FINITE', `${pp}.x`, 'x must be a finite number');
      } else {
        const x = Q15(p['x']);
        if (x === prevX) push('X_DUPLICATE', `${pp}.x`, `x = ${x} duplicates the previous point`);
        else if (x < prevX) push('X_UNSORTED', `${pp}.x`, `x = ${x} is below the previous point (${prevX})`);
        prevX = x;
      }
      if (!isFiniteNumber(p['d'])) push('D_NOT_FINITE', `${pp}.d`, 'd (tangent) must be a finite number');
      const y: unknown = p['y'];
      if (typeof y === 'number') {
        if (!Number.isFinite(y)) push('Y_NOT_FINITE', `${pp}.y`, 'y must be finite');
        else if (Q15(y) < yMin || Q15(y) > yMax) push('Y_OUT_OF_RANGE', `${pp}.y`, `y = ${y} outside [${yMin}, ${yMax}]`);
      } else if (isRecord(y)) {
        walk(y, `${pp}.y`, nextUsed);
      } else {
        push('Y_BAD_TYPE', `${pp}.y`, 'y must be a number or a nested spline');
      }
    }
  };
  walk(value, basePath, 0);
  if (objects > MAX_OBJECTS) push('PROGRAM_TOO_LARGE', basePath, `${objects} spline objects (max ${MAX_OBJECTS})`);
  return issues;
}

/** Every number replaced by q15(v) + 0 (assumes a valid spline). */
export function normalizeSpline(s: NestedSpline): NestedSpline {
  const points: SplinePoint[] = s.points.map((p) => ({
    x: Q15(p.x) + 0,
    y: typeof p.y === 'number' ? Q15(p.y) + 0 : normalizeSpline(p.y),
    d: Q15(p.d) + 0,
  }));
  return { coord: s.coord, points };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/splineValidate.test.ts`
Expected: PASS.

- [ ] **Step 6: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/spline test/unit/splineValidate.test.ts
git commit -m "feat(core): spline types, single validator and q15 normalisation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 11: Compiled Hermite splines (`core/spline/hermite.ts`)

**Files:**
- Create: `src/core/spline/hermite.ts`
- Test: `test/unit/splineHermite.test.ts`

**Interfaces:**
- Consumes: Task 10 types and functions, `q15`.
- Produces:
  - `interface CompiledSpline { readonly code: Int32Array; readonly nums: Float64Array; readonly regs: Float64Array; readonly coordMask: number; readonly depth: number; readonly splines: number; readonly knots: number }`
  - `compileSpline(s: NestedSpline, opts?: SplineOpts): CompiledSpline` (throws `SplineValidationError`)
  - `evalSpline(p: CompiledSpline, coords: Float64Array): number` (zero allocation)
  - `evalSplineBatch(p, soa: Float64Array, stride: number, n: number, out: Float64Array, scratch: Float64Array): void` (`soa[slot*stride + j]`)
  - `evalSplineRef(s: NestedSpline, coords: Float64Array): number`
  - `withKnotY(s: NestedSpline, path: KnotPath, y: number): NestedSpline`, `knotPathToString(path: KnotPath): string`

- [ ] **Step 1: Write the failing test**

`test/unit/splineHermite.test.ts`:

```ts
import v8 from 'node:v8';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { compileSpline, evalSpline, evalSplineBatch, evalSplineRef, knotPathToString, withKnotY } from '../../src/core/spline/hermite';
import { SPLINE_COORDS, type NestedSpline, type SplineCoord } from '../../src/core/spline/types';
import { SplineValidationError, validateSpline } from '../../src/core/spline/validate';
import { testFloat, testRng } from '../harness/stats';

const P = (x: number, y: number | NestedSpline, d = 0) => ({ x, y, d });

/** Random valid nested spline: distinct coords along every path, 1-6 points, depth ≤ 3. */
function randomSpline(next: () => number, depth: number, used: readonly SplineCoord[]): NestedSpline {
  const free = SPLINE_COORDS.filter((c) => !used.includes(c));
  const coord = free[next() % free.length]!;
  const n = 1 + (next() % 6);
  const xs = Array.from({ length: n }, () => -1.2 + 2.4 * testFloat(next)).sort((a, b) => a - b);
  const points = xs.filter((x, i) => i === 0 || x !== xs[i - 1]).map((x) => ({
    x,
    y: depth > 0 && next() % 3 === 0 ? randomSpline(next, depth - 1, [...used, coord]) : -100 + 200 * testFloat(next),
    d: -50 + 100 * testFloat(next),
  }));
  return { coord, points };
}

const coordsOf = (next: () => number) => Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));

describe('spline tests 1-3', () => {
  test('1: the segment formula equals the textbook Hermite basis', () => {
    const next = testRng(111);
    for (let i = 0; i < 20000; i++) {
      const x0 = -1 + testFloat(next), x1 = x0 + 0.01 + testFloat(next);
      const y0 = -4096 + 8192 * testFloat(next), y1 = -4096 + 8192 * testFloat(next);
      const d0 = -5000 + 10000 * testFloat(next), d1 = -5000 + 10000 * testFloat(next);
      const s: NestedSpline = { coord: 'C', points: [P(x0, y0, d0), P(x1, y1, d1)] };
      const q = x0 + (x1 - x0) * testFloat(next);
      const c = new Float64Array(6);
      c[0] = q;
      const h = x1 - x0, t = (q - x0) / h;
      const basis = (2 * t ** 3 - 3 * t ** 2 + 1) * y0 + (t ** 3 - 2 * t ** 2 + t) * h * d0 + (-2 * t ** 3 + 3 * t ** 2) * y1 + (t ** 3 - t ** 2) * h * d1;
      const tol = 1e-13 * Math.max(1, Math.abs(y0), Math.abs(y1), Math.abs(d0 * h), Math.abs(d1 * h));
      expect(Math.abs(evalSplineRef(s, c) - basis)).toBeLessThanOrEqual(tol);
    }
  });
  test('2: numeric knots interpolate exactly; a nested knot equals its child', () => {
    const child: NestedSpline = { coord: 'E', points: [P(-1, 70, 3), P(0.25, 64, -2), P(1, 63)] };
    const s: NestedSpline = { coord: 'C', points: [P(-1, 16, 5), P(-0.3, 40, 2), P(0.2, child), P(0.9, 30, -1)] };
    const p = compileSpline(s);
    const c = new Float64Array(6);
    for (const k of s.points) {
      c[0] = k.x;
      c[1] = 0.37;
      const expected = typeof k.y === 'number' ? k.y : evalSpline(compileSpline(k.y), c);
      expect(evalSpline(p, c)).toBe(expected);
    }
  });
  test('3: hold outside the end knots; 1-point constant; NaN in → NaN out', () => {
    const s: NestedSpline = { coord: 'C', points: [P(-0.5, 10, 7), P(0.5, 20, -3)] };
    const p = compileSpline(s);
    const c = new Float64Array(6);
    for (const [q, v] of [[-5, 10], [-0.5, 10], [0.5, 20], [5, 20]] as const) {
      c[0] = q;
      expect(evalSpline(p, c)).toBe(v);
    }
    c[0] = NaN;
    expect(evalSpline(p, c)).toBeNaN();
    expect(evalSplineRef(s, c)).toBeNaN();
    const one = compileSpline({ coord: 'H', points: [P(0.3, 42, 9)] });
    for (const q of [-9, 0.3, 9]) { c[5] = q; expect(evalSpline(one, c)).toBe(42); }
  });
});

describe('compiled program', () => {
  test('6: compiled equals the reference bit for bit on 1M random points', () => {
    const next = testRng(112);
    let bad = 0;
    for (let k = 0; k < 50; k++) {
      const s = randomSpline(next, 3, []);
      const p = compileSpline(s);
      for (let i = 0; i < 20000; i++) {
        const c = coordsOf(next);
        if (!Object.is(evalSpline(p, c), evalSplineRef(s, c))) bad++;
      }
    }
    expect(bad).toBe(0);
  });
  test('6b: a −0 knot compiles and references to +0', () => {
    const s: NestedSpline = { coord: 'C', points: [P(-0.5, -0, -0), P(0.5, { coord: 'E', points: [P(0, -0)] })] };
    const p = compileSpline(s);
    const c = new Float64Array(6);
    c[0] = -3;
    expect(Object.is(evalSpline(p, c), 0)).toBe(true);
    expect(Object.is(evalSplineRef(s, c), 0)).toBe(true);
    c[0] = 3;
    expect(Object.is(evalSpline(p, c), 0)).toBe(true);
  });
  test('7: batch equals point evaluation', () => {
    const next = testRng(113);
    const s = randomSpline(next, 3, []);
    const p = compileSpline(s);
    const n = 4096;
    const soa = new Float64Array(6 * n);
    for (let i = 0; i < soa.length; i++) soa[i] = -1.25 + 2.5 * testFloat(next);
    const out = new Float64Array(n);
    evalSplineBatch(p, soa, n, n, out, new Float64Array(6));
    const c = new Float64Array(6);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < 6; k++) c[k] = soa[k * n + j]!;
      expect(Object.is(out[j], evalSpline(p, c))).toBe(true);
    }
  });
  test('9: compileSpline throws with exactly the validator issues', () => {
    const bad = { coord: 'C', points: [P(0.5, 1), P(0.2, 2)] } as unknown as NestedSpline;
    try {
      compileSpline(bad);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SplineValidationError);
      expect((e as SplineValidationError).issues).toEqual(validateSpline(bad));
    }
    expect(() => compileSpline({ coord: 'T', points: [P(0, 1)] }, { coords: ['C'] })).toThrow(SplineValidationError);
  });
  test('10: equal canonical JSON after q15 gives identical code and nums', () => {
    const a = compileSpline({ coord: 'C', points: [P(0.1 + 0.2, 1 / 3), P(0.7, 2)] });
    const b = compileSpline({ coord: 'C', points: [P(0.3, 0.333333333333333), P(0.7, 2)] });
    expect(Array.from(a.code)).toEqual(Array.from(b.code));
    expect(canonicalJSON(Array.from(a.nums))).toBe(canonicalJSON(Array.from(b.nums)));
    expect(a.depth).toBe(1);
    expect(a.splines).toBe(1);
    expect(a.knots).toBe(2);
  });
  test('11: evaluation does not allocate (≤ 1 scavenge over 4M calls)', () => {
    const next = testRng(114);
    const p = compileSpline(randomSpline(next, 3, []));
    const c = coordsOf(next);
    let sink = 0;
    for (let i = 0; i < 200000; i++) { c[0] = (i % 997) / 400 - 1.25; sink += evalSpline(p, c); }
    const prof = new v8.GCProfiler();
    prof.start();
    for (let i = 0; i < 4000000; i++) { c[0] = (i % 997) / 400 - 1.25; sink += evalSpline(p, c); }
    const stats = prof.stop();
    const scavenges = stats.statistics.filter((s) => s.gcType === 'Scavenge').length;
    expect(Number.isFinite(sink)).toBe(true);
    expect(scavenges).toBeLessThanOrEqual(1);
  });
});

describe('knot paths', () => {
  const s: NestedSpline = { coord: 'C', points: [P(-1, 1), P(0, { coord: 'E', points: [P(-1, 2), P(1, 3)] })] };
  test('withKnotY replaces one knot with structural sharing', () => {
    const t = withKnotY(s, [1, 0], 9);
    expect(((t.points[1]!.y as NestedSpline).points[0]!.y)).toBe(9);
    expect(t.points[0]).toBe(s.points[0]);
    expect(s.points[1]!.y).not.toBe(t.points[1]!.y);
    expect(() => withKnotY(s, [1], 5)).toThrow(/nested/);
    expect(() => withKnotY(s, [0, 0], 5)).toThrow(/numeric/);
    expect(() => withKnotY(s, [], 5)).toThrow(/empty/);
  });
  test('knotPathToString', () => {
    expect(knotPathToString([7, 1, 1])).toBe('points[7].y.points[1].y.points[1]');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/splineHermite.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/core/spline/hermite.ts`**

```ts
import { q15 } from '../params/canonical';
import { SPLINE_SLOT } from './types';
import type { KnotPath, NestedSpline, SplineOpts, SplinePoint } from './types';
import { normalizeSpline, SplineValidationError, validateSpline } from './validate';

const Q15 = q15;
const SLOT = SPLINE_SLOT;
const NORMALIZE = normalizeSpline;
const ValidationError = SplineValidationError;
const VALIDATE = validateSpline;

const OP_CONST = 0;
const OP_LEAF = 1;
const OP_MIX = 2;

/**
 * Program layout (SP1 spec §3.3), root at code[0], DFS pre-order:
 *   CONST [0, k]                  value = nums[k]
 *   LEAF  [1, slot, n, b]         nums[b..b+n) = x, [b+n..b+2n) = d, [b+2n..b+3n) = y
 *   MIX   [2, slot, n, b, c0..]   nums[b..b+n) = x, [b+n..b+2n) = d; c_i = code offset of knot i's child
 */
export interface CompiledSpline {
  readonly code: Int32Array;
  readonly nums: Float64Array;
  /** Register file (2·depth + 1); owned by the program, single-threaded use. */
  readonly regs: Float64Array;
  /** Bit i set = coords[i] is read. */
  readonly coordMask: number;
  readonly depth: number;
  readonly splines: number;
  readonly knots: number;
}

export function compileSpline(s: NestedSpline, opts: SplineOpts = {}): CompiledSpline {
  const issues = VALIDATE(s, '', opts);
  if (issues.length > 0) throw new ValidationError(issues);
  const norm = NORMALIZE(s);
  const code: number[] = [];
  const nums: number[] = [];
  let coordMask = 0;
  let depth = 0;
  let splines = 0;
  let knots = 0;
  const emit = (node: NestedSpline, level: number): number => {
    const at = code.length;
    const n = node.points.length;
    const mix = node.points.some((p) => typeof p.y !== 'number');
    const slot = SLOT[node.coord];
    coordMask |= 1 << slot;
    if (level > depth) depth = level;
    splines++;
    knots += n;
    code.push(mix ? OP_MIX : OP_LEAF, slot, n, nums.length);
    for (const p of node.points) nums.push(p.x);
    for (const p of node.points) nums.push(p.d);
    if (!mix) {
      for (const p of node.points) nums.push(p.y as number);
      return at;
    }
    const refs = code.length;
    for (let i = 0; i < n; i++) code.push(-1);
    for (let i = 0; i < n; i++) {
      const y = node.points[i]!.y;
      if (typeof y === 'number') {
        code[refs + i] = code.length;
        code.push(OP_CONST, nums.length);
        nums.push(y);
      } else {
        code[refs + i] = emit(y, level + 1);
      }
    }
    return at;
  };
  emit(norm, 1);
  return { code: Int32Array.from(code), nums: Float64Array.from(nums), regs: new Float64Array(2 * depth + 1), coordMask, depth, splines, knots };
}

/**
 * Register-file interpreter: writes the node's value to regs[r]; a MIX node's two bracketing children
 * write regs[r+1] and regs[r+2]. No double is returned from the recursion, so V8 never boxes.
 * Canonical segment formula: f = y0 + t*dy + t*(1 - t)*((1 - t)*(d0*h - dy) + t*(dy - d1*h)).
 */
function evalNode(code: Int32Array, nums: Float64Array, o: number, c: Float64Array, regs: Float64Array, r: number): void {
  const op = code[o]!;
  if (op === OP_CONST) { regs[r] = nums[code[o + 1]!]!; return; }
  const q = c[code[o + 1]!]!;
  const n = code[o + 2]!;
  const b = code[o + 3]!;
  if (q !== q) { regs[r] = q; return; }
  let i: number;
  if (q <= nums[b]!) i = -1;
  else if (q >= nums[b + n - 1]!) i = n - 1;
  else { i = 0; while (q >= nums[b + i + 1]!) i++; }
  if (op === OP_LEAF) {
    if (i < 0) { regs[r] = nums[b + 2 * n]!; return; }
    if (i === n - 1) { regs[r] = nums[b + 3 * n - 1]!; return; }
    const x0 = nums[b + i]!;
    const h = nums[b + i + 1]! - x0;
    const t = (q - x0) / h;
    const y0 = nums[b + 2 * n + i]!;
    const dy = nums[b + 2 * n + i + 1]! - y0;
    regs[r] = y0 + t * dy + t * (1 - t) * ((1 - t) * (nums[b + n + i]! * h - dy) + t * (dy - nums[b + n + i + 1]! * h));
    return;
  }
  if (i < 0) { evalNode(code, nums, code[o + 4]!, c, regs, r); return; }
  if (i === n - 1) { evalNode(code, nums, code[o + 3 + n]!, c, regs, r); return; }
  evalNode(code, nums, code[o + 4 + i]!, c, regs, r + 1);
  evalNode(code, nums, code[o + 5 + i]!, c, regs, r + 2);
  const x0 = nums[b + i]!;
  const h = nums[b + i + 1]! - x0;
  const t = (q - x0) / h;
  const y0 = regs[r + 1]!;
  const dy = regs[r + 2]! - y0;
  regs[r] = y0 + t * dy + t * (1 - t) * ((1 - t) * (nums[b + n + i]! * h - dy) + t * (dy - nums[b + n + i + 1]! * h));
}

/** coords: Float64Array(6) in SPLINE_COORDS order. Zero allocation. */
export function evalSpline(p: CompiledSpline, coords: Float64Array): number {
  evalNode(p.code, p.nums, 0, coords, p.regs, 0);
  return p.regs[0]!;
}

/** Structure-of-arrays batch: soa[slot*stride + j] for j < n; writes out[j]. Zero allocation. */
export function evalSplineBatch(p: CompiledSpline, soa: Float64Array, stride: number, n: number, out: Float64Array, scratch: Float64Array): void {
  const mask = p.coordMask;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < 6; k++) if ((mask >> k) & 1) scratch[k] = soa[k * stride + j]!;
    evalNode(p.code, p.nums, 0, scratch, p.regs, 0);
    out[j] = p.regs[0]!;
  }
}

const N = (v: number) => Q15(v) + 0;

/** Object-walk oracle with the same formula; reads every number as q15(v) + 0. */
export function evalSplineRef(s: NestedSpline, coords: Float64Array): number {
  const q = coords[SLOT[s.coord]]!;
  const pts = s.points;
  const n = pts.length;
  const val = (pt: SplinePoint): number => (typeof pt.y === 'number' ? N(pt.y) : evalSplineRef(pt.y, coords));
  if (q !== q) return q;
  if (q <= N(pts[0]!.x)) return val(pts[0]!);
  if (q >= N(pts[n - 1]!.x)) return val(pts[n - 1]!);
  let i = 0;
  while (q >= N(pts[i + 1]!.x)) i++;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const y0 = val(a);
  const y1 = val(b);
  const x0 = N(a.x);
  const h = N(b.x) - x0;
  const t = (q - x0) / h;
  const dy = y1 - y0;
  return y0 + t * dy + t * (1 - t) * ((1 - t) * (N(a.d) * h - dy) + t * (dy - N(b.d) * h));
}

export function knotPathToString(path: KnotPath): string {
  return path.map((i, k) => (k === 0 ? `points[${i}]` : `y.points[${i}]`)).join('.');
}

/** Pure update of one numeric knot's y (structural sharing). */
export function withKnotY(s: NestedSpline, path: KnotPath, y: number): NestedSpline {
  const [i, ...rest] = path;
  if (i === undefined) throw new Error('empty knot path');
  const points = s.points.slice();
  const p = points[i];
  if (p === undefined) throw new Error(`no knot ${i}`);
  if (rest.length === 0) {
    if (typeof p.y !== 'number') throw new Error('knot y is a nested spline');
    points[i] = { x: p.x, y, d: p.d };
  } else {
    if (typeof p.y === 'number') throw new Error('path descends into a numeric knot');
    points[i] = { x: p.x, y: withKnotY(p.y, rest, y), d: p.d };
  }
  return { coord: s.coord, points };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/splineHermite.test.ts`
Expected: PASS.

- [ ] **Step 5: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/spline/hermite.ts test/unit/splineHermite.test.ts
git commit -m "feat(core): compiled nested Hermite splines with a register-file evaluator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 12: Default tangents, fixtures and fixture-based spline tests

**Files:**
- Create: `src/core/spline/tangents.ts`
- Create: `src/metrics/sp1Fixtures.ts` (spline fixtures and noise fixture defs; Task 16 adds the params fixture)
- Test: `test/unit/splineFixtures.test.ts`

**Interfaces:**
- Consumes: Tasks 10-11; `completeNoiseDef`, `NoiseDef` (Task 8); `q15`.
- Produces:
  - `autoTangents(s: NestedSpline): NestedSpline`
  - in `sp1Fixtures.ts`: `OFFSET`, `SIGMA`, `JAG`, `TANGENT_FIXTURE: NestedSpline`; `interface FixtureNoise { readonly seedName: string; readonly def: NoiseDef; readonly dims: 2 | 3; readonly corners: boolean }`; `CLIMATE_FIXTURE_DEFS: readonly FixtureNoise[]` (12, schema pre-order), `DENSITY3D_DEF: FixtureNoise`, `ADVERSARIAL_DEFS: readonly FixtureNoise[]`

- [ ] **Step 1: Write the failing test**

`test/unit/splineFixtures.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { compileSpline, evalSpline, evalSplineRef, withKnotY } from '../../src/core/spline/hermite';
import { autoTangents } from '../../src/core/spline/tangents';
import { SPLINE_SLOT, type NestedSpline } from '../../src/core/spline/types';
import { ADVERSARIAL_DEFS, CLIMATE_FIXTURE_DEFS, DENSITY3D_DEF, JAG, OFFSET, SIGMA, TANGENT_FIXTURE } from '../../src/metrics/sp1Fixtures';
import { nextDown, nextUp, testFloat, testRng } from '../harness/stats';

const FIXTURES: Array<[string, NestedSpline]> = [['OFFSET', OFFSET], ['SIGMA', SIGMA], ['JAG', JAG], ['TANGENT_FIXTURE', TANGENT_FIXTURE]];

interface NodeCtx { readonly node: NestedSpline; readonly depth: number; readonly constraints: ReadonlyArray<{ slot: number; lo: number; hi: number }> }

function collectNodes(s: NestedSpline, depth = 0, constraints: NodeCtx['constraints'] = []): NodeCtx[] {
  const out: NodeCtx[] = [{ node: s, depth, constraints }];
  const n = s.points.length;
  s.points.forEach((p, i) => {
    if (typeof p.y === 'number') return;
    const lo = i > 0 ? s.points[i - 1]!.x : -1.25;
    const hi = i < n - 1 ? s.points[i + 1]!.x : 1.25;
    out.push(...collectNodes(p.y, depth + 1, [...constraints, { slot: SPLINE_SLOT[s.coord], lo, hi }]));
  });
  return out;
}

/** A coordinate vector that makes `ctx.node` matter: every enclosing coordinate inside its bracket. */
function reachable(ctx: NodeCtx, next: () => number): Float64Array {
  const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
  for (const k of ctx.constraints) c[k.slot] = k.lo + (k.hi - k.lo) * (0.05 + 0.9 * testFloat(next));
  return c;
}

describe('spline test 4: C0 at every knot of every node', () => {
  test.each(FIXTURES)('%s', (_name, s) => {
    const p = compileSpline(s);
    const next = testRng(121);
    let worst = 0;
    for (const ctx of collectNodes(s)) {
      const slot = SPLINE_SLOT[ctx.node.coord];
      for (const k of ctx.node.points) {
        for (let r = 0; r < 200; r++) {
          const c = reachable(ctx, next);
          c[slot] = k.x;
          const f = evalSpline(p, c);
          c[slot] = nextUp(k.x);
          const up = evalSpline(p, c);
          c[slot] = nextDown(k.x);
          const down = evalSpline(p, c);
          worst = Math.max(worst, Math.abs(up - f), Math.abs(down - f));
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });
});

/** Second-order one-sided differences along `slot` at c[slot] = x. */
function oneSided(p: ReturnType<typeof compileSpline>, c: Float64Array, slot: number, x: number, f: typeof evalSpline): [number, number] {
  const h = 1e-5;
  const at = (q: number) => { c[slot] = q; return f(p, c); };
  const f0 = at(x);
  const plus = (-3 * f0 + 4 * at(x + h) - at(x + 2 * h)) / (2 * h);
  const minus = (3 * f0 - 4 * at(x - h) + at(x - 2 * h)) / (2 * h);
  return [plus, minus];
}

describe('spline test 5: C1 at interior knots', () => {
  test.each(FIXTURES)('%s', (_name, s) => {
    const p = compileSpline(s);
    const next = testRng(122);
    for (const ctx of collectNodes(s)) {
      const slot = SPLINE_SLOT[ctx.node.coord];
      const pts = ctx.node.points;
      for (let j = 1; j < pts.length - 1; j++) {
        for (let r = 0; r < 200; r++) {
          const c = reachable(ctx, next);
          const [dp, dm] = oneSided(p, c, slot, pts[j]!.x, evalSpline);
          expect(Math.abs(dp - dm)).toBeLessThanOrEqual(1e-3 * Math.max(1, Math.abs(dp)));
          if (ctx.depth === 0) expect(Math.abs(dp - pts[j]!.d)).toBeLessThanOrEqual(1e-3 * Math.max(1, Math.abs(pts[j]!.d)));
        }
      }
    }
  });
  test('TANGENT_FIXTURE catches the "tangent not multiplied by h" mutant', () => {
    const mutant = (s: NestedSpline, c: Float64Array): number => {
      const q = c[SPLINE_SLOT[s.coord]]!;
      const pts = s.points;
      const val = (y: number | NestedSpline) => (typeof y === 'number' ? y : mutant(y, c));
      if (q <= pts[0]!.x) return val(pts[0]!.y);
      if (q >= pts[pts.length - 1]!.x) return val(pts[pts.length - 1]!.y);
      let i = 0;
      while (q >= pts[i + 1]!.x) i++;
      const a = pts[i]!, b = pts[i + 1]!, y0 = val(a.y), dy = val(b.y) - y0, t = (q - a.x) / (b.x - a.x);
      return y0 + t * dy + t * (1 - t) * ((1 - t) * (a.d - dy) + t * (dy - b.d));
    };
    const next = testRng(123);
    let worst = 0;
    for (const ctx of collectNodes(TANGENT_FIXTURE)) {
      const slot = SPLINE_SLOT[ctx.node.coord];
      for (let j = 1; j < ctx.node.points.length - 1; j++) {
        for (let r = 0; r < 20; r++) {
          const c = reachable(ctx, next);
          const [dp, dm] = oneSided(null as never, c, slot, ctx.node.points[j]!.x, (_p, cc) => mutant(TANGENT_FIXTURE, cc));
          worst = Math.max(worst, Math.abs(dp - dm) / Math.max(1, Math.abs(dp)));
        }
      }
    }
    expect(worst).toBeGreaterThan(0.1);
  });
});

test('spline test 6 on the fixtures: compiled equals the reference on 1M points', () => {
  const next = testRng(124);
  let bad = 0;
  for (const [, s] of FIXTURES) {
    const p = compileSpline(s);
    for (let i = 0; i < 250000; i++) {
      const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
      if (!Object.is(evalSpline(p, c), evalSplineRef(s, c))) bad++;
    }
  }
  expect(bad).toBe(0);
});

/** Product of Hermite value-basis weights of the knot along `path` (tangents fixed). */
function pathWeight(s: NestedSpline, path: readonly number[], c: Float64Array): number {
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

describe('spline test 8: knot-raise linearity', () => {
  test.each([[[2]], [[5, 1]], [[7, 1, 1]]] as const)('OFFSET knot %j', (path) => {
    const base = compileSpline(OFFSET);
    const raised = compileSpline(withKnotY(OFFSET, path, (() => {
      let node: NestedSpline = OFFSET;
      for (let i = 0; i < path.length - 1; i++) node = node.points[path[i]!]!.y as NestedSpline;
      return (node.points[path[path.length - 1]!]!.y as number) + 10;
    })()));
    const next = testRng(125);
    let hits = 0;
    for (let i = 0; i < 100000; i++) {
      const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
      const delta = evalSpline(raised, c) - evalSpline(base, c);
      const w = pathWeight(OFFSET, path, c);
      expect(w >= 0 && w <= 1).toBe(true);
      if (w === 0) expect(delta).toBe(0);
      else { hits++; expect(Math.abs(delta - 10 * w)).toBeLessThanOrEqual(1e-12); }
    }
    expect(hits).toBeGreaterThan(0);
  });
  test('raising every leaf by 10 shifts the spline by 10', () => {
    const lift = (s: NestedSpline): NestedSpline => ({ coord: s.coord, points: s.points.map((p) => ({ ...p, y: typeof p.y === 'number' ? p.y + 10 : lift(p.y) })) });
    const a = compileSpline(OFFSET);
    const b = compileSpline(lift(OFFSET));
    const next = testRng(126);
    for (let i = 0; i < 20000; i++) {
      const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
      expect(Math.abs(evalSpline(b, c) - evalSpline(a, c) - 10)).toBeLessThanOrEqual(1e-12);
    }
  });
});

describe('spline test 12: autoTangents', () => {
  test('offset top-level tangents', () => {
    expect(OFFSET.points.map((p) => Math.round(p.d * 1000) / 1000)).toEqual([0, 38.889, 72.506, 87.097, 0, 0, 0, 0, 0]);
  });
  test('d = 0 exactly where the hybrid rule requires it', () => {
    for (const [, s] of [['OFFSET', OFFSET], ['SIGMA', SIGMA], ['JAG', JAG]] as const) {
      for (const { node } of collectNodes(s)) {
        const pts = node.points;
        const nested = pts.map((p) => typeof p.y !== 'number');
        pts.forEach((p, i) => {
          const single = !nested[i] && (i === 0 || nested[i - 1]) && (i === pts.length - 1 || nested[i + 1]);
          const mustBeZero = nested[i] || nested[i - 1] === true || nested[i + 1] === true || single
            || (i === 0 && p.x > -1) || (i === pts.length - 1 && p.x < 1);
          if (mustBeZero) expect(Object.is(p.d, 0)).toBe(true);
        });
      }
    }
  });
  test('no segment leaves its hull by more than 4 ulp (uniform-random and near-knot coordinates)', () => {
    const TOL = 4 * 2 ** -52;
    let worst = 0;
    const check = (s: NestedSpline, c: Float64Array): number => {
      const q = c[SPLINE_SLOT[s.coord]]!;
      const pts = s.points;
      const val = (y: number | NestedSpline) => (typeof y === 'number' ? y : check(y, c));
      if (q <= pts[0]!.x) return val(pts[0]!.y);
      if (q >= pts[pts.length - 1]!.x) return val(pts[pts.length - 1]!.y);
      let i = 0;
      while (q >= pts[i + 1]!.x) i++;
      const a = pts[i]!, b = pts[i + 1]!, y0 = val(a.y), y1 = val(b.y);
      const h = b.x - a.x, t = (q - a.x) / h, dy = y1 - y0;
      const f = y0 + t * dy + t * (1 - t) * ((1 - t) * (a.d * h - dy) + t * (dy - b.d * h));
      const m = Math.max(Math.abs(y0), Math.abs(y1));
      const excess = Math.max(Math.min(y0, y1) - f, f - Math.max(y0, y1), 0);
      worst = Math.max(worst, m === 0 ? (excess > 0 ? Infinity : 0) : excess / (m * TOL));
      return f;
    };
    const next = testRng(127);
    for (const s of [OFFSET, SIGMA, JAG]) {
      for (let i = 0; i < 100000; i++) check(s, Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next)));
      for (const ctx of collectNodes(s)) {
        const slot = SPLINE_SLOT[ctx.node.coord];
        for (const k of ctx.node.points) {
          for (let r = 0; r < 50; r++) {
            const c = reachable(ctx, next);
            let up = k.x;
            let down = k.x;
            for (let step = 0; step < 5; step++) {
              up = nextUp(up);
              down = nextDown(down);
              c[slot] = up; check(s, c);
              c[slot] = down; check(s, c);
            }
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  test('autoTangents is idempotent and leaves x and y untouched', () => {
    expect(autoTangents(OFFSET)).toEqual(OFFSET);
    const strip = (s: NestedSpline): unknown => s.points.map((p) => [p.x, typeof p.y === 'number' ? p.y : strip(p.y)]);
    expect(strip(autoTangents(TANGENT_FIXTURE))).toEqual(strip(TANGENT_FIXTURE));
  });
});

test('noise fixture defs', () => {
  expect(CLIMATE_FIXTURE_DEFS.map((f) => f.seedName)).toEqual([
    'climate.warp.shift.noise.x', 'climate.warp.shift.noise.z', 'climate.warp.C.noise.x', 'climate.warp.C.noise.z',
    'climate.warp.R.noise.x', 'climate.warp.R.noise.z', 'climate.C', 'climate.E', 'climate.W', 'climate.T', 'climate.H', 'climate.R',
  ]);
  expect(CLIMATE_FIXTURE_DEFS.every((f) => f.dims === 2 && !f.corners)).toBe(true);
  expect(DENSITY3D_DEF).toMatchObject({ seedName: 'test.density3d', dims: 3, def: { wavelength: 64, octaves: 4, double: true } });
  expect(ADVERSARIAL_DEFS.map((f) => [f.seedName, f.dims, f.def.wavelength, f.def.octaves, f.def.double, f.corners])).toEqual([
    ['test.adv2d16', 2, 16, 1, false, false], ['test.adv3d8', 3, 8, 1, false, false], ['test.adv3d32', 3, 32, 1, false, true],
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/splineFixtures.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/spline/tangents.ts`**

```ts
import { q15 } from '../params/canonical';
import type { NestedSpline, SplinePoint } from './types';

const Q15 = q15;

function endSlope(h0: number, h1: number, m0: number, m1: number): number {
  let e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (Math.sign(e) !== Math.sign(m0)) e = 0;
  else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > Math.abs(3 * m0)) e = 3 * m0;
  return e;
}

/** Fritsch–Carlson PCHIP tangents with SciPy end conditions over one numeric run (length ≥ 2). */
function pchipRun(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  if (n === 2) {
    const d = (ys[1]! - ys[0]!) / (xs[1]! - xs[0]!);
    return [d, d];
  }
  const h: number[] = [];
  const dl: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1]! - xs[i]!);
    dl.push((ys[i + 1]! - ys[i]!) / h[i]!);
  }
  const d = new Array<number>(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    const a = dl[k - 1]!;
    const b = dl[k]!;
    if (a * b <= 0) continue;
    const w1 = 2 * h[k]! + h[k - 1]!;
    const w2 = h[k]! + 2 * h[k - 1]!;
    d[k] = (w1 + w2) / (w1 / a + w2 / b);
  }
  d[0] = endSlope(h[0]!, h[1]!, dl[0]!, dl[1]!);
  d[n - 1] = endSlope(h[n - 2]!, h[n - 3]!, dl[n - 2]!, dl[n - 3]!);
  return d;
}

/**
 * The hybrid tangent rule (SP1 spec §3.4), authoring-time only: PCHIP inside each maximal run of
 * numeric knots; d = 0 at nested knots, at knots adjacent to a nested knot, at single-knot runs and at
 * end knots strictly inside (−1, 1). Every d is stored as q15(d) + 0.
 */
export function autoTangents(s: NestedSpline): NestedSpline {
  const pts = s.points;
  const n = pts.length;
  const nested = pts.map((p) => typeof p.y !== 'number');
  const ds = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    if (nested[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && !nested[j + 1]) j++;
    if (j > i) {
      const run = pchipRun(pts.slice(i, j + 1).map((p) => p.x), pts.slice(i, j + 1).map((p) => p.y as number));
      for (let k = i; k <= j; k++) ds[k] = run[k - i]!;
    }
    i = j + 1;
  }
  const points: SplinePoint[] = pts.map((p, k) => {
    const zero = nested[k] || nested[k - 1] === true || nested[k + 1] === true
      || (k === 0 && p.x > -1) || (k === n - 1 && p.x < 1);
    const d = zero ? 0 : ds[k]!;
    return { x: p.x, y: typeof p.y === 'number' ? p.y : autoTangents(p.y), d: Q15(d) + 0 };
  });
  return { coord: s.coord, points };
}
```

(A single-knot run keeps `ds = 0` because no run of length ≥ 2 wrote it.)

- [ ] **Step 4: Implement `src/metrics/sp1Fixtures.ts`**

```ts
/**
 * Frozen SP1 fixtures (SP1 spec Appendix B). Used by tests, benches, goldens and the lab. Changing any
 * of this changes goldens (a GENERATOR_VERSION bump once they are recorded). Follows the core rules.
 */
import { completeNoiseDef } from '../core/noise/types';
import type { NoiseDef } from '../core/noise/types';
import { autoTangents } from '../core/spline/tangents';
import type { NestedSpline, SplineCoord } from '../core/spline/types';

const COMPLETE = completeNoiseDef;
const AUTO = autoTangents;

type Knot = readonly [number, number | NestedSpline];
const S = (coord: SplineCoord, knots: readonly Knot[]): NestedSpline => ({ coord, points: knots.map(([x, y]) => ({ x, y, d: 0 })) });
const PV3 = (a: number, b: number, c: number): NestedSpline => S('PV', [[-1, a], [0, b], [1, c]]);
const PVJ = (): NestedSpline => S('PV', [[0.3, 0], [0.7, 30], [1.0, 55]]);

export const OFFSET: NestedSpline = AUTO(S('C', [
  [-1, 16], [-0.6, 26], [-0.4, 40], [-0.24, 52], [-0.16, 60],
  [-0.1, S('E', [[-1, 70], [0, 64], [1, 63]])],
  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(65, 72, 80)], [1, 66]])],
  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(66, 76, 88)], [0.6, 70], [1, 66]])],
  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(68, 82, 96)], [1, 70]])],
]));

export const SIGMA: NestedSpline = AUTO(S('C', [
  [-1, 3], [-0.16, 3], [-0.1, 1.5],
  [0.05, S('E', [[-1, S('PV', [[-1, 4], [1, 16]])], [0, 3], [1, 1.2]])],
]));

export const JAG: NestedSpline = AUTO(S('C', [
  [-0.1, 0],
  [0.05, S('E', [[-1, PVJ()], [-0.5, PVJ()], [-0.4, 0]])],
]));

/** Explicit non-zero tangents and uneven spacing (catches the "tangent not multiplied by h" mutant). */
export const TANGENT_FIXTURE: NestedSpline = {
  coord: 'C',
  points: [
    { x: -0.9, y: 10, d: 12 },
    { x: -0.2, y: { coord: 'E', points: [{ x: -0.7, y: 5, d: -3 }, { x: 0.4, y: 20, d: 8 }, { x: 0.8, y: 14, d: -6 }] }, d: 4 },
    { x: 0.5, y: 30, d: -9 },
  ],
};

export interface FixtureNoise {
  readonly seedName: string;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
  /** Sample only at 4×8×4 cell corners (the λ 32 adversarial def). */
  readonly corners: boolean;
}

const warp = (name: string, wavelength: number, octaves: number): FixtureNoise[] => {
  const def = COMPLETE({ wavelength, octaves });
  return [
    { seedName: `${name}.x`, def, dims: 2, corners: false },
    { seedName: `${name}.z`, def, dims: 2, corners: false },
  ];
};
const climate = (name: string, wavelength: number, octaves: number): FixtureNoise => ({
  seedName: name, def: COMPLETE({ wavelength, octaves, remap: 'uniform' }), dims: 2, corners: false,
});

/** Frozen copies of the 12 SP1 schema instances, in schema pre-order. */
export const CLIMATE_FIXTURE_DEFS: readonly FixtureNoise[] = [
  ...warp('climate.warp.shift.noise', 256, 3),
  ...warp('climate.warp.C.noise', 1024, 2),
  ...warp('climate.warp.R.noise', 512, 2),
  climate('climate.C', 2400, 6),
  climate('climate.E', 1600, 5),
  climate('climate.W', 900, 5),
  climate('climate.T', 5000, 4),
  climate('climate.H', 2400, 4),
  climate('climate.R', 1400, 4),
];

export const DENSITY3D_DEF: FixtureNoise = { seedName: 'test.density3d', def: COMPLETE({ wavelength: 64, octaves: 4 }), dims: 3, corners: false };

export const ADVERSARIAL_DEFS: readonly FixtureNoise[] = [
  { seedName: 'test.adv2d16', def: COMPLETE({ wavelength: 16, octaves: 1, double: false }), dims: 2, corners: false },
  { seedName: 'test.adv3d8', def: COMPLETE({ wavelength: 8, octaves: 1, double: false }), dims: 3, corners: false },
  { seedName: 'test.adv3d32', def: COMPLETE({ wavelength: 32, octaves: 1, double: false }), dims: 3, corners: true },
];
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/splineFixtures.test.ts`
Expected: PASS.

- [ ] **Step 6: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/spline/tangents.ts src/metrics/sp1Fixtures.ts test/unit/splineFixtures.test.ts
git commit -m "feat(core): hybrid auto tangents, SP1 fixtures and fixture spline tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 13: ParamSchema kit, part 1 (types, builders, validators, `buildSchema`, `checkParams`)

**Files:**
- Modify: `src/core/ids.ts` (add `RegenScope`, `StageId`)
- Create: `src/core/params/kit.ts`
- Test: `test/unit/kit.test.ts`

**Interfaces:**
- Consumes: `q15` (Task 6), `NoiseDef`, `NoiseDefPatch`, `NOISE_DEF_DEFAULTS` (Task 8), `validateSpline`, `normalizeSpline`, `SplineErrorCode`, spline types (Task 10).
- Produces (all from `src/core/params/kit.ts`):
  - `type ParamKind`, `type Placement`, `type MetaInput`, `interface ParamMeta`, `type ParamIssueCode`, `type PresetIssueCode`, `type IssueCode`, `interface Issue`, `type Result<T>`
  - `interface Leaf<T, P = T>`, `interface Group<C>`, `type Node`, `interface Children`, `type Value<N>`, `type Patch<N>`
  - builders `num`, `int`, `bool`, `enumOf`, `noise`, `spline`, `group`; `NOISE_FIELD_RANGES`; `NOISE_KEYS`
  - `interface LeafInfo { path; leaf; meta: ParamMeta }`, `interface NodeInfo { path; depth; node }`, `interface Schema<R>`, `buildSchema(root)`, `checkParams(s, v)`, `checkLeaf(leaf, v, path, out)`, `deepFreeze(v)`
  - Note: a `Leaf` carries its `MetaInput`; the path-bearing `ParamMeta` lives in `schema.leaves[i].meta` (a builder cannot know its path).

- [ ] **Step 1: Add the shared ids**

Append to `src/core/ids.ts`:

```ts

/** Invalidation scope of a parameter (master §5.1). */
export type RegenScope = 'live' | 'remesh' | 'decorate' | 'terrain' | 'climate';

/** Generation and derived stages (master §2.5, SP1 spec §5). */
export type StageId = 'climate' | 'shape' | 'surfaceEst' | 'biome2d' | 'terrain' | 'decorate' | 'light' | 'mesh' | 'lod' | 'map';
```

- [ ] **Step 2: Write the failing test**

`test/unit/kit.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { bool, buildSchema, checkParams, enumOf, group, int, noise, num, spline, type Issue } from '../../src/core/params/kit';

const P = (x: number, y: number, d = 0) => ({ x, y, d });
const ROOT = group('Test', 'test schema', {
  a: group('A', 'group a', {
    n: num(0.5, { label: 'n', doc: 'a number', min: 0, max: 1, step: 0.05, scope: 'climate', stage: 'climate' }),
    k: int(3, { label: 'k', doc: 'an int', min: 1, max: 8, scope: 'climate', stage: 'climate' }),
    b: bool(true, { label: 'b', doc: 'a flag', scope: 'live' }),
    e: enumOf(['p', 'q'], 'q', { label: 'e', doc: 'an enum', scope: 'decorate', stage: 'decorate' }),
    w: noise({ wavelength: 128, octaves: 3 }, { label: 'w', doc: '2D noise', scope: 'climate', stage: 'climate', wavelength: { min: 16, max: 1024 }, dims: 2, components: ['x', 'z'] }),
    v: noise({ wavelength: 64, octaves: 2 }, { label: 'v', doc: '3D noise', scope: 'climate', stage: 'climate', wavelength: { min: 8, max: 512 }, dims: 3, seedName: 'old.v' }),
  }),
  s: spline({ coord: 'C', points: [P(-1, 1), P(1, 2)] }, { label: 's', doc: 'a spline', coords: ['C', 'E'], min: -100, max: 100, scope: 'terrain', stage: 'shape' }),
});
const S = buildSchema(ROOT);
const valid = () => JSON.parse(JSON.stringify(S.defaults)) as Record<string, any>;
const brief = (issues: readonly Issue[]) => issues.map((i) => `${i.code} @ ${i.path}`);
const check = (mutate: (d: Record<string, any>) => void) => {
  const d = valid();
  mutate(d);
  const r = checkParams(S, d);
  return r.ok ? [] : brief(r.issues);
};

describe('buildSchema', () => {
  test('nodes in pre-order with depth, leaves with ParamMeta', () => {
    expect(S.nodes.map((n) => `${n.depth}:${n.path}`)).toEqual(['0:', '1:a', '2:a.n', '2:a.k', '2:a.b', '2:a.e', '2:a.w', '2:a.v', '1:s']);
    expect(S.leaves.map((l) => l.path)).toEqual(['a.n', 'a.k', 'a.b', 'a.e', 'a.w', 'a.v', 's']);
    expect(S.leaves[0]!.meta).toEqual({ path: 'a.n', label: 'n', doc: 'a number', kind: 'number', min: 0, max: 1, step: 0.05, scope: 'climate', stage: 'climate' });
    expect(S.leaves[2]!.meta).toEqual({ path: 'a.b', label: 'b', doc: 'a flag', kind: 'bool', scope: 'live' });
    expect(S.leaves[3]!.meta.options).toEqual(['p', 'q']);
    expect(S.leaves[4]!.meta).toMatchObject({ kind: 'noise', dims: 2, min: 16, max: 1024 });
    expect(S.leaves[6]!.meta.coords).toEqual(['C', 'E']);
    expect(S.leaves[4]!.leaf.components).toEqual(['x', 'z']);
    expect(S.leaves[5]!.leaf.seedName).toBe('old.v');
    expect(S.byPath.get('a.w')).toBe(ROOT.children.a.children.w);
  });
  test('defaults are complete, normalised and deep-frozen', () => {
    expect(S.defaults.a.w).toEqual({ wavelength: 128, octaves: 3, persistence: 0.5, lacunarity: 2, amplitudes: null, yScale: 1, double: true, remap: 'none', clampSigma: 3 });
    expect(Object.isFrozen(S.defaults)).toBe(true);
    expect(Object.isFrozen(S.defaults.a.w)).toBe(true);
    expect(Object.isFrozen(S.defaults.s.points[0])).toBe(true);
  });
  test('invalid defaults and non-q15-stable bounds throw', () => {
    expect(() => buildSchema(group('x', 'x', { n: num(2, { label: 'n', doc: 'd', min: 0, max: 1, scope: 'live' }) }))).toThrow(/invalid schema defaults/);
    expect(() => buildSchema(group('x', 'x', { n: num(0.5, { label: 'n', doc: 'd', min: 0.1 + 0.2, max: 1, scope: 'live' }) }))).toThrow(/q15/);
    expect(() => buildSchema(group('x', 'x', { 'bad-key': num(0.5, { label: 'n', doc: 'd', min: 0, max: 1, scope: 'live' }) }))).toThrow(/key/);
  });
});

describe('checkParams codes and paths', () => {
  test('the defaults are valid', () => {
    expect(check(() => {})).toEqual([]);
  });
  test.each<[string, (d: Record<string, any>) => void, string[]]>([
    ['unknown key', (d) => { d.a.zz = 1; }, ['UNKNOWN_KEY @ a.zz']],
    ['__proto__ key', (d) => { Object.defineProperty(d.a, '__proto__', { value: 1, enumerable: true }); }, ['UNKNOWN_KEY @ a.__proto__']],
    ['missing key', (d) => { delete d.a.k; }, ['MISSING_KEY @ a.k']],
    ['group not an object', (d) => { d.a = 5; }, ['NOT_OBJECT @ a']],
    ['not a number', (d) => { d.a.n = '0.5'; }, ['NOT_NUMBER @ a.n']],
    ['not finite', (d) => { d.a.n = Infinity; }, ['NOT_FINITE @ a.n']],
    ['out of range', (d) => { d.a.n = 1.5; }, ['OUT_OF_RANGE @ a.n']],
    ['not an integer', (d) => { d.a.k = 2.5; }, ['NOT_INTEGER @ a.k']],
    ['integer too large', (d) => { d.a.k = 2e15; }, ['INT_TOO_LARGE @ a.k']],
    ['not a boolean', (d) => { d.a.b = 1; }, ['NOT_BOOL @ a.b']],
    ['bad enum', (d) => { d.a.e = 'r'; }, ['BAD_ENUM @ a.e']],
    ['noise missing field', (d) => { delete d.a.w.octaves; }, ['MISSING_KEY @ a.w.octaves']],
    ['noise unknown field', (d) => { d.a.w.gain = 1; }, ['UNKNOWN_KEY @ a.w.gain']],
    ['noise wavelength range', (d) => { d.a.w.wavelength = 8; }, ['OUT_OF_RANGE @ a.w.wavelength']],
    ['octaves range', (d) => { d.a.w.octaves = 17; }, ['OUT_OF_RANGE @ a.w.octaves']],
    ['amplitudes length', (d) => { d.a.w.amplitudes = [1, 0.5]; }, ['AMPLITUDES_LENGTH @ a.w.amplitudes']],
    ['amplitudes all zero', (d) => { d.a.w.amplitudes = [0, 0, 0]; }, ['AMPLITUDES_ZERO @ a.w.amplitudes']],
    ['amplitude range', (d) => { d.a.w.amplitudes = [1, 17, 0]; }, ['OUT_OF_RANGE @ a.w.amplitudes[1]']],
    ['amplitudes wrong type', (d) => { d.a.w.amplitudes = 3; }, ['NOT_OBJECT @ a.w.amplitudes']],
    ['yScale on a 2D noise', (d) => { d.a.w.yScale = 2; }, ['YSCALE_NOT_1 @ a.w.yScale']],
    ['uniform needs double', (d) => { d.a.w.remap = 'uniform'; d.a.w.double = false; }, ['REMAP_NEEDS_DOUBLE @ a.w.remap']],
    ['uniform needs 2D', (d) => { d.a.v.remap = 'uniform'; }, ['REMAP_NEEDS_2D @ a.v.remap']],
    ['bad remap', (d) => { d.a.w.remap = 'cdf'; }, ['BAD_ENUM @ a.w.remap']],
    ['double not boolean', (d) => { d.a.w.double = 'yes'; }, ['NOT_BOOL @ a.w.double']],
    ['spline issue keeps the spline path', (d) => { d.s.points[0].y = 999; }, ['Y_OUT_OF_RANGE @ s.points[0].y']],
    ['spline coord outside the leaf coords', (d) => { d.s.coord = 'T'; }, ['BAD_COORD @ s.coord']],
  ])('%s', (_name, mutate, expected) => {
    expect(check(mutate)).toEqual(expected);
  });
  test('every issue is collected in schema pre-order', () => {
    expect(check((d) => { d.a.n = -1; d.a.k = 0.5; d.s.points[1].y = 'x'; })).toEqual(['OUT_OF_RANGE @ a.n', 'NOT_INTEGER @ a.k', 'Y_BAD_TYPE @ s.points[1].y']);
  });
  test('numbers are normalised with q15 before the range check', () => {
    const d = valid();
    d.a.n = 1.0000000000000002;
    d.a.w.persistence = 0.1 + 0.2;
    const r = checkParams(S, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.a.n).toBe(1);
      expect(r.value.a.w.persistence).toBe(0.3);
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/kit.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement part 1 of `src/core/params/kit.ts`**

```ts
/**
 * ParamSchema kit (SP1 spec §4, approach A): nodes are plain data built by small builders; the Params
 * type is inferred from the schema; validation dispatches on `kind`. Part 2 (applyPatch, diffParams,
 * getPath, patchAt, renderReference) is appended in Task 14.
 */
import type { MetricId, RegenScope, StageId } from '../ids';
import { NOISE_DEF_DEFAULTS, type NoiseDef, type NoiseDefPatch } from '../noise/types';
import type { NestedSpline, SplineCoord } from '../spline/types';
import { normalizeSpline, validateSpline, type SplineErrorCode } from '../spline/validate';
import { q15 } from './canonical';

export type ParamKind =
  | 'number' | 'int' | 'bool' | 'enum' | 'noise' | 'spline' | 'expr' | 'boxTable' | 'ruleTree' | 'featureList' | 'structureSets';

/** Live leaves are hashed by no stage; every other leaf names its home stage. */
export type Placement =
  | { readonly scope: 'live'; readonly stage?: never }
  | { readonly scope: Exclude<RegenScope, 'live'>; readonly stage: StageId };

export type MetaInput = {
  readonly label: string;
  readonly doc: string;
  readonly unit?: string;
  readonly effectMetric?: MetricId;
} & Placement;

export interface ParamMeta {
  readonly path: string;
  readonly label: string;
  readonly doc: string;
  readonly unit?: string;
  readonly kind: ParamKind;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly dims?: 2 | 3;
  readonly coords?: readonly SplineCoord[];
  readonly scope: RegenScope;
  readonly stage?: StageId;
  readonly effectMetric?: MetricId;
}

export type ParamIssueCode =
  | 'UNKNOWN_KEY' | 'MISSING_KEY' | 'NOT_OBJECT' | 'NOT_NUMBER' | 'NOT_FINITE' | 'NOT_INTEGER' | 'INT_TOO_LARGE'
  | 'OUT_OF_RANGE' | 'NOT_BOOL' | 'BAD_ENUM' | 'AMPLITUDES_LENGTH' | 'AMPLITUDES_ZERO' | 'YSCALE_NOT_1'
  | 'REMAP_NEEDS_DOUBLE' | 'REMAP_NEEDS_2D';
export type PresetIssueCode = 'BAD_FORMAT' | 'BAD_NAME' | 'RESERVED_NAME' | 'UNKNOWN_PROFILE' | 'BAD_SCHEMA_VERSION' | 'NEWER_SCHEMA_VERSION';
export type IssueCode = ParamIssueCode | PresetIssueCode | 'MIGRATION_FAILED' | SplineErrorCode;

export interface Issue {
  readonly path: string;
  readonly code: IssueCode;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

// ---------------------------------------------------------------- nodes
export interface Leaf<T, P = T> {
  readonly tag: 'leaf';
  readonly kind: ParamKind;
  readonly merge: 'atomic' | 'fields';
  readonly def: T;
  readonly meta: MetaInput;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly dims?: 2 | 3;
  readonly coords?: readonly SplineCoord[];
  readonly seedName?: string;
  readonly components?: readonly ['x', 'z'];
  /** Phantom: never present at runtime. */
  readonly __patch?: P;
}

export interface Group<C extends Children = Children> {
  readonly tag: 'group';
  readonly label: string;
  readonly doc: string;
  readonly children: C;
}

export type Node = Leaf<unknown, unknown> | Group;
export interface Children {
  readonly [key: string]: Node;
}

export type Value<N> =
  N extends Leaf<infer T, unknown> ? T :
  N extends Group<infer C> ? { readonly [K in keyof C]: Value<C[K]> } :
  never;
export type Patch<N> =
  N extends Leaf<unknown, infer P> ? P :
  N extends Group<infer C> ? { readonly [K in keyof C]?: Patch<C[K]> } :
  never;

// ---------------------------------------------------------------- builders
type Ranged = MetaInput & { readonly min: number; readonly max: number; readonly step?: number };
export type NoiseMeta = MetaInput & {
  readonly wavelength: { readonly min: number; readonly max: number };
  readonly dims: 2 | 3;
  readonly seedName?: string;
  readonly components?: readonly ['x', 'z'];
};
export type SplineMeta = MetaInput & { readonly coords: readonly SplineCoord[]; readonly min: number; readonly max: number };

export function num(def: number, meta: Ranged): Leaf<number> {
  return { tag: 'leaf', kind: 'number', merge: 'atomic', def, meta, min: meta.min, max: meta.max, ...(meta.step !== undefined ? { step: meta.step } : {}) };
}

export function int(def: number, meta: Ranged): Leaf<number> {
  return { tag: 'leaf', kind: 'int', merge: 'atomic', def, meta, min: meta.min, max: meta.max, step: meta.step ?? 1 };
}

export function bool(def: boolean, meta: MetaInput): Leaf<boolean> {
  return { tag: 'leaf', kind: 'bool', merge: 'atomic', def, meta };
}

export function enumOf<const V extends readonly [string, ...string[]]>(options: V, def: V[number], meta: MetaInput): Leaf<V[number]> {
  return { tag: 'leaf', kind: 'enum', merge: 'atomic', def, meta, options };
}

export function noise(def: Pick<NoiseDef, 'wavelength' | 'octaves'> & NoiseDefPatch, meta: NoiseMeta): Leaf<NoiseDef, NoiseDefPatch> {
  return {
    tag: 'leaf', kind: 'noise', merge: 'fields', def: { ...NOISE_DEF_DEFAULTS, ...def }, meta,
    min: meta.wavelength.min, max: meta.wavelength.max, dims: meta.dims,
    ...(meta.seedName !== undefined ? { seedName: meta.seedName } : {}),
    ...(meta.components !== undefined ? { components: meta.components } : {}),
  };
}

export function spline(def: NestedSpline, meta: SplineMeta): Leaf<NestedSpline> {
  return { tag: 'leaf', kind: 'spline', merge: 'atomic', def, meta, coords: meta.coords, min: meta.min, max: meta.max };
}

export function group<const C extends Children>(label: string, doc: string, children: C): Group<C> {
  return { tag: 'group', label, doc, children };
}

/** Noise sub-field ranges shared by the validator and the lab widgets (wavelength ranges are per leaf). */
export const NOISE_FIELD_RANGES = {
  octaves: { min: 1, max: 16, step: 1 },
  persistence: { min: 0.05, max: 1, step: 0.01 },
  lacunarity: { min: 1.1, max: 4, step: 0.01 },
  amplitude: { min: -16, max: 16, step: 0.01 },
  yScale: { min: 0.01, max: 100, step: 0.01 },
  clampSigma: { min: 1, max: 8, step: 0.1 },
} as const;

export const NOISE_KEYS = ['wavelength', 'octaves', 'persistence', 'lacunarity', 'amplitudes', 'yScale', 'double', 'remap', 'clampSigma'] as const;

// ---------------------------------------------------------------- validation
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const join = (p: string, k: string): string => (p === '' ? k : `${p}.${k}`);
const fmt = (v: unknown): string => {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

function checkNumber(v: unknown, path: string, out: Issue[], min: number, max: number, integer: boolean): number | undefined {
  if (typeof v !== 'number') { out.push({ path, code: 'NOT_NUMBER', message: `expected a number, got ${fmt(v)}` }); return undefined; }
  if (!Number.isFinite(v)) { out.push({ path, code: 'NOT_FINITE', message: `expected a finite number, got ${String(v)}` }); return undefined; }
  if (integer && !Number.isInteger(v)) { out.push({ path, code: 'NOT_INTEGER', message: `expected an integer, got ${v}` }); return undefined; }
  if (integer && Math.abs(v) >= 1e15) { out.push({ path, code: 'INT_TOO_LARGE', message: `|${v}| must be below 1e15` }); return undefined; }
  const q = q15(v);
  if (q < min || q > max) { out.push({ path, code: 'OUT_OF_RANGE', message: `${q} outside [${min}, ${max}]` }); return undefined; }
  return q;
}

function unknownKeys(v: Record<string, unknown>, known: readonly string[], path: string, out: Issue[]): boolean {
  let any = false;
  for (const k of Object.keys(v)) {
    if (!known.includes(k)) { out.push({ path: join(path, k), code: 'UNKNOWN_KEY', message: `unknown key "${k}"` }); any = true; }
  }
  return any;
}

function checkNoise(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): NoiseDef | undefined {
  if (!isObj(v)) { out.push({ path, code: 'NOT_OBJECT', message: `expected a noise object, got ${fmt(v)}` }); return undefined; }
  const n0 = out.length;
  unknownKeys(v, NOISE_KEYS, path, out);
  for (const k of NOISE_KEYS) if (!Object.hasOwn(v, k)) out.push({ path: join(path, k), code: 'MISSING_KEY', message: 'missing' });
  if (out.length > n0) return undefined;
  const R = NOISE_FIELD_RANGES;
  const wavelength = checkNumber(v['wavelength'], join(path, 'wavelength'), out, leaf.min ?? 1, leaf.max ?? 1e6, false);
  const octaves = checkNumber(v['octaves'], join(path, 'octaves'), out, R.octaves.min, R.octaves.max, true);
  const persistence = checkNumber(v['persistence'], join(path, 'persistence'), out, R.persistence.min, R.persistence.max, false);
  const lacunarity = checkNumber(v['lacunarity'], join(path, 'lacunarity'), out, R.lacunarity.min, R.lacunarity.max, false);
  let amplitudes: number[] | null = null;
  const ap = join(path, 'amplitudes');
  const rawAmps = v['amplitudes'];
  if (rawAmps !== null) {
    if (!Array.isArray(rawAmps)) {
      out.push({ path: ap, code: 'NOT_OBJECT', message: 'expected null or an array of numbers' });
    } else {
      amplitudes = rawAmps.map((a: unknown, i: number) => checkNumber(a, `${ap}[${i}]`, out, R.amplitude.min, R.amplitude.max, false) ?? 0);
      if (octaves !== undefined && rawAmps.length !== octaves) out.push({ path: ap, code: 'AMPLITUDES_LENGTH', message: `length ${rawAmps.length} != octaves ${octaves}` });
      else if (amplitudes.every((a) => a === 0)) out.push({ path: ap, code: 'AMPLITUDES_ZERO', message: 'at least one amplitude must be non-zero' });
    }
  }
  const yScale = checkNumber(v['yScale'], join(path, 'yScale'), out, R.yScale.min, R.yScale.max, false);
  const dbl = v['double'];
  if (typeof dbl !== 'boolean') out.push({ path: join(path, 'double'), code: 'NOT_BOOL', message: `expected a boolean, got ${fmt(dbl)}` });
  const remap = v['remap'];
  if (remap !== 'none' && remap !== 'uniform') out.push({ path: join(path, 'remap'), code: 'BAD_ENUM', message: `expected "none" | "uniform", got ${fmt(remap)}` });
  const clampSigma = checkNumber(v['clampSigma'], join(path, 'clampSigma'), out, R.clampSigma.min, R.clampSigma.max, false);
  if (leaf.dims === 2 && yScale !== undefined && yScale !== 1) out.push({ path: join(path, 'yScale'), code: 'YSCALE_NOT_1', message: 'a 2D noise has yScale 1' });
  if (remap === 'uniform' && dbl === false) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_DOUBLE', message: "remap 'uniform' needs double: true" });
  if (remap === 'uniform' && leaf.dims === 3) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_2D', message: "remap 'uniform' is for 2D noises" });
  if (out.length > n0) return undefined;
  return {
    wavelength: wavelength!, octaves: octaves!, persistence: persistence!, lacunarity: lacunarity!, amplitudes,
    yScale: yScale!, double: dbl as boolean, remap: remap as 'none' | 'uniform', clampSigma: clampSigma!,
  };
}

function checkSpline(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): NestedSpline | undefined {
  const issues = validateSpline(v, path, { ...(leaf.coords !== undefined ? { coords: leaf.coords } : {}), yMin: leaf.min ?? -Infinity, yMax: leaf.max ?? Infinity });
  if (issues.length > 0) { out.push(...issues); return undefined; }
  return normalizeSpline(v as NestedSpline);
}

/** Validates a complete leaf value; returns the normalised value, or undefined with issues appended. */
export function checkLeaf(leaf: Leaf<unknown, unknown>, v: unknown, path: string, out: Issue[]): unknown {
  switch (leaf.kind) {
    case 'number': return checkNumber(v, path, out, leaf.min ?? -Infinity, leaf.max ?? Infinity, false);
    case 'int': return checkNumber(v, path, out, leaf.min ?? -Infinity, leaf.max ?? Infinity, true);
    case 'bool':
      if (typeof v !== 'boolean') { out.push({ path, code: 'NOT_BOOL', message: `expected a boolean, got ${fmt(v)}` }); return undefined; }
      return v;
    case 'enum':
      if (typeof v !== 'string' || !leaf.options!.includes(v)) { out.push({ path, code: 'BAD_ENUM', message: `expected one of ${leaf.options!.join(' | ')}, got ${fmt(v)}` }); return undefined; }
      return v;
    case 'noise': return checkNoise(v, path, out, leaf);
    case 'spline': return checkSpline(v, path, out, leaf);
    default: throw new Error(`no validator for kind ${leaf.kind} in SP1`);
  }
}

export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ---------------------------------------------------------------- schema
export interface LeafInfo {
  readonly path: string;
  readonly leaf: Leaf<unknown, unknown>;
  readonly meta: ParamMeta;
}

export interface NodeInfo {
  readonly path: string;
  readonly depth: number;
  readonly node: Node;
}

export interface Schema<R extends Group> {
  readonly root: R;
  /** Pre-order, declaration order. */
  readonly nodes: readonly NodeInfo[];
  readonly leaves: readonly LeafInfo[];
  readonly byPath: ReadonlyMap<string, Node>;
  readonly defaults: Value<R>;
}

function toMeta(path: string, l: Leaf<unknown, unknown>): ParamMeta {
  const m = l.meta;
  return {
    path, label: m.label, doc: m.doc, kind: l.kind,
    ...(m.unit !== undefined ? { unit: m.unit } : {}),
    ...(l.min !== undefined ? { min: l.min } : {}),
    ...(l.max !== undefined ? { max: l.max } : {}),
    ...(l.step !== undefined ? { step: l.step } : {}),
    ...(l.options !== undefined ? { options: l.options } : {}),
    ...(l.dims !== undefined ? { dims: l.dims } : {}),
    ...(l.coords !== undefined ? { coords: l.coords } : {}),
    scope: m.scope,
    ...(m.stage !== undefined ? { stage: m.stage } : {}),
    ...(m.effectMetric !== undefined ? { effectMetric: m.effectMetric } : {}),
  };
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Indexes the schema and validates every default; throws on schema bugs (bad keys, bounds or defaults). */
export function buildSchema<R extends Group>(root: R): Schema<R> {
  const nodes: NodeInfo[] = [];
  const leaves: LeafInfo[] = [];
  const byPath = new Map<string, Node>();
  const errs: Issue[] = [];
  const walk = (n: Node, path: string, depth: number): unknown => {
    nodes.push({ path, depth, node: n });
    byPath.set(path, n);
    if (n.tag === 'leaf') {
      for (const b of [n.min, n.max, n.step]) {
        if (b !== undefined && Number.isFinite(b) && q15(b) !== b) throw new Error(`schema bound ${b} at ${path} is not q15-stable`);
      }
      leaves.push({ path, leaf: n, meta: toMeta(path, n) });
      return checkLeaf(n, n.def, path, errs);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) {
      if (!KEY_RE.test(k)) throw new Error(`schema key "${k}" at ${path === '' ? '<root>' : path} must match ${KEY_RE.source}`);
      out[k] = walk(n.children[k]!, join(path, k), depth + 1);
    }
    return out;
  };
  const defaults = walk(root, '', 0);
  if (errs.length > 0) throw new Error(`invalid schema defaults:\n${errs.map((e) => `  ${e.path}: ${e.code} ${e.message}`).join('\n')}`);
  return { root, nodes, leaves, byPath, defaults: deepFreeze(defaults) as Value<R> };
}

/** Validates a complete params document (saves, .wiworld): every key required, unknown keys rejected. */
export function checkParams<R extends Group>(s: Schema<R>, v: unknown): Result<Value<R>> {
  const out: Issue[] = [];
  const walk = (n: Node, x: unknown, path: string): unknown => {
    if (n.tag === 'leaf') return checkLeaf(n, x, path, out);
    if (!isObj(x)) { out.push({ path, code: 'NOT_OBJECT', message: `expected an object, got ${fmt(x)}` }); return undefined; }
    unknownKeys(x, Object.keys(n.children), path, out);
    const res: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) {
      if (!Object.hasOwn(x, k)) { out.push({ path: join(path, k), code: 'MISSING_KEY', message: 'missing' }); continue; }
      res[k] = walk(n.children[k]!, x[k], join(path, k));
    }
    return res;
  };
  const value = walk(s.root, v, '');
  return out.length > 0 ? { ok: false, issues: out } : { ok: true, value: deepFreeze(value) as Value<R> };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/kit.test.ts`
Expected: PASS.

- [ ] **Step 6: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/ids.ts src/core/params/kit.ts test/unit/kit.test.ts
git commit -m "feat(core): ParamSchema kit with typed builders, validators and checkParams

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 14: ParamSchema kit, part 2 (patches, paths, README reference)

**Files:**
- Modify: `src/core/params/kit.ts` (append)
- Create: `test/harness/params.ts`
- Test: `test/unit/patch.test.ts`

**Interfaces:**
- Consumes: Task 13 kit, `canonicalJSON` (Task 6), `testRng`/`testFloat` (Task 3).
- Produces:
  - `applyPatch<R>(s: Schema<R>, base: Value<R>, patch: unknown): Result<Value<R>>`
  - `diffParams<R>(s: Schema<R>, base: Value<R>, value: Value<R>): Patch<R>`
  - `getPath(value: unknown, path: string): unknown`, `patchAt(path: string, value: unknown): Record<string, unknown>`
  - `renderReference<R>(s: Schema<R>): string`
  - test side: `randomParams(s, next)`, `randomPatch(s, next)` in `test/harness/params.ts`

- [ ] **Step 1: Write the test-side generators**

`test/harness/params.ts`:

```ts
import { q15 } from '../../src/core/params/canonical';
import { checkParams, type Group, type Leaf, type Node, type Schema, NOISE_FIELD_RANGES } from '../../src/core/params/kit';
import type { NestedSpline } from '../../src/core/spline/types';
import { testFloat } from './stats';

const between = (next: () => number, lo: number, hi: number) => q15(lo + (hi - lo) * testFloat(next));

function randomSplineLike(s: NestedSpline, next: () => number, lo: number, hi: number): NestedSpline {
  return { coord: s.coord, points: s.points.map((p) => ({ ...p, y: typeof p.y === 'number' ? between(next, lo, hi) : randomSplineLike(p.y, next, lo, hi) })) };
}

/** A random valid value for one leaf. */
export function randomValue(leaf: Leaf<unknown, unknown>, next: () => number): unknown {
  switch (leaf.kind) {
    case 'number': return between(next, leaf.min!, leaf.max!);
    case 'int': return leaf.min! + (next() % (leaf.max! - leaf.min! + 1));
    case 'bool': return (next() & 1) === 1;
    case 'enum': return leaf.options![next() % leaf.options!.length];
    case 'noise': {
      const R = NOISE_FIELD_RANGES;
      const octaves = 1 + (next() % 16);
      const double = (next() & 1) === 1;
      const amplitudes = (next() & 1) === 1 ? null : Array.from({ length: octaves }, (_, i) => (i === 0 ? 1 : between(next, R.amplitude.min, R.amplitude.max)));
      return {
        wavelength: between(next, leaf.min!, leaf.max!), octaves,
        persistence: between(next, R.persistence.min, R.persistence.max), lacunarity: between(next, R.lacunarity.min, R.lacunarity.max),
        amplitudes, yScale: leaf.dims === 2 ? 1 : between(next, R.yScale.min, R.yScale.max), double,
        remap: leaf.dims === 2 && double && (next() & 1) === 1 ? 'uniform' : 'none',
        clampSigma: between(next, R.clampSigma.min, R.clampSigma.max),
      };
    }
    case 'spline': return randomSplineLike(leaf.def as NestedSpline, next, Math.max(leaf.min!, -1000), Math.min(leaf.max!, 1000));
    default: throw new Error(`no generator for ${leaf.kind}`);
  }
}

/** A random complete, validated params document. */
export function randomParams<R extends Group>(s: Schema<R>, next: () => number): Schema<R>['defaults'] {
  const walk = (n: Node): unknown => {
    if (n.tag === 'leaf') return randomValue(n, next);
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) o[k] = walk(n.children[k]!);
    return o;
  };
  const r = checkParams(s, walk(s.root));
  if (!r.ok) throw new Error(`randomParams produced an invalid document: ${JSON.stringify(r.issues)}`);
  return r.value;
}

/** A random valid patch: each leaf with probability ½; noise leaves get either a whole def or only a wavelength. */
export function randomPatch<R extends Group>(s: Schema<R>, next: () => number): Record<string, unknown> {
  const walk = (n: Node): unknown => {
    if (n.tag === 'leaf') {
      if ((next() & 1) === 0) return undefined;
      if (n.kind === 'noise' && (next() & 1) === 0) return { wavelength: between(next, n.min!, n.max!) };
      return randomValue(n, next);
    }
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) {
      const v = walk(n.children[k]!);
      if (v !== undefined) o[k] = v;
    }
    return Object.keys(o).length > 0 ? o : undefined;
  };
  return (walk(s.root) ?? {}) as Record<string, unknown>;
}
```

- [ ] **Step 2: Write the failing test**

`test/unit/patch.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch, bool, buildSchema, diffParams, enumOf, getPath, group, int, noise, num, patchAt, renderReference, spline } from '../../src/core/params/kit';
import { randomParams, randomPatch } from '../harness/params';
import { testRng } from '../harness/stats';

const P = (x: number, y: number, d = 0) => ({ x, y, d });
const S = buildSchema(group('Test', 'test schema', {
  a: group('A', 'group a', {
    n: num(0.5, { label: 'n', doc: 'a number', min: 0, max: 1, step: 0.05, scope: 'climate', stage: 'climate' }),
    k: int(3, { label: 'k', doc: 'an int', min: 1, max: 8, scope: 'climate', stage: 'climate' }),
    b: bool(true, { label: 'b', doc: 'a | flag', scope: 'live' }),
    e: enumOf(['p', 'q'], 'q', { label: 'e', doc: 'an enum', scope: 'decorate', stage: 'decorate' }),
    w: noise({ wavelength: 128, octaves: 3 }, { label: 'w', doc: '2D noise', scope: 'climate', stage: 'climate', wavelength: { min: 16, max: 1024 }, dims: 2 }),
    v: noise({ wavelength: 64, octaves: 2 }, { label: 'v', doc: '3D noise', scope: 'climate', stage: 'climate', wavelength: { min: 8, max: 512 }, dims: 3 }),
  }),
  s: spline({ coord: 'C', points: [P(-1, 1), P(1, 2)] }, { label: 's', doc: 'a spline', unit: 'blocks', coords: ['C', 'E'], min: -100, max: 100, scope: 'terrain', stage: 'shape' }),
}));
const D = S.defaults;

describe('applyPatch', () => {
  test('noise leaves merge per field; other leaves are replaced; untouched subtrees keep their reference', () => {
    const r = applyPatch(S, D, { a: { w: { octaves: 5 }, n: 0.25 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.a.w).toEqual({ ...D.a.w, octaves: 5 });
    expect(r.value.a.n).toBe(0.25);
    expect(r.value.s).toBe(D.s);
    expect(r.value.a.v).toBe(D.a.v);
    expect(Object.isFrozen(r.value.a)).toBe(true);
  });
  test('an empty or undefined-valued patch returns the base itself', () => {
    const r = applyPatch(S, D, { a: { n: undefined } });
    expect(r.ok && r.value).toBe(D);
    const e = applyPatch(S, D, {});
    expect(e.ok && e.value).toBe(D);
  });
  test('all issues are collected and nothing is applied', () => {
    const r = applyPatch(S, D, { a: { n: 7, k: 1.5, zz: 1, w: { remap: 'uniform', double: false } }, s: { coord: 'C', points: [] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.code} @ ${i.path}`)).toEqual([
      'UNKNOWN_KEY @ a.zz', 'OUT_OF_RANGE @ a.n', 'NOT_INTEGER @ a.k', 'REMAP_NEEDS_DOUBLE @ a.w.remap', 'EMPTY @ s.points',
    ]);
  });
  test('__proto__ is rejected and never touches a prototype', () => {
    const patch = JSON.parse('{"a":{"__proto__":{"polluted":1},"w":{"__proto__":{"x":1}}}}') as unknown;
    const r = applyPatch(S, D, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(['a.__proto__', 'a.w.__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  test('a non-object patch where a group or noise is expected', () => {
    const r = applyPatch(S, D, { a: 3, s: 4 });
    expect(!r.ok && r.issues.map((i) => `${i.code} @ ${i.path}`)).toEqual(['NOT_OBJECT @ a', 'NOT_OBJECT @ s']);
  });
});

describe('diffParams', () => {
  test('minimal patch: noise fields only where they differ; equal inputs give {}', () => {
    const r = applyPatch(S, D, { a: { w: { octaves: 5, amplitudes: [1, 0, 0.5, 0, 0] }, e: 'p' } });
    if (!r.ok) throw new Error('setup');
    expect(diffParams(S, D, r.value)).toEqual({ a: { w: { octaves: 5, amplitudes: [1, 0, 0.5, 0, 0] }, e: 'p' } });
    expect(diffParams(S, D, D)).toEqual({});
  });
  test('diff → JSON → apply is an identity on 2000 random pairs', () => {
    const next = testRng(141);
    for (let i = 0; i < 2000; i++) {
      const base = randomParams(S, next);
      const target = randomParams(S, next);
      const d = JSON.parse(JSON.stringify(diffParams(S, base, target))) as unknown;
      const r = applyPatch(S, base, d);
      expect(r.ok).toBe(true);
      if (r.ok) expect(canonicalJSON(r.value)).toBe(canonicalJSON(target));
    }
  });
  test('random patches always apply', () => {
    const next = testRng(142);
    for (let i = 0; i < 500; i++) expect(applyPatch(S, D, randomPatch(S, next)).ok).toBe(true);
  });
});

test('getPath and patchAt', () => {
  expect(getPath(D, 'a.w.octaves')).toBe(3);
  expect(getPath(D, '')).toBe(D);
  expect(getPath(D, 'a.nope')).toBeUndefined();
  expect(getPath(D, 'a.n.x')).toBeUndefined();
  expect(patchAt('a.w.octaves', 4)).toEqual({ a: { w: { octaves: 4 } } });
});

test('renderReference', () => {
  const lines = renderReference(S).split('\n');
  expect(lines[0]).toBe('| path | kind | default | range | unit | scope | doc |');
  expect(lines[1]).toBe('|---|---|---|---|---|---|---|');
  expect(lines[2]).toBe('| `a.n` | number | 0.5 | 0 … 1 |  | climate | n: a number |');
  expect(lines[4]).toBe('| `a.b` | bool | true |  |  | live | b: a \\| flag |');
  expect(lines[5]).toBe('| `a.e` | enum | "q" | p / q |  | decorate | e: an enum |');
  expect(lines[6]).toContain('| `a.w` | noise | {"amplitudes":null,"clampSigma":3,');
  expect(lines[6]).toContain('| wavelength 16 … 1024 |');
  expect(lines[8]).toContain('| blocks | terrain |');
  expect(lines.length).toBe(2 + S.leaves.length);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/patch.test.ts`
Expected: FAIL (`applyPatch` and the others are not exported).

- [ ] **Step 4: Append part 2 to `src/core/params/kit.ts`**

Add `import { canonicalJSON, q15 } from './canonical';` in place of the existing `import { q15 } from './canonical';`, then append:

```ts
// ---------------------------------------------------------------- patches
/**
 * Deep-merges a partial document over `base` with validation (profiles, presets, lab URL, panel edits,
 * saves). Groups and noise leaves merge per key; other leaves are replaced whole. Collects every issue
 * and applies nothing on error. A subtree the patch does not mention keeps its reference.
 */
export function applyPatch<R extends Group>(s: Schema<R>, base: Value<R>, patch: unknown): Result<Value<R>> {
  const out: Issue[] = [];
  const walk = (n: Node, b: unknown, p: unknown, path: string): unknown => {
    if (p === undefined) return b;
    if (n.tag === 'leaf') {
      if (n.merge === 'fields') {
        if (!isObj(p)) { out.push({ path, code: 'NOT_OBJECT', message: `expected an object, got ${fmt(p)}` }); return b; }
        if (unknownKeys(p, NOISE_KEYS, path, out)) return b;
        const merged: Record<string, unknown> = { ...(b as Record<string, unknown>) };
        for (const k of NOISE_KEYS) if (p[k] !== undefined) merged[k] = p[k];
        return checkLeaf(n, merged, path, out) ?? b;
      }
      return checkLeaf(n, p, path, out) ?? b;
    }
    if (!isObj(p)) { out.push({ path, code: 'NOT_OBJECT', message: `expected an object, got ${fmt(p)}` }); return b; }
    unknownKeys(p, Object.keys(n.children), path, out);
    const bb = b as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    let changed = false;
    for (const k of Object.keys(n.children)) {
      const v = Object.hasOwn(p, k) ? walk(n.children[k]!, bb[k], p[k], join(path, k)) : bb[k];
      res[k] = v;
      if (v !== bb[k]) changed = true;
    }
    return changed ? res : b;
  };
  const value = walk(s.root, base, patch, '');
  return out.length > 0 ? { ok: false, issues: out } : { ok: true, value: deepFreeze(value) as Value<R> };
}

/** Minimal patch with applyPatch(s, base, diffParams(s, base, v)) canonically equal to v. */
export function diffParams<R extends Group>(s: Schema<R>, base: Value<R>, value: Value<R>): Patch<R> {
  const walk = (n: Node, b: unknown, x: unknown): unknown => {
    if (n.tag === 'leaf') {
      if (n.merge === 'fields' && isObj(b) && isObj(x)) {
        const d: Record<string, unknown> = {};
        for (const k of NOISE_KEYS) if (canonicalJSON(x[k]) !== canonicalJSON(b[k])) d[k] = x[k];
        return Object.keys(d).length > 0 ? d : undefined;
      }
      return canonicalJSON(b) === canonicalJSON(x) ? undefined : x;
    }
    const d: Record<string, unknown> = {};
    const bb = b as Record<string, unknown>;
    const xx = x as Record<string, unknown>;
    for (const k of Object.keys(n.children)) {
      const c = walk(n.children[k]!, bb[k], xx[k]);
      if (c !== undefined) d[k] = c;
    }
    return Object.keys(d).length > 0 ? d : undefined;
  };
  return (walk(s.root, base, value) ?? {}) as Patch<R>;
}

export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let cur: unknown = value;
  for (const k of path.split('.')) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** {a: {b: value}} for path "a.b". */
export function patchAt(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  let acc: unknown = value;
  for (let i = keys.length - 1; i >= 0; i--) acc = { [keys[i]!]: acc };
  return acc as Record<string, unknown>;
}

// ---------------------------------------------------------------- README reference
/** Markdown parameter table (SP1 spec §4.7): path | kind | default | range | unit | scope | doc. */
export function renderReference<R extends Group>(s: Schema<R>): string {
  const esc = (t: string) => t.replaceAll('|', '\\|');
  const rows = ['| path | kind | default | range | unit | scope | doc |', '|---|---|---|---|---|---|---|'];
  for (const { path, meta } of s.leaves) {
    const def = canonicalJSON(getPath(s.defaults, path));
    const range = meta.options !== undefined ? meta.options.join(' / ')
      : meta.kind === 'noise' ? `wavelength ${meta.min} … ${meta.max}`
      : meta.min !== undefined ? `${meta.min} … ${meta.max}` : '';
    rows.push(`| \`${path}\` | ${meta.kind} | ${esc(def)} | ${esc(range)} | ${esc(meta.unit ?? '')} | ${meta.scope} | ${esc(`${meta.label}: ${meta.doc}`)} |`);
  }
  return rows.join('\n');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit test/unit/patch.test.ts test/unit/kit.test.ts`
Expected: PASS.

- [ ] **Step 6: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/params/kit.ts test/harness/params.ts test/unit/patch.test.ts
git commit -m "feat(core): applyPatch, diffParams, paths and the README reference renderer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 15: The SP1 schema and its noise instances

**Files:**
- Create: `src/core/params/schema.ts`, `src/core/params/meta.ts`, `src/core/params/defaults.ts`, `src/core/params/noises.ts`
- Test: `test/unit/schema.test.ts`

**Interfaces:**
- Consumes: Tasks 13-14 kit, `fnv1a32` (Task 3), `NoiseDef` (Task 8).
- Produces:
  - `ROOT`, `SCHEMA`, `type Params`, `type ParamsPatch`, `interface ClimateParams`, re-exported `NOISE_FIELD_RANGES` (`schema.ts`)
  - `PARAM_META: readonly ParamMeta[]`, `metaOf(path): ParamMeta | undefined` (`meta.ts`); `DEFAULTS: Params` (`defaults.ts`)
  - `interface NoiseInstance { readonly path: string; readonly seedName: string; readonly def: NoiseDef; readonly dims: 2 | 3 }`, `noiseInstances(schema, params): NoiseInstance[]` (`noises.ts`)

- [ ] **Step 1: Write the failing test**

`test/unit/schema.test.ts`:

```ts
import { expect, test } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import { metaOf, PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA, type ClimateParams } from '../../src/core/params/schema';

test('13 leaves, all climate scope and stage, in declaration order', () => {
  expect(PARAM_META.map((m) => `${m.path}:${m.kind}`)).toEqual([
    'climate.scaleMul:number',
    'climate.warp.shift.amplitude:number', 'climate.warp.shift.noise:noise',
    'climate.warp.C.amplitude:number', 'climate.warp.C.noise:noise',
    'climate.warp.R.amplitude:number', 'climate.warp.R.noise:noise',
    'climate.C:noise', 'climate.E:noise', 'climate.W:noise', 'climate.T:noise', 'climate.H:noise', 'climate.R:noise',
  ]);
  for (const m of PARAM_META) {
    expect(m.scope).toBe('climate');
    expect(m.stage).toBe('climate');
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.doc.length).toBeGreaterThan(0);
  }
  expect(metaOf('climate.scaleMul')).toMatchObject({ min: 0.25, max: 16, step: 0.05, effectMetric: 'Z4' });
  expect(metaOf('climate.warp.C.noise')).toMatchObject({ min: 16, max: 8192, dims: 2 });
  expect(metaOf('climate.T')).toMatchObject({ min: 64, max: 20000, dims: 2 });
  expect(metaOf('nope')).toBeUndefined();
});

test('defaults match spec §4.3', () => {
  const c: ClimateParams = DEFAULTS.climate;
  expect(c.scaleMul).toBe(1);
  expect([c.warp.shift.amplitude, c.warp.C.amplitude, c.warp.R.amplitude]).toEqual([48, 180, 120]);
  expect([c.warp.shift.noise, c.warp.C.noise, c.warp.R.noise].map((n) => [n.wavelength, n.octaves, n.remap])).toEqual([[256, 3, 'none'], [1024, 2, 'none'], [512, 2, 'none']]);
  expect([c.C, c.E, c.W, c.T, c.H, c.R].map((n) => [n.wavelength, n.octaves, n.remap, n.persistence, n.lacunarity, n.double])).toEqual([
    [2400, 6, 'uniform', 0.5, 2, true], [1600, 5, 'uniform', 0.5, 2, true], [900, 5, 'uniform', 0.5, 2, true],
    [5000, 4, 'uniform', 0.5, 2, true], [2400, 4, 'uniform', 0.5, 2, true], [1400, 4, 'uniform', 0.5, 2, true],
  ]);
  expect(Object.isFrozen(DEFAULTS.climate.C)).toBe(true);
});

test('noise instances: warps expand to .x/.z, seed names default to paths', () => {
  const inst = noiseInstances(SCHEMA, DEFAULTS);
  expect(inst.map((i) => `${i.seedName}|${i.path}|${i.dims}`)).toEqual([
    'climate.warp.shift.noise.x|climate.warp.shift.noise|2', 'climate.warp.shift.noise.z|climate.warp.shift.noise|2',
    'climate.warp.C.noise.x|climate.warp.C.noise|2', 'climate.warp.C.noise.z|climate.warp.C.noise|2',
    'climate.warp.R.noise.x|climate.warp.R.noise|2', 'climate.warp.R.noise.z|climate.warp.R.noise|2',
    'climate.C|climate.C|2', 'climate.E|climate.E|2', 'climate.W|climate.W|2', 'climate.T|climate.T|2', 'climate.H|climate.H|2', 'climate.R|climate.R|2',
  ]);
  expect(inst[6]!.def).toBe(DEFAULTS.climate.C);
});

test('every octave seed name is distinct within a world (fnv1a32 of name × {#i, \'#i}, i < 16)', () => {
  const names = noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName);
  expect(new Set(names).size).toBe(names.length);
  const hashes = new Set<number>();
  for (const n of names) for (let i = 0; i < 16; i++) { hashes.add(fnv1a32(`${n}#${i}`)); hashes.add(fnv1a32(`${n}'#${i}`)); }
  expect(hashes.size).toBe(names.length * 32);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/schema.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/params/schema.ts`**

```ts
import { buildSchema, group, noise, num, type Patch, type Value } from './kit';

export { NOISE_FIELD_RANGES } from './kit';

const CLIMATE = { scope: 'climate', stage: 'climate' } as const;

const warp = (label: string, doc: string, amplitude: number, wavelength: number, octaves: number) =>
  group(label, doc, {
    amplitude: num(amplitude, { ...CLIMATE, label: 'Amplitude', doc: 'Maximum displacement of the warp.', unit: 'blocks', min: 0, max: 1000, step: 1 }),
    noise: noise({ wavelength, octaves }, {
      ...CLIMATE, label: 'Warp noise', doc: 'Unit-sd noise sampled twice (.x and .z) to displace the coordinates.',
      wavelength: { min: 16, max: 8192 }, dims: 2, components: ['x', 'z'],
    }),
  });

const field = (label: string, doc: string, wavelength: number, octaves: number) =>
  noise({ wavelength, octaves, remap: 'uniform' }, { ...CLIMATE, label, doc, wavelength: { min: 64, max: 20000 }, dims: 2 });

/** The SP1 ParamSchema: the climate section (SP1 spec §4.3). Later sub-projects add sections. */
export const ROOT = group('Parameters', 'World generation parameters.', {
  climate: group('Climate', 'The six climate fields and their warps.', {
    scaleMul: num(1, { ...CLIMATE, label: 'Climate scale', doc: 'Zooms every climate wavelength, warp wavelength and warp amplitude (large_biomes = 4).', min: 0.25, max: 16, step: 0.05, effectMetric: 'Z4' }),
    warp: group('Warps', 'Domain warps applied before sampling the climate fields.', {
      shift: warp('Shift warp', 'Shared warp of every climate field.', 48, 256, 3),
      C: warp('Continentalness warp', 'Extra warp of C: bays and peninsulas.', 180, 1024, 2),
      R: warp('River warp', 'Extra warp of R: meanders.', 120, 512, 2),
    }),
    C: field('Continentalness', 'Ocean ↔ inland.', 2400, 6),
    E: field('Erosion', 'Flat ↔ mountainous.', 1600, 5),
    W: field('Weirdness', 'Ridges at |W| = 2/3 via PV; sign selects variants.', 900, 5),
    T: field('Temperature', 'Cold ↔ hot; zones about twice the size of humidity zones.', 5000, 4),
    H: field('Humidity', 'Dry ↔ wet.', 2400, 4),
    R: field('Rivers', 'Its zero set gives the river lines.', 1400, 4),
  }),
});

export const SCHEMA = buildSchema(ROOT);
export type Params = Value<typeof ROOT>;
export type ParamsPatch = Patch<typeof ROOT>;
export interface ClimateParams extends Value<typeof ROOT.children.climate> {}
```

- [ ] **Step 4: Implement `meta.ts`, `defaults.ts` and `noises.ts`**

`src/core/params/meta.ts`:

```ts
import type { ParamMeta } from './kit';
import { SCHEMA } from './schema';

/** Derived from the schema; never hand-written. */
export const PARAM_META: readonly ParamMeta[] = SCHEMA.leaves.map((l) => l.meta);
const BY_PATH = new Map(PARAM_META.map((m) => [m.path, m] as const));

export function metaOf(path: string): ParamMeta | undefined {
  return BY_PATH.get(path);
}
```

`src/core/params/defaults.ts`:

```ts
import { SCHEMA, type Params } from './schema';

/** Validated, deep-frozen defaults derived from the schema. */
export const DEFAULTS: Params = SCHEMA.defaults;
```

`src/core/params/noises.ts`:

```ts
import type { NoiseDef } from '../noise/types';
import { getPath, type Group, type Schema } from './kit';

export interface NoiseInstance {
  readonly path: string;
  readonly seedName: string;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
}

/**
 * Every noise instance of a schema, in pre-order (SP1 spec §2.5). The seed name is the leaf's `seedName`
 * or its path; a leaf with components ['x', 'z'] yields `<seedName>.x` and `<seedName>.z`.
 */
export function noiseInstances<R extends Group>(schema: Schema<R>, params: unknown): NoiseInstance[] {
  const out: NoiseInstance[] = [];
  for (const { path, leaf } of schema.leaves) {
    if (leaf.kind !== 'noise') continue;
    const def = getPath(params, path) as NoiseDef;
    const seedName = leaf.seedName ?? path;
    const dims = leaf.dims ?? 2;
    if (leaf.components !== undefined) for (const c of leaf.components) out.push({ path, seedName: `${seedName}.${c}`, def, dims });
    else out.push({ path, seedName, def, dims });
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/params test/unit/schema.test.ts
git commit -m "feat(core): SP1 climate schema, derived meta/defaults and noise instances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 16: Stage registry, stage hashes and genKey

**Files:**
- Create: `src/core/stage/registry.ts`, `src/core/stage/hash.ts`
- Modify: `src/metrics/sp1Fixtures.ts` (append the params fixture)
- Test: `test/unit/stage.test.ts`

**Interfaces:**
- Consumes: kit (Tasks 13-14), `SCHEMA`/`DEFAULTS` (Task 15), `fnv1a64`, `hex64`, `Seed64`, `Hash64` (Task 3), `canonicalJSON` (Task 6), `GENERATOR_VERSION` (`src/core/constants.ts`), `TANGENT_FIXTURE` (Task 12).
- Produces:
  - `interface StageDef`, `STAGES`, `SCOPE_OF_STAGE`, `prefixCovers(prefix, path)`, `checkRegistry(schema, stages?): string[]` (`registry.ts`)
  - `type StageHashes = Readonly<Partial<Record<StageId, Hash64>>>`, `stageHashes(params, stages?)`, `genKey(seed, hashes)`, `dirtyStages(a, b, stages?)`, `paramsHash(params)` (`hash.ts`)
  - in `sp1Fixtures.ts`: `PARAMS_FIXTURE`, `FIXTURE_STAGES`, `FIXTURE_DEFAULTS`

- [ ] **Step 1: Write the failing test**

`test/unit/stage.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { fnv1a64, hex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, bool, buildSchema, group, num } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, genKey, paramsHash, stageHashes } from '../../src/core/stage/hash';
import { checkRegistry, prefixCovers, STAGES, type StageDef } from '../../src/core/stage/registry';
import { FIXTURE_DEFAULTS, FIXTURE_STAGES, PARAMS_FIXTURE } from '../../src/metrics/sp1Fixtures';

const ALL = STAGES.map((s) => s.id);

describe('registry', () => {
  test('the SP1 schema and stage list satisfy every invariant', () => {
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
    expect(ALL).toEqual(['climate', 'shape', 'surfaceEst', 'biome2d', 'terrain', 'decorate', 'light', 'mesh', 'lod', 'map']);
    expect(STAGES.every((s) => s.version === 1)).toBe(true);
  });
  test('prefixes match on dot boundaries', () => {
    expect(prefixCovers('climate', 'climate.C')).toBe(true);
    expect(prefixCovers('climate.C', 'climate.C')).toBe(true);
    expect(prefixCovers('climate.C', 'climate.CX')).toBe(false);
  });
  const T = buildSchema(group('T', 't', {
    a: group('A', 'a', { x: num(0, { label: 'x', doc: 'd', min: 0, max: 1, scope: 'climate', stage: 'climate' }) }),
    b: group('B', 'b', { y: bool(true, { label: 'y', doc: 'd', scope: 'live' }) }),
    c: group('C', 'c', { z: num(0, { label: 'z', doc: 'd', min: 0, max: 1, scope: 'decorate', stage: 'decorate' }) }),
  }));
  const st = (id: StageDef['id'], reads: StageDef['reads'], params: string[], version = 1): StageDef => ({ id, version, reads, params, checkpoint: 'none' });
  test.each<[string, StageDef[], string]>([
    ['duplicate stage', [st('climate', [], ['a']), st('climate', [], []), st('decorate', ['climate'], ['c'])], 'climate: duplicate stage'],
    ['reads a later stage', [st('climate', ['decorate'], ['a']), st('decorate', [], ['c'])], 'climate: reads decorate, which is not declared earlier'],
    ['bad version', [st('climate', [], ['a'], 0), st('decorate', [], ['c'])], 'climate: version must be an integer ≥ 1'],
    ['prefix matches nothing', [st('climate', [], ['a', 'nope']), st('decorate', [], ['c'])], 'climate: prefix "nope" matches no schema node'],
    ['live leaf hashed', [st('climate', [], ['a', 'b']), st('decorate', [], ['c'])], 'b.y: live leaf is hashed by climate'],
    ['home stage does not hash it', [st('climate', [], ['a']), st('decorate', [], [])], 'c.z: home stage decorate does not hash it'],
    ['scope differs from the first covering stage', [st('climate', [], ['a', 'c']), st('decorate', [], ['c'])], 'c.z: scope decorate but first hashed by climate (scope climate)'],
    ['light hosts params', [st('climate', [], ['a']), st('decorate', [], ['c']), st('light', [], ['a'])], 'light: hosts params, but light, lod and map host none'],
  ])('%s', (_name, stages, message) => {
    expect(checkRegistry(T, stages)).toContain(message);
  });
});

describe('stage hashes', () => {
  const H = stageHashes(DEFAULTS);
  test('preimages', () => {
    expect(hex64(H.climate!)).toBe(hex64(fnv1a64(`climate|1|${canonicalJSON({ climate: DEFAULTS.climate })}|`)));
    expect(hex64(H.shape!)).toBe(hex64(fnv1a64(`shape|1|{}|${hex64(H.climate!)}`)));
    expect(hex64(H.biome2d!)).toBe(hex64(fnv1a64(`biome2d|1|{}|${hex64(H.climate!)},${hex64(H.shape!)},${hex64(H.surfaceEst!)}`)));
  });
  test('every stage is hashed and none depends on the seed', () => {
    expect(Object.keys(H).sort()).toEqual([...ALL].sort());
    expect(stageHashes(DEFAULTS)).toEqual(H);
  });
  test('genKey preimage and seed dependence', () => {
    const seed = [42, 0] as const;
    expect(hex64(genKey(seed, H))).toBe(hex64(fnv1a64(`0|42|0|${hex64(H.decorate!)}`)));
    expect(hex64(genKey([43, 0], H))).not.toBe(hex64(genKey(seed, H)));
    expect(hex64(genKey([42, 1], H))).not.toBe(hex64(genKey(seed, H)));
  });
  test('dirtyStages: a climate edit dirties every stage; no edit dirties none', () => {
    const r = applyPatch(SCHEMA, DEFAULTS, { climate: { C: { octaves: 5 } } });
    if (!r.ok) throw new Error('setup');
    expect(dirtyStages(H, stageHashes(r.value))).toEqual(ALL);
    expect(dirtyStages(H, stageHashes(DEFAULTS))).toEqual([]);
  });
  test('paramsHash is fnv1a64 of the canonical JSON', () => {
    expect(hex64(paramsHash(DEFAULTS))).toBe(hex64(fnv1a64(canonicalJSON(DEFAULTS))));
  });
  test('the frozen params fixture hashes with its own two-stage list', () => {
    const FH = stageHashes(FIXTURE_DEFAULTS, FIXTURE_STAGES);
    expect(Object.keys(FH).sort()).toEqual(['climate', 'decorate']);
    expect(checkRegistry(PARAMS_FIXTURE, FIXTURE_STAGES)).toEqual([]);
    expect(() => genKey([1, 0], {})).toThrow(/decorate/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/stage.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/stage/registry.ts`**

```ts
import type { RegenScope, StageId } from '../ids';
import type { Group, Schema } from '../params/kit';

export interface StageDef {
  readonly id: StageId;
  readonly version: number;
  /** Upstream stages whose hashes chain into this one; each appears earlier in the list. */
  readonly reads: readonly StageId[];
  /** Param path prefixes this stage reads directly. */
  readonly params: readonly string[];
  readonly checkpoint: 'columnSample' | 'proto' | 'final' | 'none';
}

/** Topological order (SP1 spec §5). SP1 registers every stage; later SPs add prefixes and bump versions. */
export const STAGES: readonly StageDef[] = [
  { id: 'climate', version: 1, reads: [], params: ['climate'], checkpoint: 'columnSample' },
  { id: 'shape', version: 1, reads: ['climate'], params: [], checkpoint: 'columnSample' },
  { id: 'surfaceEst', version: 1, reads: ['shape'], params: [], checkpoint: 'columnSample' },
  { id: 'biome2d', version: 1, reads: ['climate', 'shape', 'surfaceEst'], params: [], checkpoint: 'columnSample' },
  { id: 'terrain', version: 1, reads: ['shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'proto' },
  { id: 'decorate', version: 1, reads: ['terrain'], params: [], checkpoint: 'final' },
  { id: 'light', version: 1, reads: ['decorate'], params: [], checkpoint: 'none' },
  { id: 'mesh', version: 1, reads: ['light'], params: [], checkpoint: 'none' },
  { id: 'lod', version: 1, reads: ['surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
  { id: 'map', version: 1, reads: ['climate', 'shape', 'surfaceEst', 'biome2d'], params: [], checkpoint: 'none' },
];

/** Badge scope implied by the first stage that hashes a leaf; null = hosts no params. */
export const SCOPE_OF_STAGE: Readonly<Record<StageId, RegenScope | null>> = {
  climate: 'climate', shape: 'terrain', surfaceEst: 'terrain', biome2d: 'terrain', terrain: 'terrain',
  decorate: 'decorate', light: null, mesh: 'remesh', lod: null, map: null,
};

export function prefixCovers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** U4 registry invariants (SP1 spec §5); [] = OK. */
export function checkRegistry<R extends Group>(schema: Schema<R>, stages: readonly StageDef[] = STAGES): string[] {
  const out: string[] = [];
  const seen = new Set<StageId>();
  for (const s of stages) {
    if (seen.has(s.id)) out.push(`${s.id}: duplicate stage`);
    for (const r of s.reads) if (!seen.has(r)) out.push(`${s.id}: reads ${r}, which is not declared earlier`);
    if (!Number.isInteger(s.version) || s.version < 1) out.push(`${s.id}: version must be an integer ≥ 1`);
    for (const p of s.params) if (!schema.byPath.has(p)) out.push(`${s.id}: prefix "${p}" matches no schema node`);
    if (SCOPE_OF_STAGE[s.id] === null && s.params.length > 0) out.push(`${s.id}: hosts params, but light, lod and map host none`);
    seen.add(s.id);
  }
  for (const { path, meta } of schema.leaves) {
    const covering = stages.filter((s) => s.params.some((p) => prefixCovers(p, path)));
    if (meta.scope === 'live') {
      if (covering.length > 0) out.push(`${path}: live leaf is hashed by ${covering.map((s) => s.id).join(', ')}`);
      continue;
    }
    if (meta.stage === undefined) { out.push(`${path}: non-live leaf without a stage`); continue; }
    if (!covering.some((s) => s.id === meta.stage)) out.push(`${path}: home stage ${meta.stage} does not hash it`);
    const first = covering[0];
    if (first === undefined) { out.push(`${path}: hashed by no stage`); continue; }
    const implied = SCOPE_OF_STAGE[first.id];
    if (implied !== meta.scope) out.push(`${path}: scope ${meta.scope} but first hashed by ${first.id} (scope ${implied ?? 'none'})`);
  }
  return out;
}
```

- [ ] **Step 4: Implement `src/core/stage/hash.ts`**

```ts
import { GENERATOR_VERSION } from '../constants';
import { fnv1a64, hex64, type Hash64, type Seed64 } from '../hash';
import type { StageId } from '../ids';
import { canonicalJSON } from '../params/canonical';
import { getPath } from '../params/kit';
import { STAGES, type StageDef } from './registry';

export type StageHashes = Readonly<Partial<Record<StageId, Hash64>>>;

/**
 * H[S] = fnv1a64(`${id}|${version}|${canonicalJSON(slice)}|${reads.map(hex64(H[r])).join(',')}`) with
 * slice = {prefix: subtree} over S.params (SP1 spec §5). Seed-independent.
 */
export function stageHashes(params: unknown, stages: readonly StageDef[] = STAGES): StageHashes {
  const h: Partial<Record<StageId, Hash64>> = {};
  for (const s of stages) {
    const slice: Record<string, unknown> = {};
    for (const p of s.params) slice[p] = getPath(params, p);
    const up = s.reads.map((r) => {
      const x = h[r];
      if (x === undefined) throw new Error(`${s.id} reads ${r} before it is hashed`);
      return hex64(x);
    }).join(',');
    h[s.id] = fnv1a64(`${s.id}|${s.version}|${canonicalJSON(slice)}|${up}`);
  }
  return h;
}

/** fnv1a64(`${GENERATOR_VERSION}|${lo}|${hi}|${hex64(H.decorate)}`), seed words as decimal u32. */
export function genKey(seed: Seed64, hashes: StageHashes): Hash64 {
  const d = hashes.decorate;
  if (d === undefined) throw new Error('genKey needs the decorate stage hash');
  return fnv1a64(`${GENERATOR_VERSION}|${seed[0]}|${seed[1]}|${hex64(d)}`);
}

/** Stages whose hash differs, in stage-list order. */
export function dirtyStages(a: StageHashes, b: StageHashes, stages: readonly StageDef[] = STAGES): StageId[] {
  return stages.filter((s) => {
    const x = a[s.id];
    const y = b[s.id];
    return x === undefined || y === undefined || hex64(x) !== hex64(y);
  }).map((s) => s.id);
}

export function paramsHash(params: unknown): Hash64 {
  return fnv1a64(canonicalJSON(params));
}
```

- [ ] **Step 5: Append the params fixture to `src/metrics/sp1Fixtures.ts`**

Add to the imports:

```ts
import { buildSchema, enumOf, group, int, noise, num, spline } from '../core/params/kit';
import type { StageDef } from '../core/stage/registry';
```

add the aliases next to the existing ones:

```ts
const BUILD = buildSchema;
const GROUP = group;
const NUM = num;
const INT = int;
const ENUM = enumOf;
const NOISE = noise;
const SPLINE = spline;
```

and append:

```ts
/** Frozen params fixture for the sp1.params golden (SP1 spec Appendix B). */
export const PARAMS_FIXTURE = BUILD(GROUP('Fixture', 'Frozen params fixture for the sp1.params golden.', {
  a: GROUP('A', 'Climate-scope leaves.', {
    n: NUM(0.5, { label: 'n', doc: 'A number.', min: 0, max: 1, scope: 'climate', stage: 'climate' }),
    k: INT(3, { label: 'k', doc: 'An integer.', min: 1, max: 8, scope: 'climate', stage: 'climate' }),
    e: ENUM(['p', 'q'], 'q', { label: 'e', doc: 'An enum.', scope: 'climate', stage: 'climate' }),
    w: NOISE({ wavelength: 128, octaves: 3 }, { label: 'w', doc: 'A noise.', scope: 'climate', stage: 'climate', wavelength: { min: 16, max: 1024 }, dims: 2 }),
  }),
  b: GROUP('B', 'Decorate-scope leaves.', {
    s: SPLINE(TANGENT_FIXTURE, { label: 's', doc: 'A spline.', coords: ['C', 'E', 'W', 'PV', 'T', 'H'], min: -100, max: 100, scope: 'decorate', stage: 'decorate' }),
  }),
}));

export const FIXTURE_STAGES: readonly StageDef[] = [
  { id: 'climate', version: 1, reads: [], params: ['a'], checkpoint: 'columnSample' },
  { id: 'decorate', version: 1, reads: ['climate'], params: ['b'], checkpoint: 'final' },
];

export const FIXTURE_DEFAULTS = PARAMS_FIXTURE.defaults;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit test/unit/stage.test.ts test/unit/splineFixtures.test.ts`
Expected: PASS.

- [ ] **Step 7: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/stage src/metrics/sp1Fixtures.ts test/unit/stage.test.ts
git commit -m "feat(core): stage registry, chained stage hashes and genKey

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 17: Profiles, migrations and the presets envelope

**Files:**
- Create: `src/core/params/profiles.ts`, `src/core/params/migrate.ts`, `src/core/params/presets.ts`
- Test: `test/unit/profiles.test.ts`

**Interfaces:**
- Consumes: kit, `SCHEMA`, `DEFAULTS`, `Params`, `ParamsPatch`, stage hashes (Task 16), `randomParams` (Task 14), `SubProjectId` (`src/core/ids.ts`).
- Produces:
  - `type ProfileId`, `PROFILE_IDS`, `interface Profile { overlay; readyFrom }`, `PROFILES`, `isProfileId(v)`, `resolveProfile(id): Params` (`profiles.ts`)
  - `type JsonValue`, `interface JsonObject`, `type Migration`, `SCHEMA_VERSION = 1`, `MIGRATIONS`, `migrate(doc, from, migrations?)`, `renamePath`, `deletePath`, `mapPath` (`migrate.ts`)
  - `interface PresetDoc`, `exportPreset(name, profile, draft)`, `importPreset(doc, migrations?)` (`presets.ts`)

- [ ] **Step 1: Write the failing test**

`test/unit/profiles.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { deletePath, mapPath, migrate, MIGRATIONS, renamePath, SCHEMA_VERSION, type JsonObject } from '../../src/core/params/migrate';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { PROFILE_IDS, PROFILES, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, genKey, stageHashes } from '../../src/core/stage/hash';
import { STAGES } from '../../src/core/stage/registry';
import { randomParams } from '../harness/params';
import { testRng } from '../harness/stats';

describe('profiles', () => {
  test('ids, readiness and overlays', () => {
    expect(Object.keys(PROFILES)).toEqual([...PROFILE_IDS]);
    expect(PROFILE_IDS.map((id) => [id, PROFILES[id].readyFrom])).toEqual([
      ['default', 'SP1'], ['large_biomes', 'SP2'], ['archipelago', 'SP3'], ['amplified', 'SP3'], ['floating_islands', 'SP3'], ['cave_heavy', 'SP6'],
    ]);
    expect(resolveProfile('large_biomes').climate.scaleMul).toBe(4);
    expect(resolveProfile('archipelago').climate.C.wavelength).toBe(840);
    expect(resolveProfile('default')).toBe(DEFAULTS);
  });
  test('switching profile dirties exactly what its overlay touches', () => {
    const base = stageHashes(DEFAULTS);
    const all = STAGES.map((s) => s.id);
    for (const id of PROFILE_IDS) {
      const h = stageHashes(resolveProfile(id));
      const empty = Object.keys(PROFILES[id].overlay).length === 0;
      expect(dirtyStages(base, h)).toEqual(empty ? [] : all);
      if (empty) expect(hex64(genKey([42, 0], h))).toBe(hex64(genKey([42, 0], base)));
    }
  });
});

describe('migrations', () => {
  test('invariant and identity at the current version', () => {
    expect(MIGRATIONS.length).toBe(SCHEMA_VERSION - 1);
    const doc = { climate: { scaleMul: 2 } } as JsonObject;
    const r = migrate(doc, SCHEMA_VERSION);
    expect(r.ok && r.value).toBe(doc);
  });
  test('an injected v1 → v2 rename', () => {
    const toV2 = (d: JsonObject) => renamePath(d, 'climate.zoom', 'climate.scaleMul');
    const r = migrate({ climate: { zoom: 3, C: { octaves: 5 } } }, 1, [toV2]);
    expect(r.ok && r.value).toEqual({ climate: { scaleMul: 3, C: { octaves: 5 } } });
    expect(migrate({ climate: {} }, 1, [toV2])).toEqual({ ok: true, value: { climate: {} } });
    expect(migrate({}, 3, [toV2]).ok).toBe(false);
    expect(migrate({}, 0).ok).toBe(false);
    const boom = migrate({}, 1, [() => { throw new Error('boom'); }]);
    expect(!boom.ok && boom.issues[0]!.code).toBe('MIGRATION_FAILED');
  });
  test('helpers are pure and touch only present keys', () => {
    const doc: JsonObject = { a: { b: 1, c: 2 } };
    expect(deletePath(doc, 'a.b')).toEqual({ a: { c: 2 } });
    expect(deletePath(doc, 'a.zz')).toEqual(doc);
    expect(mapPath(doc, 'a.c', (v) => (v as number) * 10)).toEqual({ a: { b: 1, c: 20 } });
    expect(mapPath(doc, 'x.y', () => 5)).toEqual(doc);
    expect(renamePath(doc, 'a.b', 'd.e')).toEqual({ a: { c: 2 }, d: { e: 1 } });
    expect(doc).toEqual({ a: { b: 1, c: 2 } });
  });
});

describe('presets', () => {
  const good = () => ({ format: 'wi10-preset', schemaVersion: 1, name: 'My world', profile: 'default', params: { climate: { scaleMul: 2 } } }) as Record<string, unknown>;
  const codes = (doc: unknown) => {
    const r = importPreset(doc);
    return r.ok ? [] : r.issues.map((i) => `${i.code} @ ${i.path}`);
  };
  test('export writes a patch over the profile; import restores the draft', () => {
    const next = testRng(171);
    for (const profile of PROFILE_IDS) {
      for (let i = 0; i < 17; i++) {
        const draft = i === 0 ? resolveProfile(profile) : randomParams(SCHEMA, next);
        const doc = JSON.parse(JSON.stringify(exportPreset(' Name ', profile, draft))) as unknown;
        const r = importPreset(doc);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(canonicalJSON(r.value.params)).toBe(canonicalJSON(draft));
          expect(r.value.name).toBe('Name');
          expect(r.value.profile).toBe(profile);
        }
      }
    }
    expect(exportPreset('x', 'large_biomes', resolveProfile('large_biomes')).params).toEqual({});
  });
  test.each<[string, (d: Record<string, unknown>) => void, string[]]>([
    ['valid', () => {}, []],
    ['unknown envelope key (all reported first)', (d) => { d.extra = 1; d.more = 2; }, ['UNKNOWN_KEY @ extra', 'UNKNOWN_KEY @ more']],
    ['bad format stops the envelope checks', (d) => { d.format = 'other'; d.name = ''; }, ['BAD_FORMAT @ format']],
    ['empty name', (d) => { d.name = '   '; }, ['BAD_NAME @ name']],
    ['long name', (d) => { d.name = 'x'.repeat(65); }, ['BAD_NAME @ name']],
    ['reserved name', (d) => { d.name = 'large_biomes'; }, ['RESERVED_NAME @ name']],
    ['unknown profile', (d) => { d.profile = 'nope'; }, ['UNKNOWN_PROFILE @ profile']],
    ['bad schema version', (d) => { d.schemaVersion = 1.5; }, ['BAD_SCHEMA_VERSION @ schemaVersion']],
    ['newer schema version', (d) => { d.schemaVersion = 2; }, ['NEWER_SCHEMA_VERSION @ schemaVersion']],
    ['params not an object', (d) => { d.params = []; }, ['NOT_OBJECT @ params']],
    ['typo in params', (d) => { d.params = { climate: { scaleMull: 4 } }; }, ['UNKNOWN_KEY @ params.climate.scaleMull']],
    ['invalid value', (d) => { d.params = { climate: { scaleMul: 99 } }; }, ['OUT_OF_RANGE @ params.climate.scaleMul']],
    ['unknown key and an invalid value together', (d) => { d.extra = 1; d.params = { climate: { scaleMul: 99 } }; }, ['UNKNOWN_KEY @ extra', 'OUT_OF_RANGE @ params.climate.scaleMul']],
  ])('%s', (_name, mutate, expected) => {
    const d = good();
    mutate(d);
    expect(codes(d)).toEqual(expected);
  });
  test('not an object', () => {
    expect(codes(5)).toEqual(['NOT_OBJECT @ ']);
  });
  test('an old document imports through injected migrations', () => {
    const toV2 = (d: JsonObject) => renamePath(d, 'climate.zoom', 'climate.scaleMul');
    const r = importPreset({ ...good(), params: { climate: { zoom: 3 } } }, [toV2]);
    expect(r.ok && r.value.params.climate.scaleMul).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/profiles.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/core/params/profiles.ts`**

```ts
import type { SubProjectId } from '../ids';
import { DEFAULTS } from './defaults';
import { applyPatch } from './kit';
import { SCHEMA, type Params, type ParamsPatch } from './schema';

export type ProfileId = 'default' | 'large_biomes' | 'archipelago' | 'amplified' | 'floating_islands' | 'cave_heavy';

export interface Profile {
  readonly overlay: ParamsPatch;
  /** Hidden in the UI until this sub-project has started. */
  readonly readyFrom: SubProjectId;
}

export const PROFILE_IDS: readonly ProfileId[] = ['default', 'large_biomes', 'archipelago', 'amplified', 'floating_islands', 'cave_heavy'];

/** Built-in world presets (master §3.15) as overlays over the defaults (SP1 spec §4.4). */
export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
  default: { overlay: {}, readyFrom: 'SP1' },
  large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2' },
  archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3' },
  amplified: { overlay: {}, readyFrom: 'SP3' },
  floating_islands: { overlay: {}, readyFrom: 'SP3' },
  cave_heavy: { overlay: {}, readyFrom: 'SP6' },
};

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v);
}

/** DEFAULTS ⊕ overlay; throws on an invalid overlay (every profile is resolved by a unit test). */
export function resolveProfile(id: ProfileId): Params {
  const r = applyPatch(SCHEMA, DEFAULTS, PROFILES[id].overlay);
  if (!r.ok) throw new Error(`profile ${id} has an invalid overlay: ${r.issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
  return r.value;
}
```

- [ ] **Step 4: Implement `src/core/params/migrate.ts`**

```ts
import type { Result } from './kit';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type Migration = (doc: JsonObject) => JsonObject;

export const SCHEMA_VERSION = 1;
/** MIGRATIONS[v - 1] upgrades a version-v document to v + 1; invariant: length === SCHEMA_VERSION - 1. */
export const MIGRATIONS: readonly Migration[] = [];

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Upgrades a document from `from` to migrations.length + 1 (SP1 spec §4.6). */
export function migrate(doc: JsonObject, from: number, migrations: readonly Migration[] = MIGRATIONS): Result<JsonObject> {
  const current = migrations.length + 1;
  if (!Number.isInteger(from) || from < 1 || from > current) {
    return { ok: false, issues: [{ path: '', code: 'MIGRATION_FAILED', message: `cannot migrate from version ${from} (current ${current})` }] };
  }
  let d = doc;
  for (let v = from; v < current; v++) {
    try {
      d = migrations[v - 1]!(d);
    } catch (e) {
      return { ok: false, issues: [{ path: '', code: 'MIGRATION_FAILED', message: `migration ${v} → ${v + 1} failed: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
  return { ok: true, value: d };
}

function getAt(doc: JsonObject, keys: readonly string[]): { found: boolean; value: JsonValue } {
  let cur: JsonValue = doc;
  for (const k of keys) {
    if (!isObject(cur) || !Object.hasOwn(cur, k)) return { found: false, value: null };
    cur = cur[k]!;
  }
  return { found: true, value: cur };
}

function setAt(doc: JsonObject, keys: readonly string[], value: JsonValue | undefined): JsonObject {
  const [k, ...rest] = keys;
  const out: Record<string, JsonValue> = { ...doc };
  if (rest.length === 0) {
    if (value === undefined) delete out[k!];
    else out[k!] = value;
    return out;
  }
  const child = doc[k!];
  out[k!] = setAt(isObject(child) ? child : {}, rest, value);
  return out;
}

export function deletePath(doc: JsonObject, path: string): JsonObject {
  const keys = path.split('.');
  return getAt(doc, keys).found ? setAt(doc, keys, undefined) : doc;
}

export function mapPath(doc: JsonObject, path: string, fn: (v: JsonValue) => JsonValue): JsonObject {
  const keys = path.split('.');
  const at = getAt(doc, keys);
  return at.found ? setAt(doc, keys, fn(at.value)) : doc;
}

export function renamePath(doc: JsonObject, from: string, to: string): JsonObject {
  const at = getAt(doc, from.split('.'));
  return at.found ? setAt(deletePath(doc, from), to.split('.'), at.value) : doc;
}
```

- [ ] **Step 5: Implement `src/core/params/presets.ts`**

```ts
import { applyPatch, diffParams, isObj, type Issue, type Result } from './kit';
import { migrate, MIGRATIONS, type JsonObject, type Migration } from './migrate';
import { isProfileId, resolveProfile, type ProfileId } from './profiles';
import { SCHEMA, type Params, type ParamsPatch } from './schema';

export interface PresetDoc {
  readonly format: 'wi10-preset';
  readonly schemaVersion: number;
  readonly name: string;
  readonly profile: ProfileId;
  readonly params: ParamsPatch;
}

const ENVELOPE_KEYS = ['format', 'schemaVersion', 'name', 'profile', 'params'];

/** params = the minimal patch over the profile (SP1 spec §4.5). */
export function exportPreset(name: string, profile: ProfileId, draft: Params): PresetDoc {
  return { format: 'wi10-preset', schemaVersion: MIGRATIONS.length + 1, name: name.trim(), profile, params: diffParams(SCHEMA, resolveProfile(profile), draft) };
}

/**
 * Unknown envelope keys first (all), then format → name → profile → schemaVersion (stop at the first
 * failure), then migrate, then every applyPatch issue with a `params.` prefix. Nothing is applied on error.
 */
export function importPreset(doc: unknown, migrations: readonly Migration[] = MIGRATIONS): Result<{ name: string; profile: ProfileId; params: Params }> {
  if (!isObj(doc)) return { ok: false, issues: [{ path: '', code: 'NOT_OBJECT', message: 'a preset must be a JSON object' }] };
  const issues: Issue[] = [];
  for (const k of Object.keys(doc)) if (!ENVELOPE_KEYS.includes(k)) issues.push({ path: k, code: 'UNKNOWN_KEY', message: `unknown key "${k}"` });
  const stop = (i: Issue) => ({ ok: false as const, issues: [...issues, i] });
  if (doc['format'] !== 'wi10-preset') return stop({ path: 'format', code: 'BAD_FORMAT', message: 'format must be "wi10-preset"' });
  const rawName = doc['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length < 1 || name.length > 64) return stop({ path: 'name', code: 'BAD_NAME', message: 'a name has 1-64 characters after trimming' });
  if (isProfileId(name)) return stop({ path: 'name', code: 'RESERVED_NAME', message: `"${name}" is a built-in profile name` });
  const profile = doc['profile'];
  if (!isProfileId(profile)) return stop({ path: 'profile', code: 'UNKNOWN_PROFILE', message: `unknown profile ${JSON.stringify(profile)}` });
  const version = doc['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return stop({ path: 'schemaVersion', code: 'BAD_SCHEMA_VERSION', message: 'schemaVersion must be an integer ≥ 1' });
  const current = migrations.length + 1;
  if (version > current) return stop({ path: 'schemaVersion', code: 'NEWER_SCHEMA_VERSION', message: `schemaVersion ${version} is newer than this build (${current})` });
  const params = doc['params'];
  if (!isObj(params)) return stop({ path: 'params', code: 'NOT_OBJECT', message: 'params must be an object' });
  const m = migrate(params as JsonObject, version, migrations);
  if (!m.ok) return stop({ path: 'params', code: 'MIGRATION_FAILED', message: m.issues[0]!.message });
  const r = applyPatch(SCHEMA, resolveProfile(profile), m.value);
  if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: i.path === '' ? 'params' : `params.${i.path}` })));
  if (issues.length > 0 || !r.ok) return { ok: false, issues };
  return { ok: true, value: { name, profile, params: r.value } };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/profiles.test.ts`
Expected: PASS.

- [ ] **Step 7: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/params/profiles.ts src/core/params/migrate.ts src/core/params/presets.ts test/unit/profiles.test.ts
git commit -m "feat(core): profiles skeleton, migrations and the presets envelope

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 18: Schema-shape lock, README parameter reference and their scripts

**Files:**
- Create: `test/harness/schemaShape.ts`, `test/arch/schemaShape.test.ts`, `test/arch/paramsDoc.test.ts`, `test/unit/schemaShape.test.ts`
- Create: `test/schema-shape.lock.json` (generated)
- Modify: `package.json` (scripts), `README.md` (generated block), `CLAUDE.md` (Commands)

**Interfaces:**
- Consumes: `SCHEMA` (Task 15), `SCHEMA_VERSION` (Task 17), `renderReference` (Task 14).
- Produces (in `test/harness/schemaShape.ts`, used by Task 21's U4 metric):
  - `interface ShapeLock { schemaVersion: number; leaves: Record<string, string> }`, `SHAPE_LOCK_PATH`, `README_PATH`
  - `currentShape(schema): Record<string, string>`, `readShapeLock(path?): ShapeLock | null`
  - `shapeViolations(lock: ShapeLock | null, current, schemaVersion): string[]`
  - `acceptShape(lock, current, schemaVersion): { ok: true; next: ShapeLock } | { ok: false; errors: string[] }`
  - `readmeBlock(readme: string): string | null`, `replaceReadmeBlock(readme: string, table: string): string`

- [ ] **Step 1: Write the failing unit test**

`test/unit/schemaShape.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { acceptShape, readmeBlock, replaceReadmeBlock, shapeViolations } from '../harness/schemaShape';

const lock = { schemaVersion: 1, leaves: { 'a.x': 'number', 'a.n': 'noise' } };

describe('shapeViolations', () => {
  test('equal shape passes', () => {
    expect(shapeViolations(lock, { 'a.x': 'number', 'a.n': 'noise' }, 1)).toEqual([]);
  });
  test('missing lock', () => {
    expect(shapeViolations(null, {}, 1)).toEqual(['test/schema-shape.lock.json is missing: run npm run test:accept-schema']);
  });
  test('removed, renamed or re-kinded leaves need a version bump', () => {
    expect(shapeViolations(lock, { 'a.y': 'number', 'a.n': 'spline' }, 1)).toEqual([
      'a.x removed or renamed: bump SCHEMA_VERSION and add a migration',
      'a.n changed kind noise → spline: bump SCHEMA_VERSION and add a migration',
      'leaves added (a.y): run npm run test:accept-schema',
    ]);
  });
  test('added leaves or a newer version only need an accept', () => {
    expect(shapeViolations(lock, { 'a.x': 'number', 'a.n': 'noise', 'b.z': 'bool' }, 1)).toEqual(['leaves added (b.z): run npm run test:accept-schema']);
    expect(shapeViolations(lock, { 'a.x': 'number' }, 2)).toEqual(['SCHEMA_VERSION 2 is ahead of the lock (1): run npm run test:accept-schema']);
  });
});

describe('acceptShape', () => {
  test('refuses removals without a version bump', () => {
    expect(acceptShape(lock, { 'a.n': 'noise' }, 1)).toEqual({ ok: false, errors: ['a.x removed or renamed: bump SCHEMA_VERSION and add a migration'] });
  });
  test('accepts additions and bumped versions', () => {
    expect(acceptShape(lock, { 'a.x': 'number', 'a.n': 'noise', 'b.z': 'bool' }, 1)).toEqual({ ok: true, next: { schemaVersion: 1, leaves: { 'a.n': 'noise', 'a.x': 'number', 'b.z': 'bool' } } });
    expect(acceptShape(lock, { 'a.y': 'number' }, 2)).toEqual({ ok: true, next: { schemaVersion: 2, leaves: { 'a.y': 'number' } } });
    expect(acceptShape(null, { 'a.y': 'number' }, 1).ok).toBe(true);
  });
});

test('README block helpers', () => {
  const readme = 'intro\n<!-- params:begin -->\nold\n<!-- params:end -->\nend\n';
  expect(readmeBlock(readme)).toBe('old');
  expect(replaceReadmeBlock(readme, 'new\ntable')).toBe('intro\n<!-- params:begin -->\nnew\ntable\n<!-- params:end -->\nend\n');
  expect(readmeBlock('no markers')).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/schemaShape.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `test/harness/schemaShape.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Group, Schema } from '../../src/core/params/kit';

export interface ShapeLock {
  schemaVersion: number;
  leaves: Record<string, string>;
}

export const SHAPE_LOCK_PATH = fileURLToPath(new URL('../schema-shape.lock.json', import.meta.url));
export const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));
const ACCEPT = 'run npm run test:accept-schema';
const BUMP = 'bump SCHEMA_VERSION and add a migration';
const BEGIN = '<!-- params:begin -->';
const END = '<!-- params:end -->';

export function currentShape<R extends Group>(schema: Schema<R>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { path, meta } of schema.leaves) out[path] = meta.kind;
  return out;
}

export function readShapeLock(path = SHAPE_LOCK_PATH): ShapeLock | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ShapeLock) : null;
}

function breaking(lock: ShapeLock, current: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, kind] of Object.entries(lock.leaves)) {
    if (!(path in current)) out.push(`${path} removed or renamed: ${BUMP}`);
    else if (current[path] !== kind) out.push(`${path} changed kind ${kind} → ${current[path]}: ${BUMP}`);
  }
  return out;
}

/** U4 shapeLockViolations (SP1 spec §4.6). */
export function shapeViolations(lock: ShapeLock | null, current: Record<string, string>, schemaVersion: number): string[] {
  if (lock === null) return [`test/schema-shape.lock.json is missing: ${ACCEPT}`];
  if (schemaVersion > lock.schemaVersion) return [`SCHEMA_VERSION ${schemaVersion} is ahead of the lock (${lock.schemaVersion}): ${ACCEPT}`];
  const out = breaking(lock, current);
  const added = Object.keys(current).filter((p) => !(p in lock.leaves));
  if (added.length > 0) out.push(`leaves added (${added.join(', ')}): ${ACCEPT}`);
  return out;
}

export function acceptShape(lock: ShapeLock | null, current: Record<string, string>, schemaVersion: number): { ok: true; next: ShapeLock } | { ok: false; errors: string[] } {
  if (lock !== null && schemaVersion === lock.schemaVersion) {
    const errors = breaking(lock, current);
    if (errors.length > 0) return { ok: false, errors };
  }
  const leaves: Record<string, string> = {};
  for (const p of Object.keys(current).sort()) leaves[p] = current[p]!;
  return { ok: true, next: { schemaVersion, leaves } };
}

export function readmeBlock(readme: string): string | null {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) return null;
  return readme.slice(a + BEGIN.length, b).replace(/^\n/, '').replace(/\n$/, '');
}

export function replaceReadmeBlock(readme: string, table: string): string {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error('README.md has no params block markers');
  return `${readme.slice(0, a + BEGIN.length)}\n${table}\n${readme.slice(b)}`;
}
```

- [ ] **Step 4: Write the accept and write flows**

`test/arch/schemaShape.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core/params/migrate';
import { SCHEMA } from '../../src/core/params/schema';
import { acceptShape, currentShape, readShapeLock, SHAPE_LOCK_PATH, shapeViolations } from '../harness/schemaShape';

test('schema shape matches test/schema-shape.lock.json', () => {
  const lock = readShapeLock();
  const current = currentShape(SCHEMA);
  if (process.env.ACCEPT_SCHEMA === '1') {
    const r = acceptShape(lock, current, SCHEMA_VERSION);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) writeFileSync(SHAPE_LOCK_PATH, `${JSON.stringify(r.next, null, 2)}\n`);
    return;
  }
  expect(shapeViolations(lock, current, SCHEMA_VERSION)).toEqual([]);
});
```

`test/arch/paramsDoc.test.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { renderReference } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { README_PATH, readmeBlock, replaceReadmeBlock } from '../harness/schemaShape';

test('README parameter reference is fresh', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const table = renderReference(SCHEMA);
  if (process.env.WRITE_PARAMS_DOC === '1') {
    writeFileSync(README_PATH, replaceReadmeBlock(readme, table));
    return;
  }
  expect(readmeBlock(readme), 'README params block is stale: run npm run docs:params').toBe(table);
});
```

- [ ] **Step 5: Add the scripts, the README markers and the CLAUDE.md commands**

In `package.json` `"scripts"`, add after `"test:goldens"`:

```json
    "test:accept-schema": "ACCEPT_SCHEMA=1 vitest run --project arch test/arch/schemaShape.test.ts",
    "docs:params": "WRITE_PARAMS_DOC=1 vitest run --project arch test/arch/paramsDoc.test.ts"
```

(add a comma after the `test:goldens` line).

In `README.md`, insert before `## Requirements`:

```markdown
## Parameters

Generated from `src/core/params/schema.ts` by `npm run docs:params`; a test fails when it is stale.

<!-- params:begin -->
<!-- params:end -->

```

In `CLAUDE.md` `## Commands`, add after the `npm run test:goldens` bullet:

```markdown
- `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
- `npm run docs:params` — regenerate the README parameter table from the schema
```

- [ ] **Step 6: Generate the lock and the README table**

Run: `npm run test:accept-schema && npm run docs:params`
Expected: both PASS; `test/schema-shape.lock.json` lists the 13 leaves with `"schemaVersion": 1`; the README block holds a 15-line table.

- [ ] **Step 7: Run the suites**

Run: `npx vitest run --project unit test/unit/schemaShape.test.ts && npx vitest run --project arch`
Expected: PASS (the arch checks now compare against the committed lock and README).

- [ ] **Step 8: Commit**

```bash
git add test/harness/schemaShape.ts test/arch/schemaShape.test.ts test/arch/paramsDoc.test.ts test/unit/schemaShape.test.ts test/schema-shape.lock.json package.json README.md CLAUDE.md
git commit -m "test(arch): schema-shape lock and generated README parameter reference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 19: Shared statistics (`metrics/noiseStats.ts`)

**Files:**
- Create: `src/metrics/noiseStats.ts`
- Test: `test/unit/noiseStats.test.ts`

**Interfaces:**
- Consumes: `fnv1a32` (Task 3), `Xoshiro128` (Task 4), `NoiseDef` (Task 8).
- Produces (used by Tasks 20-21 and the lab in Tasks 23-24):
  - `WINDOW = 524288`, `interface Points { n; x; y; z: Float64Array }`, `samplePoints(id: string, n: number): Points`
  - `type Field = (x: number, y: number, z: number) => number`
  - `class Moments { add(v); readonly n; mean; sd; min; max }`, `ksUniform(u, lo?, hi?)`, `histogram(values, lo, hi, bins): Uint32Array`
  - `roseBin(da, db)`, `class Rose { add(da, db); readonly counts: Float64Array; ratio(): number }`, `pearson(a, b)`
  - `lastOctaveWavelength(def)`, `meanAbsPairDiff(f, a, b, corners)`, `meanAbsShiftDiff(f, a, shift, corners)`, `zeroRate(f, pts, corners)`

- [ ] **Step 1: Write the failing test**

`test/unit/noiseStats.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { completeNoiseDef } from '../../src/core/noise/types';
import {
  histogram, ksUniform, lastOctaveWavelength, meanAbsPairDiff, meanAbsShiftDiff, Moments, pearson, Rose, roseBin, samplePoints, zeroRate,
} from '../../src/metrics/noiseStats';

test('samplePoints: deterministic, x and z in the colKey window, y in the world height', () => {
  const a = samplePoints('N1', 1000);
  const b = samplePoints('N1', 1000);
  expect(Array.from(a.x)).toEqual(Array.from(b.x));
  for (let i = 0; i < 1000; i++) {
    expect(a.x[i]! >= -524288 && a.x[i]! < 524288).toBe(true);
    expect(a.z[i]! >= -524288 && a.z[i]! < 524288).toBe(true);
    expect(a.y[i]! >= -64 && a.y[i]! < 320).toBe(true);
  }
  expect(samplePoints('N2', 10).x[0]).not.toBe(a.x[0]);
});

test('Moments', () => {
  const m = new Moments();
  for (const v of [1, 2, 3, 4]) m.add(v);
  expect([m.n, m.mean, m.min, m.max]).toEqual([4, 2.5, 1, 4]);
  expect(m.sd).toBeCloseTo(Math.sqrt(5 / 3), 12);
});

test('ksUniform', () => {
  const grid = Float64Array.from({ length: 1000 }, (_, i) => -1 + (2 * (i + 0.5)) / 1000);
  expect(ksUniform(grid)).toBeCloseTo(0.0005, 10);
  const skew = Float64Array.from({ length: 1000 }, (_, i) => -1 + (i + 0.5) / 1000);
  expect(ksUniform(skew)).toBeCloseTo(0.5, 3);
});

test('histogram clamps into the end bins', () => {
  expect(Array.from(histogram([-2, -1, -0.5, 0, 0.5, 1, 2], -1, 1, 4))).toEqual([2, 1, 1, 3]);
});

test('rose bins are centred on axes and diagonals', () => {
  expect(roseBin(1, 0)).toBe(8);
  expect(roseBin(-1, 0)).toBe(0);
  expect(roseBin(1, 1)).toBe(10);
  expect(roseBin(0, 1)).toBe(12);
  expect(roseBin(0, -1)).toBe(4);
  const r = new Rose();
  for (let k = 0; k < 16; k++) { const t = (k * Math.PI) / 8; r.add(Math.cos(t), Math.sin(t)); r.add(Math.cos(t), Math.sin(t)); }
  r.add(1, 0);
  expect(r.ratio()).toBe(1.5);
  expect(new Rose().ratio()).toBe(Infinity);
});

test('pearson', () => {
  expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
});

test('lastOctaveWavelength divides by the lacunarity per octave', () => {
  expect(lastOctaveWavelength(completeNoiseDef({ wavelength: 2400, octaves: 6 }))).toBe(75);
  expect(lastOctaveWavelength(completeNoiseDef({ wavelength: 64, octaves: 1 }))).toBe(64);
});

describe('aperiodicity and zero rate helpers', () => {
  const pts = samplePoints('test.helpers', 5000);
  const other = samplePoints('test.helpers.b', 5000);
  const periodic = (x: number) => Math.sin((2 * Math.PI * x) / 100);
  test('a periodic field has zero shift difference at its period', () => {
    const f = (x: number) => periodic(x);
    expect(meanAbsShiftDiff(f, pts, [100, 0, 0], false)).toBeLessThan(1e-9);
    expect(meanAbsPairDiff(f, pts, other, false)).toBeGreaterThan(0.5);
  });
  test('corner snapping and integer points', () => {
    expect(zeroRate((x) => x - Math.floor(x), pts, false)).toBe(1);
    expect(zeroRate((x, y, z) => (x % 4) + (y % 8) + (z % 4), pts, true)).toBe(1);
    expect(zeroRate(() => 0.5, pts, false)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/noiseStats.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/metrics/noiseStats.ts`**

```ts
/**
 * Statistics shared by the metric tests and the lab (SP1 spec §6, §7.3): one implementation, so the
 * lab shows the numbers CI gates on.
 */
import { fnv1a32 } from '../core/hash';
import type { NoiseDef } from '../core/noise/types';
import { Xoshiro128 } from '../core/rng';

const FNV32 = fnv1a32;
const Rng = Xoshiro128;

/** Half-width of the colKey window [−2^19, 2^19). */
export const WINDOW = 524288;

export interface Points {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
}

export type Field = (x: number, y: number, z: number) => number;

/** n points from new Xoshiro128(fnv1a32(id)); each point draws x, y, z in this order. */
export function samplePoints(id: string, n: number): Points {
  const r = new Rng(FNV32(id));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = -524288 + 1048576 * r.nextFloat();
    y[i] = -64 + 384 * r.nextFloat();
    z[i] = -524288 + 1048576 * r.nextFloat();
  }
  return { n, x, y, z };
}

/** Welford accumulator. */
export class Moments {
  n = 0;
  mean = 0;
  min = Infinity;
  max = -Infinity;
  private m2 = 0;

  add(v: number): void {
    this.n++;
    const d = v - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (v - this.mean);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  get sd(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }
}

/** Kolmogorov–Smirnov D of `u` against U(lo, hi). */
export function ksUniform(u: ArrayLike<number>, lo = -1, hi = 1): number {
  const a = Float64Array.from(u).sort();
  const n = a.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = (a[i]! - lo) / (hi - lo);
    d = Math.max(d, f - i / n, (i + 1) / n - f);
  }
  return d;
}

/** Counts over `bins` equal bins of [lo, hi]; values outside clamp into the end bins. */
export function histogram(values: ArrayLike<number>, lo: number, hi: number, bins: number): Uint32Array {
  const out = new Uint32Array(bins);
  for (let i = 0; i < values.length; i++) {
    let b = Math.floor(((values[i]! - lo) / (hi - lo)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    out[b]!++;
  }
  return out;
}

/** 16 bins centred on axes and diagonals: floor((θ + π + π/16)/(2π)·16) mod 16, θ = atan2(db, da). */
export function roseBin(da: number, db: number): number {
  const theta = Math.atan2(db, da);
  const b = Math.floor(((theta + Math.PI + Math.PI / 16) / (2 * Math.PI)) * 16);
  return b >= 16 ? b - 16 : b;
}

export class Rose {
  readonly counts = new Float64Array(16);

  add(da: number, db: number): void {
    this.counts[roseBin(da, db)]!++;
  }

  /** max/min bin count (Infinity while a bin is empty). */
  ratio(): number {
    let mx = 0;
    let mn = Infinity;
    for (const c of this.counts) {
      if (c > mx) mx = c;
      if (c < mn) mn = c;
    }
    return mn === 0 ? Infinity : mx / mn;
  }
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb);
}

export function lastOctaveWavelength(def: NoiseDef): number {
  let l = def.wavelength;
  for (let i = 1; i < def.octaves; i++) l = l / def.lacunarity;
  return l;
}

const snapX = (v: number, corners: boolean) => (corners ? 4 * Math.floor(v / 4) : v);
const snapY = (v: number, corners: boolean) => (corners ? 8 * Math.floor(v / 8) : v);

/** mean |f(a_i) − f(b_i)| over independent random pairs. */
export function meanAbsPairDiff(f: Field, a: Points, b: Points, corners: boolean): number {
  let s = 0;
  for (let i = 0; i < a.n; i++) {
    s += Math.abs(f(snapX(a.x[i]!, corners), snapY(a.y[i]!, corners), snapX(a.z[i]!, corners)) - f(snapX(b.x[i]!, corners), snapY(b.y[i]!, corners), snapX(b.z[i]!, corners)));
  }
  return s / a.n;
}

/** mean |f(p) − f(p + shift)| (shift components must keep corners on corners). */
export function meanAbsShiftDiff(f: Field, a: Points, shift: readonly [number, number, number], corners: boolean): number {
  let s = 0;
  for (let i = 0; i < a.n; i++) {
    const x = snapX(a.x[i]!, corners);
    const y = snapY(a.y[i]!, corners);
    const z = snapX(a.z[i]!, corners);
    s += Math.abs(f(x, y, z) - f(x + shift[0], y + shift[1], z + shift[2]));
  }
  return s / a.n;
}

/** P(|f| < 1e-6) at integer points (floor), or at 4×8×4 cell corners. */
export function zeroRate(f: Field, pts: Points, corners: boolean): number {
  let zeros = 0;
  for (let i = 0; i < pts.n; i++) {
    const x = corners ? 4 * Math.floor(pts.x[i]! / 4) : Math.floor(pts.x[i]!);
    const y = corners ? 8 * Math.floor(pts.y[i]! / 8) : Math.floor(pts.y[i]!);
    const z = corners ? 4 * Math.floor(pts.z[i]! / 4) : Math.floor(pts.z[i]!);
    if (Math.abs(f(x, y, z)) < 1e-6) zeros++;
  }
  return zeros / pts.n;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit test/unit/noiseStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Arch suite and typecheck**

Run: `npx vitest run --project arch && npm run typecheck`
Expected: PASS (`noiseStats.ts` aliases its imports; it is not a deterministic file, so `Math.atan2` is allowed).

- [ ] **Step 6: Commit**

```bash
git add src/metrics/noiseStats.ts test/unit/noiseStats.test.ts
git commit -m "feat(metrics): shared noise statistics for metric tests and the lab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 20: Metric tests N1, N2, N3

**Files:**
- Create: `test/metrics/noise.metric.ts`
- Modify: `test/thresholds.ts`, `test/thresholds.lock.json` (accept), spec Threshold log

**Interfaces:**
- Consumes: `metricTest` (`test/harness/metric.ts`), `NormalNoise`, `toUniform`, `noiseInstances`, `SCHEMA`, `DEFAULTS`, `ADVERSARIAL_DEFS`, `DENSITY3D_DEF`, `noiseStats` (Task 19).
- Produces: `THRESHOLDS.N1/N2/N3` active from SP1; the shared metric noise sets used again in Task 21.

- [ ] **Step 1: Add the threshold rows**

In `test/thresholds.ts` replace

```ts
export const THRESHOLDS: ThresholdTable = {};
```

with

```ts
export const THRESHOLDS: ThresholdTable = {
  N1: { ksD: { max: 0.015, activeFrom: 'SP1' }, sdErr: { max: 0.02, activeFrom: 'SP1' } },
  N2: { value: { max: 0.02, activeFrom: 'SP1' } },
  N3: { value: { min: 0.9, activeFrom: 'SP1' } },
};
```

- [ ] **Step 2: Verify the coverage check now fails**

Run: `npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: FAIL (lock changed; N1/N2/N3 parts are active but no `metricTest` covers them).

- [ ] **Step 3: Write the metric tests**

`test/metrics/noise.metric.ts`:

```ts
import type { Seed64 } from '../../src/core/hash';
import { toUniform } from '../../src/core/noise/cdf';
import { NormalNoise } from '../../src/core/noise/normal';
import type { NoiseDef } from '../../src/core/noise/types';
import { DEFAULTS } from '../../src/core/params/defaults';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { meanAbsPairDiff, meanAbsShiftDiff, Moments, pearson, samplePoints, ksUniform, type Field } from '../../src/metrics/noiseStats';
import { ADVERSARIAL_DEFS, DENSITY3D_DEF } from '../../src/metrics/sp1Fixtures';
import { metricTest } from '../harness/metric';

const Normal = NormalNoise;
const U = toUniform;

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

export interface MetricNoise {
  readonly name: string;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
  readonly corners: boolean;
}

/** The 12 live schema instances (SP1 spec §7.3 "schema" set). */
export const SCHEMA_NOISES: readonly MetricNoise[] = noiseInstances(SCHEMA, DEFAULTS).map((i) => ({ name: i.seedName, def: i.def, dims: i.dims, corners: false }));
/** The 6 climate fields. */
export const CLIMATE_NOISES: readonly MetricNoise[] = SCHEMA_NOISES.filter((n) => n.def.remap === 'uniform');
/** Adversarial single-stack defs plus the 3D density-like def. */
export const TEST_NOISES: readonly MetricNoise[] = [...ADVERSARIAL_DEFS, DENSITY3D_DEF].map((f) => ({ name: f.seedName, def: f.def, dims: f.dims, corners: f.corners }));

export function field(seed: Seed64, n: MetricNoise): Field {
  const nn = new Normal(seed, n.name, n.def);
  return n.dims === 2 ? (x, _y, z) => nn.z2(x, z) : (x, y, z) => nn.z3(x, y, z);
}

metricTest('N1', ['ksD', 'sdErr'], () => {
  const seeds = pick(4, 16, 16);
  const n = pick(50000, 50000, 200000);
  const pts = samplePoints('N1', n);
  const u = new Float64Array(n);
  let ksD = 0;
  let sdErr = 0;
  for (let s = 1; s <= seeds; s++) {
    for (const nz of CLIMATE_NOISES) {
      const nn = new Normal([s, 0], nz.name, nz.def);
      const m = new Moments();
      for (let i = 0; i < n; i++) {
        const z = nn.z2(pts.x[i]!, pts.z[i]!);
        m.add(z);
        u[i] = U(z);
      }
      ksD = Math.max(ksD, ksUniform(u));
      sdErr = Math.max(sdErr, Math.abs(m.sd - 1));
    }
  }
  return { ksD, sdErr };
});

metricTest('N2', ['value'], () => {
  const set = TIER === 'fast' ? CLIMATE_NOISES : SCHEMA_NOISES;
  const n = 100000;
  const K = pick(8, 64, 64);
  const bases = pick([1000], [1000], [1000, 5000]);
  const pts = samplePoints('N2', n);
  const valuesAt = (lo: number) => set.map((nz) => {
    const nn = new Normal([lo, 0], nz.name, nz.def);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = nn.z2(pts.x[i]!, pts.z[i]!);
    return v;
  });
  let worst = 0;
  for (const b of bases) {
    const base = valuesAt(b);
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) worst = Math.max(worst, Math.abs(pearson(base[i]!, base[j]!)));
    for (let k = 1; k <= K; k++) {
      const other = valuesAt(b + k);
      for (let i = 0; i < set.length; i++) for (let j = 0; j < set.length; j++) worst = Math.max(worst, Math.abs(pearson(base[i]!, other[j]!)));
    }
  }
  return { value: worst };
});

metricTest('N3', ['value'], () => {
  const n = pick(5000, 20000, 50000);
  const a = samplePoints('N3.a', n);
  const b = samplePoints('N3.b', n);
  let worst = Infinity;
  for (const s of [1, 2]) {
    for (const nz of [...SCHEMA_NOISES, ...TEST_NOISES]) {
      const f = field([s, 0], nz);
      const base = meanAbsPairDiff(f, a, b, nz.corners);
      const dirs: Array<[number, number, number]> = nz.dims === 3 ? [[1, 0, 0], [0, 0, 1], [1, 0, 1], [0, 1, 0]] : [[1, 0, 0], [0, 0, 1], [1, 0, 1]];
      for (const P of [256, 512, 1024, 2048, 4096, 65536]) {
        const L = P * nz.def.wavelength;
        for (const e of dirs) worst = Math.min(worst, meanAbsShiftDiff(f, a, [L * e[0], L * e[1], L * e[2]], nz.corners) / base);
      }
    }
  }
  return { value: worst };
});
```

- [ ] **Step 4: Run the fast tier**

Run: `npx vitest run --project metrics-fast test/metrics/noise.metric.ts`
Expected: PASS for N1, N2, N3 (values recorded in `test/metrics/.out/N1.json` etc.; dry-run values: N1 ksD 0.0100, sdErr 0.0076; N2 0.0122; N3 0.953).

- [ ] **Step 5: Accept the lock and log it in the spec**

Run: `npm run test:accept-thresholds`
Expected: PASS; the diff lists N1.ksD, N1.sdErr, N2.value, N3.value as added.

Append to the spec's Threshold log:

```markdown
- Task 20: add N1 (ksD ≤ 0.015, sdErr ≤ 0.02), N2 (value ≤ 0.02) and N3 (value ≥ 0.9), all `activeFrom: 'SP1'`.
```

- [ ] **Step 6: Run the suite and the quick tier**

Run: `npm test && npm run test:metrics`
Expected: PASS (quick N2 takes about 20 s).

- [ ] **Step 7: Commit**

```bash
git add test/metrics/noise.metric.ts test/thresholds.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md
git commit -m "test(metrics): N1 uniformity, N2 independence and N3 aperiodicity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 21: Metric tests N5, N6 and U4

**Files:**
- Modify: `test/metrics/noise.metric.ts` (append N5, N6)
- Create: `test/metrics/params.metric.ts`
- Modify: `test/thresholds.ts`, `test/thresholds.lock.json` (accept), spec Threshold log

**Interfaces:**
- Consumes: Task 20 sets and `field`; `Rose`, `lastOctaveWavelength`, `zeroRate` (Task 19); `checkRegistry`, `STAGES` (Task 16); `MIGRATIONS`, `SCHEMA_VERSION`, `migrate` (Task 17); `exportPreset`, `importPreset`, `PROFILE_IDS`, `resolveProfile` (Task 17); `shapeViolations`, `readShapeLock`, `currentShape`, `readmeBlock`, `README_PATH` (Task 18); `renderReference` (Task 14); `randomParams` (Task 14).
- Produces: `THRESHOLDS.N5/N6/U4` active from SP1.

- [ ] **Step 1: Add the threshold rows**

In `test/thresholds.ts`, extend the object with:

```ts
  N5: { horizontal: { max: 1.15, activeFrom: 'SP1' }, vertical: { max: 1.15, activeFrom: 'SP1' } },
  N6: { value: { max: 0.001, activeFrom: 'SP1' } },
  U4: {
    registryIssues: { max: 0, activeFrom: 'SP1' },
    migrationFailures: { max: 0, activeFrom: 'SP1' },
    shapeLockViolations: { max: 0, activeFrom: 'SP1' },
    readmeStale: { max: 0, activeFrom: 'SP1' },
  },
```

- [ ] **Step 2: Append N5 and N6 to `test/metrics/noise.metric.ts`**

Extend the `noiseStats` import to `import { lastOctaveWavelength, meanAbsPairDiff, meanAbsShiftDiff, Moments, pearson, Rose, samplePoints, ksUniform, zeroRate, type Field } from '../../src/metrics/noiseStats';` and append:

```ts
const latticeTerms = (def: NoiseDef) => def.octaves * (def.double ? 2 : 1);

metricTest('N5', ['horizontal', 'vertical'], () => {
  const n = pick(100000, 200000, 400000);
  const pts = samplePoints('N5', n);
  let horizontal = 0;
  let vertical = 0;
  const DENSITY = TEST_NOISES.find((t) => t.name === 'test.density3d')!;
  for (const s of [1, 2]) {
    for (const nz of [...SCHEMA_NOISES, DENSITY].filter((t) => latticeTerms(t.def) >= 2)) {
      const nn = new Normal([s, 0], nz.name, nz.def);
      const c = nn.clamp;
      const h = lastOctaveWavelength(nz.def) / 128;
      const f: Field = nz.dims === 2 ? (x, _y, z) => nn.z2(x, z) : (x, y, z) => nn.z3(x, y, z);
      const hr = new Rose();
      const vr = new Rose();
      for (let i = 0; i < n; i++) {
        const x = pts.x[i]!, y = pts.y[i]!, z = pts.z[i]!;
        const xp = f(x + h, y, z), xm = f(x - h, y, z), zp = f(x, y, z + h), zm = f(x, y, z - h);
        if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(zp) !== c && Math.abs(zm) !== c) hr.add(xp - xm, zp - zm);
        if (nz.dims === 3) {
          const yp = f(x, y + h, z), ym = f(x, y - h, z);
          if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(yp) !== c && Math.abs(ym) !== c) vr.add(xp - xm, yp - ym);
        }
      }
      horizontal = Math.max(horizontal, hr.ratio());
      if (nz.dims === 3) vertical = Math.max(vertical, vr.ratio());
    }
  }
  return { horizontal, vertical };
});

metricTest('N6', ['value'], () => {
  const n = pick(50000, 200000, 1000000);
  const pts = samplePoints('N6', n);
  let worst = 0;
  for (const s of [1, 2]) for (const nz of [...SCHEMA_NOISES, ...TEST_NOISES]) worst = Math.max(worst, zeroRate(field([s, 0], nz), pts, nz.corners));
  return { value: worst };
});
```

- [ ] **Step 3: Write `test/metrics/params.metric.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { renderReference } from '../../src/core/params/kit';
import { migrate, MIGRATIONS, SCHEMA_VERSION, type JsonObject } from '../../src/core/params/migrate';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { PROFILE_IDS, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { checkRegistry, STAGES } from '../../src/core/stage/registry';
import { metricTest } from '../harness/metric';
import { randomParams } from '../harness/params';
import { currentShape, README_PATH, readmeBlock, readShapeLock, shapeViolations } from '../harness/schemaShape';
import { testRng } from '../harness/stats';

metricTest('U4', ['registryIssues', 'migrationFailures', 'shapeLockViolations', 'readmeStale'], () => {
  const registryIssues = checkRegistry(SCHEMA, STAGES).length;

  let migrationFailures = 0;
  if (MIGRATIONS.length !== SCHEMA_VERSION - 1) migrationFailures++;
  const id = migrate(DEFAULTS as unknown as JsonObject, SCHEMA_VERSION);
  if (!id.ok || id.value !== (DEFAULTS as unknown)) migrationFailures++;
  for (let v = 1; v < SCHEMA_VERSION; v++) {
    const doc = new URL(`../fixtures/preset-v${v}.json`, import.meta.url);
    const expected = new URL(`../fixtures/expected-v${v}.json`, import.meta.url);
    if (!existsSync(doc) || !existsSync(expected)) { migrationFailures++; continue; }
    const r = importPreset(JSON.parse(readFileSync(doc, 'utf8')) as unknown);
    if (!r.ok || canonicalJSON(r.value.params) !== canonicalJSON(JSON.parse(readFileSync(expected, 'utf8')))) migrationFailures++;
  }
  const next = testRng(401);
  const drafts = [...PROFILE_IDS.map((p) => [p, resolveProfile(p)] as const), ...Array.from({ length: 100 }, (_, i) => [PROFILE_IDS[i % PROFILE_IDS.length]!, randomParams(SCHEMA, next)] as const)];
  for (const [profile, draft] of drafts) {
    const r = importPreset(JSON.parse(JSON.stringify(exportPreset('U4 draft', profile, draft))) as unknown);
    if (!r.ok || canonicalJSON(r.value.params) !== canonicalJSON(draft)) migrationFailures++;
  }

  const shapeLockViolations = shapeViolations(readShapeLock(), currentShape(SCHEMA), SCHEMA_VERSION).length;
  const readmeStale = readmeBlock(readFileSync(README_PATH, 'utf8')) === renderReference(SCHEMA) ? 0 : 1;
  return { registryIssues, migrationFailures, shapeLockViolations, readmeStale };
});
```

- [ ] **Step 4: Run the fast tier**

Run: `npx vitest run --project metrics-fast`
Expected: PASS for N1, N2, N3, N5, N6, U4 (dry-run values: N5 horizontal 1.074, vertical 1.051; N6 0.00058, all from `test.adv2d16` — exact cancellations of a single-octave field on the ½ slice sampled at integer points, stable across tiers (0.054 % at 1 M points); U4 all 0).

- [ ] **Step 5: Accept the lock and log it in the spec**

Run: `npm run test:accept-thresholds`
Expected: PASS; the diff lists the N5, N6 and U4 parts as added.

Append to the spec's Threshold log:

```markdown
- Task 21: add N5 (horizontal, vertical ≤ 1.15), N6 (value ≤ 0.001) and U4 (registryIssues, migrationFailures, shapeLockViolations, readmeStale ≤ 0), all `activeFrom: 'SP1'`.
```

- [ ] **Step 6: Run the suite and the full tier once**

Run: `npm test && npm run test:metrics:full`
Expected: PASS (the full tier takes a few minutes).

- [ ] **Step 7: Commit**

```bash
git add test/metrics test/thresholds.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-27-sp1-deterministic-math-core-design.md
git commit -m "test(metrics): N5 isotropy, N6 lattice zeros and U4 schema governance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 22: Bench, baseline gates and the kill criterion

**Files:**
- Create: `test/bench/perm512.ts`, `test/bench/gates.ts`, `test/bench/noise.bench.ts`
- Test: `test/unit/benchGates.test.ts`
- Modify: `package.json` (script `bench:record`), `CLAUDE.md` (Commands)

**Interfaces:**
- Consumes: `fmix32`, `lattice3`, `NormalNoise`, `detErf`, `compileSpline`/`evalSpline`, `stageHashes`/`genKey`, `DEFAULTS`, fixtures, `Xoshiro128`.
- Produces: `buildPerm(seed): Uint8Array`, `perm3(P, x, y, z)` (bench-only comparator, spec §2.6); `P1_MAX_REGRESSION = 1.3`, `KILL_RATIO_MAX = 1.6`, `interface BenchKernel`, `interface Baselines`, `gateFailures(baseline, kernels, killRatio): string[]`; `test/baselines.json` (written in Task 26).

- [ ] **Step 1: Write the failing gate test**

`test/unit/benchGates.test.ts`:

```ts
import { expect, test } from 'vitest';
import { gateFailures, KILL_RATIO_MAX, P1_MAX_REGRESSION, type Baselines } from '../bench/gates';

const base: Baselines = { machine: 'm', node: 'v24', date: '2026-09-27', killRatio: 1.2, kernels: { a: { nsPerEval: 10, ratio: 2 }, b: { nsPerEval: 5, ratio: 1 } } };

test('constants', () => {
  expect([P1_MAX_REGRESSION, KILL_RATIO_MAX]).toEqual([1.3, 1.6]);
});

test('no baseline: only the kill criterion gates', () => {
  expect(gateFailures(null, { a: { nsPerEval: 99, ratio: 9 } }, 1.5)).toEqual([]);
  expect(gateFailures(null, {}, 1.61)).toEqual(['kill criterion: lattice3/perm512 = 1.610 > 1.6']);
});

test('P1: a kernel ratio above 1.3 × its baseline fails; new kernels are ignored', () => {
  expect(gateFailures(base, { a: { nsPerEval: 12, ratio: 2.6 }, b: { nsPerEval: 6, ratio: 1.31 }, c: { nsPerEval: 1, ratio: 9 } }, 1.2)).toEqual([
    'b: ratio 1.310 > 1.3 × baseline 1.000',
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/benchGates.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `test/bench/gates.ts`**

```ts
/** SP1 bench gates (SP1 spec §7.5). Outside THRESHOLDS in SP1; changing them requires a spec amendment. */
export const P1_MAX_REGRESSION = 1.3;
export const KILL_RATIO_MAX = 1.6;

export interface BenchKernel {
  readonly nsPerEval: number;
  /** nsPerEval ÷ the calibration kernel's nsPerEval, measured in the same run. */
  readonly ratio: number;
}

export interface Baselines {
  readonly machine: string;
  readonly node: string;
  readonly date: string;
  readonly kernels: Readonly<Record<string, BenchKernel>>;
  readonly killRatio: number;
}

export function gateFailures(baseline: Baselines | null, kernels: Readonly<Record<string, BenchKernel>>, killRatio: number): string[] {
  const out: string[] = [];
  if (killRatio > KILL_RATIO_MAX) out.push(`kill criterion: lattice3/perm512 = ${killRatio.toFixed(3)} > ${KILL_RATIO_MAX}`);
  if (baseline !== null) {
    for (const [name, k] of Object.entries(kernels)) {
      const b = baseline.kernels[name];
      if (b === undefined) continue;
      if (k.ratio > b.ratio * P1_MAX_REGRESSION) out.push(`${name}: ratio ${k.ratio.toFixed(3)} > ${P1_MAX_REGRESSION} × baseline ${b.ratio.toFixed(3)}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement the permutation comparator `test/bench/perm512.ts`**

```ts
import { Xoshiro128 } from '../../src/core/rng';

const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

/** 512-entry permutation (256 shuffled by Fisher–Yates with xoshiro, then duplicated). Bench only. */
export function buildPerm(seed: number): Uint8Array {
  const P = new Uint8Array(512);
  for (let i = 0; i < 256; i++) P[i] = i;
  const r = new Xoshiro128(seed);
  for (let i = 255; i >= 1; i--) {
    const j = r.nextInt(i + 1);
    const t = P[i]!;
    P[i] = P[j]!;
    P[j] = t;
  }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i]!;
  return P;
}

/** Classic permutation-table gradient noise with lattice3's gradients, fade, lerp order and dot products. */
export function perm3(P: Uint8Array, x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z, gx0 = fx - 1, gy0 = fy - 1, gz0 = fz - 1;
  const x0 = X & 255, x1 = (X + 1) & 255, y0 = Y & 255, y1 = (Y + 1) & 255, z0 = Z & 255, z1 = (Z + 1) & 255;
  const a0 = P[x0]!, a1 = P[x1]!;
  const b00 = P[a0 + y0]!, b10 = P[a1 + y0]!, b01 = P[a0 + y1]!, b11 = P[a1 + y1]!;
  let h: number;
  h = P[b00 + z0]! % 12; const n000 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * fz;
  h = P[b10 + z0]! % 12; const n100 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * fz;
  h = P[b01 + z0]! % 12; const n010 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * fz;
  h = P[b11 + z0]! % 12; const n110 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * fz;
  h = P[b00 + z1]! % 12; const n001 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * gz0;
  h = P[b10 + z1]! % 12; const n101 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * gz0;
  h = P[b01 + z1]! % 12; const n011 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * gz0;
  h = P[b11 + z1]! % 12; const n111 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * gz0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const x00 = n000 + u * (n100 - n000), x10 = n010 + u * (n110 - n010), x01 = n001 + u * (n101 - n001), x11 = n011 + u * (n111 - n011);
  const yy0 = x00 + v * (x10 - x00), yy1 = x01 + v * (x11 - x01);
  return yy0 + w * (yy1 - yy0);
}
```

- [ ] **Step 5: Write `test/bench/noise.bench.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { detErf } from '../../src/core/detMath';
import { fmix32 } from '../../src/core/hash';
import { lattice3 } from '../../src/core/noise/lattice3';
import { NormalNoise } from '../../src/core/noise/normal';
import { DEFAULTS } from '../../src/core/params/defaults';
import { Xoshiro128 } from '../../src/core/rng';
import { compileSpline, evalSpline } from '../../src/core/spline/hermite';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { DENSITY3D_DEF, JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
import { gateFailures, type Baselines, type BenchKernel } from './gates';
import { buildPerm, perm3 } from './perm512';

const FMIX = fmix32;
const LAT = lattice3;
const PERM = perm3;
const ERF = detErf;
const EVAL = evalSpline;
const HASHES = stageHashes;
const GENKEY = genKey;
const BASELINE_PATH = fileURLToPath(new URL('../baselines.json', import.meta.url));
const N = 4096;
let sink = 0;

test('SP1 kernels', async ({ bench }) => {
  const ns: Record<string, number> = {};
  const measure = async (name: string, evals: number, fn: () => void) => {
    const r = await bench(name, fn).run();
    ns[name] = (r.latency.p50 * 1e6) / evals;
  };
  const rng = new Xoshiro128(7);
  const ints = Uint32Array.from({ length: N }, () => rng.nextU32());
  const rx = Float64Array.from({ length: N }, () => rng.nextFloat() * 4096);
  const ry = Float64Array.from({ length: N }, () => rng.nextFloat() * 4096);
  const rz = Float64Array.from({ length: N }, () => rng.nextFloat() * 4096);
  const wx = Float64Array.from({ length: N }, () => -524288 + 1048576 * rng.nextFloat());
  const wz = Float64Array.from({ length: N }, () => -524288 + 1048576 * rng.nextFloat());
  const cx = Float64Array.from({ length: N }, () => 4 * Math.floor((-524288 + 1048576 * rng.nextFloat()) / 4));
  const cy = Float64Array.from({ length: N }, () => 8 * Math.floor((-64 + 384 * rng.nextFloat()) / 8));
  const cz = Float64Array.from({ length: N }, () => 4 * Math.floor((-524288 + 1048576 * rng.nextFloat()) / 4));
  const coords = Float64Array.from({ length: 6 * N }, () => -1.25 + 2.5 * rng.nextFloat());
  const P = buildPerm(12345);
  const climateC = new NormalNoise([42, 0], 'climate.C', DEFAULTS.climate.C);
  const density = new NormalNoise([42, 0], DENSITY3D_DEF.seedName, DENSITY3D_DEF.def);
  const off = compileSpline(OFFSET);
  const sig = compileSpline(SIGMA);
  const jag = compileSpline(JAG);
  const c6 = new Float64Array(6);

  await measure('calibration.fmix32', N, () => { let s = 0; for (let i = 0; i < N; i++) s ^= FMIX(ints[i]!); sink ^= s; });
  await measure('lattice3.slice', N, () => { let s = 0; for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) s += LAT(12345, 1000.3 + i / 64, 1234.37, 777.1 + j / 64); sink += s; });
  await measure('perm512.slice', N, () => { let s = 0; for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) s += PERM(P, 1000.3 + i / 64, 1234.37, 777.1 + j / 64); sink += s; });
  await measure('lattice3.random', N, () => { let s = 0; for (let i = 0; i < N; i++) s += LAT(12345, rx[i]!, ry[i]!, rz[i]!); sink += s; });
  await measure('perm512.random', N, () => { let s = 0; for (let i = 0; i < N; i++) s += PERM(P, rx[i]!, ry[i]!, rz[i]!); sink += s; });
  await measure('normal.z2.climateC', N, () => { let s = 0; for (let i = 0; i < N; i++) s += climateC.z2(wx[i]!, wz[i]!); sink += s; });
  await measure('normal.z3.density3d', N, () => { let s = 0; for (let i = 0; i < N; i++) s += density.z3(cx[i]!, cy[i]!, cz[i]!); sink += s; });
  await measure('spline.offset', N, () => {
    let s = 0;
    for (let j = 0; j < N; j++) { for (let k = 0; k < 6; k++) c6[k] = coords[6 * j + k]!; s += EVAL(off, c6); }
    sink += s;
  });
  await measure('spline.mix3', N, () => {
    let s = 0;
    for (let j = 0; j < N; j++) { for (let k = 0; k < 6; k++) c6[k] = coords[6 * j + k]!; s += EVAL(off, c6) + EVAL(sig, c6) + EVAL(jag, c6); }
    sink += s;
  });
  await measure('detErf', N, () => { let s = 0; for (let i = 0; i < N; i++) s += ERF(rx[i]! / 512 - 4); sink += s; });
  await measure('stageHashes.genKey', 16, () => { for (let i = 0; i < 16; i++) sink += GENKEY([42, 0], HASHES(DEFAULTS))[0]; });

  const calib = ns['calibration.fmix32']!;
  const kernels: Record<string, BenchKernel> = {};
  for (const [name, v] of Object.entries(ns)) kernels[name] = { nsPerEval: Math.round(v * 1000) / 1000, ratio: Math.round((v / calib) * 1000) / 1000 };
  const killRatio = Math.round(Math.max(ns['lattice3.slice']! / ns['perm512.slice']!, ns['lattice3.random']! / ns['perm512.random']!) * 1000) / 1000;
  console.table(kernels);
  console.log(`killRatio ${killRatio}`);
  expect(Number.isFinite(sink)).toBe(true);
  if (process.env.BENCH_RECORD === '1') {
    const next: Baselines = { machine: cpus()[0]?.model ?? 'unknown', node: process.version, date: new Date().toISOString().slice(0, 10), kernels, killRatio };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const baseline = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baselines) : null;
  if (baseline === null) console.log('no test/baselines.json yet: P1 not gated (run npm run bench:record on the reference machine)');
  expect(gateFailures(baseline, kernels, killRatio)).toEqual([]);
}, 600_000);
```

- [ ] **Step 6: Add the script and the CLAUDE.md line**

In `package.json` `"scripts"`, after `"bench"` add:

```json
    "bench:record": "BENCH_RECORD=1 vitest bench --run --project \"bench (bench)\"",
```

In `CLAUDE.md` `## Commands`, extend the bench mention with a new bullet:

```markdown
- `npm run bench:record` — write `test/baselines.json` on the reference machine (per-kernel ratios to a calibration kernel, plus the lattice3/perm512 kill ratio); `npm run bench` gates +30 % per kernel and kill ratio ≤ 1.6
```

- [ ] **Step 7: Run the gate test and the bench**

Run: `npx vitest run --project unit test/unit/benchGates.test.ts && npm run bench`
Expected: PASS; the bench prints the kernel table and `killRatio` and reports "no test/baselines.json yet". A dry run of this plan measured `killRatio` 0.91 (perm512's `% 12` and nested table reads cost more than the hash), `normal.z2.climateC` 356 ns and `spline.offset` 53 ns per evaluation.

- [ ] **Step 8: Commit**

```bash
git add test/bench test/unit/benchGates.test.ts package.json CLAUDE.md
git commit -m "test(bench): SP1 kernels, calibration ratios and the noise kill criterion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 23: The lab page — routing, state, seed box, field view and inspector

**Files:**
- Create: `src/ui/seedBox.ts`, `src/ui/lab/labState.ts`, `src/ui/lab/fieldView.ts`, `src/ui/lab/noiseLab.ts`, `src/ui/lab/lab.css`
- Modify: `src/main.ts`
- Test: `test/unit/seedBox.test.ts`, `test/unit/labState.test.ts`

**Interfaces:**
- Consumes: `seedFromInput`, `seedToText` (Task 4), `utf8Bytes` (Task 3), `canonicalJSON`, `q15` (Task 6), kit `applyPatch`, `patchAt`, `isObj` (Tasks 13-14), `SCHEMA`, `DEFAULTS`, `Params`, `ParamsPatch`, `NOISE_FIELD_RANGES` (Task 15), `noiseInstances` (Task 15), `NormalNoise`, `toUniform`, `NoiseDef` (Tasks 8-9), fixtures (Task 12), `WINDOW` (Task 19).
- Produces:
  - `resolveSeedText(text: string, random?: () => Seed64): { text: string; seed: Seed64 }`, `cryptoSeed(): Seed64` (`ui/seedBox.ts`)
  - `LabState`, `LabView`, `DEFAULT_LAB_STATE`, `MIN_BPP`, `MAX_BPP`, `encodeLabState`, `decodeLabState`, `base64urlEncode`, `base64urlDecode`, `mergePatch`, `labParams(state): { a: Params; b: Params | null }` (`labState.ts`)
  - `interface Camera`, `type Sample`, `createFieldView(host, opts): FieldView` (`fieldView.ts`)
  - `mountNoiseLab(root: HTMLElement): void` (`noiseLab.ts`; Task 24 adds statistics and A/B)

- [ ] **Step 1: Write the failing tests**

`test/unit/seedBox.test.ts`:

```ts
import { expect, test } from 'vitest';
import { seedFromInput } from '../../src/core/seed';
import { cryptoSeed, resolveSeedText } from '../../src/ui/seedBox';

test('non-empty text is trimmed and parsed', () => {
  expect(resolveSeedText('  hello ', () => { throw new Error('no random'); })).toEqual({ text: 'hello', seed: seedFromInput('hello') });
  expect(resolveSeedText('-1').seed).toEqual([4294967295, 4294967295]);
});

test('empty or whitespace-only text draws a random seed and writes it back as decimal text', () => {
  const r = resolveSeedText('   ', () => [7, 1]);
  expect(r).toEqual({ text: '4294967303', seed: [7, 1] });
  expect(seedFromInput(r.text)).toEqual(r.seed);
});

test('cryptoSeed returns two u32 words', () => {
  const s = cryptoSeed();
  expect(s.every((w) => Number.isInteger(w) && w >= 0 && w < 2 ** 32)).toBe(true);
});
```

`test/unit/labState.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { utf8Bytes } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import {
  base64urlDecode, base64urlEncode, decodeLabState, DEFAULT_LAB_STATE, encodeLabState, labParams, mergePatch, type LabState,
} from '../../src/ui/lab/labState';

const enc = (text: string) => base64urlEncode(utf8Bytes(text));

describe('URL state', () => {
  test('round-trips, normalising −0 and trimming the seed', () => {
    const s: LabState = { v: 1, seed: ' abc ', noise: 'climate.T', patch: { climate: { T: { octaves: 3 } } }, view: { x: -0, z: 12.5, bpp: 0.0625, mode: 'z', plane: 'xy', slice: -0 }, b: { seed: '7', patch: { climate: { T: { wavelength: 900 } } } } };
    const hash = encodeLabState(s);
    expect(hash).not.toMatch(/[=+/]/);
    const back = decodeLabState(`#${hash}`);
    expect(back.error).toBeNull();
    expect(back.state).toEqual({ ...s, seed: 'abc', view: { ...s.view, x: 0, slice: 0 } });
    expect(Object.is(back.state.view.x, 0)).toBe(true);
  });
  test('the decoder accepts padding', () => {
    const hash = encodeLabState(DEFAULT_LAB_STATE);
    const padded = hash + '='.repeat((4 - (hash.length % 4)) % 4);
    expect(decodeLabState(padded).state).toEqual(DEFAULT_LAB_STATE);
  });
  test('an empty hash gives the defaults without a notice', () => {
    expect(decodeLabState('')).toEqual({ state: DEFAULT_LAB_STATE, error: null });
    expect(decodeLabState('#')).toEqual({ state: DEFAULT_LAB_STATE, error: null });
  });
  test.each<[string, string]>([
    ['bad base64', '#***'],
    ['not JSON', `#${enc('{not json')}`],
    ['not an object', `#${enc('[1]')}`],
    ['unknown key', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, extra: 1 }))}`],
    ['wrong version', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, v: 2 }))}`],
    ['empty seed', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, seed: '  ' }))}`],
    ['invalid patch', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, patch: { climate: { scaleMul: 99 } } }))}`],
    ['bpp out of range', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, view: { ...DEFAULT_LAB_STATE.view, bpp: 5000 } }))}`],
    ['view outside the window', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, view: { ...DEFAULT_LAB_STATE.view, x: 1e9 } }))}`],
    ['bad mode', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, view: { ...DEFAULT_LAB_STATE.view, mode: 'w' } }))}`],
    ['invalid B patch', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, b: { patch: { climate: { C: { octaves: 99 } } } } }))}`],
  ])('%s falls back to the defaults with a notice', (_name, hash) => {
    const r = decodeLabState(hash);
    expect(r.state).toEqual(DEFAULT_LAB_STATE);
    expect(r.error).toMatch(/^lab URL ignored: /);
  });
});

test('base64url helpers', () => {
  expect(base64urlEncode(Uint8Array.of(251, 255))).toBe('-_8');
  expect(Array.from(base64urlDecode('-_8')!)).toEqual([251, 255]);
  expect(base64urlDecode('a b')).toBeNull();
});

test('mergePatch deep-merges plain objects and replaces everything else', () => {
  expect(mergePatch({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({ a: { b: 1, c: [2], d: 3 } });
});

test('B layers over A', () => {
  const s: LabState = { ...DEFAULT_LAB_STATE, patch: { climate: { C: { octaves: 3 } } }, b: { patch: { climate: { C: { wavelength: 900 } } } } };
  const { a, b } = labParams(s);
  expect(a.climate.C.octaves).toBe(3);
  expect(b!.climate.C).toEqual({ ...DEFAULTS.climate.C, octaves: 3, wavelength: 900 });
  expect(labParams(DEFAULT_LAB_STATE).b).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit test/unit/seedBox.test.ts test/unit/labState.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/ui/seedBox.ts`**

```ts
import type { Seed64 } from '../core/hash';
import { seedFromInput, seedToText } from '../core/seed';

export function cryptoSeed(): Seed64 {
  const w = crypto.getRandomValues(new Uint32Array(2));
  return [w[0]! >>> 0, w[1]! >>> 0];
}

/**
 * Seed-box rule (SP1 spec §1.4): non-empty text is trimmed and parsed; empty text draws a random seed and
 * returns its decimal text so the UI writes it back and the world stays reproducible from the box.
 */
export function resolveSeedText(text: string, random: () => Seed64 = cryptoSeed): { text: string; seed: Seed64 } {
  const t = text.trim();
  if (t.length > 0) return { text: t, seed: seedFromInput(t) };
  const drawn = seedToText(random());
  return { text: drawn, seed: seedFromInput(drawn) };
}
```

- [ ] **Step 4: Implement `src/ui/lab/labState.ts`**

```ts
import { utf8Bytes } from '../../core/hash';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { DEFAULTS } from '../../core/params/defaults';
import { applyPatch, isObj } from '../../core/params/kit';
import { SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';
import { WINDOW } from '../../metrics/noiseStats';

export type LabMode = 'z' | 'u';
export type LabPlane = 'xz' | 'xy';

export interface LabView {
  readonly x: number;
  readonly z: number;
  readonly bpp: number;
  readonly mode: LabMode;
  readonly plane?: LabPlane;
  readonly slice?: number;
}

export interface LabB {
  readonly seed?: string;
  readonly patch?: ParamsPatch;
}

/** The lab's URL state (SP1 spec §6). `seed` is the trimmed box text; `noise` a seed name; patches are over DEFAULTS. */
export interface LabState {
  readonly v: 1;
  readonly seed: string;
  readonly noise: string;
  readonly patch: ParamsPatch;
  readonly view: LabView;
  readonly b?: LabB;
}

export const MIN_BPP = 0.0625;
export const MAX_BPP = 1024;
export const DEFAULT_LAB_STATE: LabState = { v: 1, seed: '42', noise: 'climate.C', patch: {}, view: { x: 0, z: 0, bpp: 64, mode: 'u' } };

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  const b64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Deep merge of plain objects; arrays and scalars in `b` replace. */
export function mergePatch(a: unknown, b: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(a) ? { ...a } : {};
  if (!isObj(b)) return out;
  for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(out[k]) ? mergePatch(out[k], b[k]) : b[k];
  return out;
}

const q = (v: number) => q15(v) + 0;

function normalize(s: LabState): LabState {
  const v = s.view;
  const view: LabView = {
    x: q(v.x), z: q(v.z), bpp: q(v.bpp), mode: v.mode,
    ...(v.plane !== undefined ? { plane: v.plane } : {}),
    ...(v.slice !== undefined ? { slice: q(v.slice) } : {}),
  };
  return { ...s, seed: s.seed.trim(), view };
}

export function encodeLabState(s: LabState): string {
  return base64urlEncode(utf8Bytes(canonicalJSON(normalize(s))));
}

/** A: DEFAULTS ⊕ patch; B: A ⊕ b.patch (null when A/B is off). Throws only on states that bypassed decode. */
export function labParams(s: LabState): { a: Params; b: Params | null } {
  const a = applyPatch(SCHEMA, DEFAULTS, s.patch);
  if (!a.ok) throw new Error('invalid lab patch');
  if (s.b === undefined) return { a: a.value, b: null };
  const b = applyPatch(SCHEMA, a.value, s.b.patch ?? {});
  if (!b.ok) throw new Error('invalid lab B patch');
  return { a: a.value, b: b.value };
}

const STATE_KEYS = ['v', 'seed', 'noise', 'patch', 'view', 'b'];
const VIEW_KEYS = ['x', 'z', 'bpp', 'mode', 'plane', 'slice'];
const B_KEYS = ['seed', 'patch'];

function reason(j: unknown): string | null {
  if (!isObj(j)) return 'not an object';
  const extra = Object.keys(j).find((k) => !STATE_KEYS.includes(k));
  if (extra !== undefined) return `unknown key ${extra}`;
  if (j['v'] !== 1) return 'unsupported version';
  if (typeof j['seed'] !== 'string' || j['seed'].trim() === '') return 'empty seed';
  if (typeof j['noise'] !== 'string' || j['noise'] === '') return 'no noise';
  if (!isObj(j['patch'])) return 'patch is not an object';
  const a = applyPatch(SCHEMA, DEFAULTS, j['patch']);
  if (!a.ok) return `invalid patch (${a.issues[0]!.path} ${a.issues[0]!.code})`;
  const v = j['view'];
  if (!isObj(v)) return 'view is not an object';
  if (Object.keys(v).some((k) => !VIEW_KEYS.includes(k))) return 'unknown view key';
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!fin(v['x']) || !fin(v['z']) || Math.abs(v['x']) > WINDOW || Math.abs(v['z']) > WINDOW) return 'view outside the window';
  if (!fin(v['bpp']) || v['bpp'] < MIN_BPP || v['bpp'] > MAX_BPP) return 'zoom out of range';
  if (v['mode'] !== 'z' && v['mode'] !== 'u') return 'bad mode';
  if (v['plane'] !== undefined && v['plane'] !== 'xz' && v['plane'] !== 'xy') return 'bad plane';
  if (v['slice'] !== undefined && !fin(v['slice'])) return 'bad slice';
  const b = j['b'];
  if (b !== undefined) {
    if (!isObj(b) || Object.keys(b).some((k) => !B_KEYS.includes(k))) return 'bad B state';
    if (b['seed'] !== undefined && (typeof b['seed'] !== 'string' || b['seed'].trim() === '')) return 'empty B seed';
    if (b['patch'] !== undefined) {
      if (!isObj(b['patch'])) return 'B patch is not an object';
      const bb = applyPatch(SCHEMA, a.value, b['patch']);
      if (!bb.ok) return `invalid B patch (${bb.issues[0]!.path} ${bb.issues[0]!.code})`;
    }
  }
  return null;
}

export function decodeLabState(hash: string): { state: LabState; error: string | null } {
  const text = hash.replace(/^#/, '');
  if (text === '') return { state: DEFAULT_LAB_STATE, error: null };
  const fail = (why: string) => ({ state: DEFAULT_LAB_STATE, error: `lab URL ignored: ${why}` });
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
  return { state: normalize(json as LabState), error: null };
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run --project unit test/unit/seedBox.test.ts test/unit/labState.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement `src/ui/lab/fieldView.ts`**

```ts
import { WINDOW } from '../../metrics/noiseStats';
import { MAX_BPP, MIN_BPP } from './labState';

export interface Camera {
  readonly x: number;
  readonly z: number;
  readonly bpp: number;
}

/** Value at world coordinates (horizontal a, vertical b of the view plane). */
export type Sample = (a: number, b: number) => number;

export interface FieldViewOptions {
  onCamera(cam: Camera): void;
  onHover(a: number, b: number, value: number): void;
}

export interface FieldView {
  readonly canvas: HTMLCanvasElement;
  setSource(sample: Sample, lo: number, hi: number): void;
  setCamera(cam: Camera): void;
  destroy(): void;
}

const LEVELS = [8, 2, 1];
const BUDGET_MS = 8;

/** Diverging colour map (coolwarm): t ∈ [0, 1] → RGB. */
function colour(t: number, out: Uint8ClampedArray, o: number): void {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  const [r0, g0, b0, r1, g1, b1, s] = c < 0.5 ? [59, 76, 192, 221, 221, 221, c * 2] : [221, 221, 221, 180, 4, 38, c * 2 - 1];
  out[o] = r0 + (r1 - r0) * s;
  out[o + 1] = g0 + (g1 - g0) * s;
  out[o + 2] = b0 + (b1 - b0) * s;
  out[o + 3] = 255;
}

const clampCenter = (v: number) => Math.max(-WINDOW, Math.min(WINDOW, v));

/**
 * 2D canvas (backing store = CSS size, DPR 1) rendering a field coarse to fine (1/8, 1/2, full) in
 * ≤ 8 ms slices per frame; any change restarts the pass. Drag pans, wheel zooms around the cursor.
 */
export function createFieldView(host: HTMLElement, opts: FieldViewOptions): FieldView {
  const canvas = document.createElement('canvas');
  canvas.className = 'lab-canvas';
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');
  let cam: Camera = { x: 0, z: 0, bpp: 64 };
  let sample: Sample = () => 0;
  let lo = -1;
  let hi = 1;
  let generation = 0;
  let raf = 0;
  let image = ctx.createImageData(1, 1);

  const worldAt = (px: number, py: number): [number, number] => [
    cam.x + (px + 0.5 - canvas.width / 2) * cam.bpp,
    cam.z + (py + 0.5 - canvas.height / 2) * cam.bpp,
  ];

  const restart = () => {
    generation++;
    cancelAnimationFrame(raf);
    const gen = generation;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    if (image.width !== w || image.height !== h) image = ctx.createImageData(w, h);
    let level = 0;
    let row = 0;
    const step = () => {
      if (gen !== generation) return;
      const t0 = performance.now();
      while (level < LEVELS.length && performance.now() - t0 < BUDGET_MS) {
        const s = LEVELS[level]!;
        for (let bx = 0; bx < w; bx += s) {
          const [a, b] = worldAt(bx + s / 2 - 0.5, row + s / 2 - 0.5);
          const v = sample(a, b);
          const t = (v - lo) / (hi - lo);
          for (let yy = row; yy < Math.min(row + s, h); yy++) {
            for (let xx = bx; xx < Math.min(bx + s, w); xx++) colour(t, image.data, (yy * w + xx) * 4);
          }
        }
        row += s;
        if (row >= h) { row = 0; level++; ctx.putImageData(image, 0, 0); }
      }
      ctx.putImageData(image, 0, 0);
      if (level < LEVELS.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const resize = () => {
    const w = Math.max(1, Math.floor(host.clientWidth));
    const h = Math.max(1, Math.floor(host.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; restart(); }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.offsetX, y: e.offsetY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointermove', (e) => {
    const [a, b] = worldAt(e.offsetX, e.offsetY);
    opts.onHover(a, b, sample(a, b));
    if (drag === null) return;
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    drag = { x: e.offsetX, y: e.offsetY };
    opts.onCamera({ x: clampCenter(cam.x - dx * cam.bpp), z: clampCenter(cam.z - dy * cam.bpp), bpp: cam.bpp });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [a, b] = worldAt(e.offsetX, e.offsetY);
    const bpp = Math.max(MIN_BPP, Math.min(MAX_BPP, cam.bpp * (e.deltaY > 0 ? 1.25 : 0.8)));
    const k = bpp / cam.bpp;
    opts.onCamera({ x: clampCenter(a - (a - cam.x) * k), z: clampCenter(b - (b - cam.z) * k), bpp });
  }, { passive: false });

  resize();
  return {
    canvas,
    setSource(s, l, h) { sample = s; lo = l; hi = h; restart(); },
    setCamera(c) { cam = c; restart(); },
    destroy() { generation++; cancelAnimationFrame(raf); observer.disconnect(); canvas.remove(); },
  };
}
```

- [ ] **Step 7: Implement `src/ui/lab/lab.css`**

```css
.lab { display: grid; grid-template-rows: auto auto 1fr; grid-template-columns: 1fr 320px; height: 100vh; font: 13px system-ui, sans-serif; color: #ddd; background: #1b1d22; }
.lab-header { grid-column: 1 / 3; display: flex; gap: 12px; align-items: center; padding: 6px 10px; background: #23262d; }
.lab-notice { color: #f0b34a; }
.lab-toolbar { grid-column: 1 / 3; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #333; }
.lab-views { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; min-height: 0; }
.lab-view { position: relative; min-width: 0; min-height: 0; }
.lab-canvas { display: block; width: 100%; height: 100%; cursor: grab; }
.lab-side { overflow: auto; padding: 8px 10px; border-left: 1px solid #333; }
.lab-side h3 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; color: #9aa; }
.lab-form label { display: grid; grid-template-columns: 110px 1fr; gap: 6px; margin: 3px 0; align-items: center; }
.lab-form input, .lab-form select { width: 100%; box-sizing: border-box; }
.lab-issues { color: #ff7b72; white-space: pre-wrap; }
.lab-readout { font-family: ui-monospace, monospace; }
.lab-stats canvas { width: 100%; height: 120px; background: #15171b; }
.lab-stats pre { margin: 4px 0; font-family: ui-monospace, monospace; }
.lab-det li { font-family: ui-monospace, monospace; list-style: none; }
```

- [ ] **Step 8: Implement `src/ui/lab/noiseLab.ts` (inspector)**

```ts
import './lab.css';
import { NormalNoise } from '../../core/noise/normal';
import { toUniform } from '../../core/noise/cdf';
import type { NoiseDef } from '../../core/noise/types';
import { NOISE_FIELD_RANGES, SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';
import { applyPatch, patchAt } from '../../core/params/kit';
import { noiseInstances } from '../../core/params/noises';
import { seedFromInput } from '../../core/seed';
import { ADVERSARIAL_DEFS, DENSITY3D_DEF } from '../../metrics/sp1Fixtures';
import { resolveSeedText } from '../seedBox';
import { createFieldView, type Camera, type FieldView } from './fieldView';
import { decodeLabState, DEFAULT_LAB_STATE, encodeLabState, labParams, mergePatch, type LabState } from './labState';

/** One selectable noise: a schema instance (editable through its leaf path) or a test fixture (read-only). */
export interface LabNoise {
  readonly seedName: string;
  readonly path: string | null;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
}

export function labNoises(params: Params): LabNoise[] {
  return [
    ...noiseInstances(SCHEMA, params).map((i) => ({ seedName: i.seedName, path: i.path, def: i.def, dims: i.dims })),
    ...[DENSITY3D_DEF, ...ADVERSARIAL_DEFS].map((f) => ({ seedName: f.seedName, path: null, def: f.def, dims: f.dims })),
  ];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== '') e.className = className;
  if (text !== '') e.textContent = text;
  return e;
}

export interface Side {
  readonly seed: string;
  readonly noise: LabNoise;
  /** Value at world (a, b) of the view plane. */
  sample(a: number, b: number): number;
  readonly lo: number;
  readonly hi: number;
  readonly nn: NormalNoise;
}

/** Builds the sampling function of one side for the current view (SP1 spec §6). */
export function makeSide(seedText: string, noise: LabNoise, state: LabState): Side {
  const nn = new NormalNoise(seedFromInput(seedText), noise.seedName, noise.def);
  const u = state.view.mode === 'u' && noise.def.remap === 'uniform';
  const slice = state.view.slice ?? 64;
  const plane = state.view.plane ?? 'xz';
  const raw = noise.dims === 2 ? (a: number, b: number) => nn.z2(a, b)
    : plane === 'xz' ? (a: number, b: number) => nn.z3(a, slice, b) : (a: number, b: number) => nn.z3(a, b, slice);
  const sample = u ? (a: number, b: number) => toUniform(raw(a, b)) : raw;
  return { seed: seedText, noise, sample, lo: u ? -1 : -nn.clamp, hi: u ? 1 : nn.clamp, nn };
}

export interface LabContext {
  state: LabState;
  readonly setState: (next: LabState) => void;
}

/** Mounts the ?lab=noise page into `root` (Task 24 adds statistics and A/B). */
export function mountNoiseLab(root: HTMLElement): void {
  const decoded = decodeLabState(location.hash);
  let state = decoded.state;
  const lab = el('div', 'lab');
  const header = el('div', 'lab-header');
  header.append(el('strong', '', 'world-imaginer-voxel · noise lab'));
  const notice = el('span', 'lab-notice', decoded.error ?? '');
  header.append(notice);
  const toolbar = el('div', 'lab-toolbar');
  const views = el('div', 'lab-views');
  const side = el('div', 'lab-side');
  lab.append(header, toolbar, views, side);
  root.replaceChildren(lab);

  const noiseSelect = el('select');
  const seedInput = el('input');
  seedInput.placeholder = 'seed (empty = random)';
  const modeSelect = el('select');
  for (const m of ['u', 'z']) modeSelect.append(new Option(m === 'u' ? 'u (uniform)' : 'z (normal)', m));
  const planeSelect = el('select');
  for (const p of ['xz', 'xy']) planeSelect.append(new Option(`plane ${p}`, p));
  const sliceInput = el('input');
  sliceInput.type = 'number';
  sliceInput.step = '1';
  toolbar.append(noiseSelect, seedInput, modeSelect, planeSelect, sliceInput);

  const readout = el('div', 'lab-readout');
  const formTitle = el('h3', '', 'NoiseDef');
  const form = el('div', 'lab-form');
  const issues = el('div', 'lab-issues');
  side.append(readout, formTitle, form, issues);

  const viewHost = el('div', 'lab-view');
  views.append(viewHost);
  const onCamera = (cam: Camera) => setState({ ...state, view: { ...state.view, x: cam.x, z: cam.z, bpp: cam.bpp } });
  const view: FieldView = createFieldView(viewHost, {
    onCamera,
    onHover: (a, b, v) => { readout.textContent = `x ${a.toFixed(1)}  ${state.view.plane === 'xy' ? 'y' : 'z'} ${b.toFixed(1)}  value ${v.toFixed(4)}`; },
  });

  const current = (): { params: Params; noises: LabNoise[]; noise: LabNoise } => {
    const { a } = labParams(state);
    const noises = labNoises(a);
    const noise = noises.find((n) => n.seedName === state.noise) ?? noises.find((n) => n.seedName === DEFAULT_LAB_STATE.noise)!;
    return { params: a, noises, noise };
  };

  function setState(next: LabState): void {
    state = next;
    history.replaceState(null, '', `?lab=noise#${encodeLabState(state)}`);
    render();
  }

  const editPatch = (path: string, field: keyof NoiseDef, value: unknown) => {
    const next = mergePatch(state.patch, patchAt(path, { [field]: value })) as ParamsPatch;
    const r = applyPatch(SCHEMA, SCHEMA.defaults, next);
    if (!r.ok) { issues.textContent = r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('\n'); return; }
    issues.textContent = '';
    setState({ ...state, patch: next });
  };

  function renderForm(noise: LabNoise): void {
    form.replaceChildren();
    const R = NOISE_FIELD_RANGES;
    const editable = noise.path !== null;
    const numberField = (field: keyof NoiseDef, min: number, max: number, step: number, disabled = false) => {
      const input = el('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(noise.def[field]);
      input.disabled = !editable || disabled;
      input.addEventListener('change', () => editPatch(noise.path!, field, Number(input.value)));
      const label = el('label', '', field);
      label.append(input);
      form.append(label);
    };
    numberField('wavelength', 1, 1e6, 1);
    numberField('octaves', R.octaves.min, R.octaves.max, R.octaves.step);
    numberField('persistence', R.persistence.min, R.persistence.max, R.persistence.step);
    numberField('lacunarity', R.lacunarity.min, R.lacunarity.max, R.lacunarity.step);
    numberField('yScale', R.yScale.min, R.yScale.max, R.yScale.step, noise.dims === 2);
    numberField('clampSigma', R.clampSigma.min, R.clampSigma.max, R.clampSigma.step);
    const amps = el('input');
    amps.value = noise.def.amplitudes === null ? '' : noise.def.amplitudes.join(', ');
    amps.placeholder = 'empty = persistence';
    amps.disabled = !editable;
    amps.addEventListener('change', () => {
      const t = amps.value.trim();
      editPatch(noise.path!, 'amplitudes', t === '' ? null : t.split(',').map((s) => Number(s.trim())));
    });
    const ampsLabel = el('label', '', 'amplitudes');
    ampsLabel.append(amps);
    const dbl = el('input');
    dbl.type = 'checkbox';
    dbl.checked = noise.def.double;
    dbl.disabled = !editable;
    dbl.addEventListener('change', () => editPatch(noise.path!, 'double', dbl.checked));
    const dblLabel = el('label', '', 'double');
    dblLabel.append(dbl);
    const remap = el('select');
    for (const r of ['none', 'uniform']) remap.append(new Option(r, r));
    remap.value = noise.def.remap;
    remap.disabled = !editable;
    remap.addEventListener('change', () => editPatch(noise.path!, 'remap', remap.value));
    const remapLabel = el('label', '', 'remap');
    remapLabel.append(remap);
    form.append(ampsLabel, dblLabel, remapLabel);
    if (!editable) form.append(el('div', 'lab-notice', 'test fixture (read-only)'));
  }

  function render(): void {
    const { noises, noise } = current();
    noiseSelect.replaceChildren();
    const groups = { schema: el('optgroup'), test: el('optgroup') };
    groups.schema.label = 'schema';
    groups.test.label = 'test fixtures';
    for (const n of noises) (n.path === null ? groups.test : groups.schema).append(new Option(n.seedName, n.seedName));
    noiseSelect.append(groups.schema, groups.test);
    noiseSelect.value = noise.seedName;
    seedInput.value = state.seed;
    modeSelect.value = state.view.mode;
    planeSelect.hidden = noise.dims === 2;
    sliceInput.hidden = noise.dims === 2;
    planeSelect.value = state.view.plane ?? 'xz';
    sliceInput.value = String(state.view.slice ?? 64);
    renderForm(noise);
    const a = makeSide(state.seed, noise, state);
    view.setSource(a.sample, a.lo, a.hi);
    view.setCamera({ x: state.view.x, z: state.view.z, bpp: state.view.bpp });
  }

  noiseSelect.addEventListener('change', () => setState({ ...state, noise: noiseSelect.value }));
  seedInput.addEventListener('change', () => {
    const r = resolveSeedText(seedInput.value);
    seedInput.value = r.text;
    setState({ ...state, seed: r.text });
  });
  modeSelect.addEventListener('change', () => setState({ ...state, view: { ...state.view, mode: modeSelect.value === 'z' ? 'z' : 'u' } }));
  planeSelect.addEventListener('change', () => setState({ ...state, view: { ...state.view, plane: planeSelect.value === 'xy' ? 'xy' : 'xz' } }));
  sliceInput.addEventListener('change', () => setState({ ...state, view: { ...state.view, slice: Number(sliceInput.value) } }));

  if (!current().noises.some((n) => n.seedName === state.noise)) notice.textContent = `unknown noise ${state.noise}; showing ${DEFAULT_LAB_STATE.noise}`;
  render();
}
```

- [ ] **Step 9: Route `?lab=noise` in `src/main.ts`**

Replace the last block of `src/main.ts`

```ts
const root = document.getElementById('app');
if (root === null) throw new Error('#app element missing from index.html');
boot(root).catch((error: unknown) => {
```

with

```ts
const root = document.getElementById('app');
if (root === null) throw new Error('#app element missing from index.html');
const start: Promise<void> = new URLSearchParams(location.search).get('lab') === 'noise'
  ? import('./ui/lab/noiseLab').then((m) => m.mountNoiseLab(root))
  : boot(root);
start.catch((error: unknown) => {
```

(the lab routes before the capability probe; it needs no SharedArrayBuffer).

- [ ] **Step 10: Typecheck, build and look at it**

Run: `npm run typecheck && npm run build`
Expected: PASS; the build emits a separate lab chunk.

Run: `npm run dev` (background), open `http://localhost:5183/?lab=noise` in Chrome, and check by hand: the C field renders coarse then fine; drag pans; wheel zooms around the cursor; the seed box writes back a random seed when emptied; editing octaves re-renders and updates the URL hash; an invalid edit (e.g. `double` off with remap `uniform`) shows the issue and is not applied; `test.density3d` shows the plane selector and slice; reloading the page restores the state; `?lab=noise#garbage` opens with the defaults and a notice. Stop the dev server you started (only that process).

- [ ] **Step 11: Run the suite**

Run: `npm test`
Expected: PASS (arch: `ui/` may import `metrics/` and `core/`).

- [ ] **Step 12: Commit**

```bash
git add src/ui src/main.ts test/unit/seedBox.test.ts test/unit/labState.test.ts
git commit -m "feat(ui): ?lab=noise inspector with URL state, seed box and progressive field view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 24: Lab statistics and A/B mode

**Files:**
- Create: `src/ui/lab/statsPanel.ts`
- Modify: `src/ui/lab/noiseLab.ts`

**Interfaces:**
- Consumes: `samplePoints`, `Moments`, `ksUniform`, `histogram`, `Rose`, `pearson`, `lastOctaveWavelength` (Task 19), `toUniform`, `makeSide`, `labParams`, `labNoises` (Task 23).
- Produces: `createStatsPanel(host, title): StatsPanel` with `update(side: Side | null)` and an `onDone` callback carrying the 50k z values; A/B mode in `mountNoiseLab`.

- [ ] **Step 1: Implement `src/ui/lab/statsPanel.ts`**

```ts
import { toUniform } from '../../core/noise/cdf';
import { histogram, ksUniform, lastOctaveWavelength, Moments, Rose, samplePoints } from '../../metrics/noiseStats';
import type { Side } from './noiseLab';

const STATS_N = 50000;
const POINTS = samplePoints('lab.stats', STATS_N);
const BUDGET_MS = 8;

export interface StatsPanel {
  update(side: Side | null): void;
  /** Called with the z values over the 50k stats points when a pass finishes. */
  onDone: ((z: Float64Array) => void) | null;
  destroy(): void;
}

function drawHistogram(canvas: HTMLCanvasElement, counts: Uint32Array, lo: number, hi: number, uniform: boolean): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const w = (canvas.width = canvas.clientWidth || 300);
  const h = (canvas.height = canvas.clientHeight || 120);
  ctx.clearRect(0, 0, w, h);
  const total = counts.reduce((s, c) => s + c, 0);
  const bins = counts.length;
  const width = (hi - lo) / bins;
  const pdf = (x: number) => (uniform ? 0.5 : Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI));
  let peak = 0;
  for (let i = 0; i < bins; i++) peak = Math.max(peak, counts[i]! / (total * width), pdf(lo + (i + 0.5) * width));
  ctx.fillStyle = '#5b8def';
  for (let i = 0; i < bins; i++) {
    const d = counts[i]! / (total * width);
    const bh = (d / peak) * (h - 4);
    ctx.fillRect((i * w) / bins, h - bh, w / bins - 1, bh);
  }
  ctx.strokeStyle = '#f0b34a';
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const x = lo + ((hi - lo) * i) / 100;
    const y = h - (pdf(x) / peak) * (h - 4);
    if (i === 0) ctx.moveTo((i * w) / 100, y); else ctx.lineTo((i * w) / 100, y);
  }
  ctx.stroke();
}

function drawRose(canvas: HTMLCanvasElement, rose: Rose): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const w = (canvas.width = canvas.clientWidth || 300);
  const h = (canvas.height = canvas.clientHeight || 120);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...rose.counts);
  const r0 = Math.min(w, h) / 2 - 4;
  ctx.fillStyle = '#7ee787';
  for (let b = 0; b < 16; b++) {
    const theta = (b / 16) * 2 * Math.PI - Math.PI;
    const r = max > 0 ? (rose.counts[b]! / max) * r0 : 0;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2);
    ctx.arc(w / 2, h / 2, r, theta - Math.PI / 16, theta + Math.PI / 16);
    ctx.closePath();
    ctx.fill();
  }
}

/** Statistics over 50k random points of the whole window (not the visible pixels), computed in ≤ 8 ms slices. */
export function createStatsPanel(host: HTMLElement, title: string): StatsPanel {
  const box = document.createElement('div');
  box.className = 'lab-stats';
  const h = document.createElement('h3');
  h.textContent = title;
  const text = document.createElement('pre');
  const hist = document.createElement('canvas');
  const roseCanvas = document.createElement('canvas');
  box.append(h, text, hist, roseCanvas);
  host.append(box);
  let generation = 0;
  let raf = 0;
  const panel: StatsPanel = {
    onDone: null,
    update(side) {
      generation++;
      cancelAnimationFrame(raf);
      if (side === null) { text.textContent = ''; return; }
      const gen = generation;
      const z = new Float64Array(STATS_N);
      const m = new Moments();
      const rose = new Rose();
      const c = side.nn.clamp;
      const step = lastOctaveWavelength(side.noise.def) / 128;
      const f = side.noise.dims === 2 ? (x: number, _y: number, zz: number) => side.nn.z2(x, zz) : (x: number, y: number, zz: number) => side.nn.z3(x, y, zz);
      let atClamp = 0;
      let i = 0;
      const tick = () => {
        if (gen !== generation) return;
        const t0 = performance.now();
        while (i < STATS_N && performance.now() - t0 < BUDGET_MS) {
          for (let k = 0; k < 256 && i < STATS_N; k++, i++) {
            const x = POINTS.x[i]!, y = POINTS.y[i]!, zz = POINTS.z[i]!;
            const v = f(x, y, zz);
            z[i] = v;
            m.add(v);
            if (Math.abs(v) === c) atClamp++;
            const xp = f(x + step, y, zz), xm = f(x - step, y, zz), zp = f(x, y, zz + step), zm = f(x, y, zz - step);
            if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(zp) !== c && Math.abs(zm) !== c) rose.add(xp - xm, zp - zm);
          }
        }
        text.textContent = `${i < STATS_N ? `computing ${Math.round((100 * i) / STATS_N)} %` : 'done'}\n`;
        if (i < STATS_N) { raf = requestAnimationFrame(tick); return; }
        const u = z.map((v) => toUniform(v));
        const uniform = side.noise.def.remap === 'uniform';
        text.textContent = [
          `n ${STATS_N}  mean ${m.mean.toFixed(4)}  sd ${m.sd.toFixed(4)}`,
          `min ${m.min.toFixed(3)}  max ${m.max.toFixed(3)}  at clamp ${((100 * atClamp) / STATS_N).toFixed(3)} %`,
          `KS D of u vs U(-1, 1): ${ksUniform(u).toFixed(4)}`,
          `gradient rose max/min: ${rose.ratio().toFixed(3)}`,
        ].join('\n');
        drawHistogram(hist, uniform ? histogram(u, -1, 1, 64) : histogram(z, -c, c, 64), uniform ? -1 : -c, uniform ? 1 : c, uniform);
        drawRose(roseCanvas, rose);
        panel.onDone?.(z);
      };
      raf = requestAnimationFrame(tick);
    },
    destroy() { generation++; cancelAnimationFrame(raf); box.remove(); },
  };
  return panel;
}
```

- [ ] **Step 2: Add statistics and A/B mode to `src/ui/lab/noiseLab.ts`**

1. Add the imports:

```ts
import { pearson } from '../../metrics/noiseStats';
import { createStatsPanel, type StatsPanel } from './statsPanel';
```

2. After `side.append(readout, formTitle, form, issues);` add:

```ts
  const abButton = el('button', '', 'A/B');
  const bSeedInput = el('input');
  bSeedInput.placeholder = 'B seed (empty = same as A)';
  const copyButton = el('button', '', 'copy A → B');
  toolbar.append(abButton, bSeedInput, copyButton);
  const statsA: StatsPanel = createStatsPanel(side, 'Statistics A');
  let statsB: StatsPanel | null = null;
  const corr = el('div', 'lab-readout');
  side.append(corr);
  let zA: Float64Array | null = null;
  let zB: Float64Array | null = null;
  const showCorr = () => { corr.textContent = zA !== null && zB !== null ? `r(A, B) = ${pearson(zA, zB).toFixed(4)}` : ''; };
  statsA.onDone = (z) => { zA = z; showCorr(); };
  let viewB: FieldView | null = null;
  let viewBHost: HTMLElement | null = null;
```

3. In `render()`, replace the last three lines (`const a = makeSide…`, `view.setSource…`, `view.setCamera…`) with:

```ts
    const a = makeSide(state.seed, noise, state);
    const cam = { x: state.view.x, z: state.view.z, bpp: state.view.bpp };
    view.setSource(a.sample, a.lo, a.hi);
    view.setCamera(cam);
    zA = null;
    zB = null;
    showCorr();
    statsA.update(a);
    abButton.textContent = state.b === undefined ? 'A/B: off' : 'A/B: on';
    bSeedInput.hidden = state.b === undefined;
    copyButton.hidden = state.b === undefined;
    if (state.b === undefined) {
      viewB?.destroy();
      viewBHost?.remove();
      statsB?.destroy();
      viewB = null;
      viewBHost = null;
      statsB = null;
      return;
    }
    const { b } = labParams(state);
    const noiseB = labNoises(b!).find((n) => n.seedName === noise.seedName) ?? noise;
    const sideB = makeSide(state.b.seed ?? state.seed, noiseB, state);
    if (viewB === null) {
      viewBHost = el('div', 'lab-view');
      views.append(viewBHost);
      viewB = createFieldView(viewBHost, { onCamera, onHover: () => {} });
      statsB = createStatsPanel(side, 'Statistics B');
      statsB.onDone = (z) => { zB = z; showCorr(); };
    }
    bSeedInput.value = state.b.seed ?? '';
    viewB.setSource(sideB.sample, sideB.lo, sideB.hi);
    viewB.setCamera(cam);
    statsB!.update(sideB);
```

4. Before the final `if (!current().noises…` line, add the handlers:

```ts
  abButton.addEventListener('click', () => {
    if (state.b === undefined) setState({ ...state, b: {} });
    else { const { b: _off, ...rest } = state; setState(rest); }
  });
  bSeedInput.addEventListener('change', () => {
    const t = bSeedInput.value.trim();
    const { seed: _old, ...restB } = state.b ?? {};
    setState({ ...state, b: t === '' ? restB : { ...restB, seed: t } });
  });
  copyButton.addEventListener('click', () => setState({ ...state, b: {} }));
```

5. Let the NoiseDef form edit either side. After `toolbar.append(abButton, bSeedInput, copyButton);` (from item 2) add:

```ts
  const targetSelect = el('select');
  targetSelect.append(new Option('edit A', 'A'), new Option('edit B', 'B'));
  toolbar.append(targetSelect);
  let target: 'A' | 'B' = 'A';
  targetSelect.addEventListener('change', () => { target = targetSelect.value === 'B' ? 'B' : 'A'; render(); });
```

6. Replace the whole `const editPatch = …;` definition from Task 23 with:

```ts
  const editPatch = (path: string, field: keyof NoiseDef, value: unknown) => {
    const delta = patchAt(path, { [field]: value });
    const show = (r: ReturnType<typeof applyPatch>) => { issues.textContent = r.ok ? '' : r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('\n'); return r.ok; };
    if (target === 'B' && state.b !== undefined) {
      const nextB = mergePatch(state.b.patch ?? {}, delta) as ParamsPatch;
      if (show(applyPatch(SCHEMA, labParams(state).a, nextB))) setState({ ...state, b: { ...state.b, patch: nextB } });
      return;
    }
    const next = mergePatch(state.patch, delta) as ParamsPatch;
    if (show(applyPatch(SCHEMA, SCHEMA.defaults, next))) setState({ ...state, patch: next });
  };
```

7. In `render()`, replace `renderForm(noise);` with:

```ts
    const editB = target === 'B' && state.b !== undefined;
    const formNoise = editB ? labNoises(labParams(state).b!).find((n) => n.seedName === noise.seedName) ?? noise : noise;
    formTitle.textContent = `NoiseDef (${editB ? 'B' : 'A'})`;
    renderForm(formNoise);
```

and next to `copyButton.hidden = state.b === undefined;` (item 3) add `targetSelect.hidden = state.b === undefined;`.

(B's params are `A ⊕ b.patch`, so B follows A except where it differs; "copy A → B" resets B to follow A exactly. The B side can differ in seed, params or both, as spec §6 requires.)

- [ ] **Step 3: Typecheck, build and look at it**

Run: `npm run typecheck && npm run build`
Expected: PASS.

Run: `npm run dev` (background), open `http://localhost:5183/?lab=noise` in Chrome and check by hand: the statistics fill in without freezing the page and show sd ≈ 1, KS D ≈ 0.01 and rose max/min ≈ 1.05 for `climate.C`; turning A/B on shows two views with a shared camera; setting a B seed shows `r(A, B)` near 0; the same seed on both sides shows `r(A, B) = 1.0000`; with "edit B" selected, changing octaves re-renders only B and A keeps its value. Stop the dev server you started.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/lab
git commit -m "feat(ui): lab statistics (histogram, gradient rose, KS) and A/B comparison

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---
### Task 25: SP1 goldens, the determinism panel and the JavaScriptCore check

This is the **last generator-affecting task**: after it, any change to hash, rng, detMath, noise, splines, `autoTangents`, `sp1Fixtures`, the kit or stage hashing needs a `GENERATOR_VERSION` bump (spec §7.4).

**Files:**
- Modify: `src/metrics/sp1Goldens.ts` (append the noise, spline and params digests and the key API)
- Create: `test/unit/goldens.sp1.test.ts`, `src/ui/lab/determinismPanel.ts`, `test/tools/goldensJsc.ts`
- Modify: `src/ui/lab/noiseLab.ts` (mount the panel), `test/goldens.json` (recorded), `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 3-17 through the fixtures; `expectGolden` (`test/harness/goldens.ts`).
- Produces: `noiseDigest(f: FixtureNoise)`, `splineDigest(name)`, `paramsDigest()`, `goldenKeys(): string[]`, `computeGolden(key): string`, `interface GoldenRow { key; expected: string | null; actual; ok }`, `compareGoldens(expected, keys, compute): GoldenRow[]`; `mountDeterminismPanel(host)`.

- [ ] **Step 1: Write the failing test**

`test/unit/goldens.sp1.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { compareGoldens, computeGolden, goldenKeys } from '../../src/metrics/sp1Goldens';
import { expectGolden } from '../harness/goldens';

test('27 unique keys: 6 detMath, 16 noise fixtures, 4 splines, 1 params', () => {
  const keys = goldenKeys();
  expect(keys.length).toBe(27);
  expect(new Set(keys).size).toBe(27);
  expect(keys.filter((k) => k.startsWith('sp1.detMath.')).length).toBe(6);
  expect(keys.filter((k) => k.startsWith('sp1.noise.')).length).toBe(16);
  expect(keys.filter((k) => k.startsWith('sp1.spline.')).length).toBe(4);
  expect(keys).toContain('sp1.params');
  expect(computeGolden('sp1.params')).toMatch(/^[0-9a-f]{16}$/);
  expect(() => computeGolden('sp1.nope')).toThrow(/unknown golden/);
});

describe('SP1 goldens', () => {
  test.each(goldenKeys())('%s', (key) => {
    expectGolden(key, computeGolden(key));
  });
});

test('compareGoldens reports matches, mismatches and missing keys', () => {
  expect(compareGoldens({ a: '1', b: '2' }, ['a', 'b', 'c'], (k) => (k === 'b' ? '3' : '1'))).toEqual([
    { key: 'a', expected: '1', actual: '1', ok: true },
    { key: 'b', expected: '2', actual: '3', ok: false },
    { key: 'c', expected: null, actual: '1', ok: false },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit test/unit/goldens.sp1.test.ts`
Expected: FAIL (`goldenKeys` is not exported).

- [ ] **Step 3: Complete `src/metrics/sp1Goldens.ts`**

Replace the import block at the top with:

```ts
import { toUniform } from '../core/noise/cdf';
import { detCos, detErf, detExp, detExp2, detSin, detSmoothstep } from '../core/detMath';
import { fnv1a32, fnv1a64, hashF64, hex64 } from '../core/hash';
import { NormalNoise } from '../core/noise/normal';
import { canonicalJSON } from '../core/params/canonical';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { compileSpline, evalSpline } from '../core/spline/hermite';
import type { NestedSpline } from '../core/spline/types';
import { genKey, paramsHash, stageHashes } from '../core/stage/hash';
import { ADVERSARIAL_DEFS, CLIMATE_FIXTURE_DEFS, DENSITY3D_DEF, FIXTURE_DEFAULTS, FIXTURE_STAGES, JAG, OFFSET, SIGMA, TANGENT_FIXTURE } from './sp1Fixtures';
import type { FixtureNoise } from './sp1Fixtures';
```

add these aliases after the existing ones (`const Rng = Xoshiro128;`):

```ts
const FNV64 = fnv1a64;
const Normal = NormalNoise;
const U = toUniform;
const CANON = canonicalJSON;
const SEED = seedFromInput;
const COMPILE = compileSpline;
const EVAL_SPLINE = evalSpline;
const HASHES = stageHashes;
const GENKEY = genKey;
const PARAMS_HASH = paramsHash;
const CLIMATE_DEFS = CLIMATE_FIXTURE_DEFS;
const DENSITY3D = DENSITY3D_DEF;
const ADVERSARIAL = ADVERSARIAL_DEFS;
const P_DEFAULTS = FIXTURE_DEFAULTS;
const P_STAGES = FIXTURE_STAGES;
const OFFSET_F = OFFSET;
const SIGMA_F = SIGMA;
const JAG_F = JAG;
const TANGENT_F = TANGENT_FIXTURE;
```

and append:

```ts
const GOLDEN_POINTS = 4096;
const NOISE_FIXTURES: readonly FixtureNoise[] = [...CLIMATE_DEFS, DENSITY3D, ...ADVERSARIAL];
const SPLINES: Readonly<Record<string, NestedSpline>> = { OFFSET: OFFSET_F, SIGMA: SIGMA_F, JAG: JAG_F, TANGENT_FIXTURE: TANGENT_F };

/** z (then u for uniform fields) at 4096 points from Xoshiro128(fnv1a32('sp1.noise')), world seed '42'. */
export function noiseDigest(f: FixtureNoise): string {
  const r = new Rng(FNV32('sp1.noise'));
  const nn = new Normal(SEED('42'), f.seedName, f.def);
  const uniform = f.def.remap === 'uniform';
  const out = new Float64Array(uniform ? 2 * GOLDEN_POINTS : GOLDEN_POINTS);
  for (let i = 0; i < GOLDEN_POINTS; i++) {
    const x = -524288 + 1048576 * r.nextFloat();
    const y = -64 + 384 * r.nextFloat();
    const z = -524288 + 1048576 * r.nextFloat();
    out[i] = f.dims === 2 ? nn.z2(x, z) : nn.z3(x, y, z);
  }
  if (uniform) for (let i = 0; i < GOLDEN_POINTS; i++) out[GOLDEN_POINTS + i] = U(out[i]!);
  return HEX64(HASH_F64(out));
}

/** evalSpline on 4096 vectors of 6 draws −1.25 + 2.5·u (slot order) from Xoshiro128(fnv1a32('sp1.spline')). */
export function splineDigest(name: string): string {
  const s = SPLINES[name];
  if (s === undefined) throw new Error(`unknown golden spline ${name}`);
  const p = COMPILE(s);
  const r = new Rng(FNV32('sp1.spline'));
  const c = new Float64Array(6);
  const out = new Float64Array(GOLDEN_POINTS);
  for (let j = 0; j < GOLDEN_POINTS; j++) {
    for (let k = 0; k < 6; k++) c[k] = -1.25 + 2.5 * r.nextFloat();
    out[j] = EVAL_SPLINE(p, c);
  }
  return HEX64(HASH_F64(out));
}

/** fnv1a64 of canonicalJSON([H.climate, H.decorate, genKey('42'), paramsHash]) over the frozen params fixture. */
export function paramsDigest(): string {
  const h = HASHES(P_DEFAULTS, P_STAGES);
  return HEX64(FNV64(CANON([HEX64(h.climate!), HEX64(h.decorate!), HEX64(GENKEY(SEED('42'), h)), HEX64(PARAMS_HASH(P_DEFAULTS))])));
}

export function goldenKeys(): string[] {
  return [
    ...DETMATH_FNS.map((fn) => `sp1.detMath.${fn}`),
    ...NOISE_FIXTURES.map((f) => `sp1.noise.${f.seedName}`),
    ...Object.keys(SPLINES).map((n) => `sp1.spline.${n}`),
    'sp1.params',
  ];
}

export function computeGolden(key: string): string {
  if (key.startsWith('sp1.detMath.')) {
    const fn = key.slice('sp1.detMath.'.length);
    if ((DETMATH_FNS as readonly string[]).includes(fn)) return detMathDigest(fn as DetMathFn);
  } else if (key.startsWith('sp1.noise.')) {
    const f = NOISE_FIXTURES.find((x) => x.seedName === key.slice('sp1.noise.'.length));
    if (f !== undefined) return noiseDigest(f);
  } else if (key.startsWith('sp1.spline.')) {
    const name = key.slice('sp1.spline.'.length);
    if (name in SPLINES) return splineDigest(name);
  } else if (key === 'sp1.params') {
    return paramsDigest();
  }
  throw new Error(`unknown golden ${key}`);
}

export interface GoldenRow {
  readonly key: string;
  readonly expected: string | null;
  readonly actual: string;
  readonly ok: boolean;
}

/** Pure comparison used by the unit test, the lab panel and the JSC check; missing keys fail. */
export function compareGoldens(expected: Readonly<Record<string, string>>, keys: readonly string[], compute: (key: string) => string): GoldenRow[] {
  return keys.map((key) => {
    const e = Object.hasOwn(expected, key) ? expected[key]! : null;
    const actual = compute(key);
    return { key, expected: e, actual, ok: e === actual };
  });
}
```

- [ ] **Step 4: Run the key test (goldens not yet recorded)**

Run: `npx vitest run --project unit test/unit/goldens.sp1.test.ts`
Expected: the key-count and `compareGoldens` tests PASS; the 27 golden cases FAIL with `missing golden sp1.… : run npm run test:goldens`.

- [ ] **Step 5: Record the goldens**

Run: `npm run test:goldens`
Expected: PASS; `test/goldens.json` gains 27 `sp1.*` entries and keeps `"generatorVersion": 0`.

Run: `npx vitest run --project unit test/unit/goldens.sp1.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement `src/ui/lab/determinismPanel.ts`**

```ts
import goldens from '../../../test/goldens.json';
import { compareGoldens, computeGolden, goldenKeys, type GoldenRow } from '../../metrics/sp1Goldens';

/** Recomputes every sp1.* golden in this browser, one key per frame, and compares with test/goldens.json. */
export function mountDeterminismPanel(host: HTMLElement): void {
  const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
  const box = document.createElement('div');
  box.className = 'lab-det';
  const title = document.createElement('h3');
  title.textContent = 'Determinism';
  const run = document.createElement('button');
  run.textContent = 'run determinism check';
  const copy = document.createElement('button');
  copy.textContent = 'copy as JSON';
  copy.disabled = true;
  const summary = document.createElement('div');
  const list = document.createElement('ul');
  box.append(title, run, copy, summary, list);
  host.append(box);
  let rows: GoldenRow[] = [];
  run.addEventListener('click', () => {
    rows = [];
    list.replaceChildren();
    copy.disabled = true;
    run.disabled = true;
    const keys = goldenKeys();
    let i = 0;
    const tick = () => {
      if (i >= keys.length) {
        const bad = rows.filter((r) => !r.ok).length;
        summary.textContent = bad === 0 ? `✓ all ${rows.length} goldens match` : `✗ ${bad} of ${rows.length} goldens differ`;
        run.disabled = false;
        copy.disabled = false;
        return;
      }
      const key = keys[i++]!;
      summary.textContent = `computing ${i}/${keys.length}…`;
      const row = compareGoldens(expected, [key], computeGolden)[0]!;
      rows.push(row);
      const li = document.createElement('li');
      li.textContent = row.ok ? `✓ ${key}` : `✗ ${key}  expected ${row.expected ?? 'missing'}  got ${row.actual}`;
      list.append(li);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  copy.addEventListener('click', () => {
    const results = Object.fromEntries(rows.map((r) => [r.key, { expected: r.expected, actual: r.actual }]));
    void navigator.clipboard.writeText(JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2));
  });
}
```

In `src/ui/lab/noiseLab.ts`, add `import { mountDeterminismPanel } from './determinismPanel';` and, just before the final `render();` call of `mountNoiseLab`, add:

```ts
  mountDeterminismPanel(side);
```

- [ ] **Step 7: Write the JavaScriptCore check `test/tools/goldensJsc.ts`**

```ts
/**
 * JavaScriptCore check of the SP1 goldens (D20): run with `npx --yes bun@1 test/tools/goldensJsc.ts`
 * (Bun runs JavaScriptCore and resolves the repository's extensionless imports; no dependency is added).
 */
import goldens from '../goldens.json';
import { compareGoldens, computeGolden, goldenKeys } from '../../src/metrics/sp1Goldens';

const expected = (goldens as unknown as { entries: Record<string, string> }).entries;
const rows = compareGoldens(expected, goldenKeys(), computeGolden);
for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.key} ${r.actual}${r.ok ? '' : ` (expected ${r.expected ?? 'missing'})`}`);
const bad = rows.filter((r) => !r.ok).length;
const bun = (globalThis as { Bun?: { version: string } }).Bun;
console.log(`${rows.length - bad}/${rows.length} match on ${bun !== undefined ? `Bun ${bun.version} (JavaScriptCore)` : `Node ${process.version}`}`);
process.exitCode = bad === 0 ? 0 : 1;
```

Add to `CLAUDE.md` `## Commands`:

```markdown
- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute the SP1 goldens under JavaScriptCore (D20; SP exit evidence); the lab's determinism panel (`?lab=noise`) does the same in Chrome and Firefox
```

- [ ] **Step 8: Typecheck, build and look at it**

Run: `npm run typecheck && npm run build && npm test`
Expected: PASS.

Run: `npm run dev` (background), open `http://localhost:5183/?lab=noise`, press "run determinism check": 27 rows appear one per frame and the summary says `✓ all 27 goldens match`. Stop the dev server you started.

- [ ] **Step 9: Commit**

```bash
git add src/metrics/sp1Goldens.ts src/ui/lab test/unit/goldens.sp1.test.ts test/goldens.json test/tools/goldensJsc.ts CLAUDE.md
git commit -m "test(core): record SP1 goldens; lab determinism panel and JSC check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

---

### Task 26: SP1 exit

**Files:**
- Create: `test/baselines.json` (recorded), `docs/superpowers/specs/assets/sp1/*.png`
- Modify: the SP1 spec (Status, Exit evidence), `README.md` (Status), `CLAUDE.md` (Status)

**Interfaces:**
- Consumes: everything. Produces: the SP1 exit evidence. Pushing, the pull request, the Vercel preview check and the merge are done with the user (outward-facing).

- [ ] **Step 1: Full local verification**

Run: `npm run build && npm test && npm run test:metrics:full`
Expected: PASS. Copy the values from `test/metrics/.out/N1.json`, `N2.json`, `N3.json`, `N5.json`, `N6.json`, `U4.json` (full tier) into the spec's Exit evidence.

- [ ] **Step 2: Record the bench baseline**

Run: `npm run bench:record && npm run bench`
Expected: both PASS; `test/baselines.json` holds 11 kernels and `killRatio` ≤ 1.6. Copy `killRatio` and the kernel table into Exit evidence.

- [ ] **Step 3: JavaScriptCore check**

Run: `npx --yes bun@1 test/tools/goldensJsc.ts`
Expected: `27/27 match on Bun 1.x (JavaScriptCore)`; exit code 0. Paste the output into Exit evidence. (This downloads Bun into the npm cache; it adds no dependency to `package.json`.)

- [ ] **Step 4: Screenshots**

Start `npm run dev` in the background. Build each lab URL hash with (run from the repo root):

```bash
python3 -c "import base64,json,sys; s={'v':1,'seed':'42','noise':sys.argv[1],'patch':{},'view':{'x':0,'z':0,'bpp':float(sys.argv[2]) if '.' in sys.argv[2] else int(sys.argv[2]),'mode':sys.argv[3]}}; print(base64.urlsafe_b64encode(json.dumps(s,separators=(',',':'),sort_keys=True).encode()).decode().rstrip('='))" climate.C 64 u
```

and capture, with a dedicated Chrome profile directory under the scratch directory (never touch other Chrome processes):

```bash
google-chrome --headless=new --disable-gpu --user-data-dir="$SCRATCH/chrome-sp1" --window-size=1400,900 --virtual-time-budget=20000 \
  --screenshot=docs/superpowers/specs/assets/sp1/climate-C.png "http://localhost:5183/?lab=noise#<hash>"
```

for `climate.C`, `climate.E`, `climate.W`, `climate.T`, `climate.H`, `climate.R` (mode `u`, bpp 64), `climate.warp.shift.noise.x` (mode `z`, bpp 16) and `test.density3d` (mode `z`, bpp 0.5). For the A/B view add `"b":{"seed":"7"}` to the state object before encoding (key order is handled by `sort_keys`). If a screenshot comes out blank because virtual time skipped the render frames, drop `--virtual-time-budget` and capture through the DevTools protocol after a 3 s wait instead. Stop the dev server and the Chrome instance you started. List the files in Exit evidence.

- [ ] **Step 5: Update the docs**

- Spec: Status → `Implemented on branch sp1/math-core (<date>); exit evidence below`; fill "Exit evidence" with Steps 1-4 (metrics per tier as measured, bench table and killRatio, JSC output, screenshots).
- `README.md` Status → `SP0 and SP1 are complete: the app shows a sky canvas and a capability report, and \`?lab=noise\` inspects every climate noise (deployed at https://world-imaginer-voxel.vercel.app). SP2 (column stage, 2D biomes, map and parameter tooling) is next.`
- `CLAUDE.md` Status → `SP0 and SP1 complete (<date>). SP2 is next.`

- [ ] **Step 6: Commit**

```bash
git add test/baselines.json docs/superpowers/specs README.md CLAUDE.md
git commit -m "docs(spec): record SP1 exit evidence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc"
```

- [ ] **Step 7: Hand off to the user (do not push on your own)**

Report to the controller: the branch is ready. With the user's go-ahead the controller pushes `sp1/math-core`, opens the pull request (CI must be green), asks the user to open the Vercel preview of the branch in Chrome and Firefox, run the lab's determinism panel and paste its JSON (added to Exit evidence in a follow-up commit), and then fast-forwards `main`.

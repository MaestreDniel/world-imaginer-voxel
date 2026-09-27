# SP0 — Scaffold and Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the world-imaginer-voxel repository with a working Vite + TypeScript 7 + three.js app shell (sky canvas + capability report), the full vitest tier structure, arch tests enforcing the layer rules and banned APIs, the governance mechanisms (started-SP list, locked thresholds with per-part `activeFrom`, gated goldens, CI governance check), and the delivery rails (Docker, Vercel, GitHub Actions).

**Architecture:** Test infrastructure lives under `test/` (harness helpers, arch scanner and rules, fixtures); app code under `src/` is split by layer (`core`, `engine`, `render`, `ui`, `workers`, `main`). Every rule of the SP0 spec is a pure function over scanned files, exercised by good/bad fixture trees and then run against the real repository. The app boots by probing capabilities (secure context, isolation in page and worker, SAB sharing, WebGL2) and shows either an error screen naming the blocking causes or the grid shell with a three.js sky canvas, HUD and report.

**Tech Stack:** Node 24, npm, TypeScript 7.0 (type-check only), Vite 8.3, Vitest 5.0, three 0.186.

**Spec:** `docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md` (parent: `docs/superpowers/specs/2026-09-26-architecture-design.md`).

## Global Constraints

- Node `24.x` (`.nvmrc` = `24`, `"engines": { "node": "24.x" }`), npm, `"type": "module"`.
- Runtime dependency: `three` `~0.186.1` only. Dev dependencies: `vite` `^8.3.1`, `vitest` `^5.0.2`, `typescript` `^7.0.2`, `@types/three` `~0.186.0`, `@types/node` `^24`.
- TypeScript: `strict`, `target: ES2023`, `module: ESNext`, `moduleResolution: bundler`, `noEmit`, `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `forceConsistentCasingInFileNames`; no `paths`/`baseUrl`; `noUncheckedIndexedAccess` off; every tsconfig lists `types` explicitly.
- No enums, namespaces or parameter properties (erasableSyntaxOnly). Type-only imports use `import type` (verbatimModuleSyntax).
- Headers exactly `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on dev, preview and Vercel; port 5183 with `strictPort`; `worker.format = 'es'`.
- No audio files (`.ogg .oga .mp3 .wav .flac .m4a .aac .opus .weba`, any case) anywhere in the repository.
- No cross-origin subresources; no imports resolving outside the repository.
- Conventional commits scoped by area (`feat(ui):`, `test(arch):`, `chore(build):`, `ci:`, `docs(spec):` …), each ending with the attribution trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- Work happens on branch `sp0/scaffold` in `~/Proyectos/world-imaginer-voxel`; it is fast-forwarded into `main` in the last task.

## Review Focus

1. **App opened over plain http from a LAN IP or proxy hostname** (not a secure context, so `SharedArrayBuffer` is undefined): expect the error screen to name "not a secure context" first, not a crash or a misleading "headers missing". Test: Task 12, `insecure LAN access` case; Task 14 probe guards `typeof SharedArrayBuffer`.
2. **Worker script 404s or a cold dev server answers slowly**: expect "worker script failed to load" or "worker did not answer within 5 s", never "worker scripts are missing the COOP/COEP headers". Test: Task 12, `load-error` and `timeout` cases.
3. **Legitimate future code** (type-only `world/store/api` imports from `gen`, comments that mention `Math.random`, `engine` spawning workers, `render` importing `mesh/packing` values, `persist/idb.ts` using `indexedDB`): expect no arch violation. Test: good fixture trees in Tasks 7 and 9.
4. **Parallel sub-projects appended out of order** (`SP8c` before `SP8b`): expect acceptance when dependencies are started, rejection when one is missing. Test: Task 3, `parallel SPs` cases.
5. **HUD fed no frames, a non-finite delta (tab switched back) or a negative delta**: expect `0 fps` and no `NaN` text; bad samples ignored. Test: Task 13, `empty` and `non-finite` cases.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `package-lock.json`, `.nvmrc` | toolchain, scripts | 1 |
| `tsconfig.base.json`, `tsconfig.json`, `tsconfig.worker.json`, `tsconfig.test.json` | shared options + DOM / WebWorker / test programs | 1 |
| `vite.config.ts`, `vitest.config.ts` | dev/preview/build config; vitest projects | 1 |
| `src/core/constants.ts`, `src/core/ids.ts` | `GENERATOR_VERSION`; `SubProjectId`, `MetricId` types | 1 |
| `src/workers/probe.worker.ts` | capability probe worker | 1 |
| `test/unit/constants.test.ts` | toolchain smoke test | 1 |
| `test/unit/sab.test.ts`, `test/unit/fixtures/sabWorker.mjs` | SAB round-trip across worker_threads | 2 |
| `test/harness/sp.ts`, `test/arch/sp.test.ts` | started-SP list and dependency rules | 3 |
| `test/harness/lock.ts`, `test/thresholds.ts`, `test/thresholds.lock.json`, `test/harness/metric.ts`, `test/arch/thresholds.test.ts`, `test/unit/lock.test.ts`, `test/unit/metric.test.ts` | thresholds lock, diff, metric registration | 4 |
| `test/harness/goldens.ts`, `test/goldens.json`, `test/arch/goldens.test.ts`, `test/arch/goldensMerge.test.ts` | goldens store and merge | 5 |
| `test/arch/scan.ts`, `test/arch/scan.test.ts` | file listing, blanking, edge extraction, target resolution | 6 |
| `test/arch/rules/imports.ts`, `test/arch/imports.test.ts`, `test/arch/fixtures/imports/**` | layer table | 7 |
| `test/arch/rules/resolution.ts`, `test/arch/resolution.test.ts`, `test/arch/fixtures/resolution/**`, `test/arch/fixtures/hygiene/**` | resolution inside the repo; config hygiene | 8 |
| `test/arch/rules/banned.ts`, `test/arch/banned.test.ts`, `test/arch/fixtures/banned/**` | banned APIs; audio files | 9 |
| `vercel.json`, `test/arch/rules/headers.ts`, `test/arch/headers.test.ts` | header parity; cross-origin subresources | 10 |
| `test/harness/governance.ts`, `test/arch/governance.test.ts`, `test/unit/governance.test.ts` | CI governance check | 11 |
| `src/engine/capabilityRules.ts`, `test/unit/capabilityRules.test.ts` | report → blocking causes and warnings | 12 |
| `src/ui/frameStats.ts`, `test/unit/frameStats.test.ts` | frame-time ring buffer | 13 |
| `src/engine/capabilities.ts`, `src/render/renderer.ts`, `src/ui/shell.ts`, `src/ui/styles.css`, `src/ui/hud.ts`, `src/ui/capabilityReport.ts`, `src/main.ts`, `index.html` | the running app | 14 |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.github/workflows/ci.yml` | delivery rails | 15 |
| `README.md`, `CLAUDE.md`, SP0 spec, `docs/superpowers/specs/assets/sp0/*` | docs and exit evidence | 16 |

Folder placeholders `test/metrics/README.md` and `test/bench/README.md` are added in Task 1.

---

### Task 1: Toolchain, configs and the core type files

**Files:**
- Create: `package.json`, `.nvmrc`, `tsconfig.base.json`, `tsconfig.json`, `tsconfig.worker.json`, `tsconfig.test.json`, `vite.config.ts`, `vitest.config.ts`, `src/core/constants.ts`, `src/core/ids.ts`, `src/workers/probe.worker.ts`, `test/unit/constants.test.ts`, `test/metrics/README.md`, `test/bench/README.md`
- Unchanged: `.gitignore` already ignores `test/.cache/` (goldens observations) and `test/metrics/.out/`
- Generated: `package-lock.json`

**Interfaces:**
- Produces: `GENERATOR_VERSION: number` (`src/core/constants.ts`); `type SubProjectId`, `type MetricId` (`src/core/ids.ts`); npm scripts used by every later task; worker message protocol `{ sab: SharedArrayBuffer | null }` → `{ isolated: boolean }`.

- [ ] **Step 1: Create the branch**

```bash
cd ~/Proyectos/world-imaginer-voxel
git checkout -b sp0/scaffold
```

- [ ] **Step 2: Write `package.json` and `.nvmrc`**

`package.json`:
```json
{
  "name": "world-imaginer-voxel",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": "24.x" },
  "scripts": {
    "dev": "vite",
    "build": "npm run typecheck && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json",
    "test": "vitest run --project unit --project arch --project metrics-fast",
    "test:metrics": "vitest run --project metrics-quick",
    "test:metrics:full": "vitest run --project metrics-full",
    "bench": "vitest bench --run --project \"bench (bench)\"",
    "test:accept-thresholds": "ACCEPT_THRESHOLDS=1 vitest run --project arch test/arch/thresholds.test.ts",
    "test:goldens": "rm -rf test/.cache/goldens-obs && UPDATE_GOLDENS=1 vitest run --project unit --project metrics-quick && MERGE_GOLDENS=1 vitest run --project arch test/arch/goldensMerge.test.ts"
  }
}
```

`.nvmrc`:
```
24
```

- [ ] **Step 3: Install the toolchain**

```bash
npm install --save-prefix='~' three@~0.186.1
npm install -D vite@^8.3.1 vitest@^5.0.2 typescript@^7.0.2 @types/node@^24
npm install -D --save-prefix='~' @types/three@~0.186.0
node -e "const p=require('./package.json');console.log(p.dependencies,p.devDependencies)"
```
Expected: `dependencies` is exactly `{ three: '~0.186.1' }`; devDependencies list the five packages (`@types/three` with `~`).

- [ ] **Step 4: Write the tsconfigs**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM"], "types": ["vite/client"] },
  "include": ["src/**/*.ts"],
  "exclude": ["src/workers/**"]
}
```

`tsconfig.worker.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "WebWorker"], "types": [] },
  "include": ["src/workers/**/*.ts"]
}
```

`tsconfig.test.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM"], "types": ["node", "vite/client"] },
  "include": ["test/**/*.ts", "vite.config.ts", "vitest.config.ts"],
  "exclude": ["test/arch/fixtures/**"]
}
```

- [ ] **Step 5: Write `vite.config.ts` and `vitest.config.ts`**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const extraHosts = (process.env.VITE_ALLOWED_HOSTS ?? '').split(',').filter((h) => h.length > 0);

export default defineConfig({
  server: {
    port: 5183,
    strictPort: true,
    headers: ISOLATION_HEADERS,
    allowedHosts: ['world-imaginer-voxel', ...extraHosts],
  },
  preview: { port: 5183, strictPort: true, headers: ISOLATION_HEADERS },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1024 },
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

type Tier = 'fast' | 'quick' | 'full';

const metrics = (tier: Tier) => ({
  test: { name: `metrics-${tier}`, include: ['test/metrics/**/*.metric.ts'], env: { METRICS_TIER: tier } },
});

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { test: { name: 'arch', include: ['test/arch/**/*.test.ts'] } },
      metrics('fast'),
      metrics('quick'),
      metrics('full'),
      { test: { name: 'bench', include: [], benchmark: { include: ['test/bench/**/*.bench.ts'] } } },
    ],
  },
});
```

- [ ] **Step 6: Write the failing smoke test**

`test/unit/constants.test.ts`:
```ts
import { expect, test } from 'vitest';
import { GENERATOR_VERSION } from '../../src/core/constants';

test('GENERATOR_VERSION is a non-negative integer', () => {
  expect(Number.isInteger(GENERATOR_VERSION)).toBe(true);
  expect(GENERATOR_VERSION).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `npx vitest run --project unit`
Expected: FAIL — cannot resolve `../../src/core/constants`.

- [ ] **Step 8: Write the core files and the probe worker**

`src/core/constants.ts`:
```ts
/** Bumped whenever generated output changes; goldens and saves are bound to it (§6.2). */
export const GENERATOR_VERSION = 0;
```

`src/core/ids.ts`:
```ts
/** Sub-project ids of master spec §10. */
export type SubProjectId =
  | 'SP0' | 'SP1' | 'SP2' | 'SP3' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
  | 'SP8a' | 'SP8b' | 'SP8c' | 'SP9' | 'SP10' | 'SP11' | 'SP12';

/** Every metric id of master spec §6.4 (E1-E6 expanded). */
export type MetricId =
  | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6'
  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8'
  | 'B1' | 'B2' | 'B3' | 'B4' | 'B5'
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6'
  | 'A1' | 'A2' | 'A3' | 'A4'
  | 'S1' | 'S2' | 'S3'
  | 'O1' | 'O2'
  | 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6'
  | 'X1' | 'X2'
  | 'DT1' | 'DT2'
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7'
  | 'L1' | 'L2' | 'L3'
  | 'F1' | 'F2' | 'F3'
  | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7'
  | 'U1' | 'U2' | 'U3' | 'U4'
  | 'Z1' | 'Z2' | 'Z3' | 'Z4'
  | 'P1'
  | 'G1' | 'G2'
  | 'M1'
  | 'AU1' | 'AU2' | 'AU3' | 'AU4';
```

`src/workers/probe.worker.ts`:
```ts
/** Capability probe: proves this worker is cross-origin isolated and shares memory with the page. */
interface ProbeRequest {
  sab: SharedArrayBuffer | null;
}

self.onmessage = (event: MessageEvent<ProbeRequest>) => {
  const { sab } = event.data;
  if (sab !== null) Atomics.store(new Int32Array(sab), 0, 42);
  postMessage({ isolated: self.crossOriginIsolated });
};

export {};
```

`test/metrics/README.md`:
```markdown
Metric tests (`*.metric.ts`) live here. Each registers through `metricTest()` from `test/harness/metric.ts`; thresholds are in `test/thresholds.ts` (locked).
```

`test/bench/README.md`:
```markdown
Benchmarks (`*.bench.ts`) live here and run with `npm run bench`. Vitest 5 benches use the test-context fixture: `test('<id>', async ({ bench }) => { await bench('<name>', fn).run() })`.
```

- [ ] **Step 9: Run tests, typecheck and the empty tiers**

```bash
npx vitest run --project unit
npm run typecheck
npm test && npm run test:metrics && npm run test:metrics:full && npm run bench
```
Expected: the smoke test PASSES; typecheck exits 0 with no diagnostics; every script exits 0 (metrics/bench print "No test files found, exiting with code 0").

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json .nvmrc tsconfig*.json vite.config.ts vitest.config.ts src test
git commit -m "chore(build): toolchain, tsconfigs, vite and vitest projects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: SAB round-trip across two worker_threads

**Files:**
- Create: `test/unit/fixtures/sabWorker.mjs`, `test/unit/sab.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a platform guarantee test; SAB layout used only here: `i32[0]` counter, `i32[1]` turn, `i32[2]` log length, `i32[3..]` log.

- [ ] **Step 1: Write the failing test**

`test/unit/sab.test.ts`:
```ts
import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';

const WORKER_URL = new URL('./fixtures/sabWorker.mjs', import.meta.url);
const ADDS = 100_000;
const ROUNDS = 50;
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.terminate()));
});

function run(role: 0 | 1, sab: SharedArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { workerData: { sab, role, adds: ADDS, rounds: ROUNDS } });
    workers.push(w);
    w.once('message', (m: { ok: boolean; error?: string }) => (m.ok ? resolve() : reject(new Error(m.error))));
    w.once('error', reject);
  });
}

test('SAB round-trip across 2 worker_threads', { repeats: 5 }, async () => {
  const sab = new SharedArrayBuffer(4 * (3 + 2 * ROUNDS));
  const i32 = new Int32Array(sab);
  await Promise.all([run(0, sab), run(1, sab)]);
  expect(Atomics.load(i32, 0)).toBe(2 * ADDS);
  expect(Atomics.load(i32, 2)).toBe(2 * ROUNDS);
  const log = Array.from(i32.subarray(3, 3 + 2 * ROUNDS));
  expect(log).toEqual(Array.from({ length: 2 * ROUNDS }, (_, k) => k % 2));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit test/unit/sab.test.ts`
Expected: FAIL — worker file `sabWorker.mjs` not found.

- [ ] **Step 3: Write the worker fixture**

`test/unit/fixtures/sabWorker.mjs`:
```js
import { parentPort, workerData } from 'node:worker_threads';

const { sab, role, adds, rounds } = workerData;
const i32 = new Int32Array(sab);
const COUNTER = 0;
const TURN = 1;
const LOG_LEN = 2;
const LOG = 3;
const WAIT_MS = 5000;

function main() {
  for (let k = 0; k < adds; k++) Atomics.add(i32, COUNTER, 1);
  for (let r = 0; r < rounds; r++) {
    while (Atomics.load(i32, TURN) !== role) {
      if (Atomics.wait(i32, TURN, 1 - role, WAIT_MS) === 'timed-out') {
        return { ok: false, error: `role ${role} timed out waiting in round ${r}` };
      }
    }
    const idx = Atomics.add(i32, LOG_LEN, 1);
    Atomics.store(i32, LOG + idx, role);
    Atomics.store(i32, TURN, 1 - role);
    Atomics.notify(i32, TURN);
  }
  return { ok: true };
}

parentPort.postMessage(main());
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run --project unit test/unit/sab.test.ts`
Expected: PASS (5 repeats).

- [ ] **Step 5: Commit**

```bash
git add test/unit/sab.test.ts test/unit/fixtures/sabWorker.mjs
git commit -m "test(platform): SAB round-trip across two worker_threads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Started sub-projects and dependencies

**Files:**
- Create: `test/harness/sp.ts`, `test/arch/sp.test.ts`

**Interfaces:**
- Consumes: `SubProjectId` from `src/core/ids.ts`.
- Produces:
  - `SP_DEPS: Readonly<Record<SubProjectId, readonly SubProjectId[]>>`
  - `SP_ORDER: readonly SubProjectId[]`
  - `STARTED_SPS: readonly SubProjectId[]` (= `['SP0']`)
  - `spIndex(sp: SubProjectId): number`
  - `validateStarted(started: readonly string[], deps?: Readonly<Record<SubProjectId, readonly SubProjectId[]>>): string[]`

- [ ] **Step 1: Write the failing test**

`test/arch/sp.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { SP_DEPS, SP_ORDER, STARTED_SPS, spIndex, validateStarted } from '../harness/sp';

describe('started sub-projects', () => {
  test('the committed list is valid', () => {
    expect(validateStarted(STARTED_SPS)).toEqual([]);
  });

  test('SP_DEPS covers all 15 sub-projects and SP_ORDER follows it', () => {
    expect(SP_ORDER).toEqual([
      'SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
      'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
    ]);
    for (const sp of SP_ORDER) for (const dep of SP_DEPS[sp]) expect(spIndex(dep)).toBeLessThan(spIndex(sp));
  });

  test('duplicates and unknown ids are rejected', () => {
    expect(validateStarted(['SP0', 'SP0'])).toEqual(['duplicate SP0']);
    expect(validateStarted(['SP0', 'SP99'])).toEqual(['unknown SP99']);
  });

  test('an SP cannot start before its dependencies', () => {
    expect(validateStarted(['SP0', 'SP2'])).toEqual(['SP2 started before its dependency SP1']);
  });

  test('parallel SPs: SP8c before SP8b is fine once SP7 and SP5 have started', () => {
    const path = ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP8a', 'SP5', 'SP6', 'SP7', 'SP8c', 'SP8b'];
    expect(validateStarted(path)).toEqual([]);
  });

  test('parallel SPs: SP8c without SP7 is rejected', () => {
    const path = ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP8c'];
    expect(validateStarted(path)).toEqual(['SP8c started before its dependency SP7']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/sp.test.ts`
Expected: FAIL — cannot resolve `../harness/sp`.

- [ ] **Step 3: Implement**

`test/harness/sp.ts`:
```ts
import type { SubProjectId } from '../../src/core/ids';

/** Dependencies transcribed from the §10 headers of the master spec. */
export const SP_DEPS: Readonly<Record<SubProjectId, readonly SubProjectId[]>> = {
  SP0: [],
  SP1: ['SP0'],
  SP2: ['SP1'],
  SP3: ['SP2'],
  SP4: ['SP3'],
  SP5: ['SP4'],
  SP6: ['SP3', 'SP5'],
  SP7: ['SP6', 'SP5'],
  SP8a: ['SP4'],
  SP8b: ['SP7', 'SP8a'],
  SP8c: ['SP7', 'SP5'],
  SP9: ['SP8b', 'SP8a'],
  SP10: ['SP9'],
  SP11: ['SP10'],
  SP12: ['SP11'],
};

export const SP_ORDER = Object.keys(SP_DEPS) as SubProjectId[];

/**
 * Append-only list of sub-projects whose first commit has landed.
 * Each SP appends its id in its first commit. Part of the locked governance state.
 */
export const STARTED_SPS: readonly SubProjectId[] = ['SP0'];

export function spIndex(sp: SubProjectId): number {
  return SP_ORDER.indexOf(sp);
}

export function validateStarted(
  started: readonly string[],
  deps: Readonly<Record<SubProjectId, readonly SubProjectId[]>> = SP_DEPS,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const sp of started) {
    if (seen.has(sp)) { errors.push(`duplicate ${sp}`); continue; }
    if (!(sp in deps)) { errors.push(`unknown ${sp}`); continue; }
    for (const dep of deps[sp as SubProjectId]) {
      if (!seen.has(dep)) errors.push(`${sp} started before its dependency ${dep}`);
    }
    seen.add(sp);
  }
  return errors;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run --project arch test/arch/sp.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add test/harness/sp.ts test/arch/sp.test.ts
git commit -m "test(governance): started sub-project list with dependency checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Locked thresholds and metric registration

**Files:**
- Create: `test/thresholds.ts`, `test/harness/lock.ts`, `test/harness/metric.ts`, `test/arch/thresholds.test.ts`, `test/unit/lock.test.ts`, `test/unit/metric.test.ts`
- Generated: `test/thresholds.lock.json`

**Interfaces:**
- Consumes: `SubProjectId`, `MetricId`; `STARTED_SPS`, `spIndex` (Task 3).
- Produces:
  - `interface ThresholdPart { min?: number; max?: number; activeFrom: SubProjectId }`
  - `type ThresholdTable = Partial<Record<MetricId, Record<string, ThresholdPart>>>`
  - `THRESHOLDS: ThresholdTable` (empty)
  - `interface GovernanceState { thresholds: ThresholdTable; startedSps: readonly SubProjectId[] }`
  - `canonicalize(v: unknown): unknown`, `canonicalJson(v: unknown): string`, `sha256(s: string): string`
  - `interface LockFile { sha256: string; canonical: unknown }`, `makeLock(state: GovernanceState): LockFile`, `verifyLock(lock: LockFile): boolean`
  - `type ChangeKind = 'LOOSEN' | 'TIGHTEN' | 'NEUTRAL'`, `interface LockChange { path: string; detail: string; kind: ChangeKind }`
  - `diffGovernance(prev: GovernanceState, next: GovernanceState): LockChange[]`, `formatChanges(changes: readonly LockChange[]): string`
  - `interface MetricEvaluation { asserted: string[]; inactive: string[]; errors: string[] }`
  - `evaluateMetric(id, parts, values, table?, started?): MetricEvaluation`
  - `metricTest(id: MetricId, parts: readonly string[], run: () => Record<string, number> | Promise<Record<string, number>>, timeoutMs?: number): void`
  - `interface MetricCall { file: string; id: string; parts: string[] }`, `findMetricCalls(root: string): MetricCall[]`, `coverageErrors(calls, table?, started?): string[]`

- [ ] **Step 1: Write the failing unit tests**

`test/unit/lock.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { canonicalJson, diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState } from '../harness/lock';

const base: GovernanceState = {
  thresholds: { T1: { band: { max: 0.25, activeFrom: 'SP3' }, span: { min: 60, activeFrom: 'SP3' } } },
  startedSps: ['SP0', 'SP1', 'SP2', 'SP3'],
};

describe('canonical JSON and lock', () => {
  test('keys are sorted and undefined fields dropped', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}]},"b":1}');
  });

  test('a lock verifies and detects tampering', () => {
    const lock = makeLock(base);
    expect(verifyLock(lock)).toBe(true);
    expect(verifyLock({ ...lock, sha256: '0'.repeat(64) })).toBe(false);
  });
});

describe('diffGovernance', () => {
  const edit = (f: (s: GovernanceState) => void): GovernanceState => {
    const s = structuredClone(base) as GovernanceState;
    f(s);
    return s;
  };

  test('no change → empty diff', () => {
    expect(diffGovernance(base, structuredClone(base) as GovernanceState)).toEqual([]);
  });

  test('raising a max loosens, lowering it tightens', () => {
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.max = 0.3; }))).toEqual([
      { path: 'T1.band', detail: 'max 0.25→0.3', kind: 'LOOSEN' },
    ]);
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.max = 0.2; }))[0]!.kind).toBe('TIGHTEN');
  });

  test('lowering a min loosens; a later activeFrom loosens', () => {
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.span!.min = 50; }))[0]).toEqual(
      { path: 'T1.span', detail: 'min 60→50', kind: 'LOOSEN' },
    );
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.span!.activeFrom = 'SP6'; }))[0]).toEqual(
      { path: 'T1.span', detail: 'activeFrom SP3→SP6', kind: 'LOOSEN' },
    );
  });

  test('removing an active part loosens; adding a part tightens', () => {
    expect(diffGovernance(base, edit((s) => { delete s.thresholds.T1!.span; }))[0]).toEqual(
      { path: 'T1.span', detail: 'removed', kind: 'LOOSEN' },
    );
    expect(diffGovernance(base, edit((s) => { s.thresholds.C1 = { default: { min: 0.05, activeFrom: 'SP6' } }; }))[0]).toEqual(
      { path: 'C1.default', detail: 'added', kind: 'TIGHTEN' },
    );
  });

  test('removing a started SP loosens; adding one tightens', () => {
    expect(diffGovernance(base, edit((s) => { s.startedSps = ['SP0', 'SP1', 'SP2']; }))).toEqual([
      { path: 'startedSps', detail: 'removed SP3', kind: 'LOOSEN' },
    ]);
    expect(diffGovernance(base, edit((s) => { s.startedSps = [...s.startedSps, 'SP4']; }))).toEqual([
      { path: 'startedSps', detail: 'added SP4', kind: 'TIGHTEN' },
    ]);
  });

  test('formatChanges prints one tagged line per change', () => {
    expect(formatChanges([{ path: 'T1.band', detail: 'max 0.25→0.3', kind: 'LOOSEN' }])).toBe('LOOSEN  T1.band  max 0.25→0.3');
  });
});
```

`test/unit/metric.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { coverageErrors, evaluateMetric } from '../harness/metric';
import type { ThresholdTable } from '../thresholds';

const table: ThresholdTable = {
  C1: { default: { min: 0.05, max: 0.15, activeFrom: 'SP6' }, cave_heavy: { min: 0.1, max: 0.22, activeFrom: 'SP12' } },
};

describe('evaluateMetric', () => {
  test('active parts are asserted, inactive parts only recorded', () => {
    const r = evaluateMetric('C1', ['default', 'cave_heavy'], { default: 0.09, cave_heavy: 0.5 }, table, ['SP6']);
    expect(r).toEqual({ asserted: ['default'], inactive: ['cave_heavy'], errors: [] });
  });

  test('an active part outside its range fails', () => {
    const r = evaluateMetric('C1', ['default'], { default: 0.2 }, table, ['SP6']);
    expect(r.errors).toEqual(['C1.default = 0.2 > max 0.15']);
  });

  test('missing values and unknown parts are errors', () => {
    expect(evaluateMetric('C1', ['default'], {}, table, ['SP6']).errors).toEqual(['C1.default: no value returned']);
    expect(evaluateMetric('C1', ['nope'], { nope: 1 }, table, ['SP6']).errors).toEqual(['C1.nope: not in THRESHOLDS']);
  });
});

describe('coverageErrors', () => {
  test('every active part needs exactly one registering call', () => {
    expect(coverageErrors([], table, ['SP6'])).toEqual(['C1.default is active but no metricTest covers it']);
    const call = { file: 'a.metric.ts', id: 'C1', parts: ['default'] };
    expect(coverageErrors([call], table, ['SP6'])).toEqual([]);
    expect(coverageErrors([call, call], table, ['SP6'])).toEqual(['C1.default is covered by 2 metricTest calls']);
  });

  test('calls naming unknown ids or parts are errors', () => {
    expect(coverageErrors([{ file: 'a.metric.ts', id: 'C9', parts: ['x'] }], table, [])).toEqual([
      'a.metric.ts: C9 is not in THRESHOLDS',
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit test/unit/lock.test.ts test/unit/metric.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `test/thresholds.ts` and `test/harness/lock.ts`**

`test/thresholds.ts`:
```ts
import type { MetricId, SubProjectId } from '../src/core/ids';

export interface ThresholdPart {
  min?: number;
  max?: number;
  /** First sub-project that gates this part (per-part, master §10 Definition of done). */
  activeFrom: SubProjectId;
}

/** One entry per metric id; part keys are stable slugs, one per threshold cell of the §6.4 row. */
export type ThresholdTable = Partial<Record<MetricId, Record<string, ThresholdPart>>>;

/** Locked by test/thresholds.lock.json — change only with `npm run test:accept-thresholds` and a spec amendment. */
export const THRESHOLDS: ThresholdTable = {};
```

`test/harness/lock.ts`:
```ts
import { createHash } from 'node:crypto';
import type { SubProjectId } from '../../src/core/ids';
import type { ThresholdPart, ThresholdTable } from '../thresholds';
import { spIndex } from './sp';

export interface GovernanceState {
  thresholds: ThresholdTable;
  startedSps: readonly SubProjectId[];
}

export interface LockFile {
  sha256: string;
  canonical: unknown;
}

export type ChangeKind = 'LOOSEN' | 'TIGHTEN' | 'NEUTRAL';

export interface LockChange {
  path: string;
  detail: string;
  kind: ChangeKind;
}

export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      const value = (v as Record<string, unknown>)[key];
      if (value !== undefined) out[key] = canonicalize(value);
    }
    return out;
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function makeLock(state: GovernanceState): LockFile {
  const canonical = canonicalize(state);
  return { sha256: sha256(JSON.stringify(canonical)), canonical };
}

export function verifyLock(lock: LockFile): boolean {
  return sha256(canonicalJson(lock.canonical)) === lock.sha256;
}

function partChanges(path: string, prev: ThresholdPart, next: ThresholdPart): LockChange[] {
  const out: LockChange[] = [];
  if (prev.min !== next.min) {
    const loosen = next.min === undefined || (prev.min !== undefined && next.min < prev.min);
    out.push({ path, detail: `min ${prev.min ?? '—'}→${next.min ?? '—'}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
  }
  if (prev.max !== next.max) {
    const loosen = next.max === undefined || (prev.max !== undefined && next.max > prev.max);
    out.push({ path, detail: `max ${prev.max ?? '—'}→${next.max ?? '—'}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
  }
  if (prev.activeFrom !== next.activeFrom) {
    const loosen = spIndex(next.activeFrom) > spIndex(prev.activeFrom);
    out.push({ path, detail: `activeFrom ${prev.activeFrom}→${next.activeFrom}`, kind: loosen ? 'LOOSEN' : 'TIGHTEN' });
  }
  return out;
}

export function diffGovernance(prev: GovernanceState, next: GovernanceState): LockChange[] {
  const out: LockChange[] = [];
  const ids = [...new Set([...Object.keys(prev.thresholds), ...Object.keys(next.thresholds)])].sort();
  for (const id of ids) {
    const a = prev.thresholds[id as keyof ThresholdTable] ?? {};
    const b = next.thresholds[id as keyof ThresholdTable] ?? {};
    for (const part of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const path = `${id}.${part}`;
      const pa = a[part];
      const pb = b[part];
      if (pa && !pb) {
        const wasActive = prev.startedSps.includes(pa.activeFrom);
        out.push({ path, detail: 'removed', kind: wasActive ? 'LOOSEN' : 'NEUTRAL' });
      } else if (!pa && pb) {
        out.push({ path, detail: 'added', kind: 'TIGHTEN' });
      } else if (pa && pb) {
        out.push(...partChanges(path, pa, pb));
      }
    }
  }
  for (const sp of prev.startedSps) if (!next.startedSps.includes(sp)) out.push({ path: 'startedSps', detail: `removed ${sp}`, kind: 'LOOSEN' });
  for (const sp of next.startedSps) if (!prev.startedSps.includes(sp)) out.push({ path: 'startedSps', detail: `added ${sp}`, kind: 'TIGHTEN' });
  return out;
}

export function formatChanges(changes: readonly LockChange[]): string {
  return changes.map((c) => `${c.kind.padEnd(7)} ${c.path}  ${c.detail}`).join('\n');
}
```

- [ ] **Step 4: Implement `test/harness/metric.ts`**

```ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { MetricId, SubProjectId } from '../../src/core/ids';
import { THRESHOLDS, type ThresholdTable } from '../thresholds';
import { STARTED_SPS } from './sp';

const OUT_DIR = fileURLToPath(new URL('../metrics/.out/', import.meta.url));

export interface MetricEvaluation {
  asserted: string[];
  inactive: string[];
  errors: string[];
}

export function evaluateMetric(
  id: string,
  parts: readonly string[],
  values: Readonly<Record<string, number>>,
  table: ThresholdTable = THRESHOLDS,
  started: readonly SubProjectId[] = STARTED_SPS,
): MetricEvaluation {
  const result: MetricEvaluation = { asserted: [], inactive: [], errors: [] };
  const row = table[id as MetricId];
  for (const part of parts) {
    const t = row?.[part];
    if (!t) { result.errors.push(`${id}.${part}: not in THRESHOLDS`); continue; }
    const value = values[part];
    if (value === undefined) { result.errors.push(`${id}.${part}: no value returned`); continue; }
    if (!started.includes(t.activeFrom)) { result.inactive.push(part); continue; }
    result.asserted.push(part);
    if (t.min !== undefined && value < t.min) result.errors.push(`${id}.${part} = ${value} < min ${t.min}`);
    if (t.max !== undefined && value > t.max) result.errors.push(`${id}.${part} = ${value} > max ${t.max}`);
  }
  return result;
}

/** Registers one metric test. Inactive parts still run and record their value, then the test is skipped. */
export function metricTest(
  id: MetricId,
  parts: readonly string[],
  run: () => Record<string, number> | Promise<Record<string, number>>,
  timeoutMs = 600_000,
): void {
  test(id, async (ctx) => {
    const values = await run();
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${id}.json`), `${JSON.stringify({ id, tier: process.env.METRICS_TIER ?? null, values }, null, 2)}\n`);
    const r = evaluateMetric(id, parts, values);
    expect(r.errors, r.errors.join('\n')).toEqual([]);
    if (r.asserted.length === 0) {
      const next = r.inactive.map((p) => THRESHOLDS[id]?.[p]?.activeFrom).join(', ');
      ctx.skip(true, `inactive until ${next} (value recorded)`);
    }
  }, timeoutMs);
}

export interface MetricCall {
  file: string;
  id: string;
  parts: string[];
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.metric.ts')) out.push(full);
  }
}

export function findMetricCalls(root: string): MetricCall[] {
  const files: string[] = [];
  walk(join(root, 'test', 'metrics'), files);
  const calls: MetricCall[] = [];
  const re = /metricTest\(\s*['"]([A-Z]+\d+)['"]\s*,\s*\[([^\]]*)\]/g;
  for (const file of files.sort()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const parts = m[2]!.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter((p) => p.length > 0);
      calls.push({ file: relative(root, file).split('\\').join('/'), id: m[1]!, parts });
    }
  }
  return calls;
}

export function coverageErrors(
  calls: readonly MetricCall[],
  table: ThresholdTable = THRESHOLDS,
  started: readonly SubProjectId[] = STARTED_SPS,
): string[] {
  const errors: string[] = [];
  for (const call of calls) {
    const row = table[call.id as MetricId];
    if (!row) { errors.push(`${call.file}: ${call.id} is not in THRESHOLDS`); continue; }
    for (const part of call.parts) if (!row[part]) errors.push(`${call.file}: ${call.id}.${part} is not in THRESHOLDS`);
  }
  for (const [id, row] of Object.entries(table)) {
    for (const [part, t] of Object.entries(row ?? {})) {
      if (!started.includes(t.activeFrom)) continue;
      const n = calls.filter((c) => c.id === id && c.parts.includes(part)).length;
      if (n === 0) errors.push(`${id}.${part} is active but no metricTest covers it`);
      else if (n > 1) errors.push(`${id}.${part} is covered by ${n} metricTest calls`);
    }
  }
  return errors;
}
```

- [ ] **Step 5: Run the unit tests to see them pass**

Run: `npx vitest run --project unit test/unit/lock.test.ts test/unit/metric.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the lock/coverage arch test**

`test/arch/thresholds.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState, type LockFile } from '../harness/lock';
import { coverageErrors, findMetricCalls } from '../harness/metric';
import { STARTED_SPS } from '../harness/sp';
import { THRESHOLDS } from '../thresholds';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../thresholds.lock.json', import.meta.url));

test('thresholds lock matches THRESHOLDS and STARTED_SPS', () => {
  const live = makeLock({ thresholds: THRESHOLDS, startedSps: STARTED_SPS });
  const stored = existsSync(LOCK_PATH) ? (JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as LockFile) : null;
  const changes = stored ? diffGovernance(stored.canonical as GovernanceState, live.canonical as GovernanceState) : [];
  const report = formatChanges(changes);
  if (process.env.ACCEPT_THRESHOLDS === '1') {
    writeFileSync(LOCK_PATH, `${JSON.stringify(live, null, 2)}\n`);
    console.log(report.length > 0 ? report : 'no threshold changes; lock rewritten');
    return;
  }
  expect(stored, 'test/thresholds.lock.json missing: run npm run test:accept-thresholds').not.toBeNull();
  expect(verifyLock(stored!), 'lock sha256 does not match its canonical content').toBe(true);
  expect(stored!.canonical, `governance state changed:\n${report}\nrun npm run test:accept-thresholds and amend the spec`).toEqual(live.canonical);
});

test('every active threshold part is covered by exactly one metricTest', () => {
  expect(coverageErrors(findMetricCalls(ROOT))).toEqual([]);
});
```

- [ ] **Step 7: Run it to see the lock test fail, then accept**

Run: `npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: FAIL — "test/thresholds.lock.json missing".

Run: `npm run test:accept-thresholds && npx vitest run --project arch test/arch/thresholds.test.ts`
Expected: accept prints `no threshold changes; lock rewritten`; then both tests PASS. `test/thresholds.lock.json` contains `{"sha256": "…", "canonical": {"startedSps": ["SP0"], "thresholds": {}}}`.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add test/thresholds.ts test/thresholds.lock.json test/harness/lock.ts test/harness/metric.ts test/arch/thresholds.test.ts test/unit/lock.test.ts test/unit/metric.test.ts
git commit -m "test(governance): locked thresholds with per-part activeFrom and metric registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Gated goldens

The spec describes a vitest `globalSetup` merge; with inline projects the root `globalSetup` is inherited by every project, so it would run once per project. This plan implements the same behaviour (observe during the run, merge once at the end, refuse changed entries without a `GENERATOR_VERSION` bump, write nothing on failure) as an explicit second vitest step in `test:goldens`. Task 16 records this in the SP0 spec.

**Files:**
- Create: `test/goldens.json`, `test/harness/goldens.ts`, `test/arch/goldens.test.ts`, `test/arch/goldensMerge.test.ts`

**Interfaces:**
- Consumes: `GENERATOR_VERSION`.
- Produces:
  - `interface GoldensFile { generatorVersion: number; entries: Record<string, string> }`
  - `interface Observation { key: string; hash: string }`
  - `interface GoldenStore { check(key: string, hash: string): void }`
  - `createGoldenStore(opts: { path: string; generatorVersion: number; mode: 'check' | 'record'; observationsDir: string }): GoldenStore`
  - `expectGolden(key: string, hash: string): void`
  - `mergeObservations(base: GoldensFile, observations: readonly Observation[], currentVersion: number): { ok: true; next: GoldensFile } | { ok: false; errors: string[] }`
  - `readObservations(dir: string): Observation[]`
  - constants `GOLDENS_PATH`, `OBSERVATIONS_DIR`

- [ ] **Step 1: Write the failing test**

`test/arch/goldens.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createGoldenStore, mergeObservations, readObservations, type GoldensFile } from '../harness/goldens';

function tempGoldens(file: GoldensFile): { path: string; obs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'goldens-'));
  const path = join(dir, 'goldens.json');
  writeFileSync(path, JSON.stringify(file));
  return { path, obs: join(dir, 'obs') };
}

describe('check mode', () => {
  const file: GoldensFile = { generatorVersion: 3, entries: { 'region/a': 'aaa' } };

  test('a matching entry passes', () => {
    const t = tempGoldens(file);
    createGoldenStore({ path: t.path, generatorVersion: 3, mode: 'check', observationsDir: t.obs }).check('region/a', 'aaa');
  });

  test('missing entry, mismatch and a stale generatorVersion fail with hints', () => {
    const t = tempGoldens(file);
    const store = createGoldenStore({ path: t.path, generatorVersion: 3, mode: 'check', observationsDir: t.obs });
    expect(() => store.check('region/b', 'bbb')).toThrow(/missing golden region\/b.*npm run test:goldens/);
    expect(() => store.check('region/a', 'zzz')).toThrow(/golden region\/a changed: aaa → zzz/);
    const stale = createGoldenStore({ path: t.path, generatorVersion: 4, mode: 'check', observationsDir: t.obs });
    expect(() => stale.check('region/a', 'aaa')).toThrow(/goldens\.json is for GENERATOR_VERSION 3, code is 4/);
  });

  test('record mode writes observations instead of failing', () => {
    const t = tempGoldens(file);
    const store = createGoldenStore({ path: t.path, generatorVersion: 3, mode: 'record', observationsDir: t.obs });
    store.check('region/b', 'bbb');
    store.check('region/a', 'zzz');
    expect(readObservations(t.obs)).toEqual([
      { key: 'region/a', hash: 'zzz' },
      { key: 'region/b', hash: 'bbb' },
    ]);
  });
});

describe('mergeObservations', () => {
  const base: GoldensFile = { generatorVersion: 3, entries: { a: '1', b: '2' } };

  test('new keys are added without a bump; unobserved keys are kept', () => {
    expect(mergeObservations(base, [{ key: 'c', hash: '3' }], 3)).toEqual({
      ok: true, next: { generatorVersion: 3, entries: { a: '1', b: '2', c: '3' } },
    });
  });

  test('changed entries need a GENERATOR_VERSION bump and are all listed', () => {
    expect(mergeObservations(base, [{ key: 'a', hash: 'x' }, { key: 'b', hash: 'y' }], 3)).toEqual({
      ok: false, errors: ['changed without a GENERATOR_VERSION bump: a, b'],
    });
    expect(mergeObservations(base, [{ key: 'a', hash: 'x' }, { key: 'b', hash: 'y' }], 4)).toEqual({
      ok: true, next: { generatorVersion: 4, entries: { a: 'x', b: 'y' } },
    });
  });

  test('two different hashes for one key are nondeterminism', () => {
    expect(mergeObservations(base, [{ key: 'c', hash: '3' }, { key: 'c', hash: '4' }], 3)).toEqual({
      ok: false, errors: ['nondeterministic golden c: 3 vs 4'],
    });
  });

  test('a code version older than the file is rejected', () => {
    expect(mergeObservations(base, [], 2)).toEqual({ ok: false, errors: ['code GENERATOR_VERSION 2 is older than goldens.json (3)'] });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/goldens.test.ts`
Expected: FAIL — module `../harness/goldens` not found.

- [ ] **Step 3: Implement**

`test/goldens.json`:
```json
{
  "generatorVersion": 0,
  "entries": {}
}
```

`test/harness/goldens.ts`:
```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR_VERSION } from '../../src/core/constants';

export const GOLDENS_PATH = fileURLToPath(new URL('../goldens.json', import.meta.url));
export const OBSERVATIONS_DIR = fileURLToPath(new URL('../.cache/goldens-obs/', import.meta.url));

export interface GoldensFile {
  generatorVersion: number;
  entries: Record<string, string>;
}

export interface Observation {
  key: string;
  hash: string;
}

export interface GoldenStore {
  check(key: string, hash: string): void;
}

const HINT = 'run npm run test:goldens';

export function createGoldenStore(opts: {
  path: string;
  generatorVersion: number;
  mode: 'check' | 'record';
  observationsDir: string;
}): GoldenStore {
  return {
    check(key, hash) {
      if (opts.mode === 'record') {
        mkdirSync(opts.observationsDir, { recursive: true });
        const name = createHash('sha256').update(`${key}\n${hash}`).digest('hex').slice(0, 32);
        writeFileSync(join(opts.observationsDir, `${name}.json`), JSON.stringify({ key, hash }));
        return;
      }
      const file = JSON.parse(readFileSync(opts.path, 'utf8')) as GoldensFile;
      if (file.generatorVersion !== opts.generatorVersion) {
        throw new Error(`goldens.json is for GENERATOR_VERSION ${file.generatorVersion}, code is ${opts.generatorVersion}: ${HINT}`);
      }
      const expected = file.entries[key];
      if (expected === undefined) throw new Error(`missing golden ${key}: ${HINT}`);
      if (expected !== hash) throw new Error(`golden ${key} changed: ${expected} → ${hash}`);
    },
  };
}

let defaultStore: GoldenStore | null = null;

export function expectGolden(key: string, hash: string): void {
  defaultStore ??= createGoldenStore({
    path: GOLDENS_PATH,
    generatorVersion: GENERATOR_VERSION,
    mode: process.env.UPDATE_GOLDENS === '1' ? 'record' : 'check',
    observationsDir: OBSERVATIONS_DIR,
  });
  defaultStore.check(key, hash);
}

export function readObservations(dir: string): Observation[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Observation)
    .sort((a, b) => (a.key === b.key ? a.hash.localeCompare(b.hash) : a.key.localeCompare(b.key)));
}

export function mergeObservations(
  base: GoldensFile,
  observations: readonly Observation[],
  currentVersion: number,
): { ok: true; next: GoldensFile } | { ok: false; errors: string[] } {
  if (currentVersion < base.generatorVersion) {
    return { ok: false, errors: [`code GENERATOR_VERSION ${currentVersion} is older than goldens.json (${base.generatorVersion})`] };
  }
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const o of observations) {
    const prev = seen.get(o.key);
    if (prev !== undefined && prev !== o.hash) errors.push(`nondeterministic golden ${o.key}: ${prev} vs ${o.hash}`);
    seen.set(o.key, o.hash);
  }
  if (errors.length > 0) return { ok: false, errors };
  const changed = [...seen].filter(([k, h]) => base.entries[k] !== undefined && base.entries[k] !== h).map(([k]) => k).sort();
  if (changed.length > 0 && currentVersion <= base.generatorVersion) {
    return { ok: false, errors: [`changed without a GENERATOR_VERSION bump: ${changed.join(', ')}`] };
  }
  const merged: Record<string, string> = { ...base.entries };
  for (const [k, h] of seen) merged[k] = h;
  const entries: Record<string, string> = {};
  for (const k of Object.keys(merged).sort()) entries[k] = merged[k]!;
  return { ok: true, next: { generatorVersion: currentVersion, entries } };
}
```

`test/arch/goldensMerge.test.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { GENERATOR_VERSION } from '../../src/core/constants';
import { GOLDENS_PATH, mergeObservations, OBSERVATIONS_DIR, readObservations, type GoldensFile } from '../harness/goldens';

test.skipIf(process.env.MERGE_GOLDENS !== '1')('merge recorded golden observations', () => {
  const base = JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldensFile;
  const result = mergeObservations(base, readObservations(OBSERVATIONS_DIR), GENERATOR_VERSION);
  expect(result.ok ? [] : result.errors).toEqual([]);
  if (result.ok) writeFileSync(GOLDENS_PATH, `${JSON.stringify(result.next, null, 2)}\n`);
});
```

- [ ] **Step 4: Run to see it pass, and exercise the script**

```bash
npx vitest run --project arch test/arch/goldens.test.ts
npm run test:goldens
git diff --exit-code test/goldens.json
```
Expected: tests PASS; `test:goldens` exits 0; with no observations the merge rewrites `goldens.json` byte-identically, so `git diff --exit-code` exits 0.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add test/goldens.json test/harness/goldens.ts test/arch/goldens.test.ts test/arch/goldensMerge.test.ts
git commit -m "test(governance): gated goldens with version-bump rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Arch scanner

**Files:**
- Create: `test/arch/scan.ts`, `test/arch/scan.test.ts`

**Interfaces:**
- Produces:
  - `ROOT: string` (repository root, absolute)
  - `type EdgeKind = 'value' | 'type' | 'worker' | 'url' | 'glob' | 'reference' | 'css' | 'html' | 'type-import-expr' | 'dynamic-nonliteral'`
  - `interface Edge { spec: string; kind: EdgeKind; line: number }`
  - `interface ScannedFile { path: string; layer: string | null; raw: string; code: string; codeKeepStrings: string; edges: Edge[] }` (`path` is repo-relative POSIX; `code` has comments and string contents blanked; `codeKeepStrings` only comments)
  - `interface Violation { file: string; line: number; rule: string; message: string }`
  - `SOURCE_EXTS: readonly string[]`
  - `blankJs(text: string, opts: { strings: boolean }): string`, `lineAt(text: string, index: number): number`
  - `layerOf(path: string): string | null`
  - `extractEdges(path: string, raw: string): Edge[]`
  - `listFiles(root: string, dir: string, exts: readonly string[], excludePrefixes?: readonly string[]): string[]`
  - `scanFile(root: string, path: string): ScannedFile`, `scanTree(root: string): ScannedFile[]` (`src/**` with `SOURCE_EXTS` plus `index.html`)
  - `type Target = { kind: 'repo'; path: string } | { kind: 'bare'; name: string } | { kind: 'builtin' } | { kind: 'url' } | { kind: 'absolute' } | { kind: 'escape' }`
  - `resolveTarget(fromPath: string, spec: string, edgeKind: EdgeKind): Target`
  - `sortViolations(v: Violation[]): Violation[]`

- [ ] **Step 1: Write the failing test**

`test/arch/scan.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { blankJs, extractEdges, layerOf, resolveTarget } from './scan';

describe('blankJs', () => {
  test('blanks comments and optionally string contents, keeping line numbers', () => {
    const src = "a // c\nb /* x\ny */ 'str' `t`";
    expect(blankJs(src, { strings: false })).toBe("a     \nb     \n     'str' `t`");
    expect(blankJs(src, { strings: true })).toBe("a     \nb     \n     '   ' ` `");
  });

  test('// inside a string is not a comment', () => {
    expect(blankJs("x = 'http://a'; // c", { strings: false })).toBe("x = 'http://a';     ");
  });
});

describe('layerOf', () => {
  test('first segment under src, main.ts is main, others null', () => {
    expect(layerOf('src/gen/density/x.ts')).toBe('gen');
    expect(layerOf('src/main.ts')).toBe('main');
    expect(layerOf('src/other.ts')).toBeNull();
    expect(layerOf('test/x.ts')).toBeNull();
  });
});

describe('extractEdges', () => {
  test('static, type-only, inline type, side-effect, export-from and multi-line imports', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from './b';",
      "import { type C } from './c';",
      "import './d.css';",
      "export * from './e';",
      "export type { F } from './f';",
      'import {',
      '  g,',
      "} from './g';",
    ].join('\n');
    expect(extractEdges('src/ui/x.ts', src)).toEqual([
      { spec: './a', kind: 'value', line: 1 },
      { spec: './b', kind: 'type', line: 2 },
      { spec: './c', kind: 'value', line: 3 },
      { spec: './g', kind: 'value', line: 7 },
      { spec: './d.css', kind: 'value', line: 4 },
      { spec: './e', kind: 'value', line: 5 },
      { spec: './f', kind: 'type', line: 6 },
    ]);
  });

  test('dynamic, type-import expression, non-literal, worker, url, glob and reference edges', () => {
    const src = [
      "const m = await import('./m');",
      "type T = import('./t').T;",
      'const n = import(name);',
      "new Worker(new URL('../workers/w.worker.ts', import.meta.url), { type: 'module' });",
      "const u = new URL('./asset.png', import.meta.url);",
      "import.meta.glob('./g/*.ts');",
      '/// <reference path="./r.d.ts" />',
    ].join('\n');
    expect(extractEdges('src/engine/x.ts', src)).toEqual([
      { spec: './m', kind: 'value', line: 1 },
      { spec: './t', kind: 'type-import-expr', line: 2 },
      { spec: '', kind: 'dynamic-nonliteral', line: 3 },
      { spec: '../workers/w.worker.ts', kind: 'worker', line: 4 },
      { spec: './asset.png', kind: 'url', line: 5 },
      { spec: './g/*.ts', kind: 'glob', line: 6 },
      { spec: './r.d.ts', kind: 'reference', line: 7 },
    ]);
  });

  test('imports mentioned in comments are ignored', () => {
    expect(extractEdges('src/ui/x.ts', "// import { a } from './a';\n/* import './b'; */")).toEqual([]);
  });

  test('css and html edges', () => {
    expect(extractEdges('src/ui/s.css', "@import './base.css';\n.a { background: url('./i.png'); }")).toEqual([
      { spec: './base.css', kind: 'css', line: 1 },
      { spec: './i.png', kind: 'css', line: 2 },
    ]);
    expect(extractEdges('index.html', '<script type="module" src="/src/main.ts"></script>')).toEqual([
      { spec: '/src/main.ts', kind: 'html', line: 1 },
    ]);
  });
});

describe('resolveTarget', () => {
  test('relative specifiers resolve to repo paths with .ts appended', () => {
    expect(resolveTarget('src/gen/x.ts', '../world/store/api', 'type')).toEqual({ kind: 'repo', path: 'src/world/store/api.ts' });
    expect(resolveTarget('src/ui/x.ts', './styles.css', 'value')).toEqual({ kind: 'repo', path: 'src/ui/styles.css' });
    expect(resolveTarget('src/main.ts', '../test/goldens.json', 'value')).toEqual({ kind: 'repo', path: 'test/goldens.json' });
    expect(resolveTarget('src/render/x.ts', './shader.glsl?raw', 'value')).toEqual({ kind: 'repo', path: 'src/render/shader.glsl' });
  });

  test('escapes, urls, absolute paths, builtins and bare names', () => {
    expect(resolveTarget('src/core/a.ts', '../../../outside', 'value')).toEqual({ kind: 'escape' });
    expect(resolveTarget('src/core/a.ts', 'https://esm.sh/three', 'value')).toEqual({ kind: 'url' });
    expect(resolveTarget('src/core/a.ts', '//cdn.example.com/x.js', 'value')).toEqual({ kind: 'url' });
    expect(resolveTarget('src/core/a.ts', '/abs/x', 'value')).toEqual({ kind: 'absolute' });
    expect(resolveTarget('index.html', '/src/main.ts', 'html')).toEqual({ kind: 'repo', path: 'src/main.ts' });
    expect(resolveTarget('test/x.ts', 'node:fs', 'value')).toEqual({ kind: 'builtin' });
    expect(resolveTarget('src/render/x.ts', 'three/addons/x.js', 'value')).toEqual({ kind: 'bare', name: 'three/addons/x.js' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/scan.test.ts`
Expected: FAIL — module `./scan` not found.

- [ ] **Step 3: Implement `test/arch/scan.ts`**

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export type EdgeKind =
  | 'value' | 'type' | 'worker' | 'url' | 'glob' | 'reference' | 'css' | 'html'
  | 'type-import-expr' | 'dynamic-nonliteral';

export interface Edge { spec: string; kind: EdgeKind; line: number }

export interface ScannedFile {
  path: string;
  layer: string | null;
  raw: string;
  code: string;
  codeKeepStrings: string;
  edges: Edge[];
}

export interface Violation { file: string; line: number; rule: string; message: string }

export const SOURCE_EXTS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.css', '.html', '.glsl', '.vert', '.frag', '.wgsl'] as const;
const JS_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SHADER_EXTS = new Set(['.glsl', '.vert', '.frag', '.wgsl']);
const KNOWN_EXTS = new Set([...SOURCE_EXTS, '.json', '.png', '.svg', '.jpg', '.webp']);

export function blankJs(text: string, opts: { strings: boolean }): string {
  const out = text.split('');
  const n = text.length;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      fill(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      fill(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(n, j + 1);
      if (opts.strings) fill(i + 1, stop - 1);
      i = stop;
    } else {
      i++;
    }
  }
  return out.join('');
}

function blankBlock(text: string, open: string, close: string): string {
  const out = text.split('');
  let i = text.indexOf(open);
  while (i !== -1) {
    const end = text.indexOf(close, i + open.length);
    const stop = end === -1 ? text.length : end + close.length;
    for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
    i = text.indexOf(open, stop);
  }
  return out.join('');
}

export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

export function layerOf(path: string): string | null {
  if (path === 'src/main.ts') return 'main';
  const parts = path.split('/');
  if (parts[0] !== 'src' || parts.length < 3) return null;
  return parts[1]!;
}

const THEN_LIKE = new Set(['then', 'catch', 'finally']);

export function extractEdges(path: string, raw: string): Edge[] {
  const ext = extname(path);
  const edges: Edge[] = [];
  const push = (spec: string, kind: EdgeKind, text: string, index: number) => edges.push({ spec, kind, line: lineAt(text, index) });
  if (ext === '.css') {
    const code = blankBlock(raw, '/*', '*/');
    for (const m of code.matchAll(/@import\s+(['"])([^'"]+)\1/g)) push(m[2]!, 'css', code, m.index);
    for (const m of code.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g)) push(m[2]!, 'css', code, m.index);
    return edges;
  }
  if (ext === '.html') {
    const code = blankBlock(raw, '<!--', '-->');
    for (const m of code.matchAll(/\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/g)) push(m[2]!, 'html', code, m.index);
    return edges;
  }
  if (!JS_EXTS.has(ext)) return edges;
  const code = blankJs(raw, { strings: false });
  for (const m of code.matchAll(/\bimport\s+(type\s+)?(?![('"])[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\2/g)) {
    push(m[3]!, m[1] ? 'type' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) push(m[2]!, 'value', code, m.index);
  for (const m of code.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g)) {
    push(m[3]!, m[1] ? 'type' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)(\s*\.\s*([\w$]+))?/g)) {
    const member = m[4];
    push(m[2]!, member !== undefined && !THEN_LIKE.has(member) ? 'type-import-expr' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*(?!['"`])/g)) push('', 'dynamic-nonliteral', code, m.index);
  const workerUrlStarts = new Set<number>();
  for (const m of code.matchAll(/\bnew\s+(?:Shared)?Worker\s*\(\s*(new\s+URL)\s*\(\s*(['"])([^'"\n]+)\2\s*,\s*import\.meta\.url\s*\)/g)) {
    workerUrlStarts.add(m.index + m[0].indexOf(m[1]!));
    push(m[3]!, 'worker', code, m.index);
  }
  for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    if (!workerUrlStarts.has(m.index)) push(m[2]!, 'url', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\.meta\.glob\s*\(\s*(['"])([^'"\n]+)\1/g)) push(m[2]!, 'glob', code, m.index);
  for (const m of raw.matchAll(/^\s*\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/gm)) push(m[2]!, 'reference', raw, m.index);
  return edges;
}

export function listFiles(root: string, dir: string, exts: readonly string[], excludePrefixes: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const childRel = posix.join(rel, name);
      if (excludePrefixes.some((p) => childRel === p || childRel.startsWith(`${p}/`))) continue;
      if (statSync(join(root, childRel)).isDirectory()) walk(childRel);
      else if (exts.includes(extname(name).toLowerCase())) out.push(childRel);
    }
  };
  walk(dir);
  return out;
}

export function scanFile(root: string, path: string): ScannedFile {
  const raw = readFileSync(join(root, path), 'utf8');
  const ext = extname(path);
  const isJs = JS_EXTS.has(ext);
  const commentsOnly = isJs ? blankJs(raw, { strings: false })
    : ext === '.css' || SHADER_EXTS.has(ext) ? blankBlock(raw, '/*', '*/')
    : ext === '.html' ? blankBlock(raw, '<!--', '-->') : raw;
  return {
    path,
    layer: layerOf(path),
    raw,
    code: isJs ? blankJs(raw, { strings: true }) : commentsOnly,
    codeKeepStrings: commentsOnly,
    edges: extractEdges(path, raw),
  };
}

export function scanTree(root: string): ScannedFile[] {
  const paths = listFiles(root, 'src', SOURCE_EXTS);
  if (existsSync(join(root, 'index.html'))) paths.push('index.html');
  return paths.map((p) => scanFile(root, p));
}

export type Target =
  | { kind: 'repo'; path: string }
  | { kind: 'bare'; name: string }
  | { kind: 'builtin' }
  | { kind: 'url' }
  | { kind: 'absolute' }
  | { kind: 'escape' };

function withExtension(path: string): string {
  return KNOWN_EXTS.has(extname(path).toLowerCase()) ? path : `${path}.ts`;
}

export function resolveTarget(fromPath: string, spec: string, edgeKind: EdgeKind): Target {
  const clean = spec.replace(/[?#].*$/, '');
  if (spec.startsWith('node:') || builtinModules.includes(clean)) return { kind: 'builtin' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('//')) return { kind: 'url' };
  if (spec.startsWith('/')) {
    return edgeKind === 'html' ? { kind: 'repo', path: withExtension(clean.slice(1)) } : { kind: 'absolute' };
  }
  if (spec.startsWith('.')) {
    const joined = posix.normalize(posix.join(posix.dirname(fromPath), clean));
    if (joined === '..' || joined.startsWith('../')) return { kind: 'escape' };
    return { kind: 'repo', path: withExtension(joined) };
  }
  return { kind: 'bare', name: spec };
}

export function sortViolations(v: Violation[]): Violation[] {
  return [...v].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run --project arch test/arch/scan.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0. (The expected edge order in the first `extractEdges` test is the order the regex passes run in: static-from, side-effect, export-from; keep the implementation's pass order if you adjust anything.)

- [ ] **Step 5: Commit**

```bash
git add test/arch/scan.ts test/arch/scan.test.ts
git commit -m "test(arch): source scanner with comment blanking, edge extraction and resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Layer dependency table

**Files:**
- Create: `test/arch/rules/imports.ts`, `test/arch/imports.test.ts`, fixture trees under `test/arch/fixtures/imports/{good,bad}/`

**Interfaces:**
- Consumes: `ScannedFile`, `Violation`, `resolveTarget`, `scanTree`, `sortViolations`, `ROOT` (Task 6).
- Produces: `LAYER_RULES`, `checkImports(files: readonly ScannedFile[]): Violation[]` with rules `unknown-layer`, `type-import-expr`, `dynamic-nonliteral`, `worker-edge`, `worker-import`, `three-outside-render`, `test-import`, `materials-outside-render`, `layer`.

- [ ] **Step 1: Create the fixture trees**

Each file below is exactly the shown content (one line unless shown otherwise).

Good tree `test/arch/fixtures/imports/good/`:
```
src/world/store/api.ts           export interface ColumnWriter { size: number }
src/world/store/padded.ts        export const PAD = 1;
src/world/blocks/registry.ts     export const STONE = 1;
src/gen/terrain.ts               import type { ColumnWriter } from '../world/store/api';
                                 import { STONE } from '../world/blocks/registry';
                                 export const fill = (w: ColumnWriter) => w.size + STONE;
src/persist/idb.ts               export const open = () => indexedDB.open('wi10');
src/sim/fluid.ts                 export const tick = () => 0;
src/textures/paint.ts            export const paint = () => 0;
src/audio/synth.ts               export const synth = () => 0;
src/mesh/packing.ts              export const PACK_LAYOUT = { layerBits: 10 };
src/mesh/greedy.ts               import { PAD } from '../world/store/padded';
                                 import type { ColumnWriter } from '../world/store/api';
                                 export const mesh = (w: ColumnWriter) => w.size + PAD;
src/engine/workerPool.ts         export const spawn = () => new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' });
src/workers/task.worker.ts       export {};
src/workers/sim.worker.ts        import { open } from '../persist/idb';
                                 import { tick } from '../sim/fluid';
                                 import { paint } from '../textures/paint';
                                 import { synth } from '../audio/synth';
                                 export const all = [open, tick, paint, synth];
src/render/materials/index.ts    import { PACK_LAYOUT } from '../../mesh/packing';
                                 import { ShaderMaterial } from 'three';
                                 export const make = () => new ShaderMaterial({ defines: { BITS: PACK_LAYOUT.layerBits } });
src/render/renderer.ts           import { make } from './materials/index';
                                 export const start = () => make();
src/ui/panel.ts                  import { start } from '../render/renderer';
                                 import { spawn } from '../engine/workerPool';
                                 export const boot = () => [start(), spawn()];
src/ui/metricsDashboard.ts       import { THRESHOLDS } from '../../test/thresholds';
                                 export const t = THRESHOLDS;
src/ui/styles.css                .a { color: red; }
src/main.ts                      import './ui/styles.css';
                                 import goldens from '../test/goldens.json';
                                 import { boot } from './ui/panel';
                                 boot(); console.info(goldens);
```

Bad tree `test/arch/fixtures/imports/bad/` (each file's single violation is on line 1):
```
src/gen/bad-value-api.ts         import { type ColumnWriter } from '../world/store/api';
src/core/bad-world.ts            import { x } from '../world/thing';
src/render/bad-gen-type.ts       import type { T } from '../gen/terrain';
src/ui/bad-materials.ts          import { m } from '../render/materials/index';
src/engine/bad-three.ts          import { Vector3 } from 'three';
src/ui/bad-worker-edge.ts        export const w = new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' });
src/main.ts                      import './workers/task.worker';
src/light/bad-slab.ts            import { alloc } from '../world/store/slab';
src/ui/bad-test-import.ts        import { THRESHOLDS } from '../../test/thresholds';
src/core/bad-type-expr.ts        export type X = import('../core/y').Y;
src/core/bad-dynamic.ts          export const load = (m: string) => import(m);
src/strange/bad-layer.ts         export const s = 1;
```

- [ ] **Step 2: Write the failing test**

`test/arch/imports.test.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkImports } from './rules/imports';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/imports/${name}`, import.meta.url));
const brief = (root: string) => sortViolations(checkImports(scanTree(root))).map((v) => `${v.file}:${v.line} ${v.rule}`);

test('good fixture tree has no violations', () => {
  expect(brief(fixture('good'))).toEqual([]);
});

test('bad fixture tree reports every violation', () => {
  expect(brief(fixture('bad'))).toEqual([
    'src/core/bad-dynamic.ts:1 dynamic-nonliteral',
    'src/core/bad-type-expr.ts:1 type-import-expr',
    'src/core/bad-world.ts:1 layer',
    'src/engine/bad-three.ts:1 three-outside-render',
    'src/gen/bad-value-api.ts:1 layer',
    'src/light/bad-slab.ts:1 layer',
    'src/main.ts:1 worker-import',
    'src/render/bad-gen-type.ts:1 layer',
    'src/strange/bad-layer.ts:1 unknown-layer',
    'src/ui/bad-materials.ts:1 materials-outside-render',
    'src/ui/bad-test-import.ts:1 test-import',
    'src/ui/bad-worker-edge.ts:1 worker-edge',
  ]);
});

test('the repository follows the layer table', () => {
  expect(sortViolations(checkImports(scanTree(ROOT)))).toEqual([]);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/imports.test.ts`
Expected: FAIL — module `./rules/imports` not found.

- [ ] **Step 4: Implement `test/arch/rules/imports.ts`**

```ts
import { layerOf, resolveTarget, type Edge, type ScannedFile, type Violation } from '../scan';

interface LayerRule {
  value: readonly string[];
  typeOnly?: readonly string[];
  deny?: readonly string[];
}

const LAYERS = ['core', 'world', 'gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist', 'metrics',
  'daynight', 'workers', 'engine', 'render', 'player', 'sound', 'ui', 'main'] as const;
const L2_CORE = ['core', 'world', 'gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist'];
const LIGHT_MESH = ['core', 'world/blocks/**', 'world/store/padded.ts', 'gen', 'textures', 'audio', 'light', 'mesh'];

/** SP0 spec "Dependency table" (refines master §1). */
export const LAYER_RULES: Readonly<Record<string, LayerRule>> = {
  core: { value: ['core'] },
  world: { value: ['core', 'world'] },
  gen: { value: ['core', 'gen', 'world/blocks/**'], typeOnly: ['world/store/api.ts'] },
  textures: { value: ['core', 'textures'] },
  audio: { value: ['core', 'audio', 'world/blocks/**'], typeOnly: ['world/store/api.ts'] },
  light: { value: LIGHT_MESH, typeOnly: ['world/store/api.ts'] },
  mesh: { value: LIGHT_MESH, typeOnly: ['world/store/api.ts'] },
  sim: { value: L2_CORE },
  persist: { value: L2_CORE },
  metrics: { value: [...L2_CORE, 'metrics'] },
  daynight: { value: ['core', 'daynight'] },
  workers: { value: [...L2_CORE, 'metrics', 'daynight', 'workers'] },
  engine: { value: ['core', 'world', 'engine', 'workers/protocol.ts'], typeOnly: ['gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist', 'metrics'] },
  render: { value: ['core', 'world', 'light', 'mesh', 'textures', 'daynight', 'render', 'workers/protocol.ts'] },
  player: { value: ['core', 'world', 'daynight', 'player', 'workers/protocol.ts'], typeOnly: ['engine', 'render'], deny: ['render/materials/**'] },
  sound: { value: ['core', 'world', 'audio', 'daynight', 'sound', 'workers/protocol.ts'], typeOnly: ['engine'] },
  ui: { value: LAYERS, deny: ['render/materials/**', '*.worker.ts'] },
  main: { value: LAYERS, deny: ['*.worker.ts'] },
};

/** `srcRel` is a path under src/, e.g. `world/store/api.ts`. */
function matches(srcRel: string, pattern: string): boolean {
  if (pattern === '*.worker.ts') return srcRel.endsWith('.worker.ts');
  if (pattern.endsWith('/**')) return srcRel.startsWith(pattern.slice(0, -2));
  if (pattern.includes('/')) return srcRel === pattern;
  return layerOf(`src/${srcRel}`) === pattern;
}

function allowed(rule: LayerRule, srcRel: string, kind: Edge['kind']): boolean {
  if (rule.deny?.some((p) => matches(srcRel, p))) return false;
  if (rule.value.some((p) => matches(srcRel, p))) return true;
  return kind === 'type' && (rule.typeOnly ?? []).some((p) => matches(srcRel, p));
}

const TEST_IMPORT_EXCEPTIONS: ReadonlyArray<{ from: (f: ScannedFile) => boolean; target: string }> = [
  { from: (f) => f.layer === 'main' || f.layer === 'ui', target: 'test/goldens.json' },
  { from: (f) => f.path === 'src/ui/metricsDashboard.ts', target: 'test/thresholds.ts' },
];

function checkEdge(f: ScannedFile, layer: string, e: Edge): Violation | null {
  const at = (rule: string, message: string): Violation => ({ file: f.path, line: e.line, rule, message });
  if (e.kind === 'type-import-expr') return at('type-import-expr', `use import type instead of import('${e.spec}')`);
  if (e.kind === 'dynamic-nonliteral') return at('dynamic-nonliteral', 'dynamic import with a non-literal specifier');
  const t = resolveTarget(f.path, e.spec, e.kind);
  if (t.kind === 'bare') {
    const isThree = t.name === 'three' || t.name.startsWith('three/');
    return isThree && layer !== 'render' ? at('three-outside-render', `${layer} imports ${t.name}`) : null;
  }
  if (t.kind !== 'repo') return null;
  const target = t.path;
  if (e.kind === 'worker') {
    return layer === 'engine' && target.endsWith('.worker.ts') ? null : at('worker-edge', `only engine/ may spawn workers (${target})`);
  }
  if (target.endsWith('.worker.ts')) return at('worker-import', `worker entry ${target} must not be imported`);
  if (target.startsWith('test/')) {
    const ok = TEST_IMPORT_EXCEPTIONS.some((x) => x.target === target && x.from(f));
    return ok ? null : at('test-import', `src must not import ${target}`);
  }
  if (!target.startsWith('src/')) return null;
  const srcRel = target.slice('src/'.length);
  if (srcRel.startsWith('render/materials/') && layer !== 'render') {
    return at('materials-outside-render', `${layer} imports ${srcRel}`);
  }
  const rule = LAYER_RULES[layer]!;
  return allowed(rule, srcRel, e.kind) ? null : at('layer', `${layer} may not import ${srcRel}${e.kind === 'type' ? ' (type-only)' : ''}`);
}

export function checkImports(files: readonly ScannedFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.path.startsWith('src/')) continue;
    const layer = f.layer;
    if (layer === null || !(layer in LAYER_RULES)) {
      out.push({ file: f.path, line: 1, rule: 'unknown-layer', message: `no layer for ${f.path}; amend the dependency table` });
      continue;
    }
    for (const e of f.edges) {
      const v = checkEdge(f, layer, e);
      if (v) out.push(v);
    }
  }
  return out;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run --project arch test/arch/imports.test.ts && npm run typecheck`
Expected: PASS (all three tests); typecheck exits 0 (fixtures are excluded from `tsconfig.test.json`).

- [ ] **Step 6: Commit**

```bash
git add test/arch/rules/imports.ts test/arch/imports.test.ts test/arch/fixtures/imports
git commit -m "test(arch): layer dependency table with good/bad fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Resolution inside the repository and config hygiene

**Files:**
- Create: `test/arch/rules/resolution.ts`, `test/arch/resolution.test.ts`, `test/arch/fixtures/resolution/bad/src/core/a.ts`, `test/arch/fixtures/hygiene/bad/{package.json,tsconfig.json,vite.config.ts}`, `test/arch/fixtures/hygiene/good/{package.json,tsconfig.json,vite.config.ts}`

**Interfaces:**
- Consumes: `scanFile`, `listFiles`, `resolveTarget`, `ScannedFile`, `Violation`, `ROOT`, `sortViolations`, `SOURCE_EXTS` (Task 6).
- Produces:
  - `repositoryFiles(root: string): ScannedFile[]` (src, test except fixtures, index.html, root configs)
  - `checkResolution(root: string, files: readonly ScannedFile[]): Violation[]` — rules `escapes-root`, `url-specifier`, `absolute-specifier`, `src-bare-not-three`, `bare-unresolved`, `bare-outside-node-modules`
  - `checkConfigHygiene(root: string): Violation[]` — rules `alias`, `tsconfig-paths`, `non-registry-dep`, `runtime-deps`

- [ ] **Step 1: Create the fixtures**

`test/arch/fixtures/resolution/bad/src/core/a.ts` (exactly five lines):
```ts
import '../../../../../outside';
import 'https://esm.sh/three';
import '//cdn.example.com/x.js';
import '/abs/x';
import 'lodash';
```

`test/arch/fixtures/hygiene/bad/package.json`:
```json
{ "dependencies": { "three": "~0.186.1", "left-pad": "file:../left-pad" } }
```
`test/arch/fixtures/hygiene/bad/tsconfig.json`:
```json
{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }
```
`test/arch/fixtures/hygiene/bad/vite.config.ts`:
```ts
export default { resolve: { alias: { '@': '/src' } } };
```
`test/arch/fixtures/hygiene/good/package.json`:
```json
{ "dependencies": { "three": "~0.186.1" }, "devDependencies": { "vite": "^8.3.1", "@types/node": "^24" } }
```
`test/arch/fixtures/hygiene/good/tsconfig.json`:
```json
{ "compilerOptions": { "strict": true } }
```
`test/arch/fixtures/hygiene/good/vite.config.ts`:
```ts
// no alias here, and an 'alias' inside a string does not count
export default { server: { port: 5183 }, note: 'alias: none' };
```

- [ ] **Step 2: Write the failing test**

`test/arch/resolution.test.ts`:
```ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkConfigHygiene, checkResolution, repositoryFiles } from './rules/resolution';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const brief = (v: ReturnType<typeof checkResolution>) => sortViolations(v).map((x) => `${x.file}:${x.line} ${x.rule}`);

test('bad specifiers are reported', () => {
  const root = fixture('resolution/bad');
  expect(brief(checkResolution(root, scanTree(root)))).toEqual([
    'src/core/a.ts:1 escapes-root',
    'src/core/a.ts:2 url-specifier',
    'src/core/a.ts:3 url-specifier',
    'src/core/a.ts:4 absolute-specifier',
    'src/core/a.ts:5 src-bare-not-three',
  ]);
});

test('symlinks cannot escape the repository', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'evil.ts'), 'export const evil = 1;');
  mkdirSync(join(outside, 'three'));
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(root, 'src/core'), { recursive: true });
  mkdirSync(join(root, 'src/render'), { recursive: true });
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(outside, 'evil.ts'), join(root, 'src/core/link.ts'));
  symlinkSync(join(outside, 'three'), join(root, 'node_modules/three'));
  writeFileSync(join(root, 'src/core/uses.ts'), "import { evil } from './link';\nexport const x = evil;");
  writeFileSync(join(root, 'src/render/r.ts'), "import 'three';");
  expect(brief(checkResolution(root, scanTree(root)).filter((v) => v.file !== 'src/core/link.ts'))).toEqual([
    'src/core/uses.ts:1 escapes-root',
    'src/render/r.ts:1 bare-outside-node-modules',
  ]);
});

test('config hygiene: aliases, tsconfig paths, non-registry and extra runtime deps', () => {
  expect(brief(checkConfigHygiene(fixture('hygiene/bad')))).toEqual([
    'package.json:1 non-registry-dep',
    'package.json:1 runtime-deps',
    'tsconfig.json:1 tsconfig-paths',
    'vite.config.ts:1 alias',
  ]);
  expect(checkConfigHygiene(fixture('hygiene/good'))).toEqual([]);
});

test('the repository resolves everything inside itself and keeps its configs clean', () => {
  expect(sortViolations(checkResolution(ROOT, repositoryFiles(ROOT)))).toEqual([]);
  expect(checkConfigHygiene(ROOT)).toEqual([]);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/resolution.test.ts`
Expected: FAIL — module `./rules/resolution` not found.

- [ ] **Step 4: Implement `test/arch/rules/resolution.ts`**

```ts
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { blankJs, listFiles, resolveTarget, scanFile, SOURCE_EXTS, type ScannedFile, type Violation } from '../scan';

const CONFIG_FILES = ['vite.config.ts', 'vitest.config.ts'];

export function repositoryFiles(root: string): ScannedFile[] {
  const paths = [
    ...listFiles(root, 'src', SOURCE_EXTS),
    ...listFiles(root, 'test', SOURCE_EXTS, ['test/arch/fixtures', 'test/.cache', 'test/metrics/.out']),
    ...['index.html', ...CONFIG_FILES].filter((p) => existsSync(join(root, p))),
  ];
  return paths.map((p) => scanFile(root, p));
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

export function checkResolution(root: string, files: readonly ScannedFile[]): Violation[] {
  const realRoot = realpathSync(root);
  const nodeModules = join(root, 'node_modules');
  const realNodeModules = existsSync(nodeModules) ? realpathSync(nodeModules) : null;
  const out: Violation[] = [];
  for (const f of files) {
    for (const e of f.edges) {
      if (e.kind === 'dynamic-nonliteral' || e.kind === 'type-import-expr') continue;
      const at = (rule: string, message: string) => out.push({ file: f.path, line: e.line, rule, message });
      const t = resolveTarget(f.path, e.spec, e.kind);
      const inSrc = f.path.startsWith('src/');
      if (t.kind === 'url') { at('url-specifier', `${e.spec} is a URL`); continue; }
      if (t.kind === 'absolute') { at('absolute-specifier', `${e.spec} is an absolute path`); continue; }
      if (t.kind === 'escape') { at('escapes-root', `${e.spec} leaves the repository`); continue; }
      if (t.kind === 'builtin') { if (inSrc) at('src-bare-not-three', `${e.spec} is a Node builtin`); continue; }
      if (t.kind === 'repo') {
        const abs = join(root, t.path);
        if (existsSync(abs) && !inside(realpathSync(abs), realRoot)) at('escapes-root', `${e.spec} resolves outside through a symlink`);
        continue;
      }
      if (inSrc && t.name !== 'three' && !t.name.startsWith('three/')) { at('src-bare-not-three', `src imports ${t.name}`); continue; }
      const dir = join(nodeModules, packageName(t.name));
      if (!existsSync(dir) || realNodeModules === null) { at('bare-unresolved', `${t.name} is not installed`); continue; }
      if (!inside(realpathSync(dir), realNodeModules)) at('bare-outside-node-modules', `${t.name} resolves outside node_modules`);
    }
  }
  return out;
}

const REGISTRY_RANGE = /^[\^~<>=\s\d.x*|-]+$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export function checkConfigHygiene(root: string): Violation[] {
  const out: Violation[] = [];
  const at = (file: string, rule: string, message: string) => out.push({ file, line: 1, rule, message });
  for (const file of CONFIG_FILES) {
    const abs = join(root, file);
    if (existsSync(abs) && /\balias\s*:/.test(blankJs(readFileSync(abs, 'utf8'), { strings: true }))) {
      at(file, 'alias', 'resolve.alias is not allowed');
    }
  }
  for (const file of readdirSync(root).filter((n) => /^tsconfig.*\.json$/.test(n)).sort()) {
    const opts = (JSON.parse(readFileSync(join(root, file), 'utf8')) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
    if ('paths' in opts || 'baseUrl' in opts) at(file, 'tsconfig-paths', 'paths/baseUrl are not allowed');
  }
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (!REGISTRY_RANGE.test(range)) at('package.json', 'non-registry-dep', `${field}.${name} = ${range}`);
      }
    }
    const runtime = Object.keys(pkg.dependencies ?? {});
    if (runtime.length !== 1 || runtime[0] !== 'three') at('package.json', 'runtime-deps', `dependencies must be exactly three (got ${runtime.join(', ')})`);
  }
  return out;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run --project arch test/arch/resolution.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add test/arch/rules/resolution.ts test/arch/resolution.test.ts test/arch/fixtures/resolution test/arch/fixtures/hygiene
git commit -m "test(arch): imports resolve inside the repo; config hygiene checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Banned APIs and audio files

**Files:**
- Create: `test/arch/rules/banned.ts`, `test/arch/banned.test.ts`, fixture trees under `test/arch/fixtures/banned/{good,bad}/`

**Interfaces:**
- Consumes: `ScannedFile`, `Violation`, `lineAt`, `scanTree`, `sortViolations`, `ROOT` (Task 6).
- Produces:
  - `checkBanned(files: readonly ScannedFile[]): Violation[]` — rules `nondeterministic`, `math-member`, `math-computed`, `math-as-value`, `math-pow-operator`, `numeric-export`, `numeric-data-export`, `dom-global`, `worker-api`, `glsl-outside-materials`, `webaudio-outside-sound`, `three-audio`, `raw-shader-file`, `raw-import`
  - `isNumericExpr(init: string): boolean`
  - `listAudioFiles(root: string): string[]`

- [ ] **Step 1: Create the fixture trees**

Bad tree `test/arch/fixtures/banned/bad/src/` (single line unless shown):
```
core/random.ts                    export const r = () => Math.random();
world/clock.ts                    export const t = () => Date.now();
gen/log.ts                        export function f() { console.log('x'); }
gen/trig.ts                       export const s = (x: number) => Math.sin(x);
gen/pow.ts                        export const p = (x: number) => x ** 2;
gen/alias.ts                      const M = Math; export const f = (x: number) => M.floor(x);
gen/computed.ts                   export const f = (x: number) => Math['sin'](x);
gen/tunable.ts                    export const CAVE_GAIN = 1.6;
gen/tunables2.ts                  const K = -0.3;
                                  export { K };
gen/data.ts                       export const TUNING = { k: 0.37 };
light/dom.ts                      export const w = () => window.innerWidth;
core/worker.ts                    export const send = () => postMessage(1);
ui/shader.ts                      export const s = 'void main() { gl_Position = vec4(0.0); }';
ui/audio.ts                       export const a = () => new AudioContext();
render/threeAudio.ts              import { PositionalAudio } from 'three';
render/materials/raw.glsl         void main() {}
render/materials/rawImport.ts     import src from './x.glsl?raw';
```

Good tree `test/arch/fixtures/banned/good/src/`:
```
core/doc.ts                       // never use Math.random here
                                  export const msg = 'console.log is banned';
gen/floor.ts                      export const f = (x: number) => Math.floor(x) + Math.imul(x, 3) + Math.sqrt(x) * Math.PI;
gen/density/defaults.ts           export const DEFAULT_EXPR = { op: 'const', v: 1 };
persist/idb.ts                    export const open = () => indexedDB.open('wi10');
render/materials/terrain.glsl.ts  export const VERT = `#version 300 es
                                  void main() { gl_Position = vec4(0.0); }`;
sound/engine.ts                   export const ctx = () => new AudioContext();
ui/label.ts                       export const title = () => document.title;
```

- [ ] **Step 2: Write the failing test**

`test/arch/banned.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkBanned, isNumericExpr, listAudioFiles } from './rules/banned';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/banned/${name}`, import.meta.url));
const brief = (root: string) => sortViolations(checkBanned(scanTree(root))).map((v) => `${v.file}:${v.line} ${v.rule}`);

test('bad fixture tree reports every banned use', () => {
  expect(brief(fixture('bad'))).toEqual([
    'src/core/random.ts:1 nondeterministic',
    'src/core/worker.ts:1 worker-api',
    'src/gen/alias.ts:1 math-as-value',
    'src/gen/computed.ts:1 math-computed',
    'src/gen/data.ts:1 numeric-data-export',
    'src/gen/log.ts:1 nondeterministic',
    'src/gen/pow.ts:1 math-pow-operator',
    'src/gen/trig.ts:1 math-member',
    'src/gen/tunable.ts:1 numeric-export',
    'src/gen/tunables2.ts:2 numeric-export',
    'src/light/dom.ts:1 dom-global',
    'src/render/materials/raw.glsl:1 raw-shader-file',
    'src/render/materials/rawImport.ts:1 raw-import',
    'src/render/threeAudio.ts:1 three-audio',
    'src/ui/audio.ts:1 webaudio-outside-sound',
    'src/ui/shader.ts:1 glsl-outside-materials',
    'src/world/clock.ts:1 nondeterministic',
  ]);
});

test('good fixture tree passes', () => {
  expect(brief(fixture('good'))).toEqual([]);
});

test('the repository uses no banned API', () => {
  expect(sortViolations(checkBanned(scanTree(ROOT)))).toEqual([]);
});

describe('isNumericExpr', () => {
  test.each(['1', '-1', '+1', '1e-3', '0x10', '1_000', '1n', '(3)', '5 as const', '2 * 8', '1.5 satisfies number', '.5'])('%s is numeric', (s) => {
    expect(isNumericExpr(s)).toBe(true);
  });
  test.each(['x', '() => 1', "'a'", '{ k: 1 }', 'Math.PI', 'a * 2'])('%s is not numeric', (s) => {
    expect(isNumericExpr(s)).toBe(false);
  });
});

describe('audio files', () => {
  test('any audio extension, any case, outside node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'audio-'));
    mkdirSync(join(root, 'public'));
    mkdirSync(join(root, 'node_modules'));
    for (const f of ['public/x.ogg', 'Y.MP3', 'ok.txt', 'node_modules/z.wav', 'a.Flac']) writeFileSync(join(root, f), '');
    expect(listAudioFiles(root)).toEqual(['Y.MP3', 'a.Flac', 'public/x.ogg']);
  });

  test('the repository contains no audio files', () => {
    expect(listAudioFiles(ROOT)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/banned.test.ts`
Expected: FAIL — module `./rules/banned` not found.

- [ ] **Step 4: Implement `test/arch/rules/banned.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { lineAt, type ScannedFile, type Violation } from '../scan';

const JS_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SHADER_EXTS = new Set(['.glsl', '.vert', '.frag', '.wgsl']);
const ND_LAYERS = new Set(['core', 'world', 'gen']);
const PURE_LAYERS = new Set(['core', 'world', 'gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist', 'metrics', 'daynight']);
const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'imul', 'fround', 'clz32', 'sqrt',
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
const THREE_AUDIO = new Set(['Audio', 'AudioListener', 'PositionalAudio', 'AudioLoader', 'AudioAnalyser']);
const AUDIO_EXTS = new Set(['.ogg', '.oga', '.mp3', '.wav', '.flac', '.m4a', '.aac', '.opus', '.weba']);

const NUM = String.raw`(?:0x[\da-f_]+|\d[\d_]*(?:\.[\d_]*)?(?:e[-+]?\d+)?n?|\.\d[\d_]*(?:e[-+]?\d+)?)`;
const NUMERIC_EXPR = new RegExp(String.raw`^[-+(]*${NUM}\)*(?:[-+*/%][-+(]*${NUM}\)*)*$`, 'i');

export function isNumericExpr(init: string): boolean {
  const s = init.trim().replace(/\s+as\s+const\s*$/, '').replace(/\s+satisfies\s+[\w$.<>[\]]+\s*$/, '').replace(/\s+/g, '');
  return NUMERIC_EXPR.test(s);
}

function readStatement(code: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) break;
  }
  return code.slice(start, i);
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(from, i)); from = i + 1; }
  }
  parts.push(s.slice(from));
  return parts;
}

function numericExportViolations(f: ScannedFile, srcRel: string): Violation[] {
  const out: Violation[] = [];
  const dataAllowed = /^gen\/(?:.*\/)?defaults\.ts$/.test(srcRel) || srcRel.startsWith('gen/structures/templates/');
  const at = (index: number, rule: string, message: string) => out.push({ file: f.path, line: lineAt(f.code, index), rule, message });
  for (const m of f.code.matchAll(/\bexport\s+(?:const|let|var)\s+/g)) {
    for (const decl of splitTopLevel(readStatement(f.code, m.index + m[0].length))) {
      const d = /^\s*([\w$]+)\s*(?::[^=]+)?=\s*([\s\S]*)$/.exec(decl);
      if (!d) continue;
      const init = d[2]!.trim();
      if (isNumericExpr(init)) at(m.index, 'numeric-export', `exported numeric constant ${d[1]} (use ParamSchema or core/constants)`);
      else if (!dataAllowed && /^[{[]/.test(init) && /(?<![\w$])\d/.test(init)) at(m.index, 'numeric-data-export', `exported data with numbers ${d[1]} outside defaults.ts/templates`);
    }
  }
  for (const m of f.code.matchAll(/\bexport\s+default\s+([^;\n]+)/g)) {
    if (isNumericExpr(m[1]!)) at(m.index, 'numeric-export', 'exported default numeric constant');
  }
  const numericBindings = new Set<string>();
  for (const m of f.code.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g)) {
    if (isNumericExpr(m[2]!)) numericBindings.add(m[1]!);
  }
  for (const m of f.code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const item of m[1]!.split(',')) {
      const local = item.trim().split(/\s+as\s+/)[0]!;
      if (numericBindings.has(local)) at(m.index, 'numeric-export', `exported numeric constant ${local}`);
    }
  }
  return out;
}

export function checkBanned(files: readonly ScannedFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.path.startsWith('src/')) continue;
    const srcRel = f.path.slice('src/'.length);
    const layer = f.layer ?? '';
    const ext = extname(f.path);
    const found = new Map<string, Violation>();
    const at = (text: string, index: number, rule: string, message: string) => {
      const line = lineAt(text, index);
      const key = `${rule}:${line}`;
      if (!found.has(key)) found.set(key, { file: f.path, line, rule, message });
    };
    if (SHADER_EXTS.has(ext)) { at(f.raw, 0, 'raw-shader-file', 'GLSL lives in render/materials/*.glsl.ts template literals'); }
    for (const e of f.edges) {
      if (e.spec.includes('?raw')) found.set(`raw-import:${e.line}`, { file: f.path, line: e.line, rule: 'raw-import', message: `${e.spec}: ?raw imports are not allowed` });
    }
    if (JS_EXTS.has(ext)) {
      const { code, codeKeepStrings } = f;
      if (ND_LAYERS.has(layer)) {
        for (const m of code.matchAll(/\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|\bconsole\s*\./g)) at(code, m.index, 'nondeterministic', `${m[0]} in ${layer}/`);
      }
      if (layer === 'gen' || srcRel.startsWith('core/noise/')) {
        for (const m of code.matchAll(/\bMath\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
          if (!MATH_ALLOWED.has(m[1]!) && m[1] !== 'random') at(code, m.index, 'math-member', `Math.${m[1]} (use core/detMath)`);
        }
        for (const m of code.matchAll(/\bMath\s*\[/g)) at(code, m.index, 'math-computed', 'computed Math access');
        for (const m of code.matchAll(/\bMath\b(?!\s*[.[])/g)) at(code, m.index, 'math-as-value', 'Math used as a value');
        for (const m of code.matchAll(/\*\*/g)) at(code, m.index, 'math-pow-operator', '** operator (use detMath)');
      }
      if (layer === 'gen') for (const v of numericExportViolations(f, srcRel)) found.set(`${v.rule}:${v.line}`, v);
      if (PURE_LAYERS.has(layer)) {
        for (const m of code.matchAll(/(?<![\w$.])(document|window|indexedDB|localStorage|sessionStorage)\b/g)) {
          if (!(srcRel === 'persist/idb.ts' && m[1] === 'indexedDB')) at(code, m.index, 'dom-global', `${m[1]} in pure layer ${layer}/`);
        }
      }
      if (layer === 'core') {
        for (const m of code.matchAll(/(?<![\w$.])(self|postMessage|importScripts|onmessage)\b|\bnew\s+(?:Shared)?Worker\b/g)) at(code, m.index, 'worker-api', `${m[0]} in core/`);
      }
      if (!srcRel.startsWith('render/materials/')) {
        for (const m of code.matchAll(/\b(ShaderMaterial|RawShaderMaterial|onBeforeCompile|ShaderChunk|ShaderLib|glslVersion)\b/g)) at(code, m.index, 'glsl-outside-materials', `${m[1]} outside render/materials/`);
        for (const m of codeKeepStrings.matchAll(/#version\b|\bgl_Position\b|\bgl_FragColor\b|\bgl_FragCoord\b|\bprecision\s+(?:highp|mediump|lowp)\b/g)) at(codeKeepStrings, m.index, 'glsl-outside-materials', `GLSL (${m[0]}) outside render/materials/`);
      }
      if (layer !== 'sound') {
        for (const m of code.matchAll(/\b(AudioContext|webkitAudioContext|OfflineAudioContext|AudioWorklet|AudioWorkletNode|AudioWorkletProcessor|registerProcessor|decodeAudioData)\b/g)) at(code, m.index, 'webaudio-outside-sound', `${m[1]} outside sound/`);
      }
      for (const m of codeKeepStrings.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]three(?:\/[^'"]*)?['"]/g)) {
        const names = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!);
        if (names.some((n) => THREE_AUDIO.has(n))) at(codeKeepStrings, m.index, 'three-audio', 'three audio classes are not used (audio lives in sound/)');
      }
    }
    out.push(...found.values());
  }
  return out;
}

function walkFiles(root: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(root, rel))) {
    const child = rel === '' ? name : posix.join(rel, name);
    if (['node_modules', 'dist', '.git'].includes(name) || child === 'test/.cache') continue;
    if (statSync(join(root, child)).isDirectory()) walkFiles(root, child, out);
    else out.push(child);
  }
}

export function listAudioFiles(root: string): string[] {
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter((f) => f.length > 0);
  } catch {
    files = [];
    walkFiles(root, '', files);
  }
  return files.filter((f) => AUDIO_EXTS.has(extname(f).toLowerCase())).sort();
}
```

Note: the temporary directory in the audio test is not a git repository, so `git ls-files` fails there and the walk is used, which is the "no git (Docker)" path of the spec.

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run --project arch test/arch/banned.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add test/arch/rules/banned.ts test/arch/banned.test.ts test/arch/fixtures/banned
git commit -m "test(arch): banned APIs, numeric exports, GLSL/WebAudio placement and audio files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Header parity and cross-origin subresources

**Files:**
- Create: `vercel.json`, `test/arch/rules/headers.ts`, `test/arch/headers.test.ts`

**Interfaces:**
- Consumes: `vite.config.ts` default export (Task 1); `ScannedFile`, `scanTree`, `ROOT`, `lineAt`, `Violation` (Task 6).
- Produces: `ISOLATION_HEADERS_EXPECTED`, `vercelHeaders(json: unknown): Record<string, string> | null`, `findCrossOriginSubresources(files: readonly Pick<ScannedFile, 'path' | 'raw' | 'codeKeepStrings'>[]): Violation[]`.

- [ ] **Step 1: Write the failing test**

`test/arch/headers.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import viteConfig from '../../vite.config';
import { findCrossOriginSubresources, ISOLATION_HEADERS_EXPECTED, vercelHeaders } from './rules/headers';
import { ROOT, scanTree } from './scan';

describe('isolation headers', () => {
  test('vite server and preview send exactly COOP/COEP on 5183 with strictPort, ES workers', () => {
    expect(viteConfig.server?.headers).toEqual(ISOLATION_HEADERS_EXPECTED);
    expect(viteConfig.preview?.headers).toEqual(ISOLATION_HEADERS_EXPECTED);
    expect(viteConfig.server?.port).toBe(5183);
    expect(viteConfig.preview?.port).toBe(5183);
    expect(viteConfig.server?.strictPort).toBe(true);
    expect(viteConfig.preview?.strictPort).toBe(true);
    expect(viteConfig.worker?.format).toBe('es');
  });

  test('vercel.json sends the same headers for every route', () => {
    const json: unknown = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    expect(vercelHeaders(json)).toEqual(ISOLATION_HEADERS_EXPECTED);
  });
});

describe('cross-origin subresources', () => {
  const file = (path: string, text: string) => ({ path, raw: text, codeKeepStrings: text });

  test('script/link/img/css/fetch/import/worker URLs to other origins are reported', () => {
    const found = findCrossOriginSubresources([
      file('index.html', '<link href="https://fonts.googleapis.com/css2">\n<script src="//cdn.x/y.js"></script>'),
      file('src/ui/s.css', "@import 'https://x/y.css';\n.a { background: url(//x/i.png); }"),
      file('src/ui/a.ts', "fetch('https://api.x/y');\nnew Worker('https://x/w.js');"),
    ]).map((v) => `${v.file}:${v.line}`);
    expect(found).toEqual(['index.html:1', 'index.html:2', 'src/ui/s.css:1', 'src/ui/s.css:2', 'src/ui/a.ts:1', 'src/ui/a.ts:2']);
  });

  test('plain text mentioning a URL is allowed', () => {
    expect(findCrossOriginSubresources([file('src/engine/r.ts', "const hint = 'open via http://localhost:<port> or HTTPS';")])).toEqual([]);
  });

  test('the repository loads nothing from other origins', () => {
    expect(findCrossOriginSubresources(scanTree(ROOT))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project arch test/arch/headers.test.ts`
Expected: FAIL — `./rules/headers` not found.

- [ ] **Step 3: Implement**

`vercel.json`:
```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

`test/arch/rules/headers.ts`:
```ts
import { extname } from 'node:path';
import { lineAt, type ScannedFile, type Violation } from '../scan';

export const ISOLATION_HEADERS_EXPECTED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

interface VercelJson { headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }> }

export function vercelHeaders(json: unknown): Record<string, string> | null {
  const entry = (json as VercelJson).headers?.find((h) => h.source === '/(.*)');
  if (!entry) return null;
  return Object.fromEntries(entry.headers.map((h) => [h.key, h.value]));
}

const OTHER_ORIGIN = String.raw`(?:https?:)?\/\/`;
const PATTERNS: Record<string, RegExp[]> = {
  '.html': [
    new RegExp(String.raw`<(?:script|img)\b[^>]*\bsrc\s*=\s*['"]${OTHER_ORIGIN}`, 'gi'),
    new RegExp(String.raw`<link\b[^>]*\bhref\s*=\s*['"]${OTHER_ORIGIN}`, 'gi'),
  ],
  '.css': [
    new RegExp(String.raw`@import\s+(?:url\()?\s*['"]?${OTHER_ORIGIN}`, 'gi'),
    new RegExp(String.raw`url\(\s*['"]?${OTHER_ORIGIN}`, 'gi'),
  ],
  '.ts': [new RegExp(String.raw`\b(?:fetch|import|importScripts|new\s+URL|new\s+Worker)\s*\(\s*['"\x60]${OTHER_ORIGIN}`, 'g')],
};

export function findCrossOriginSubresources(files: readonly Pick<ScannedFile, 'path' | 'raw' | 'codeKeepStrings'>[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    const patterns = PATTERNS[extname(f.path)];
    if (!patterns) continue;
    const lines = new Set<number>();
    for (const re of patterns) for (const m of f.codeKeepStrings.matchAll(re)) lines.add(lineAt(f.codeKeepStrings, m.index));
    for (const line of [...lines].sort((a, b) => a - b)) {
      out.push({ file: f.path, line, rule: 'cross-origin-subresource', message: 'COEP require-corp forbids loading from other origins' });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run --project arch test/arch/headers.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add vercel.json test/arch/rules/headers.ts test/arch/headers.test.ts
git commit -m "test(arch): COOP/COEP parity between Vite and Vercel; no cross-origin subresources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CI governance check

**Files:**
- Create: `test/harness/governance.ts`, `test/unit/governance.test.ts`, `test/arch/governance.test.ts`

**Interfaces:**
- Consumes: `GoldensFile` (Task 5).
- Produces:
  - `interface GovernanceInput { baseGoldens: GoldensFile | null; headGoldens: GoldensFile; baseVersion: number | null; headVersion: number; changedFiles: readonly string[] }`
  - `checkGovernance(input: GovernanceInput): string[]`
  - `parseGeneratorVersion(source: string): number | null`

- [ ] **Step 1: Write the failing unit test**

`test/unit/governance.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { checkGovernance, parseGeneratorVersion, type GovernanceInput } from '../harness/governance';

const base: GovernanceInput = {
  baseGoldens: { generatorVersion: 1, entries: { a: '1', b: '2' } },
  headGoldens: { generatorVersion: 1, entries: { a: '1', b: '2' } },
  baseVersion: 1,
  headVersion: 1,
  changedFiles: [],
};

describe('checkGovernance', () => {
  test('unchanged goldens and lock pass; new golden keys need no bump', () => {
    expect(checkGovernance(base)).toEqual([]);
    expect(checkGovernance({ ...base, headGoldens: { generatorVersion: 1, entries: { a: '1', b: '2', c: '3' } } })).toEqual([]);
  });

  test('a changed or removed golden without a version bump fails (hand edits included)', () => {
    const edited = { ...base, headGoldens: { generatorVersion: 1, entries: { a: 'x' } } };
    expect(checkGovernance(edited)).toEqual(['goldens changed or removed without a GENERATOR_VERSION bump: a, b']);
    expect(checkGovernance({ ...edited, headVersion: 2 })).toEqual([]);
  });

  test('a lock change needs a spec change in the same range', () => {
    const lockOnly = { ...base, changedFiles: ['test/thresholds.lock.json', 'test/thresholds.ts'] };
    expect(checkGovernance(lockOnly)).toEqual(['test/thresholds.lock.json changed without a change under docs/superpowers/specs/']);
    expect(checkGovernance({ ...lockOnly, changedFiles: [...lockOnly.changedFiles, 'docs/superpowers/specs/2026-10-01-sp1-x-design.md'] })).toEqual([]);
  });

  test('no goldens at the base ref means nothing to protect yet', () => {
    expect(checkGovernance({ ...base, baseGoldens: null, baseVersion: null })).toEqual([]);
  });
});

test('parseGeneratorVersion reads the constant', () => {
  expect(parseGeneratorVersion('export const GENERATOR_VERSION = 12;')).toBe(12);
  expect(parseGeneratorVersion('nothing')).toBeNull();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit test/unit/governance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `test/harness/governance.ts`**

```ts
import type { GoldensFile } from './goldens';

export interface GovernanceInput {
  baseGoldens: GoldensFile | null;
  headGoldens: GoldensFile;
  baseVersion: number | null;
  headVersion: number;
  changedFiles: readonly string[];
}

export function parseGeneratorVersion(source: string): number | null {
  const m = /GENERATOR_VERSION\s*=\s*(\d+)/.exec(source);
  return m ? Number(m[1]) : null;
}

export function checkGovernance(input: GovernanceInput): string[] {
  const errors: string[] = [];
  if (input.baseGoldens) {
    const changed = Object.entries(input.baseGoldens.entries)
      .filter(([k, h]) => input.headGoldens.entries[k] !== h)
      .map(([k]) => k)
      .sort();
    const bumped = input.baseVersion !== null && input.headVersion > input.baseVersion;
    if (changed.length > 0 && !bumped) errors.push(`goldens changed or removed without a GENERATOR_VERSION bump: ${changed.join(', ')}`);
  }
  if (input.changedFiles.includes('test/thresholds.lock.json') && !input.changedFiles.some((f) => f.startsWith('docs/superpowers/specs/'))) {
    errors.push('test/thresholds.lock.json changed without a change under docs/superpowers/specs/');
  }
  return errors;
}
```

- [ ] **Step 4: Write the CI-only arch test**

`test/arch/governance.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { GoldensFile } from '../harness/goldens';
import { checkGovernance, parseGeneratorVersion } from '../harness/governance';
import { ROOT } from './scan';

const BASE = process.env.GOVERNANCE_BASE ?? '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const showAtBase = (path: string): string | null => {
  try { return git('show', `${BASE}:${path}`); } catch { return null; }
};

test.skipIf(BASE === '' || /^0+$/.test(BASE))('goldens and threshold lock changes follow governance (CI, against GOVERNANCE_BASE)', () => {
  const baseGoldensText = showAtBase('test/goldens.json');
  const baseConstants = showAtBase('src/core/constants.ts');
  const errors = checkGovernance({
    baseGoldens: baseGoldensText ? (JSON.parse(baseGoldensText) as GoldensFile) : null,
    headGoldens: JSON.parse(readFileSync(join(ROOT, 'test/goldens.json'), 'utf8')) as GoldensFile,
    baseVersion: baseConstants ? parseGeneratorVersion(baseConstants) : null,
    headVersion: parseGeneratorVersion(readFileSync(join(ROOT, 'src/core/constants.ts'), 'utf8')) ?? 0,
    changedFiles: git('diff', '--name-only', BASE, 'HEAD').split('\n').filter((f) => f.length > 0),
  });
  expect(errors).toEqual([]);
});
```

- [ ] **Step 5: Run the tests (including the CI path locally)**

```bash
npx vitest run --project unit test/unit/governance.test.ts
npx vitest run --project arch test/arch/governance.test.ts
GOVERNANCE_BASE=$(git rev-parse main) npx vitest run --project arch test/arch/governance.test.ts
```
Expected: unit PASS; without the env var the arch test is SKIPPED; with `GOVERNANCE_BASE=main` it FAILS with `test/thresholds.lock.json changed without a change under docs/superpowers/specs/`. That is the rule working: the branch adds the lock but has not touched the specs yet. Task 16 amends the SP0 spec on this branch and re-runs this command (Task 16 Step 4), where it must PASS. Nothing is pushed before Task 16.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add test/harness/governance.ts test/unit/governance.test.ts test/arch/governance.test.ts
git commit -m "test(governance): CI check for golden bumps and threshold-lock spec amendments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Capability rules

**Files:**
- Create: `src/engine/capabilityRules.ts`, `test/unit/capabilityRules.test.ts`

**Interfaces:**
- Produces:
  - `type WorkerProbe = 'ok' | 'not-isolated' | 'load-error' | 'timeout'`
  - `interface CapabilityReport { secureContext: boolean; pageIsolated: boolean; workerProbe: WorkerProbe; workerIsolated: boolean | null; sabShared: boolean; webgl2: boolean; multiDraw: boolean; timerQuery: boolean; maxArrayTextureLayers: number | null; maxTextureSize: number | null; renderer: string | null; vendor: string | null; hardwareConcurrency: number | null; deviceMemory: number | null }`
  - `type CauseCode = 'insecure-context' | 'page-not-isolated' | 'worker-not-isolated' | 'worker-load-error' | 'worker-timeout' | 'sab-not-shared' | 'no-webgl2' | 'no-multi-draw' | 'no-timer-query'`
  - `interface Cause { code: CauseCode; message: string }`, `interface Evaluation { ok: boolean; blocking: Cause[]; warnings: Cause[] }`
  - `evaluateCapabilities(report: CapabilityReport): Evaluation`

- [ ] **Step 1: Write the failing test**

`test/unit/capabilityRules.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { evaluateCapabilities, type CapabilityReport, type CauseCode } from '../../src/engine/capabilityRules';

const OK: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
  webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
  renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
};

const codes = (r: Partial<CapabilityReport>) => {
  const e = evaluateCapabilities({ ...OK, ...r });
  return { ok: e.ok, blocking: e.blocking.map((c) => c.code), warnings: e.warnings.map((c) => c.code) };
};

describe('evaluateCapabilities', () => {
  test('everything available → ok, no causes', () => {
    expect(codes({})).toEqual({ ok: true, blocking: [], warnings: [] });
  });

  test('insecure LAN access: secure context is named first', () => {
    const r = codes({ secureContext: false, pageIsolated: false, workerProbe: 'not-isolated', workerIsolated: false, sabShared: false });
    expect(r.ok).toBe(false);
    expect(r.blocking).toEqual<CauseCode[]>(['insecure-context', 'page-not-isolated', 'worker-not-isolated', 'sab-not-shared']);
    expect(evaluateCapabilities({ ...OK, secureContext: false }).blocking[0]!.message).toMatch(/http:\/\/localhost:<port> or HTTPS/);
  });

  test('a worker that fails to load is not reported as missing headers', () => {
    expect(codes({ workerProbe: 'load-error', workerIsolated: null, sabShared: false }).blocking).toEqual(['worker-load-error', 'sab-not-shared']);
  });

  test('a worker that does not answer is reported as a timeout', () => {
    const e = evaluateCapabilities({ ...OK, workerProbe: 'timeout', workerIsolated: null, sabShared: false });
    expect(e.blocking.map((c) => c.code)).toEqual(['worker-timeout', 'sab-not-shared']);
    expect(e.blocking[0]!.message).toMatch(/5 s/);
  });

  test('worker without headers', () => {
    expect(codes({ workerProbe: 'not-isolated', workerIsolated: false, sabShared: false }).blocking).toEqual(['worker-not-isolated', 'sab-not-shared']);
  });

  test('no WebGL2 blocks; missing extensions only warn', () => {
    expect(codes({ webgl2: false, multiDraw: false, timerQuery: false })).toEqual({ ok: false, blocking: ['no-webgl2'], warnings: [] });
    expect(codes({ multiDraw: false, timerQuery: false })).toEqual({ ok: true, blocking: [], warnings: ['no-multi-draw', 'no-timer-query'] });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit test/unit/capabilityRules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/engine/capabilityRules.ts`**

```ts
export type WorkerProbe = 'ok' | 'not-isolated' | 'load-error' | 'timeout';

export interface CapabilityReport {
  secureContext: boolean;
  pageIsolated: boolean;
  workerProbe: WorkerProbe;
  /** null unless the worker replied. */
  workerIsolated: boolean | null;
  sabShared: boolean;
  webgl2: boolean;
  multiDraw: boolean;
  timerQuery: boolean;
  maxArrayTextureLayers: number | null;
  maxTextureSize: number | null;
  renderer: string | null;
  vendor: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
}

export type CauseCode =
  | 'insecure-context' | 'page-not-isolated' | 'worker-not-isolated' | 'worker-load-error' | 'worker-timeout'
  | 'sab-not-shared' | 'no-webgl2' | 'no-multi-draw' | 'no-timer-query';

export interface Cause {
  code: CauseCode;
  message: string;
}

export interface Evaluation {
  ok: boolean;
  blocking: Cause[];
  warnings: Cause[];
}

const MESSAGES: Record<CauseCode, string> = {
  'insecure-context': 'Not a secure context: open the app via http://localhost:<port> or HTTPS.',
  'page-not-isolated': 'The page is not cross-origin isolated: the COOP/COEP headers are missing on the page.',
  'worker-not-isolated': 'Worker scripts are missing the COOP/COEP headers.',
  'worker-load-error': 'The worker script failed to load (see the browser console).',
  'worker-timeout': 'The worker did not answer within 5 s.',
  'sab-not-shared': 'SharedArrayBuffer is not shared between the page and its workers.',
  'no-webgl2': 'WebGL2 is not available in this browser.',
  'no-multi-draw': 'WEBGL_multi_draw is missing: rendering will use the per-region fallback (SP4).',
  'no-timer-query': 'EXT_disjoint_timer_query_webgl2 is missing: GPU timings are unavailable.',
};

const WORKER_CAUSE: Record<Exclude<WorkerProbe, 'ok'>, CauseCode> = {
  'not-isolated': 'worker-not-isolated',
  'load-error': 'worker-load-error',
  timeout: 'worker-timeout',
};

export function evaluateCapabilities(report: CapabilityReport): Evaluation {
  const blocking: CauseCode[] = [];
  const warnings: CauseCode[] = [];
  if (!report.secureContext) blocking.push('insecure-context');
  if (!report.pageIsolated) blocking.push('page-not-isolated');
  if (report.workerProbe !== 'ok') blocking.push(WORKER_CAUSE[report.workerProbe]);
  if (!report.sabShared) blocking.push('sab-not-shared');
  if (!report.webgl2) blocking.push('no-webgl2');
  else {
    if (!report.multiDraw) warnings.push('no-multi-draw');
    if (!report.timerQuery) warnings.push('no-timer-query');
  }
  const cause = (code: CauseCode): Cause => ({ code, message: MESSAGES[code] });
  return { ok: blocking.length === 0, blocking: blocking.map(cause), warnings: warnings.map(cause) };
}
```

- [ ] **Step 4: Run it to see it pass, and run the arch suite**

Run: `npx vitest run --project unit test/unit/capabilityRules.test.ts && npx vitest run --project arch && npm run typecheck`
Expected: PASS; the repository arch tests still pass with the new `src/engine/` file.

- [ ] **Step 5: Commit**

```bash
git add src/engine/capabilityRules.ts test/unit/capabilityRules.test.ts
git commit -m "feat(engine): capability evaluation with distinct blocking causes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Frame statistics

**Files:**
- Create: `src/ui/frameStats.ts`, `test/unit/frameStats.test.ts`

**Interfaces:**
- Produces:
  - `interface FrameSummary { fps: number; p50: number; p95: number; count: number }`
  - `interface FrameStats { push(frameMs: number): void; summary(): FrameSummary }`
  - `createFrameStats(capacity?: number): FrameStats` (default 120)
  - `nearestRank(sorted: readonly number[], p: number): number`

- [ ] **Step 1: Write the failing test**

`test/unit/frameStats.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { createFrameStats, nearestRank } from '../../src/ui/frameStats';

describe('frameStats', () => {
  test('empty → zeros, never NaN', () => {
    expect(createFrameStats().summary()).toEqual({ fps: 0, p50: 0, p95: 0, count: 0 });
  });

  test('non-finite and negative deltas are ignored', () => {
    const s = createFrameStats();
    s.push(Number.NaN);
    s.push(Number.POSITIVE_INFINITY);
    s.push(-3);
    expect(s.summary().count).toBe(0);
  });

  test('steady 60 Hz', () => {
    const s = createFrameStats();
    for (let i = 0; i < 60; i++) s.push(1000 / 60);
    const r = s.summary();
    expect(r.fps).toBeCloseTo(60, 6);
    expect(r.p50).toBeCloseTo(16.667, 3);
    expect(r.count).toBe(60);
  });

  test('ring buffer keeps only the last `capacity` frames', () => {
    const s = createFrameStats(4);
    for (const ms of [100, 100, 100, 100, 10, 10, 10, 10]) s.push(ms);
    expect(s.summary()).toEqual({ fps: 100, p50: 10, p95: 10, count: 4 });
  });

  test('p95 catches a spike', () => {
    const s = createFrameStats(20);
    for (let i = 0; i < 19; i++) s.push(10);
    s.push(50);
    expect(s.summary().p95).toBe(10);
    s.push(50);
    expect(s.summary().p95).toBe(50);
  });

  test('nearestRank and invalid capacity', () => {
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 3, 4], 0.95)).toBe(4);
    expect(() => createFrameStats(0)).toThrow(/capacity/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit test/unit/frameStats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ui/frameStats.ts`**

```ts
export interface FrameSummary {
  fps: number;
  p50: number;
  p95: number;
  count: number;
}

export interface FrameStats {
  push(frameMs: number): void;
  summary(): FrameSummary;
}

export function nearestRank(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export function createFrameStats(capacity = 120): FrameStats {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`frameStats capacity must be a positive integer (got ${capacity})`);
  const ring = new Float64Array(capacity);
  let next = 0;
  let count = 0;
  return {
    push(frameMs) {
      if (!Number.isFinite(frameMs) || frameMs < 0) return;
      ring[next] = frameMs;
      next = (next + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    summary() {
      if (count === 0) return { fps: 0, p50: 0, p95: 0, count: 0 };
      const sorted = Array.from(ring.subarray(0, count)).sort((a, b) => a - b);
      const mean = sorted.reduce((a, b) => a + b, 0) / count;
      return { fps: mean > 0 ? 1000 / mean : 0, p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95), count };
    },
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run --project unit test/unit/frameStats.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/frameStats.ts test/unit/frameStats.test.ts
git commit -m "feat(ui): frame-time ring buffer with FPS and p50/p95

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The running app — probe, shell, renderer, HUD, report

**Files:**
- Create: `index.html`, `src/main.ts`, `src/engine/capabilities.ts`, `src/render/renderer.ts`, `src/ui/shell.ts`, `src/ui/styles.css`, `src/ui/hud.ts`, `src/ui/capabilityReport.ts`

**Interfaces:**
- Consumes: `CapabilityReport`, `WorkerProbe`, `Evaluation`, `evaluateCapabilities` (Task 12); `createFrameStats`, `FrameStats` (Task 13); `probe.worker.ts` protocol (Task 1).
- Produces: `probeCapabilities(): Promise<CapabilityReport>`; `startSkyRenderer(host: HTMLElement, onFrame: (frameMs: number) => void): SkyRenderer` with `interface SkyRenderer { dispose(): void }`; `interface Shell { toolbar: HTMLElement; canvasHost: HTMLElement; sidePanel: HTMLElement }`, `createShell(root: HTMLElement): Shell`; `mountHud(host: HTMLElement, stats: FrameStats): () => void`; `renderCapabilityReport(panel: HTMLElement, report: CapabilityReport, evaluation: Evaluation): void`; `renderErrorScreen(root: HTMLElement, report: CapabilityReport, evaluation: Evaluation): void`. Both render functions write the report as single-line JSON into `<pre id="capability-json" hidden>`.

This task is DOM code verified by typecheck, the arch suite (it is the first real use of `engine`→worker edges, `render`→three, `main`→css), and a headless-browser check.

- [ ] **Step 1: Write `src/engine/capabilities.ts`**

```ts
import type { CapabilityReport, WorkerProbe } from './capabilityRules';

const WORKER_TIMEOUT_MS = 5000;

interface WorkerResult {
  workerProbe: WorkerProbe;
  workerIsolated: boolean | null;
  sabShared: boolean;
}

function probeWorker(): Promise<WorkerResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/probe.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
      return;
    }
    const sab = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(8) : null;
    const view = sab === null ? null : new Int32Array(sab);
    let done = false;
    const finish = (result: WorkerResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ workerProbe: 'timeout', workerIsolated: null, sabShared: false }), WORKER_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{ isolated: boolean }>) => {
      const isolated = event.data.isolated;
      finish({ workerProbe: isolated ? 'ok' : 'not-isolated', workerIsolated: isolated, sabShared: view !== null && Atomics.load(view, 0) === 42 });
    };
    worker.onerror = () => finish({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
    worker.onmessageerror = () => finish({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
    worker.postMessage({ sab });
  });
}

type GlResult = Pick<CapabilityReport, 'webgl2' | 'multiDraw' | 'timerQuery' | 'maxArrayTextureLayers' | 'maxTextureSize' | 'renderer' | 'vendor'>;

function probeWebgl(): GlResult {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl === null) {
    return { webgl2: false, multiDraw: false, timerQuery: false, maxArrayTextureLayers: null, maxTextureSize: null, renderer: null, vendor: null };
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const result: GlResult = {
    webgl2: true,
    multiDraw: gl.getExtension('WEBGL_multi_draw') !== null,
    timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return result;
}

export async function probeCapabilities(): Promise<CapabilityReport> {
  const worker = await probeWorker();
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    secureContext: isSecureContext,
    pageIsolated: crossOriginIsolated,
    ...worker,
    ...probeWebgl(),
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
  };
}
```

- [ ] **Step 2: Write `src/render/renderer.ts`**

```ts
import { Color, SRGBColorSpace, WebGLRenderer } from 'three';

const SKY = 0x87b8e8;

export interface SkyRenderer {
  dispose(): void;
}

export function startSkyRenderer(host: HTMLElement, onFrame: (frameMs: number) => void): SkyRenderer {
  const renderer = new WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color(SKY), 1);
  host.appendChild(renderer.domElement);

  const resize = () => renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  let last = performance.now();
  let raf = 0;
  const loop = (now: number) => {
    onFrame(now - last);
    last = now;
    renderer.clear();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
```

- [ ] **Step 3: Write the UI modules**

`src/ui/shell.ts`:
```ts
export interface Shell {
  toolbar: HTMLElement;
  canvasHost: HTMLElement;
  sidePanel: HTMLElement;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function createShell(root: HTMLElement): Shell {
  const shell = div('shell');
  const toolbar = div('toolbar');
  const title = document.createElement('strong');
  title.textContent = 'world-imaginer-voxel';
  toolbar.append(title);
  const canvasHost = div('canvas-host');
  const sidePanel = div('side-panel');
  shell.append(toolbar, canvasHost, sidePanel);
  root.replaceChildren(shell);
  return { toolbar, canvasHost, sidePanel };
}
```

`src/ui/hud.ts`:
```ts
import type { FrameStats } from './frameStats';

const REFRESH_MS = 250;

export function mountHud(host: HTMLElement, stats: FrameStats): () => void {
  const span = document.createElement('span');
  span.className = 'hud';
  host.append(span);
  const id = setInterval(() => {
    const s = stats.summary();
    span.textContent = `${s.fps.toFixed(0)} fps · p50 ${s.p50.toFixed(1)} ms · p95 ${s.p95.toFixed(1)} ms`;
  }, REFRESH_MS);
  return () => clearInterval(id);
}
```

`src/ui/capabilityReport.ts`:
```ts
import type { CapabilityReport, Cause, Evaluation } from '../engine/capabilityRules';

const ROWS: ReadonlyArray<[keyof CapabilityReport, string]> = [
  ['secureContext', 'Secure context'],
  ['pageIsolated', 'Page cross-origin isolated'],
  ['workerProbe', 'Worker probe'],
  ['workerIsolated', 'Worker cross-origin isolated'],
  ['sabShared', 'SharedArrayBuffer shared'],
  ['webgl2', 'WebGL2'],
  ['multiDraw', 'WEBGL_multi_draw'],
  ['timerQuery', 'GPU timer query'],
  ['maxArrayTextureLayers', 'Max array texture layers'],
  ['maxTextureSize', 'Max texture size'],
  ['renderer', 'GPU renderer'],
  ['vendor', 'GPU vendor'],
  ['hardwareConcurrency', 'Logical CPUs'],
  ['deviceMemory', 'Device memory (GB)'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function valueClass(value: CapabilityReport[keyof CapabilityReport]): string {
  if (value === true || value === 'ok') return 'ok';
  if (value === false || value === 'not-isolated' || value === 'load-error' || value === 'timeout') return 'bad';
  return '';
}

function jsonBlock(report: CapabilityReport): HTMLPreElement {
  const pre = el('pre', JSON.stringify(report));
  pre.id = 'capability-json';
  pre.hidden = true;
  return pre;
}

function causeList(causes: readonly Cause[], className: string): HTMLUListElement {
  const ul = el('ul');
  for (const c of causes) ul.append(el('li', c.message, className));
  return ul;
}

export function renderCapabilityReport(panel: HTMLElement, report: CapabilityReport, evaluation: Evaluation): void {
  const table = el('table', undefined, 'cap-table');
  for (const [key, label] of ROWS) {
    const value = report[key];
    const row = el('tr');
    row.append(el('td', label), el('td', value === null ? '—' : String(value), valueClass(value)));
    table.append(row);
  }
  const copy = el('button', 'Copy as JSON');
  copy.type = 'button';
  copy.onclick = () => { void navigator.clipboard.writeText(JSON.stringify(report, null, 2)); };
  panel.replaceChildren(el('h2', 'Capabilities'), table);
  if (evaluation.warnings.length > 0) panel.append(el('h3', 'Warnings'), causeList(evaluation.warnings, 'warn'));
  panel.append(copy, jsonBlock(report));
}

export function renderErrorScreen(root: HTMLElement, report: CapabilityReport, evaluation: Evaluation): void {
  const screen = el('div', undefined, 'error-screen');
  screen.append(
    el('h1', 'world-imaginer-voxel cannot start'),
    causeList(evaluation.blocking, 'bad'),
    el('p', 'Fix the causes above and reload. Full report:'),
    el('pre', JSON.stringify(report, null, 2)),
    jsonBlock(report),
  );
  root.replaceChildren(screen);
}
```

`src/ui/styles.css`:
```css
:root { color-scheme: dark; --panel: #16213e; --line: #2a3558; --text: #e0e0e0; }
* { box-sizing: border-box; margin: 0; }
html, body, #app { height: 100%; }
body { background: #0f1629; color: var(--text); font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
.shell {
  display: grid; height: 100%;
  grid-template-columns: 1fr minmax(260px, 22rem);
  grid-template-rows: auto 1fr;
  grid-template-areas: "toolbar toolbar" "canvas panel";
}
.toolbar { grid-area: toolbar; display: flex; gap: 1rem; align-items: center; padding: .4rem .8rem; background: var(--panel); border-bottom: 1px solid var(--line); }
.canvas-host { grid-area: canvas; position: relative; min-width: 0; min-height: 0; }
.canvas-host canvas { display: block; width: 100%; height: 100%; }
.side-panel { grid-area: panel; overflow: auto; padding: .8rem; background: var(--panel); border-left: 1px solid var(--line); display: grid; gap: .6rem; align-content: start; }
.hud { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .85; }
.cap-table { width: 100%; border-collapse: collapse; }
.cap-table td { padding: 2px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
.ok { color: #7bd88f; } .bad { color: #ff6b6b; } .warn { color: #ffd166; }
.error-screen { display: grid; gap: 1rem; align-content: center; height: 100%; max-width: 48rem; margin: 0 auto; padding: 2rem; overflow: auto; }
.error-screen pre { white-space: pre-wrap; background: var(--panel); padding: .8rem; border-radius: 4px; }
@media (max-width: 720px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; grid-template-areas: "toolbar" "canvas" "panel"; }
  .side-panel { max-height: 40vh; border-left: 0; border-top: 1px solid var(--line); }
}
```

- [ ] **Step 4: Write `src/main.ts` and `index.html`**

`src/main.ts`:
```ts
import './ui/styles.css';
import { probeCapabilities } from './engine/capabilities';
import { evaluateCapabilities } from './engine/capabilityRules';
import { startSkyRenderer } from './render/renderer';
import { renderCapabilityReport, renderErrorScreen } from './ui/capabilityReport';
import { createFrameStats } from './ui/frameStats';
import { mountHud } from './ui/hud';
import { createShell } from './ui/shell';

async function boot(root: HTMLElement): Promise<void> {
  const report = await probeCapabilities();
  const evaluation = evaluateCapabilities(report);
  if (!evaluation.ok) {
    renderErrorScreen(root, report, evaluation);
    return;
  }
  const shell = createShell(root);
  renderCapabilityReport(shell.sidePanel, report, evaluation);
  const stats = createFrameStats();
  mountHud(shell.toolbar, stats);
  startSkyRenderer(shell.canvasHost, (ms) => stats.push(ms));
}

const root = document.getElementById('app');
if (root === null) throw new Error('#app element missing from index.html');
boot(root).catch((error: unknown) => {
  const pre = document.createElement('pre');
  pre.textContent = `Boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  root.replaceChildren(pre);
});
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>world-imaginer-voxel</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Typecheck, arch suite, build**

Run: `npm run typecheck && npx vitest run --project arch && npm run build`
Expected: all exit 0; `dist/assets/` contains an `index-*.js` and a `probe.worker-*.js`; no chunk-size warning.

- [ ] **Step 6: Verify headers and the probe in a real browser (dev)**

```bash
npm run dev > /tmp/wiv-dev.log 2>&1 &
DEV=$!; sleep 3
curl -sI http://localhost:5183/ | grep -i cross-origin
curl -s http://localhost:5183/src/engine/capabilities.ts | grep -o '/src/workers/probe.worker.ts[^"]*'
curl -sI "http://localhost:5183/src/workers/probe.worker.ts?worker_file&type=module" | grep -i cross-origin
google-chrome --headless=new --virtual-time-budget=10000 --dump-dom http://localhost:5183/ | grep -o '<pre id="capability-json" hidden="">[^<]*'
kill $DEV
```
Expected: both COOP/COEP headers on `/` and on the worker URL; the dumped JSON contains `"secureContext":true,"pageIsolated":true,"workerProbe":"ok","workerIsolated":true,"sabShared":true` and `"webgl2":true`. (If `google-chrome` is not installed, use `chromium`; if neither exists, open http://localhost:5183 manually and check the side panel.)

- [ ] **Step 7: Same check on the production build (preview)**

```bash
npm run preview > /tmp/wiv-preview.log 2>&1 &
PREV=$!; sleep 3
curl -sI http://localhost:5183/ | grep -i cross-origin
curl -sI "http://localhost:5183/assets/$(ls dist/assets | grep probe.worker)" | grep -i cross-origin
google-chrome --headless=new --virtual-time-budget=10000 --dump-dom http://localhost:5183/ | grep -o '"sabShared":true'
kill $PREV
```
Expected: both headers on the page and on the built worker asset (two pairs of lines); `"sabShared":true`.

- [ ] **Step 8: Commit**

```bash
git add index.html src
git commit -m "feat(ui): capability probe, CSS-grid shell, sky renderer and HUD

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Delivery rails — Docker and CI

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: npm scripts (Task 1), `GOVERNANCE_BASE` contract (Task 11).

- [ ] **Step 1: Write the Docker files**

`Dockerfile`:
```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5183
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5183"]
```

`.dockerignore`:
```
node_modules
dist
.git
test/.cache
```

`docker-compose.yml`:
```yaml
services:
  world-imaginer-voxel:
    build:
      context: .
    container_name: world_imaginer_voxel
    ports:
      - "5183:5183"
    environment:
      - VITE_ALLOWED_HOSTS=${VITE_ALLOWED_HOSTS:-}
    volumes:
      - .:/app
      - world_imaginer_voxel_modules:/app/node_modules
    networks:
      - app-network

networks:
  app-network:
    external: true
    name: maestre-web_app-network

volumes:
  world_imaginer_voxel_modules:
```

- [ ] **Step 2: Verify Docker (skip with a note if Docker is unavailable)**

```bash
docker compose config --quiet && echo compose-ok
docker network inspect maestre-web_app-network >/dev/null 2>&1 || echo "network missing: create it or skip the run"
docker compose up -d --build world-imaginer-voxel && sleep 8
curl -sI http://localhost:5183/ | grep -i cross-origin
docker compose down
```
Expected: `compose-ok`; both headers returned from the container via localhost. The arch banned test's audio walk also runs without git inside the container (not exercised here).

- [ ] **Step 3: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
        env:
          GOVERNANCE_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
      - run: npm run test:metrics
```

- [ ] **Step 4: Validate the workflow file locally**

Run: `node -e "const t=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); for (const k of ['actions/checkout@v7','actions/setup-node@v7','node-version-file: .nvmrc','GOVERNANCE_BASE','fetch-depth: 0']) if(!t.includes(k)) {console.error('missing',k); process.exit(1)} console.log('ci.yml ok')"`
Expected: `ci.yml ok`. (The real validation is the first CI run in Task 16.)

- [ ] **Step 5: Run the whole local suite and commit**

```bash
npm run build && npm test && npm run test:metrics && npm run test:metrics:full && npm run bench
git add Dockerfile .dockerignore docker-compose.yml .github/workflows/ci.yml
git commit -m "ci: GitHub Actions workflow; Docker image and compose service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: every command exits 0.

---

### Task 16: Docs, exit evidence, push and merge

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-26-sp0-scaffold-guardrails-design.md`
- Create: `docs/superpowers/specs/assets/sp0/dev.png`, `docs/superpowers/specs/assets/sp0/preview.png`

- [ ] **Step 1: Record the goldens-merge refinement and the base tsconfig in the SP0 spec**

In the SP0 spec, section "vitest configuration": replace the root config sentence's `globalSetup: ['test/harness/goldensSetup.ts'], ` with nothing, and in "Governance mechanisms → Goldens" replace the `UPDATE_GOLDENS=1` bullet with:
```markdown
- `UPDATE_GOLDENS=1`: every `expectGolden` call writes its observation to `test/.cache/goldens-obs/`; `npm run test:goldens` then runs `MERGE_GOLDENS=1 vitest run --project arch test/arch/goldensMerge.test.ts`, which merges them once: new keys are added; changed existing entries are accepted only if `GENERATOR_VERSION > goldens.generatorVersion`, otherwise the run fails listing every such key and writes nothing; `generatorVersion` is set once, at the end. (A root `globalSetup` was dropped because inline vitest projects inherit it and would run it once per project.)
```
In the layout block remove the line `harness/goldensSetup.ts …` and add `tsconfig.base.json` next to the three tsconfigs with the note "shared compiler options".

- [ ] **Step 2: Update README.md and CLAUDE.md**

In `README.md`, replace the "## Status" section with:
~~~markdown
## Status

SP0 (scaffold, guardrails, CI) is complete: the app shows a sky canvas and a capability report; SP1 (deterministic math core) is next.

## Development

```bash
npm install
npm run dev            # http://localhost:5183 (must be localhost or HTTPS)
npm run build          # typecheck + production build
npm test               # unit + arch + fast metrics
npm run test:metrics   # quick metric tier (CI)
docker compose up world-imaginer-voxel
```
~~~

In `CLAUDE.md`, replace the Status line with `**Status:** SP0 complete (scaffold, guardrails, CI). SP1 is next.` and replace the whole "## Commands" section with:
```markdown
## Commands

- `npm run dev` / `npm run preview` — http://localhost:5183 (COOP/COEP headers; open via localhost or HTTPS)
- `npm run build` — `typecheck` (three tsconfigs) + `vite build`
- `npm test` — vitest projects `unit`, `arch`, `metrics-fast`; `npm run test:metrics` (quick, CI), `npm run test:metrics:full` (SP exit), `npm run bench`
- `npm run test:accept-thresholds` — rewrite `test/thresholds.lock.json` (needs a spec amendment in the same change; CI checks it)
- `npm run test:goldens` — record and merge goldens (refuses changed goldens without a `GENERATOR_VERSION` bump)
- `docker compose up world-imaginer-voxel`
- Each sub-project appends its id to `STARTED_SPS` in `test/harness/sp.ts` in its first commit.
```
and change the Conventions dev-dependency list to `vite`, `typescript`, `vitest`, `@types/three`, `@types/node`.

- [ ] **Step 3: Capture the visual-review screenshots**

```bash
mkdir -p docs/superpowers/specs/assets/sp0
npm run dev > /tmp/wiv-dev.log 2>&1 & DEV=$!; sleep 3
google-chrome --headless=new --window-size=1600,900 --virtual-time-budget=10000 --screenshot=docs/superpowers/specs/assets/sp0/dev.png http://localhost:5183/
kill $DEV
npm run build
npm run preview > /tmp/wiv-preview.log 2>&1 & PREV=$!; sleep 3
google-chrome --headless=new --window-size=1600,900 --virtual-time-budget=10000 --screenshot=docs/superpowers/specs/assets/sp0/preview.png http://localhost:5183/
kill $PREV
```
Expected: two PNGs showing the toolbar with HUD, the sky canvas and the capability side panel with green values. Look at both images before committing.

- [ ] **Step 4: Final local verification**

Run: `npm run build && npm test && npm run test:metrics && npm run test:metrics:full && npm run bench && GOVERNANCE_BASE=$(git rev-parse main) npx vitest run --project arch test/arch/governance.test.ts`
Expected: all exit 0 (the governance run now passes because the branch changes `docs/superpowers/specs/` together with the new lock).

- [ ] **Step 5: Commit, push the branch and check CI**

```bash
git add README.md CLAUDE.md docs/superpowers/specs
git commit -m "docs(spec): SP0 complete — commands, goldens merge note, screenshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin sp0/scaffold
sleep 90
curl -s "https://api.github.com/repos/MaestreDniel/world-imaginer-voxel/actions/runs?branch=sp0/scaffold&per_page=1" | grep -E '"(status|conclusion)"'
```
Expected: `"status": "completed"` and `"conclusion": "success"` (re-run the curl until completed). If it fails, open the run's logs at https://github.com/MaestreDniel/world-imaginer-voxel/actions and fix before continuing.

- [ ] **Step 6: Fast-forward main and confirm CI on main**

```bash
git checkout main
git merge --ff-only sp0/scaffold
git push origin main
sleep 90
curl -s "https://api.github.com/repos/MaestreDniel/world-imaginer-voxel/actions/runs?branch=main&per_page=1" | grep -E '"(status|conclusion)"'
```
Expected: CI `success` on `main` (exit criterion "CI green on main").

- [ ] **Step 7: Hand off the manual checks to the user**

Report to the user, with the screenshots:
- Vercel: link the project to the repository root, deploy a preview, open it and confirm the side panel shows `secureContext`, `pageIsolated`, `workerIsolated`, `sabShared` all `true` (cut line: may slip to SP4).
- Docker: `docker compose up world-imaginer-voxel` and the same check at http://localhost:5183 if Task 15 Step 2 was skipped.

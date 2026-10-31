/**
 * The master spec's sub-project list agrees with the code (SP3a spec §11: the master §2.5 and §10 amendments): the
 * `SubProjectId` type of §2.5 lists `SUB_PROJECTS` in order, §10 has one header per sub-project in that order whose
 * parenthetical names every dependency `SP_DEPS` transcribes from it, and the critical path is a dependency chain.
 * SP3b (its spec §14): §2.5's store interfaces name every method of `world/store/api.ts`, and §3.6's default
 * expression states the density noises and amplitudes of the schema defaults, so a retune must amend the master.
 * SP3c (its spec §12): §1's `metrics/*.ts` entry names every golden-digest module of `src/metrics/`, and "Banned APIs"
 * lists exactly the determinism files (`DET_FILES`) of `test/arch/rules/banned.ts`; §1's `gen/surface/` entry names
 * every module of `src/gen/surface/` and its `test/` entry SP3c's test files; §2.2 lists the terrain palette in registry
 * order; §3.10 and §3.11 state the `surface.*` defaults they name (lapse, snowline, cliffs), so a retune must amend the
 * master; §10's SP3c entry names its spec and no longer defers its deliverable, exit and cut line to it.
 * SP3d (its spec §12): §10's SP3d entry names its spec and no longer defers its deliverable, exit and cut line to it;
 * §1's `test/` entry names SP3d's test files, which exist (it lands with the last of them, `harness/treeMutator.ts`);
 * §1's `ui/inspector/*` entry names every module of the Density tab, and the reserved top-level `sliceView.ts`,
 * `probe.ts` and `jsonEditor.ts` are dropped (it lands with the last of them, `sliceView.ts`); §7's inspector slice line
 * names the three slice bench rows that gate it, which `BENCH_ROWS` measures, and no longer promises the 256² refinement
 * (it lands with the rows). The exit commit: §10's SP10 entry no longer lists the inspector mutes and pins, the density and
 * surface-rule JSON editors or the 128² slice target, which SP3d delivered; since the pins were built (`PIN_MAX` exists),
 * the SP3d entry's cut line says it was not taken, the cut-line receivers say nothing moved and §5.5 no longer sends them
 * to SP10.
 * SP3e (its spec §11, §13): §10's SP3e entry names its spec and no longer defers its deliverable, exit and cut line to it
 * (the cut line is the islands' own surface branch, → SP12); it lands with the first commit. §1's `gen/column/` entry
 * names `islands.ts`, and its `core/params/` entry `presetTrees.ts`, which exist (each lands with its file). §6.4's U2
 * row states the leaf count U2 covers (the schema's climate, shape, biome2d and terrain leaves: 73 with
 * `density.noises.islands`), and §3.6 sends the islands term to the SP3e spec §3 (both land with `FLOATING_DENSITY_TREE`).
 * §6.4's B1 row states archipelago's per-profile parts with the minShare floor THRESHOLDS gates, and its DT2 row the
 * presets' parts (`DT2.presets`), which THRESHOLDS lists (both land with `presets.metric.ts`). §1's `metrics/*.ts` entry
 * names `sp3eGoldens.ts` and "Banned APIs" lists it as a determinism file (both land with the window search). §6.4's
 * Z1-Z3 rows state SP3e's definitions and that the rows are recorded from SP3e and gated from SP12 on the quick and full
 * tiers, as THRESHOLDS has them (they land with the Z rows). §7's "Measured in SP3e" line names the `terrain.islands`
 * bench row, which `BENCH_ROWS` measures, and its p50 gate at `TERRAIN_P50_MAX_MS` on cluster columns (it lands with the row).
 * The goldens commit: §1's `metrics/*.ts` entry and "Banned APIs" name `pointDigest.ts`; §1's `test/` entry names SP3e's
 * test files in their own parentheses (it lands with the last of them, `unit/goldens.sp3e.test.ts`); §6.2's goldens line
 * names the `sp3e.*` keys and §10's SP12 says SP3e's drafts are pinned by them.
 * The exit commit (SP3e §12, §13): the cut-line texts are worded by whether the islands surface branch was built
 * (`FLOATING_SURFACE_RULES` exists and is floating_islands' rules): built, the SP3e entry's cut line says it was not taken
 * and the receivers say nothing moved; cut, SP12 receives the branch. §3.15's title names the code SP3e adds and its
 * amplified, archipelago and floating_islands rows state the final constants, read from the preset trees and overlays;
 * SP3e's "Received from SP3a" states amplified's final slide; SP6, SP8b and SP11 carry SP3e's notes (the island-run
 * threshold `ISLAND_RUN_MIN_BOTTOM`, the islands tap's gate and corners read from `FLOATING_DENSITY_TREE`); SP12 receives
 * SP3e's §12 list with Z2's islands part at its measured value (the committed after set's `Z2.json`), and the continental
 * profile stays with SP12.
 * SP4a (its spec §9.3, §12): §7's "Measured in SP4a" line names the `light.column` and `mesh.section` bench rows, which
 * `BENCH_ROWS` measures, with their absolute gates (`LIGHT_P50_MAX_MS` … `MESH_P99_MAX_MS`); it lands with the rows.
 * The exit commit (SP4a §12, §14): §1 lists SP4a's new modules on its entries' list lines (not only in their prose),
 * which exist, and its `test/` entry SP4a's test files in their own parentheses (it lands with the last of them,
 * `tools/measureChrome.ts`'s cells); the panoramas were built (`public/panoramas/manifest.json` lists all six), so the
 * SP4a entry's cut line says it was not taken and the receivers say nothing moved; and a bare `SP4` is left only in the
 * §10 split paragraphs and the parallelism line, where spec §14's own wording keeps it.
 * SP4b (its spec §13): the split; §1's `ci.yml` line names the unit shards (it lands with `unitShards.mjs`); §1 names each
 * SP4b module in its entry, which exists (`SP4B_MODULES`, a row added by each task that adds a module); the engine entry
 * marks `scheduler.ts` as not created; §4.3 states the four heaps and the throttle's cap and display-tied thresholds.
 * R7's commit (SP4b §8.1-§8.2, §13): §6.4's R7 row names `partialColumnFrames` and its flight and Apply parts, which
 * `THRESHOLDS` holds; §1's `test/` entry lists SP4b's test files in their own parentheses, which exist.
 * The bench route's commit (SP4b §8.3, §13): §5.8's bench route is `?bench=medium`'s 95 s script; §1's `ui/world/*`
 * entry names `ui/world/bench.ts`.
 * G1's streaming commit (SP4b §8.2, §8.4, §13): §6.4's G1 row names the six streaming parts, which `THRESHOLDS` holds
 * activeFrom SP4b, and the RTX check at the exit; no "first playable" is left in §4.18, §6.4, §7 or §8.
 * SP4c (its spec §10, §12): the first commit moves the SP4c header pin here (L, with its spec) with §10's SP4c entry,
 * SP5's walk-mode teleport and saved places and SP10's map layers without bookmarks; §1 names each SP4c module in its
 * entry, which exists (`SP4C_MODULES`, a row added by each task that adds a module). R7's Apply commit (SP4c §8.1-§8.2,
 * §12): §6.4's R7 row names `applyPartialColumnFrames` and `mixedEpochFrames`, which `THRESHOLDS` holds activeFrom SP4c
 * beside SP4b's `partialColumnFrames` (SP4b's R7 pin moved into the SP4c block).
 * The SP4c-complete commit (the commit after SP4c's exit commit; SP4c §13, §14): the cut-line texts are worded by
 * the decision taken at the exit: the map's regeneration readout was built (`mapOverlay.ts` writes "Regenerating n /
 * needed"), so it did not move; the climate-grid cache was not built (no module under `src/` names a climate grid) and moved to SP10, which receives it
 * in a "Received from SP4c" line and its exit; §1's `ci.yml` line names the metrics-fast shards (`fastShards.mjs`).
 * SP5a (its spec §8, §9): the first commit lands the split (the §10 paragraph and the SP5a, SP5b and SP5c entries in
 * place of SP5's) with its other §9 amendments (SP6, SP7, SP8a and SP8c, the receivers, the critical path, SP10's and
 * SP8b's "Received from SP5a", §0.7, §2.5's `setLight`, §3.7), and moves the pins that read the SP5 entry here (SP5a's
 * walk-mode teleport, SP5b's saved places, the SP4b cut line's conditional); the pins of §3.7, §4.1, §5.1, §5.6 and
 * risk 1 take §9's rewordings in place. §1 names each SP5a module in its entry, which exists (`SP5A_MODULES`, a row
 * added by each task that adds a module); §6.4's E1-E6 row gives edit→unload→reload's session part to SP5a and its
 * flush part to SP5b (the L3 and E5 commit); §1's test entry names `metrics/edit.metric.ts` and
 * `integration/edit.test.ts`. At the exit (SP5a §8), a bare `SP5` is left only in the §10 split paragraph and the
 * pinned historical receivers (the default receivers' deferred-reclamation primitive and SP4b's cut line); §4.13's
 * read-through passes the D job's diff cloned with the decorate message; and the cut-line texts are worded by the
 * decision taken: palette search was built (`palette.ts` filters its groups by the search box), so SP5a's cut line was
 * not taken and nothing moved to SP10.
 * SP5b (its spec §8, §9, §11): the first commit lands §10's SP5b entry (its size L and spec, the Settings screen, the
 * exit and the cut line), the default receivers' worlds-menu polish, SP10's "Received from SP5b", SP8c's Audio tab,
 * SP11's Graphics tab and SP5c's clipboard storage, and moves the SP5a block's pins that read the SP5b entry and the
 * receivers here; the other §9 amendments land with what they describe, each moving the earlier pin it rewords. The
 * exit words risk 1's Kill line by what SP5b met: its window closed, with no isolation or concurrency problem unfixed.
 * §1 names each SP5b module in its entry, which exists (`SP5B_MODULES`, a row added by each task that adds a module).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SUB_PROJECTS, type SubProjectId } from '../../src/core/ids';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { DEFAULTS } from '../../src/core/params/defaults';
import * as presetTrees from '../../src/core/params/presetTrees';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { PIN_MAX } from '../../src/ui/inspector/sliceModel';
import { REGISTRY } from '../../src/world/blocks';
import { BENCH_ROWS, LIGHT_P50_MAX_MS, LIGHT_P99_MAX_MS, MESH_P50_MAX_MS, MESH_P99_MAX_MS, TERRAIN_P50_MAX_MS } from '../bench/gates';
import { THRESHOLDS } from '../thresholds';
import { SP_DEPS } from '../harness/sp';
import { DET_FILES } from './rules/banned';

// Resolved from this file, not the cwd (SP3b spec §7), so the test also runs from another directory.
const MASTER = fileURLToPath(new URL('../../docs/superpowers/specs/2026-09-26-architecture-design.md', import.meta.url));
const text = readFileSync(MASTER, 'utf8');
const API = fileURLToPath(new URL('../../src/world/store/api.ts', import.meta.url));
const METRICS = fileURLToPath(new URL('../../src/metrics/', import.meta.url));
const SURFACE = fileURLToPath(new URL('../../src/gen/surface/', import.meta.url));
const INSPECTOR = fileURLToPath(new URL('../../src/ui/inspector/', import.meta.url));
const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
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

/** The method names declared in `interface <name> { … }` (up to its first closing brace) of a TypeScript source, comments removed. */
function interfaceMethods(source: string, name: string): string[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const start = src.search(new RegExp(`interface ${name} \\{`));
  if (start < 0) return [];
  const body = src.slice(src.indexOf('{', start) + 1, src.indexOf('}', start));
  return [...body.matchAll(/\b([a-zA-Z]\w*)\(/g)].map((m) => m[1]!);
}

describe('master spec amendments (SP3b §14)', () => {
  test.each(['ColumnWriter', 'ColumnView', 'NeighborhoodReader', 'ProtoWriter'])('§2.5 %s names every method of world/store/api.ts', (name) => {
    const api = interfaceMethods(readFileSync(API, 'utf8'), name);
    expect(api.length, `no interface ${name} in api.ts`).toBeGreaterThan(0);
    expect(new Set(interfaceMethods(text, name))).toEqual(new Set(api));
  });

  test('§3.6 default expression states the schema defaults of the density noises and amplitudes', () => {
    const d = DEFAULTS.density;
    const jag = /u = noise2\('jag'\) \/ clampSigma \(λ (\d+), (\d+) oct\)/.exec(text);
    expect(jag, "no `u = noise2('jag') / clampSigma (λ …, … oct)` in §3.6").not.toBeNull();
    expect([Number(jag![1]), Number(jag![2])]).toEqual([d.noises.jag.wavelength, d.noises.jag.octaves]);
    const n3 = /N3 = noise\('overhang'\) λ (\d+), λy (\d+), (\d+) oct, persistence ([\d.]+)/.exec(text);
    expect(n3, "no `N3 = noise('overhang') λ …, λy …, … oct, persistence …` in §3.6").not.toBeNull();
    const o = d.noises.overhang;
    expect(n3!.slice(1).map(Number)).toEqual([o.wavelength, o.wavelength / o.yScale, o.octaves, o.persistence]);
    const det = /detail {4}= noise\('detail'\) λ (\d+), (\d+) oct × amp\(E\) ([\d.]+)-([\d.]+)/.exec(text);
    expect(det, "no `detail = noise('detail') λ …, … oct × amp(E) …-…` in §3.6").not.toBeNull();
    expect(det!.slice(1).map(Number)).toEqual([d.noises.detail.wavelength, d.noises.detail.octaves, d.detailAmpLo, d.detailAmpHi]);
  });
});

describe('master spec amendments (SP3c §12)', () => {
  test('§1\'s metrics/*.ts entry names every golden-digest module of src/metrics', () => {
    const lines = text.split('\n');
    const from = lines.findIndex((l) => /^\s+metrics\/\*\.ts\s/.test(l));
    expect(from, 'no `metrics/*.ts` entry in §1').toBeGreaterThanOrEqual(0);
    const to = lines.findIndex((l, i) => i > from && /^\s+workers\//.test(l));
    const entry = lines.slice(from, to).join(' ');
    const goldens = readdirSync(METRICS).filter((f) => /Goldens\.ts$/.test(f)).sort();
    expect(goldens).toContain('sp3cGoldens.ts');
    for (const f of goldens) expect(entry, `§1's metrics entry misses ${f}`).toContain(f);
  });

  test('"Banned APIs" lists exactly the determinism files of test/arch/rules/banned.ts', () => {
    const line = text.split('\n').find((l) => l.includes('(`DET_FILES` in `test/arch/rules/banned.ts`:'));
    expect(line, 'no `DET_FILES` list in "Banned APIs"').toBeDefined();
    const list = line!.slice(line!.indexOf('(`DET_FILES`'), line!.indexOf('):'));
    expect(new Set([...list.matchAll(/`(metrics\/\w+\.ts)`/g)].map((m) => m[1]))).toEqual(new Set(DET_FILES));
  });
});

/** A §1 module-layout entry: its first line (matching `head`) and the continuation lines indented deeper than it. */
function layoutEntry(head: RegExp): string {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => head.test(l));
  if (from < 0) return '';
  const indent = /^\s*/.exec(lines[from]!)![0].length;
  let to = from + 1;
  while (to < lines.length && /^\s*/.exec(lines[to]!)![0].length > indent && lines[to]!.trim() !== '') to++;
  return lines.slice(from, to).join(' ');
}

/** The column where §1's prose continuations start; lines indented less are list lines. */
const PROSE_INDENT = 32;

/**
 * The file tokens of a §1 entry's list lines (SP4a §14): the head line and its deeper lines indented below the prose
 * column, each up to its first gap of two or more spaces, split on spaces. Prose continuation lines are skipped, so a
 * file named only in a description does not count as listed.
 */
function listTokens(head: RegExp): string[] {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => head.test(l));
  if (from < 0) return [];
  const indent = /^\s*/.exec(lines[from]!)![0].length;
  const out: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]!;
    const at = /^\s*/.exec(l)![0].length;
    if (i > from && (at <= indent || l.trim() === '')) break;
    if (i > from && at >= PROSE_INDENT) continue;
    out.push(...l.trim().split(/\s{2,}/)[0]!.split(/\s+/));
  }
  return out;
}

/** A number written in the spec, with its Unicode minus. */
const num = (s: string): number => Number(s.replace('−', '-'));

describe('master spec amendments (SP3c §12, Task 19)', () => {
  test('§1\'s gen/surface entry names every module of src/gen/surface', () => {
    const entry = layoutEntry(/^\s+surface\/rules\.ts\s/);
    expect(entry, 'no `surface/rules.ts …` entry under gen/ in §1').not.toBe('');
    const files = readdirSync(SURFACE).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toContain('pass.ts');
    for (const f of files) expect(entry, `§1's gen/surface entry misses ${f}`).toMatch(new RegExp(`(^|[\\s/])${f.replace('.', '\\.')}(\\s|,|;|\\)|$)`));
  });

  test('§1\'s gen/surface entry names source.ts and no defaults.ts (SP3d spec §12: the default rules are data)', () => {
    const entry = layoutEntry(/^\s+surface\/rules\.ts\s/);
    expect(entry).toMatch(/\ssource\.ts\s/);
    expect(entry, "§1's gen/surface entry still names defaults.ts").not.toMatch(/defaults\.ts/);
    expect(existsSync(`${SURFACE}defaults.ts`), 'src/gen/surface/defaults.ts still exists').toBe(false);
  });

  test('§1\'s test/ entry names SP3c\'s test files, which exist', () => {
    const entry = layoutEntry(/^\s+test\/ unit\/ metrics\//);
    expect(entry, 'no `test/ unit/ metrics/ …` entry in §1').not.toBe('');
    const sp3c = /SP3c: ([^)]*)\)/.exec(entry);
    expect(sp3c, "§1's test/ entry has no `SP3c: …` list").not.toBeNull();
    const named = sp3c![1]!.split(/,\s*/).map((f) => f.trim());
    expect(named).toEqual([
      'harness/surfaceFuzz.ts', 'harness/surfaceScatter.ts', 'harness/surfaceScatterWorker.ts', 'metrics/surface.metric.ts',
      'fixtures/sp3c-default-rules.json',
    ]);
    for (const f of named) expect(existsSync(`${ROOT_DIR}test/${f}`), `test/${f} does not exist`).toBe(true);
  });

  test('§2.2 lists the terrain palette in registry order (state ids 3 … 24)', () => {
    const line = text.split('\n').find((l) => l.startsWith('**Terrain palette**'));
    expect(line, 'no `**Terrain palette**` paragraph in §2.2').toBeDefined();
    const list = line!.slice(line!.indexOf('in this order:'), line!.indexOf('.', line!.indexOf('in this order:')));
    const names = [...list.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const expected = Array.from({ length: 22 }, (_, i) => REGISTRY.typeName(3 + i));
    expect(names).toEqual(expected);
  });

  test('§3.10 and §3.11 state the surface schema defaults they name', () => {
    const s = DEFAULTS.surface;
    const lapse = /`surface\.lapse` \(([\d.]+)\) and its base `surface\.lapseBase` \((\d+)\)/.exec(text);
    expect(lapse, 'no "`surface.lapse` (…) and its base `surface.lapseBase` (…)" in §3.10').not.toBeNull();
    expect([num(lapse![1]!), num(lapse![2]!)]).toEqual([s.lapse, s.lapseBase]);
    const cliff = /`steep ≥ surface\.cliffSteep` \(([\d.]+)\) and yTop ≥ `surface\.cliffMinY` \((\d+)\)/.exec(text);
    expect(cliff, 'no "`steep ≥ surface.cliffSteep` (…) and yTop ≥ `surface.cliffMinY` (…)" in §3.11').not.toBeNull();
    expect([num(cliff![1]!), num(cliff![2]!)]).toEqual([s.cliffSteep, s.cliffMinY]);
    const snow = /`T_eff < surface\.snowline` \((−?[\d.]+)\)/.exec(text);
    expect(snow, 'no "`T_eff < surface.snowline` (…)" in §3.11').not.toBeNull();
    expect(num(snow![1]!)).toBe(s.snowline);
  });

  test('§10\'s SP3c entry names its spec and sets its deliverable, exit and cut line', () => {
    const from = text.indexOf('**SP3c — ');
    expect(from, 'no SP3c header in §10').toBeGreaterThanOrEqual(0);
    const entry = text.slice(from, text.indexOf('\n**SP3d — ', from));
    const spec = /Spec: `([^`]+)`/.exec(entry);
    expect(spec, 'the SP3c header names no spec').not.toBeNull();
    expect(existsSync(`${ROOT_DIR}docs/superpowers/specs/${spec![1]}`), `${spec![1]} does not exist`).toBe(true);
    expect(entry).not.toMatch(/set by the SP3c spec/);
    for (const k of ['Deliverable:', 'Exit:', 'Cut line:']) expect(entry, `SP3c misses **${k}**`).toContain(`**${k}**`);
  });
});

describe('master spec amendments (SP3d §12)', () => {
  test('§1\'s test/ entry names SP3d\'s test files, which exist', () => {
    const entry = layoutEntry(/^\s+test\/ unit\/ metrics\//);
    const sp3d = /SP3d: ([^)]*)\)/.exec(entry);
    expect(sp3d, "§1's test/ entry has no `SP3d: …` list").not.toBeNull();
    const named = sp3d![1]!.split(/,\s*/).map((f) => f.trim());
    expect(named).toEqual(['harness/legacyTrees.ts', 'harness/treeMutator.ts', 'fixtures/preset-v1.json', 'fixtures/expected-v1.json']);
    for (const f of named) expect(existsSync(`${ROOT_DIR}test/${f}`), `test/${f} does not exist`).toBe(true);
  });

  test('§10\'s SP3d entry names its spec and sets its deliverable, exit and cut line', () => {
    const from = text.indexOf('**SP3d — ');
    expect(from, 'no SP3d header in §10').toBeGreaterThanOrEqual(0);
    const to = text.indexOf('\n**SP3e — ', from);
    expect(to, 'no SP3e header after SP3d in §10').toBeGreaterThan(from);
    const entry = text.slice(from, to);
    const spec = /Spec: `([^`]+)`/.exec(entry);
    expect(spec, 'the SP3d header names no spec').not.toBeNull();
    expect(spec![1]).toBe('2026-10-09-sp3d-editable-dag-inspector-design.md');
    expect(existsSync(`${ROOT_DIR}docs/superpowers/specs/${spec![1]}`), `${spec![1]} does not exist`).toBe(true);
    expect(entry).not.toMatch(/set by the SP3d spec/);
    for (const k of ['Deliverable:', 'Exit:', 'Cut line:']) expect(entry, `SP3d misses **${k}**`).toContain(`**${k}**`);
  });

  test('§7\'s inspector slice line names the slice bench rows, which BENCH_ROWS measures; the 256² refinement is SP10\'s', () => {
    const line = text.split('\n').find((l) => l.startsWith('- Inspector slice: '));
    expect(line, 'no `- Inspector slice: …` line in §7').toBeDefined();
    expect(line).not.toMatch(/refined to 256²/);
    expect(line).toMatch(/256² refinement is SP10's/);
    const rows: readonly string[] = BENCH_ROWS;
    for (const row of ['slice.vertical128', 'slice.partWorst', 'slice.horizontal128']) {
      expect(line, `§7's inspector slice line does not name ${row}`).toContain(`\`${row}\``);
      expect(rows, `BENCH_ROWS does not measure ${row}`).toContain(row);
    }
  });

  test('§1\'s ui/inspector entry names every module of src/ui/inspector; the reserved top-level sliceView.ts, probe.ts and jsonEditor.ts are dropped', () => {
    const entry = layoutEntry(/^\s+ui\/inspector\/\*\s/);
    expect(entry, 'no `ui/inspector/* …` entry in §1').not.toBe('');
    const files = readdirSync(INSPECTOR).filter((f) => /\.(ts|css)$/.test(f)).sort();
    expect(files).toContain('sliceView.ts');
    expect([...new Set(entry.match(/\b[A-Za-z]+\.(?:ts|css)\b/g))].sort()).toEqual(files);
    const shell = layoutEntry(/^\s+ui\/shell\.ts\s/);
    expect(shell, 'no `ui/shell.ts …` entry in §1').not.toBe('');
    for (const f of ['sliceView.ts', 'probe.ts', 'jsonEditor.ts']) {
      expect(shell, `§1's ui/shell.ts entry still reserves ${f}`).not.toMatch(new RegExp(`(^|\\s)${f.replace('.', '\\.')}(\\s|$)`));
    }
  });
});

/** A §10 entry: from its header to the next sub-project's header. */
function spEntry(id: SubProjectId, next: SubProjectId): string {
  const from = text.indexOf(`**${id} — `);
  expect(from, `no ${id} header in §10`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(`\n**${next} — `, from);
  expect(to, `no ${next} header after ${id} in §10`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('master spec amendments (SP3d §12, exit)', () => {
  test('§10\'s SP10 entry hands over only what SP3d did not deliver', () => {
    const entry = spEntry('SP10', 'SP11');
    expect(entry).not.toMatch(/inspector mutes and pins;/);
    expect(entry).toContain('inspector mutes and pins delivered by SP3d');
    expect(entry).toContain('JSON editors with validation of placed features and structure sets/pools (the density and surface-rule editors are delivered by SP3d)');
    expect(entry).not.toMatch(/inspector slice ≤ 300 ms at 128²/);
    expect(entry).toContain('inspector slice 256² refinement (128² ≤ 300 ms delivered by SP3d)');
  });

  test('the pins were built, so SP3d\'s cut line was not taken and nothing moved to SP10', () => {
    expect(PIN_MAX).toBe(3);
    const cut = spEntry('SP3d', 'SP3e').split('\n').find((l) => l.startsWith('- **Cut line:**'));
    expect(cut, 'SP3d has no cut line').toBeDefined();
    expect(cut).toMatch(/^- \*\*Cut line:\*\* inspector pins \(→ SP10\)\. It was not taken: /);
    expect(text).toContain('SP3d inspector pins → SP10 (delivered in SP3d, so nothing moved)');
    const pins = text.split('\n').find((l) => l.startsWith('  - A mute toggle per tap (SP3d)'));
    expect(pins, 'no `- A mute toggle per tap (SP3d) …` line in §5.5').toBeDefined();
    expect(pins).toContain(`up to ${PIN_MAX} pinned slices side by side`);
    expect(pins).not.toMatch(/else SP10/);
  });
});

describe('master spec amendments (SP3e §11, §13)', () => {
  test('§10\'s SP3e entry names its spec and sets its deliverable, exit and cut line', () => {
    const entry = spEntry('SP3e', 'SP4a');
    const spec = /Spec: `([^`]+)`/.exec(entry);
    expect(spec, 'the SP3e header names no spec').not.toBeNull();
    expect(spec![1]).toBe('2026-10-16-sp3e-draft-presets-design.md');
    expect(existsSync(`${ROOT_DIR}docs/superpowers/specs/${spec![1]}`), `${spec![1]} does not exist`).toBe(true);
    expect(entry).not.toMatch(/set by the SP3e spec/);
    for (const k of ['Deliverable:', 'Exit:', 'Cut line:']) expect(entry, `SP3e misses **${k}**`).toContain(`**${k}**`);
    expect(entry).toContain('- **Exit:** as the SP3e spec §10.');
    expect(entry.split('\n').find((l) => l.startsWith('- **Cut line:**'))).toMatch(/^- \*\*Cut line:\*\* the islands' own surface branch \(→ SP12\)/);
    expect(entry, 'island-edge springs stay with SP8b').toContain('island-edge springs stay with SP8b');
  });

  test('§1\'s gen/column entry names islands.ts (the island cluster mask), which exists', () => {
    const entry = layoutEntry(/^\s+column\/climate\.ts\s/);
    expect(entry, 'no `column/climate.ts …` entry under gen/ in §1').not.toBe('');
    expect(entry).toMatch(/\sislands\.ts(\s|$)/);
    expect(existsSync(`${ROOT_DIR}src/gen/column/islands.ts`), 'src/gen/column/islands.ts does not exist').toBe(true);
  });

  test('§6.4\'s U2 row covers the schema\'s U2 leaves (73) and §3.6 sends the islands term to the SP3e spec §3', () => {
    const u2 = text.split('\n').find((l) => l.startsWith('| U2 |'));
    expect(u2, 'no U2 row in §6.4').toBeDefined();
    const n = SCHEMA.leaves.filter((l) => l.meta.stage !== undefined && ['climate', 'shape', 'biome2d', 'terrain'].includes(l.meta.stage)).length;
    expect(n).toBe(73);
    expect(u2).toContain(`the islands leaves are decided on a floating_islands island column; U2 covers ${n} leaves (amended by SP3e)`);
    expect(text).toContain('- `islands` is `−1e6` except in the floating_islands preset (SP3e) (SP3e spec §3).');
  });

  test('§6.4\'s Z1-Z3 rows state SP3e\'s definitions; THRESHOLDS records them from SP3e and gates them from SP12 (quick, full)', () => {
    const tail = 'recorded on every tier from SP3e, rows activeFrom SP12 gated on the quick and full tiers (amended by SP3e)';
    const defs: Record<'Z1' | 'Z2' | 'Z3', string> = {
      Z1: 'SP3e: amplified: among land positions (worldSurfaceWG = oceanFloorWG, top = the highest solid voxel) of uniform chunk columns in ±1024 chunks, the share with ≥ 2 solid → air transitions within 30 blocks below the top / the p99 of those tops',
      Z2: 'SP3e: archipelago: the share of cells with offset0 < 63 on a step-64 raster centred on (0, 0) / 4-connected land components of ≥ 1 km² (border-clipped areas counted) per 100 km² of raster',
      Z3: 'SP3e: floating_islands: positions holding a solid run whose bottom voxel is at y ≥ 181, over uniform columns in [−4096, 4096)² / the share of those positions whose highest such run\'s top is grass_block',
    };
    const parts: Record<'Z1' | 'Z2' | 'Z3', readonly string[]> = {
      Z1: ['overhangs', 'p99Top'], Z2: ['oceanShare', 'islandsPer100km2'], Z3: ['islandColumns', 'grassTops'],
    };
    for (const id of ['Z1', 'Z2', 'Z3'] as const) {
      const row = text.split('\n').find((l) => l.startsWith(`| ${id} |`));
      expect(row, `no ${id} row in §6.4`).toBeDefined();
      expect(row).toContain(`${defs[id]}; ${tail}`);
      expect(Object.keys(THRESHOLDS[id] ?? {})).toEqual(parts[id]);
      for (const part of parts[id]) {
        expect(THRESHOLDS[id]![part], `${id}.${part}`).toMatchObject({ activeFrom: 'SP12', tiers: ['quick', 'full'] });
      }
    }
    expect([THRESHOLDS.Z1?.overhangs?.min, THRESHOLDS.Z1?.p99Top?.min]).toEqual([0.08, 250]);
    expect([THRESHOLDS.Z2?.oceanShare?.min, THRESHOLDS.Z2?.oceanShare?.max, THRESHOLDS.Z2?.islandsPer100km2?.min]).toEqual([0.6, 0.75, 20]);
    expect([THRESHOLDS.Z3?.islandColumns?.min, THRESHOLDS.Z3?.grassTops?.min]).toEqual([0.03, 0.9]);
  });

  test('§6.4\'s B1 row states archipelago\'s own parts and floor, its DT2 row the presets\' parts (DT2.presets)', () => {
    const b1 = text.split('\n').find((l) => l.startsWith('| B1 |'));
    expect(b1, 'no B1 row in §6.4').toBeDefined();
    const floor = THRESHOLDS.B1?.minShareArchipelago?.min;
    expect(floor).toBe(0.0025);
    expect(b1).toContain(`per profile: archipelago's ocean family 55-80 % with its own parts (\`B1.presets\`; its minShare floor is ${floor! * 100} %`);
    expect(b1).toContain('amplified and floating_islands share the default\'s B1 inputs (amended by SP3e)');
    const ocean = THRESHOLDS.B1?.oceanFamilyArchipelago;
    expect([ocean?.min, ocean?.max]).toEqual([0.55, 0.8]);
    const dt2 = text.split('\n').find((l) => l.startsWith('| DT2 |'));
    expect(dt2, 'no DT2 row in §6.4').toBeDefined();
    expect(dt2).toContain('SP3e: the four exactness parts, non-finite values, heightmaps and feature-column searches on the presets (`DT2.presets`) (amended by SP3e)');
    const parts = Object.keys(THRESHOLDS.DT2 ?? {}).filter((k) => k.startsWith('preset'));
    expect(parts).toEqual([
      'presetProbeBulk', 'presetCompiledReference', 'presetSurfaceProbeBulk', 'presetSurfaceReference', 'presetNonFinite',
      'presetHeightmaps', 'presetNoFeatureColumn',
    ]);
  });

  test('§1\'s core/params entry names presetTrees.ts (the preset trees), which exists', () => {
    const entry = layoutEntry(/^\s+params\/defaultTrees\.ts\s/);
    expect(entry, 'no `params/defaultTrees.ts …` entry under core/ in §1').not.toBe('');
    expect(entry).toMatch(/\spresetTrees\.ts(\s|$)/);
    expect(existsSync(`${ROOT_DIR}src/core/params/presetTrees.ts`), 'src/core/params/presetTrees.ts does not exist').toBe(true);
  });

  test('§1\'s metrics entry and "Banned APIs" name sp3eGoldens.ts (the preset window search), which exists', () => {
    const entry = layoutEntry(/^\s+metrics\/\*\.ts\s/);
    expect(entry, 'no `metrics/*.ts …` entry in §1').not.toBe('');
    expect(entry).toMatch(/SP3e: sp3eGoldens\.ts\b/);
    expect(existsSync(`${ROOT_DIR}src/metrics/sp3eGoldens.ts`), 'src/metrics/sp3eGoldens.ts does not exist').toBe(true);
    expect(DET_FILES.has('metrics/sp3eGoldens.ts')).toBe(true);
    const line = text.split('\n').find((l) => l.includes('(`DET_FILES` in `test/arch/rules/banned.ts`:'));
    expect(line).toContain('`metrics/sp3eGoldens.ts`');
    expect(line).toContain('(amended by SP1, SP2a, SP2b, SP3a, SP3c and SP3e)');
  });

  test('§1\'s metrics entry and "Banned APIs" name pointDigest.ts (the column-point digest), which exists', () => {
    const entry = layoutEntry(/^\s+metrics\/\*\.ts\s/);
    expect(entry).toMatch(/SP3e: sp3eGoldens\.ts\b[^)]*\bpointDigest\.ts\b/);
    expect(existsSync(`${ROOT_DIR}src/metrics/pointDigest.ts`), 'src/metrics/pointDigest.ts does not exist').toBe(true);
    expect(DET_FILES.has('metrics/pointDigest.ts')).toBe(true);
    const line = text.split('\n').find((l) => l.includes('(`DET_FILES` in `test/arch/rules/banned.ts`:'));
    expect(line).toContain('`metrics/pointDigest.ts`');
  });

  test('§1\'s test/ entry names SP3e\'s test files in their own parentheses, which exist', () => {
    const entry = layoutEntry(/^\s+test\/ unit\/ metrics\//);
    const sp3e = /\(SP3e: ([^)]*)\)/.exec(entry);
    expect(sp3e, "§1's test/ entry has no `(SP3e: …)` list").not.toBeNull();
    const named = sp3e![1]!.split(/,\s*/).map((f) => f.trim());
    expect(named).toEqual([
      'metrics/presets.metric.ts', 'harness/terrainScatter.ts', 'harness/dt2.ts', 'harness/surfaceAnalysis.ts',
      'harness/heightmaps.ts', 'harness/zMetrics.ts', 'unit/goldens.sp3e.test.ts',
    ]);
    for (const f of named) expect(existsSync(`${ROOT_DIR}test/${f}`), `test/${f} does not exist`).toBe(true);
    // SP3d's list still reads alone.
    expect(/SP3d: ([^)]*)\)/.exec(entry)![1]).not.toContain('SP3e');
  });

  test('§6.2\'s goldens line names the sp3e.* keys; §10\'s SP12 "goldens per preset" says SP3e pins the drafts', () => {
    const goldens = text.split('\n').find((l) => l.startsWith('- **Goldens** (region hashes per built-in preset, per stage'));
    expect(goldens, 'no §6.2 goldens line').toBeDefined();
    expect(goldens).toContain('SP3e: `sp3e.region.T.<preset>` and the column points of archipelago and floating_islands');
    const from = text.indexOf('**SP12 — ');
    const sp12 = text.slice(from, text.indexOf('### Critical path', from));
    expect(sp12).toContain('goldens per preset (SP3e\'s drafts are pinned by `sp3e.*`; finalising them bumps `GENERATOR_VERSION`)');
  });

  test('§7\'s "Measured in SP3e" line names the terrain.islands bench row, which BENCH_ROWS measures, gated at p50 ≤ 4 ms on cluster columns', () => {
    const line = text.split('\n').find((l) => l.startsWith('- **Measured in SP3e** (amended by SP3e):'));
    expect(line, 'no `- **Measured in SP3e** (amended by SP3e): …` line in §7').toBeDefined();
    expect(line).toContain('`terrain.islands`');
    expect(line).toContain(`p50 ≤ ${TERRAIN_P50_MAX_MS} ms on cluster columns`);
    expect(line).toContain('`TERRAIN_P50_MAX_MS`');
    const rows: readonly string[] = BENCH_ROWS;
    expect(rows).toContain('terrain.islands');
    // It follows SP3c's measured line, inside §7.
    const sp3c = text.indexOf('- **Measured in SP3c** (amended by SP3c):');
    const at = text.indexOf(line!);
    expect(sp3c).toBeGreaterThan(text.indexOf('## 7. Performance budget'));
    expect(at).toBeGreaterThan(sp3c);
    expect(at).toBeLessThan(text.indexOf('## 8. Risks'));
  });
});

/** The node at a dotted path of a density tree (object keys only). */
function nodeAt(tree: unknown, path: string): unknown {
  let x = tree;
  for (const k of path.split('.')) {
    expect(x !== null && typeof x === 'object' && Object.hasOwn(x, k), `no ${k} in ${path}`).toBe(true);
    x = (x as Record<string, unknown>)[k];
  }
  return x;
}

/** §10's SP12 entry: from its header to the critical path. */
function sp12Entry(): string {
  const from = text.indexOf('**SP12 — ');
  expect(from, 'no SP12 header in §10').toBeGreaterThanOrEqual(0);
  return text.slice(from, text.indexOf('### Critical path', from));
}

/** A §3.15 table row of a preset. */
function presetRow(id: string): string {
  const from = text.indexOf('### 3.15 Extreme presets');
  const to = text.indexOf('### 3.16', from);
  const row = text.slice(from, to).split('\n').find((l) => l.startsWith(`| ${id} |`));
  expect(row, `no ${id} row in §3.15`).toBeDefined();
  return row!;
}

describe('master spec amendments (SP3e §12, §13, exit)', () => {
  // The cut line (SP3e spec §4.4): built iff floating_islands carries FLOATING_SURFACE_RULES.
  const built = Object.hasOwn(presetTrees, 'FLOATING_SURFACE_RULES')
    && resolveProfile('floating_islands').surface.rules === (presetTrees as Record<string, unknown>).FLOATING_SURFACE_RULES;
  const amp = presetTrees.AMPLIFIED_DENSITY_TREE;
  const v = (path: string): number => nodeAt(amp, path) as number;
  const knots = nodeAt(amp, 'root.a.a.x.x.a.a.b.b.knots') as Array<[number, number]>;
  const slideFrom = knots[2]![0], slideTo = knots[3]![0];
  // The islands term (SP3e spec §3.1): the m gate, the y window [lo, hi) and BODY's literals.
  const gate = nodeAt(presetTrees.FLOATING_DENSITY_TREE, 'root.b.x.x') as { lo: number };
  const band = nodeAt(presetTrees.FLOATING_DENSITY_TREE, 'root.b.x.x.inside') as { lo: number; hi: number };
  const body = (path: string): number => nodeAt(presetTrees.FLOATING_DENSITY_TREE, `root.b.x.x.inside.inside.${path}`) as number;
  const lastCorner = band.hi - 1 - ((band.hi - 1 + 64) % 8);

  test('the islands surface branch decides the cut-line texts: SP3e\'s cut line, the receivers, SP12 and SP3e\'s received list', () => {
    expect(built, 'the dry run built the branch (SP3e spec §4.4)').toBe(true);
    const entry = spEntry('SP3e', 'SP4a');
    const cut = entry.split('\n').find((l) => l.startsWith('- **Cut line:**'));
    const fromSp3d = entry.split('\n').find((l) => l.startsWith('- Received from SP3d (its spec §13):'));
    expect(fromSp3d, 'SP3e has no "Received from SP3d" line').toBeDefined();
    const sp12 = sp12Entry();
    if (built) {
      expect(cut).toBe('- **Cut line:** the islands\' own surface branch (→ SP12). It was not taken: the branch shipped in SP3e, so nothing moved.');
      expect(text).toContain('SP3e islands surface branch → SP12 (delivered in SP3e, so nothing moved)');
      expect(fromSp3d).toContain('(delivered: SP3e spec §1-§6);');
      expect(sp12).not.toContain('the islands surface-rule branch');
    } else {
      expect(cut).toBe('- **Cut line:** the islands\' own surface branch (→ SP12).');
      expect(text).toMatch(/SP3e islands surface branch → SP12[;.]/);
      expect(fromSp3d).toContain('(delivered: SP3e spec §1-§6, except the islands surface-rule branch, cut to SP12)');
      expect(sp12).toContain('the islands surface-rule branch');
    }
  });

  test('SP3e\'s "Received from SP3a" states amplified\'s final slide and ceiling knee', () => {
    const line = spEntry('SP3e', 'SP4a').split('\n').find((l) => l.startsWith('- Received from SP3a'));
    expect(line).toContain(`(delivered: in the density tree, with the slide at ${slideFrom}-${slideTo} and a soft ceiling from ${-v('root.a.a.x.x.b.x.b.b.b.v')}).`);
  });

  test('§3.15\'s title names the code SP3e adds; its draft rows state the final constants of the preset trees and overlays', () => {
    expect(text).toContain('### 3.15 Extreme presets (data only: splines + climate params + DAG terms; SP3e adds the island cluster mask, water v0\'s island rule and the sky-open run under islands as code)');
    const a = presetRow('amplified');
    // The amplification and σ's factor fade with lakeMask: k + (−d)·lakeMask (the SP3e Review Focus).
    const factor = v('root.a.a.x.x.a.a.a.a.a.b.a.a.v'), knee = -v('root.a.a.x.x.a.a.a.a.a.b.b.b.b.v');
    expect(-v('root.a.a.x.x.a.a.a.a.a.b.a.b.a.v'), 'the offset fade is k·(1 − lakeMask)').toBe(factor);
    expect(a).toContain(`\`offset' = offset + ${factor}·(1 − lakeMask)·max(0, offset − ${knee})\``);
    const sigma = v('root.a.a.x.x.a.a.b.a.b.a.v'), sigmaFade = -v('root.a.a.x.x.a.a.b.a.b.b.a.v');
    expect(a).toContain(`σ ×${sigma} (${sigma} − ${sigmaFade}·lakeMask: the default's σ in a lake basin); jag ×${v('root.a.a.x.x.a.a.a.a.b.a.b.v')}; slide ${slideFrom}-${slideTo}`);
    expect(a).toContain(`ceiling \`−${v('root.a.a.x.x.b.x.a.v')}·max(0, y − ${-v('root.a.a.x.x.b.x.b.b.b.v')})\``);
    expect(a).toContain('in `density.defs`');
    const arch = resolveProfile('archipelago');
    const r = presetRow('archipelago');
    expect(r).toContain(`C λ ${arch.climate.C.wavelength}`);
    expect(arch.climate.C.wavelength / DEFAULTS.climate.C.wavelength).toBeCloseTo(0.35, 12);
    expect(r).toContain('shift 0.42: the shore at C_u 0.26-0.32, every C_u < 0.2 ocean');
    expect(r).toContain(`\`lakes.minC\` ${arch.lakes.minC}`);
    expect(r).toContain(`coast fade ${arch.rivers.coastFadeLo}-${arch.rivers.coastFadeHi}`);
    const f = presetRow('floating_islands');
    const fl = resolveProfile('floating_islands');
    const ni = fl.density.noises.islands;
    expect(f).toContain(`\`islands = ${body('a.v')}·(NI − ${-body('b.a.a.b.v')} − ${body('b.a.b.x.a.v')}·q + ${body('b.b.a.v')}·(m − 1))\`, q = ((y − ${-body('b.a.b.x.b.x.a.b.v')})/${1 / body('b.a.b.x.b.x.b.v')})²`);
    expect(f).toContain(`NI λxz ${ni.wavelength} λy ${ni.wavelength / ni.yScale} over ${ni.octaves} octaves`);
    expect(f).toContain(`the gates m ≥ ${gate.lo} and the corners y ${band.lo}-${lastCorner}`);
    expect(f).toContain(`\`m = smoothstep(${fl.islands.lo}, ${fl.islands.hi}, u(λ ${fl.islands.noise.wavelength}))\``);
    expect(f).toContain(`water v0 filling the sea under island runs (bottom ≥ ${ISLAND_RUN_MIN_BOTTOM})`);
    if (built) expect(f).toContain('its own surface-rule branch (grass tops, dirt, stone undersides');
    expect(f, 'island-edge springs moved to SP8b').not.toMatch(/springs/);
  });

  test('§10\'s SP6, SP8b and SP11 carry SP3e\'s notes', () => {
    expect(spEntry('SP6', 'SP7')).toContain(`- Received from SP3e (its spec §12): exclude cave-detached runs above y ${ISLAND_RUN_MIN_BOTTOM - 1} from the floating_islands island branch, water v0's island rule and the surface scan's sky-open run under islands when caves reach y ≥ ${ISLAND_RUN_MIN_BOTTOM}.`);
    expect(spEntry('SP8b', 'SP8c')).toContain('springs, lava lakes and island-edge springs feeding settle (island-edge springs on SP3e\'s islands term, `islandMask` and island runs; SP3e spec §12)');
    expect(spEntry('SP11', 'SP12')).toContain(`LOD clipmap with fill mask and island terms (the islands tap is non-positive outside the corners y ${band.lo}-${lastCorner} and where islandMask < ${gate.lo}; SP3e spec §12)`);
  });

  test('§10\'s SP12 receives SP3e\'s §12 list with Z2\'s islands part at its measured value; the continental profile stays with SP12', () => {
    const sp12 = sp12Entry();
    const line = sp12.split('\n').find((l) => l.startsWith('- Received from SP3e (its spec §12):'));
    expect(line, 'SP12 has no "Received from SP3e" line').toBeDefined();
    const z2 = JSON.parse(readFileSync(`${ROOT_DIR}docs/superpowers/specs/assets/sp3e/tuning/after/metrics/Z2.json`, 'utf8')) as { values: Record<string, number> };
    const measured = z2.values.islandsPer100km2!.toFixed(2);
    expect(line).toContain(`Z2's islands part (handed over by the user): ${measured} islands ≥ 1 km² per 100 km² on the quick tier`);
    expect(line).toContain(`against ≥ ${THRESHOLDS.Z2!.islandsPer100km2!.min}`);
    expect(line).toContain('the Z1-Z3 gates active');
    expect(sp12).not.toContain('it may move to SP3e');
    expect(sp12).toContain('it stays with SP12 (SP3e did not take it)');
  });
});

describe('master spec amendments (SP4a §9.3)', () => {
  test('§7\'s "Measured in SP4a" line names the light.column and mesh.section bench rows, which BENCH_ROWS measures, with their gates', () => {
    const line = text.split('\n').find((l) => l.startsWith('- **Measured in SP4a** (amended by SP4a):'));
    expect(line, 'no `- **Measured in SP4a** (amended by SP4a): …` line in §7').toBeDefined();
    const rows: readonly string[] = BENCH_ROWS;
    for (const row of ['light.column', 'mesh.section']) {
      expect(line, `§7's "Measured in SP4a" line does not name ${row}`).toContain(`\`${row}\``);
      expect(rows, `BENCH_ROWS does not measure ${row}`).toContain(row);
    }
    expect(line).toContain(`p50 ≤ ${LIGHT_P50_MAX_MS} ms, p99 ≤ ${LIGHT_P99_MAX_MS} ms`);
    expect(line).toContain(`p50 ≤ ${MESH_P50_MAX_MS.toFixed(1)} ms, p99 ≤ ${MESH_P99_MAX_MS} ms`);
    // It follows SP3e's measured line, inside §7.
    const sp3e = text.indexOf('- **Measured in SP3e** (amended by SP3e):');
    const at = text.indexOf(line!);
    expect(sp3e).toBeGreaterThan(text.indexOf('## 7. Performance budget'));
    expect(at).toBeGreaterThan(sp3e);
    expect(at).toBeLessThan(text.indexOf('## 8. Risks'));
  });
});

describe('master spec amendments (SP4a §14)', () => {
  test('§1\'s test/ entry names SP4a\'s test files in their own parentheses, which exist', () => {
    const entry = layoutEntry(/^\s+test\/ unit\/ metrics\//);
    const sp4a = /\(SP4a: ([^)]*)\)/.exec(entry);
    expect(sp4a, "§1's test/ entry has no `(SP4a: …)` list").not.toBeNull();
    const named = sp4a![1]!.split(/,\s*/).map((f) => f.trim());
    expect(named).toEqual([
      'metrics/render.metric.ts', 'metrics/light.metric.ts', 'metrics/g1.metric.ts', 'tools/cdp.ts', 'tools/panoramas.ts',
      'tools/measureChrome.ts',
    ]);
    for (const f of named) expect(existsSync(`${ROOT_DIR}test/${f}`), `test/${f} does not exist`).toBe(true);
    // SP3e's list still reads alone.
    expect(/\(SP3e: ([^)]*)\)/.exec(entry)![1]).not.toContain('SP4a');
  });

  test('§1 lists SP4a\'s new modules in their directories\' entries, and each exists', () => {
    // [entry head, the list tokens it must hold, the files on disk]; a token counts only on a list line (below).
    const named: ReadonlyArray<readonly [RegExp, readonly string[], readonly string[]]> = [
      [/^\s+pipeline\/terrainStage\.ts /, ['decorateStage.ts', 'finalHeightmaps.ts'], ['src/gen/pipeline/decorateStage.ts', 'src/gen/pipeline/finalHeightmaps.ts']],
      [/^\s+textures\/painters\//, ['flatColors.ts'], ['src/textures/flatColors.ts']],
      [/^\s+mesh\/greedy\.ts /, ['mesh/greedy.ts', 'fluid.ts', 'packing.ts', 'connectivity.ts', 'column.ts', 'builder.ts', 'faces.ts'],
        ['greedy.ts', 'fluid.ts', 'packing.ts', 'connectivity.ts', 'column.ts', 'builder.ts', 'faces.ts'].map((f) => `src/mesh/${f}`)],
      [/^\s+workers\/protocol\.ts /, ['worldJobs.ts', 'spikeStore.worker.ts', 'spikeStoreHandler.ts'],
        ['worldJobs.ts', 'spikeStore.worker.ts', 'spikeStoreHandler.ts'].map((f) => `src/workers/${f}`)],
      [/^\s+engine\/\s/, ['coordinator.ts', 'rings.ts', 'uploadBudget.ts', 'renderDistance.ts', 'spikeStore.ts'],
        ['coordinator.ts', 'rings.ts', 'uploadBudget.ts', 'renderDistance.ts', 'spikeStore.ts'].map((f) => `src/engine/${f}`)],
      [/^\s+render\/\s/, ['fpsLimiter.ts', 'frameState.ts', 'frameTiming.ts', 'regionGrid.ts', 'spike/'],
        ['fpsLimiter.ts', 'frameState.ts', 'frameTiming.ts', 'regionGrid.ts', 'spike/'].map((f) => `src/render/${f}`)],
      [/^\s+player\/fly\.ts /, ['player/fly.ts', 'keymap.ts', 'input.ts'], ['fly.ts', 'keymap.ts', 'input.ts'].map((f) => `src/player/${f}`)],
      [/^\s+ui\/world\/\* /, ['ui/world/*', 'ui/loading/*', 'ui/spike/*', 'settings.ts'], ['src/ui/world/', 'src/ui/loading/', 'src/ui/spike/', 'src/ui/settings.ts']],
      [/^\s+public\/panoramas\/ /, ['public/panoramas/'], ['public/panoramas/manifest.json']],
    ];
    for (const [head, tokens, files] of named) {
      const listed = listTokens(head);
      expect(listed, `§1 has no entry matching ${head}`).not.toEqual([]);
      for (const t of tokens) expect(listed, `§1's ${head} entry does not list ${t}`).toContain(t);
      for (const f of files) expect(existsSync(`${ROOT_DIR}${f}`), `${f} does not exist`).toBe(true);
    }
    // padded.ts is named in the store entry's prose, as spec §14 words it.
    expect(layoutEntry(/^\s+store\/pool\.ts /)).toContain('padded.ts arrives in SP4a');
    expect(existsSync(`${ROOT_DIR}src/world/store/padded.ts`)).toBe(true);
    expect(text).toContain('the standalone ?map page (mounted in-game from SP4c)');
  });

  test('the panoramas were built, so SP4a\'s cut line says it was not taken and the receivers say nothing moved', () => {
    const manifest = JSON.parse(readFileSync(`${ROOT_DIR}public/panoramas/manifest.json`, 'utf8')) as unknown[];
    expect(manifest, 'the six panoramas of SP4a spec §8.3').toHaveLength(6);
    const cut = spEntry('SP4a', 'SP4b').split('\n').find((l) => l.startsWith('- **Cut line:**'));
    expect(cut).toBe('- **Cut line:** the panoramas (→ SP4b). It was not taken: the panorama tool and its six panoramas shipped in SP4a, so nothing moved. The RegionMesh fallback was required by the capability probe (Firefox lacks `WEBGL_multi_draw`), so it is not cuttable.');
    expect(text).toContain('SP4a loading-screen panoramas → SP4b (delivered in SP4a, so nothing moved);');
  });

  test('a bare SP4 is left only where spec §14 keeps it: the §10 split paragraphs and the parallelism line', () => {
    const kept = ['SP3 was split on ', 'SP3b was split on ', 'SP3d was split on ', 'SP4 was split on ', 'In parallel: '];
    const bare = text.split('\n').filter((l) => /\bSP4\b/.test(l));
    for (const l of bare) expect(kept.some((k) => l.startsWith(k)), `a bare SP4 outside the kept lines: ${l.slice(0, 120)}`).toBe(true);
    expect(text).toContain('SP4b wires them in place of SP2b\'s pool-wide cell');
  });
});

describe('master spec amendments (SP4b §13)', () => {
  test('the split', () => {
    expect(text).toContain('SP4b was split on 2026-10-23 into SP4b (streaming) and SP4c (the map in the world and live editing), at the user\'s request');
    const sp4b = spEntry('SP4b', 'SP4c');
    expect(sp4b).toContain('Spec: `2026-10-23-sp4b-streaming-design.md`');
    expect(sp4b.split('\n').some((l) => l.startsWith('- **Cut line:** deferred reclamation\'s primitive (→ SP5)')), 'the SP4b entry has no `- **Cut line:** deferred reclamation\'s primitive (→ SP5)` line').toBe(true);
    expect(text).toContain('SP4b deferred-reclamation primitive → SP5');
    const scheduler = text.split('\n').find((l) => l.startsWith('- **Scheduler** ('));
    expect(scheduler, 'no `- **Scheduler** (…` header in §6.3').toBeDefined();
    expect(scheduler).toContain('SP4b: cancel, zero allocation, throttle; SP4c: Apply; amended by SP4a and SP4b');
    expect(text).toContain('\n  - old meshes are kept on Apply (SP4c);\n');
  });

  test('§1\'s ci.yml line names the unit shards', () => {
    expect(layoutEntry(/^\s+\.github\/workflows\/ci\.yml /)).toContain('the two unit shards (`.github/scripts/unitShards.mjs`)');
    expect(existsSync(`${ROOT_DIR}.github/scripts/unitShards.mjs`)).toBe(true);
  });

  /** [§1 entry head, the token its entry holds, the file on disk]; Tasks 5, 10, 16 and 26 append theirs. */
  const SP4B_MODULES: Array<[head: RegExp, token: string, file: string]> = [
    [/^\s+\.github\/workflows\/ci\.yml /, '.github/scripts/unitShards.mjs', '.github/scripts/unitShards.mjs'],
    [/^\s+store\/pool\.ts /, 'reclaim.ts (SP4b)', 'src/world/store/reclaim.ts'],
    [/^\s+engine\/\s/, 'throttle.ts (SP4b)', 'src/engine/throttle.ts'],
    [/^\s+core\/\s/, 'streamScore.ts (SP4b', 'src/core/streamScore.ts'],
    [/^\s+renderer\.ts sectionRenderer\.ts /, 'sectionRenderer.ts (interface; SP4b: and UploadGate)', 'src/render/sectionRenderer.ts'],
    [/^\s+ui\/world\/\* /, 'ui/world/bench.ts', 'src/ui/world/bench.ts'],
  ];

  test('§1\'s engine entry marks scheduler.ts as not created, and the file does not exist (SP4b spec §13)', () => {
    expect(layoutEntry(/^\s+engine\/\s/)).toContain('scheduler.ts (not created: the coordinator holds the scheduler)');
    expect(existsSync(`${ROOT_DIR}src/engine/scheduler.ts`)).toBe(false);
    expect(layoutEntry(/^\s+core\/\s/)).toContain('streamScore.ts (SP4b: the stage score shared by the coordinator and the section renderers\' ready queue)');
  });

  test('§4.3\'s heap and throttle sentences (SP4b spec §3.3, §3.8, §13)', () => {
    const at = text.indexOf('### 4.3 Scheduling');
    const s43 = text.slice(at, text.indexOf('### 4.4 ', at));
    expect(s43).toContain('- Four heaps, one per stage, rebuilt in O(n) (n ≤ 5k) on a crossing, an RD change or a turn > 30° (SP4b).');
    const throttle = s43.split('\n').find((l) => l.startsWith('**Adaptive throttle (`engine/throttle.ts`).**'));
    expect(throttle, 'no `**Adaptive throttle …` paragraph in §4.3').toBeDefined();
    for (const phrase of [
      'exceeds max(16.7 ms, the display interval + 0.5 ms) while generation is in flight',
      'on the T, D and L jobs in flight, in [1, max(1, N − 1)] (SP4b)',
      'After 120 frames under max(13 ms, the display interval + 0.5 ms) it rises by 1',
      'the user\'s decision of 2026-10-24',
    ]) expect(throttle, `the throttle paragraph does not say ${phrase}`).toContain(phrase);
  });

  test('§4.1\'s meshSeq is per column (SP4b spec §3.6, §13)', () => {
    const para = text.split('\n').find((l) => l.startsWith('**Optimistic concurrency.**'));
    expect(para, 'no `**Optimistic concurrency.**` paragraph').toBeDefined();
    expect(para).toContain('monotonically increasing `meshSeq` (SP4b: per column, since one MESH_COLUMN job covers a column\'s sections; a result of an older seq is dropped)');
  });

  test('§4.1\'s lock and single-writer sentences name the reader pins and the main thread\'s frees (SP4b spec §3.5, §13)', () => {
    const at = text.indexOf('### 4.1 Thread topology and ownership');
    const s41 = text.slice(at, text.indexOf('### 4.2 ', at));
    expect(s41).toContain('The only lock is the slab allocator (the coordinator\'s reader pins are main-thread counters, not locks; SP4b).');
    // The single-writer line's pin moved to 'master spec amendments (SP4c §12)' (SP4c amends it).
  });

  test('§4.2\'s proto retention and unload, §4.3\'s cancellation (SP4b spec §3.5-§3.7, §13)', () => {
    const at = text.indexOf('### 4.2 Column state machine');
    const s42 = text.slice(at, text.indexOf('### 4.3 ', at));
    const proto = s42.split('\n').find((l) => l.startsWith('**Proto retention.**'));
    expect(proto, 'no `**Proto retention.**` paragraph in §4.2').toBeDefined();
    expect(proto).toContain('(SP4b builds the rule and `T(protoOnly)`; the page keeps every proto until D places features, SP8b, because a freed proto saves nothing while the final set shares its slots)');
    const unload = s42.split('\n').find((l) => l.startsWith('**Unload.**'));
    expect(unload, 'no `**Unload.**` paragraph in §4.2').toBeDefined();
    expect(unload).toContain('(SP4b: at most 16 column frees and 64 columns hidden for mesh removal per frame, their rows released under the upload budget, a column freed only when no in-flight job reads it)');
    const at3 = text.indexOf('### 4.3 Scheduling');
    const s43 = text.slice(at3, text.indexOf('### 4.4 ', at3));
    expect(s43).toContain('- Queued jobs that leave the needed set are dropped (SP4b: from the coordinator\'s heaps and the pool\'s queue; in-flight jobs finish and are judged at intake).');
  });

  test('§2.3 has the Reclamation paragraph (SP4b spec §2.5, §13)', () => {
    const para = text.split('\n').find((l) => l.startsWith('**Reclamation.**'));
    expect(para, 'no `**Reclamation.**` paragraph in §2.3').toBeDefined();
    const at = text.indexOf(para!);
    expect(at).toBeGreaterThan(text.indexOf('### 2.3 SharedArrayBuffer store'));
    expect(at).toBeLessThan(text.indexOf('### 2.4 '));
    for (const phrase of ['reader epoch', 'limbo', 'freed at once', 'dead thread', 'reader pins', '(SP4b)']) {
      expect(para, `the Reclamation paragraph does not say ${phrase}`).toContain(phrase);
    }
  });

  test('§2.3\'s slabs paragraph names the lock owner (SP4b spec §2.6, §13)', () => {
    const at = text.indexOf('**Slabs.**');
    expect(at).toBeGreaterThan(text.indexOf('### 2.3 SharedArrayBuffer store'));
    const slabs = text.slice(at, text.indexOf('**Final section descriptor**', at));
    expect(slabs).toContain('the lock word holds its owner\'s thread index + 1, and a thread spinning on a failed owner\'s lock throws `StoreCorrupt` (SP4b)');
  });

  test('§2.1\'s floating origin, §4.3\'s uploads and §4.5\'s RegionBatch sentences (SP4b spec §3.9, §4.2, §13)', () => {
    const precision = text.split('\n').find((l) => l.startsWith('- **Rendering precision:**'));
    expect(precision, 'no `- **Rendering precision:**` line in §2.1').toBeDefined();
    expect(precision).toContain('(SP4b: each region\'s mesh carries its origin, so a rebase moves regions, not instances)');
    const uploads = text.split('\n').find((l) => l.startsWith('**Uploads** are capped'));
    expect(uploads, 'no `**Uploads** are capped` paragraph in §4.3').toBeDefined();
    expect(uploads).toContain('(SP4b: at most one structural operation per frame while flying: a region\'s batch or arena created, grown, optimised or compacted; a region with rows written in a frame is drawn unculled in it, so three uploads them under that frame\'s cap)');
    const at = text.indexOf('### 4.5 Render structure');
    const s45 = text.slice(at, text.indexOf('**Fallback.**', at));
    expect(s45).toContain('the instance matrix places the section inside its region, and the region\'s mesh carries the region origin relative to the floating origin (SP4b)');
    expect(s45).not.toContain('the instance matrix translates to the section origin relative to the floating origin');
    expect(s45).toContain('Vertex and index capacity are reserved per preset (SP4b; SP4a sizes each region exactly at load) (Medium: opaque 131,072 vertices / 196,608 indices, translucent 16,384 / 24,576, cutout 8,192 / 12,288 on demand, 1,536 instances; when full, `optimize()` above 40 % deleted space, else ×1.5)');
  });

  test('§4.5\'s Fallback paragraph names RegionMesh\'s arena (SP4b spec §4.3, §13)', () => {
    const fallback = text.split('\n').find((l) => l.startsWith('**Fallback.** `capabilities.ts`'));
    expect(fallback, 'no `**Fallback.**` paragraph in §4.5').toBeDefined();
    expect(fallback).toContain('one merged buffer per region per pass with sub-allocated ranges and `addUpdateRange` (SP4b: an arena per region and pass with column ranges, first-fit, hidden by degenerate indices until the reveal frame, compaction above 40 % free space, else ×1.5), and culling per region');
  });

  test('§4.6\'s fog sentence: SP4b\'s end, no edge fade (SP4b spec §6.3, D17, §13)', () => {
    const fog = text.split('\n').find((l) => l.startsWith('**Fog** is spherical'));
    expect(fog, 'no `**Fog** is spherical` paragraph in §4.6').toBeDefined();
    expect(fog).toContain('SP4b: end (RD − 1)·16, start 64 blocks before, no edge fade');
    expect(fog).toContain('after a live RD raise the end follows the filled radius outward');
  });

  test('§4.17\'s creative-style flight, and §5.9 without R (SP4b spec §6.1, §6.2, §13)', () => {
    const at = text.indexOf('### 4.17 Player');
    const s417 = text.slice(at, text.indexOf('### 4.18 ', at));
    expect(s417).toContain('creative-style flight');
    expect(s417).toContain('creative-style flight: forward along the horizontal projection of the look direction, Space and Shift for height, the horizontal and vertical speeds independent (the user\'s decision, SP4b)');
    expect(s417).not.toContain('spectator: forward along the look vector');
    expect(text).not.toContain('R (load the world around you');
  });

  test('§4.16\'s Live sentence names the live render distance (SP4b spec §5, §13)', () => {
    const at = text.indexOf('### 4.16 Graphics presets');
    const s416 = text.slice(at, text.indexOf('### 4.17 ', at));
    expect(s416).toContain('the render distance live since SP4b, within the reservation\'s cap');
  });

  test('§5.8\'s HUD counts gain the streaming counts (SP4b spec §7.3, §13)', () => {
    const at = text.indexOf('### 5.8 Debug HUD and bench');
    const s58 = text.slice(at, text.indexOf('### 5.9 ', at));
    expect(s58).toContain('SP4b: the streaming counts');
  });

  test('§5.8\'s bench route is `?bench=medium`\'s 95 s script, and §1\'s ui/world entry names bench.ts (SP4b spec §8.3, §13)', () => {
    const at = text.indexOf('### 5.8 Debug HUD and bench');
    const s58 = text.slice(at, text.indexOf('### 5.9 ', at));
    expect(s58).toContain('a fixed seed and a scripted flight (SP4b: `?bench=medium`, 95 s, plains, mountains and ocean along straight legs at 20, 96 and 384 blocks/s with turns, a hover and a live RD change; SP6 adds the cave scenario, SP7 the flood)');
    expect(s58).not.toContain('60 s scripted flight');
    expect(layoutEntry(/^\s+ui\/world\/\* /)).toContain('ui/world/bench.ts (SP4b: the `?bench=medium` route and its JSON)');
  });

  test('§6.4\'s G1 row names the six streaming parts THRESHOLDS holds activeFrom SP4b', () => {
    const g1 = text.split('\n').find((l) => l.startsWith('| G1 |'));
    expect(g1, 'no G1 row in §6.4').toBeDefined();
    expect(g1).toContain('SP4b gates the Medium cells while streaming from the `?bench=medium` artifacts (no frame > 33 ms as snapped frame times, frames with a structural operation included; the fill as the first entry\'s reveal with 4 workers; the GPU estimate as the section geometry, the texture array, the lightmap, the sky and the drawing buffer, the SP4b spec §8.4) and re-asserts SP4a\'s static cells on a re-measured `?flight`');
    expect(g1).toContain('on the RTX 3060 Mobile, no frame > 33 ms and p95 ≤ 16.7 ms at Medium are checked at SP4b\'s exit; only the High-preset parts (p95 at High, JS heap + SAB ≤ 450 MB) wait for SP11\'s High preset');
    expect(g1).toContain('the first entry reveals the whole RD at once behind the loading screen (the user\'s decision of 2026-10-23)');
    // The six streaming parts and the G1 row's targets they gate (SP4b spec §8.2).
    const parts: Array<[part: string, max: number, target: string]> = [
      ['mediumStreamP95', 16.7, 'p95 ≤ 16.7 ms'],
      ['mediumStreamOver33', 0, 'no frame > 33 ms while streaming'],
      ['mediumStreamDrawCalls', 100, 'draw calls ≤ 100'],
      ['mediumStreamMainP95', 6, 'main thread ≤ 6 ms p95'],
      ['mediumFill4wMs', 6000, 'RD12 fill ≤ 6 s with the 4-worker cap'],
      ['mediumGpuMB', 150, 'GPU estimate ≤ 150 MB'],
    ];
    for (const [part, max, target] of parts) {
      expect(THRESHOLDS.G1?.[part], `THRESHOLDS.G1.${part}`).toEqual({ max, activeFrom: 'SP4b' });
      expect(g1, `the G1 row's target ${target}`).toContain(target);
    }
    expect(Object.keys(THRESHOLDS.G1 ?? {}).filter((p) => THRESHOLDS.G1?.[p]?.activeFrom === 'SP4b').sort()).toEqual(parts.map(([p]) => p).sort());
  });

  test('no \'first playable\' is left in §4.18, §6.4, §7 or §8', () => {
    const section = (head: string, next: string): string => {
      const at = text.indexOf(head);
      expect(at, `no ${head}`).toBeGreaterThan(-1);
      return text.slice(at, text.indexOf(next, at + head.length));
    };
    for (const [head, next] of [['### 4.18 ', '## 5. '], ['### 6.4 ', '## 7. '], ['## 7. ', '## 8. '], ['## 8. ', '## 9. ']] as const) {
      expect(section(head, next), `${head.trim()} still says first playable`).not.toMatch(/first playable/i);
    }
    expect(section('### 4.18 ', '## 5. ')).toContain('synthesised once per page load, after the first reveal');
    expect(section('## 7. ', '## 8. ')).toContain('The first entry reveals the whole RD at once (the user\'s decision of 2026-10-23 replaced the first-playable target)');
    expect(section('## 7. ', '## 8. ')).toContain('SP4b\'s bench also flies 96 and 384 blocks/s, where generation may lag and empty areas show, never stutter (the user\'s rule)');
    expect(section('## 8. ', '## 9. ')).toContain('Synthesis runs in workers after the first reveal');
  });

  test('§1\'s test entry lists SP4b\'s test files in their own parentheses, which exist', () => {
    const entry = layoutEntry(/^\s+test\/ unit\/ metrics\//);
    const sp4b = /\(SP4b: ([^)]*)\)/.exec(entry);
    expect(sp4b, "§1's test/ entry has no `(SP4b: …)` list").not.toBeNull();
    const named = sp4b![1]!.split(/,\s*/).map((f) => f.trim());
    expect(named).toEqual([
      'metrics/stream.metric.ts', 'harness/inProcessPool.ts', 'integration/streaming.test.ts', 'integration/columnTableFuzz.test.ts',
    ]);
    for (const f of named) expect(existsSync(`${ROOT_DIR}test/${f}`), `test/${f} does not exist`).toBe(true);
    // SP4a's list still reads alone.
    expect(/\(SP4a: ([^)]*)\)/.exec(entry)![1]).not.toContain('SP4b');
  });

  test('§1 names each SP4b module in its entry, which exists', () => {
    for (const [head, token, file] of SP4B_MODULES) {
      const entry = layoutEntry(head);
      expect(entry, `§1 has no entry matching ${head}`).not.toBe('');
      expect(entry, `§1's ${head} entry does not name ${token}`).toContain(token);
      expect(existsSync(`${ROOT_DIR}${file}`), `${file} does not exist`).toBe(true);
    }
  });

  test('deferred reclamation was built, so SP4b\'s cut line says it was not taken and the receivers say nothing moved', () => {
    // Built: the reclaim module exists and the store's releases go through it (SP4b spec §2.5, §10's cut line).
    expect(existsSync(`${ROOT_DIR}src/world/store/reclaim.ts`)).toBe(true);
    expect(readFileSync(`${ROOT_DIR}src/world/store/store.ts`, 'utf8')).toMatch(/\battachReclaimer\(/);
    const cut = spEntry('SP4b', 'SP4c').split('\n').find((l) => l.startsWith('- **Cut line:**'));
    expect(cut).toBe('- **Cut line:** deferred reclamation\'s primitive (→ SP5). It was not taken: deferred reclamation shipped in SP4b, so nothing moved.');
    expect(text).toContain('SP4b deferred-reclamation primitive → SP5 (delivered in SP4b, so nothing moved);');
    // The pin that SP5 no longer carries the conditional moved to 'master spec amendments (SP5a §9)' (the split).
  });
});

describe('master spec amendments (SP4c §12)', () => {
  /** [§1 entry head, the token its entry holds, the file on disk]; Tasks 6, 12, 15, 17 and 18 append theirs. */
  const SP4C_MODULES: Array<[head: RegExp, token: string, file: string]> = [
    [/^\s+coordinator\.ts /, 'jobHeap.ts (SP4c)', 'src/engine/jobHeap.ts'],
    [/^\s+ui\/map\/\* /, 'mapTool.ts', 'src/ui/map/mapTool.ts'],
    [/^\s+ui\/world\/\* /, 'mapOverlay.ts', 'src/ui/world/mapOverlay.ts'],
    [/^\s+ui\/world\/\* /, 'teleport.ts', 'src/ui/world/teleport.ts'],
    [/^\s+ui\/world\/\* /, 'applyControl.ts', 'src/ui/world/applyControl.ts'],
  ];

  test('§3.7\'s Teleport and caching lines: 24 above the 3D surface or the water, no cache (SP4c spec §3.2, §12)', () => {
    const at = text.indexOf('### 3.7 surfaceEstimate and surfaceWaterLevel');
    const s37 = text.slice(at, text.indexOf('### 3.8 ', at));
    const caching = s37.split('\n').find((l) => l.startsWith('- Caching on the quart lattice comes with its first consumer'));
    expect(caching, 'no `- Caching on the quart lattice …` line in §3.7').toBeDefined();
    expect(caching).toContain('(aquifers, structures: SP6-SP9; spawn and teleport query one point each and need none, SP4c)');
    expect(caching).not.toContain('SP4c-SP9');
    expect(s37).toContain('- **Teleport** (SP4c): in flight, the camera at max(surface, surfaceWaterLevel) + 24, at most 400, the yaw and pitch kept, where surface is max(⌊surfaceEst⌋, `surfaceEst3`) whenever the density tree has a `terrain` tap (the default tree included), else ⌊surfaceEst⌋, from one worker query before the terrain exists (the 3D estimate, so the arrival is never inside a jagged peak; the spawn keeps its own rule); in walk mode (SP5a) the feet at that surface + 1, the look direction kept, snapped to `MOTION_BLOCKING` once the column is published; while unloaded, the player hovers.');
    expect(s37).not.toContain('surfaceEst + 2');
  });

  test('§5.6\'s click, saved places and streaming, and §5.9\'s M: the world\'s overlay (SP4c spec §2, §3.1, §12)', () => {
    const at56 = text.indexOf('### 5.6 Map view');
    const s56 = text.slice(at56, text.indexOf('### 5.7 ', at56));
    expect(s56).toContain('**Click** teleports (3.7) (SP4c: in the world\'s map a plain click teleports, except while the cut tool is armed; Shift+click sets the pin or the slice centre; on `?map` a click sets the pin).');
    // The saved-places phrase moved to 'master spec amendments (SP5b §9)', which extends it.
    expect(s56).not.toContain('bookmarks per save');
    expect(s56).toContain('The 3D view keeps streaming at reduced priority while the map is open (SP4c: in mode A, map open; in mode B the 3D streams first and the map\'s jobs are capped as §4.3).');
    const at59 = text.indexOf('### 5.9 Controls');
    const s59 = text.slice(at59, text.indexOf('## 6. ', at59));
    expect(s59).toContain('M (map: SP4c\'s overlay, full screen or side by side);');
    expect(s59).not.toContain('M (map);');
  });

  test('§1\'s ui/map/* line: the map tool both ?map and the world\'s M overlay mount (SP4c spec §1.1, §12)', () => {
    const entry = layoutEntry(/^\s+ui\/map\/\* /);
    expect(entry).toContain('(SP4c: `mapTool.ts`, the tool both `?map` and the world\'s M overlay mount)');
    expect(entry).toContain('the standalone ?map page (mounted in-game from SP4c)');
  });

  test('§10\'s SP4c entry, SP10 without bookmarks', () => {
    const sp4c = spEntry('SP4c', 'SP5a');
    expect(sp4c.startsWith('**SP4c — The map in the world and live editing** (L; SP4b). Spec: `2026-10-25-sp4c-map-in-world-design.md`'), 'the SP4c header').toBe(true);
    expect(sp4c).toContain('- **Deliverable:** teleport from the map and edit the world live in both modes.');
    // The entry's contents line, whole (final review GOV-6: spec §10 pins the header and the entry).
    expect(sp4c.split('\n'), 'the SP4c entry\'s contents line').toContain('- The map tool shared by `?map` and the M overlay; teleport (instant, no loading screen, nearest-first, 24 blocks above the surface or the water); Apply v1 live (one pool, the world holding while the pool holds an unapplied draft; the per-column epoch as the interned genKey; stale columns freed and regenerated nearest-first while their old meshes stay shown; the renderers\' swap; `invalidation.ts`); undo and redo live; the two editing modes, remembered (A full screen with "Watch live", B side by side); the pool\'s two lanes with the MAP cap by visibility.');
    expect(sp4c).toContain('**Exit:** as the SP4c spec §14');
    expect(sp4c.split('\n').some((l) => l.startsWith('- **Cut line:** the climate-grid cache and the map\'s regeneration readout (→ SP10)')), 'the SP4c entry has no `- **Cut line:** the climate-grid cache and the map\'s regeneration readout (→ SP10)` line').toBe(true);
    // SP5's walk-mode teleport and saved places moved to 'master spec amendments (SP5a §9)' (SP5a and SP5b since the split).
    const layers = /complete map layers \(([^)]*)\)/.exec(spEntry('SP10', 'SP11'));
    expect(layers, 'SP10 has no `complete map layers (…)` list').not.toBeNull();
    expect(layers![1]).not.toContain('bookmarks');
  });

  test('§2.3\'s epoch cell: Apply is one configure (SP4c)', () => {
    const cell = text.split('\n').find((l) => l.startsWith('**Epoch cell.**'));
    expect(cell, 'no `**Epoch cell.**` paragraph').toBeDefined();
    expect(cell).toContain('SP4b wires them in place of SP2b\'s pool-wide cell (every job carries its configure generation and its phase\'s cell value at issue, `scope`, and stops when the cell moves; `configure` stores the generation into all four; Apply is one `configure`, which moves all four cells past every value a job was issued with; every SP4c leaf is terrain- or climate-scope, so `bumpScope` from the dirty stage waits for SP8b\'s decorate-scope Apply, SP4c)');
    expect(cell).toContain('(amended by SP3a, SP4a, SP4b and SP4c)');
  });

  test('§4.1, §4.2, §5.1 and risk 1 say how SP4c applies (SP4c spec §4.5, §12)', () => {
    const at41 = text.indexOf('### 4.1 Thread topology and ownership');
    const s41 = text.slice(at41, text.indexOf('### 4.2 ', at41));
    expect(s41).toContain('- Mesh jobs and the main thread only read (SP4b: the main thread frees unloaded columns and protos, at zero reader pins; `T(protoOnly)` rewrites only the proto descriptors and alive bit of a Decorated or Published column, never its final set; the sim worker\'s ownership, SP5a, is of the final set; SP4c\'s Apply frees a stale column at zero pins and regenerates it from T, rewriting no Published final set, so the sim worker (SP5a) stays its first writer).');
    const at42 = text.indexOf('### 4.2 Column state machine');
    const s42 = text.slice(at42, text.indexOf('### 4.3 ', at42));
    const swap = s42.split('\n').find((l) => l.startsWith('- **Re-generation swaps atomically too.**'));
    expect(swap, 'no `- **Re-generation swaps atomically too.**` bullet in §4.2').toBeDefined();
    expect(swap).toContain('(SP4c: the column\'s voxels are freed and regenerated while its old meshes stay shown; a column whose epoch, the interned genKey of its T\'s draft, equals the applied one is kept)');
    const at51 = text.indexOf('### 5.1 Parameter model');
    const s51 = text.slice(at51, text.indexOf('### 5.2 ', at51));
    for (const phrase of [
      'An explicit button, or auto-apply with a 500 ms debounce (SP4c: auto-apply only: a draft is applied once its configure resolved, nothing newer waits, no gesture is open and 150 ms passed since the last change).',
      'Meshing waits until all 3×3 columns share the epoch (SP4c: the column\'s epoch is the interned genKey of its T\'s draft; D and L wait the same way).',
      'per-stage progress (`stale/total`) (SP10; SP4c shows the stale count in the HUD).',
      '**Since SP4c** the world applies the session\'s drafts live (the SP4c spec §4); the map previews each draft on the same pool, and the world holds during a gesture. The session\'s gestures and urgent commits are the hooks Apply and SP5b\'s world-modification mode attach to (the fork dialog is replaced, the SP5a spec\'s split).',
    ]) expect(s51, `§5.1 does not say ${phrase}`).toContain(phrase);
    expect(s51).not.toContain('**Until SP4c**');
    const at8 = text.indexOf('## 8. Risks');
    const risk1 = text.slice(at8, text.indexOf('\n2. ', at8));
    const kill = risk1.split('\n').find((l) => l.trimStart().startsWith('- Kill:'));
    expect(kill, 'risk 1 has no `- Kill:` line').toBeDefined();
    expect(kill).toContain('(amended by SP4b: the split moved Apply\'s rewrites of Published columns to SP4c, and SP5a\'s sim worker is deferred reclamation\'s first necessary consumer; SP4c\'s Apply frees and regenerates instead of rewriting)');
  });

  test('§4.3\'s caps line: the MAP cap by visibility and the pool\'s two lanes (SP4c spec §6, §12)', () => {
    const at = text.indexOf('### 4.3 Scheduling');
    const s43 = text.slice(at, text.indexOf('### 4.4 ', at));
    const caps = s43.split('\n').find((l) => l.startsWith('- LOD, MAP, SLICE, METRIC and AUDIO_SYNTH ≤ 1 while any T is pending within RD'));
    expect(caps, 'no `- LOD, MAP, SLICE, METRIC and AUDIO_SYNTH ≤ 1 …` line in §4.3').toBeDefined();
    expect(caps).toContain('(SP4c: while the 3D is visible; while the map covers the 3D, map jobs go first and the world streams on the workers left; points, landing and probes go first and are not capped; the pool keeps world jobs in a FIFO lane and the rest in a heap)');
  });

  test('§4.2\'s Unload and §4.3\'s Uploads: emptied regions go at once, releases share the rows with uploads (SP4c spec §5.4, §12)', () => {
    const at42 = text.indexOf('### 4.2 Column state machine');
    const s42 = text.slice(at42, text.indexOf('### 4.3 ', at42));
    const unload = s42.split('\n').find((l) => l.startsWith('**Unload.**'));
    expect(unload, 'no `**Unload.**` paragraph in §4.2').toBeDefined();
    expect(unload).toContain('(SP4c: a region left with no column is disposed at once, outside the row cap and the structural slot)');
    const at43 = text.indexOf('### 4.3 Scheduling');
    const s43 = text.slice(at43, text.indexOf('### 4.4 ', at43));
    const uploads = s43.split('\n').find((l) => l.startsWith('**Uploads**'));
    expect(uploads, 'no `**Uploads**` paragraph in §4.3').toBeDefined();
    expect(uploads).toContain('(SP4c: at most half the row cap on releases while an upload waits)');
  });

  test('§6.4\'s R7 row names the Apply part and THRESHOLDS holds it (SP4c spec §8.1-§8.2, §12; SP4b\'s pin moved here)', () => {
    const r7 = text.split('\n').find((l) => l.startsWith('| R7 |'));
    expect(r7, 'no R7 row in §6.4').toBeDefined();
    expect(r7).toContain('atomic reveal during the bench flight (SP4b: `partialColumnFrames`, from the streaming metric\'s scripted flight in Node; the bench records the same probe)');
    expect(r7).toContain('and a terrain Apply (SP4c: `applyPartialColumnFrames` and `mixedEpochFrames`, from the Apply metric\'s scripted edits and teleport in Node)');
    expect(r7).toContain('| 0 (the flight part SP4b, the Apply part SP4c) |');
    expect(Object.keys(THRESHOLDS.R7 ?? {})).toEqual(['partialColumnFrames', 'applyPartialColumnFrames', 'mixedEpochFrames']);
    expect(THRESHOLDS.R7?.partialColumnFrames).toEqual({ max: 0, activeFrom: 'SP4b' });
    expect(THRESHOLDS.R7?.applyPartialColumnFrames).toEqual({ max: 0, activeFrom: 'SP4c' });
    expect(THRESHOLDS.R7?.mixedEpochFrames).toEqual({ max: 0, activeFrom: 'SP4c' });
  });

  test('§6.4\'s G1 row names the live parts THRESHOLDS holds activeFrom SP4c', () => {
    const g1 = text.split('\n').find((l) => l.startsWith('| G1 |'));
    expect(g1, 'no G1 row in §6.4').toBeDefined();
    expect(g1).toContain('SP4c gates the Medium live cells (p95, no frame > 33 ms, GPU estimate) over the bench\'s Apply, undo and teleport legs, and re-asserts SP4a\'s and SP4b\'s cells on SP4c\'s code');
    // The three live parts and the G1 row's targets they gate (SP4c spec §8.2).
    const parts: Array<[part: string, max: number, target: string]> = [
      ['mediumLiveP95', 16.7, 'p95 ≤ 16.7 ms'],
      ['mediumLiveOver33', 0, 'no frame > 33 ms'],
      ['mediumLiveGpuMB', 150, 'GPU estimate ≤ 150 MB'],
    ];
    for (const [part, max, target] of parts) {
      expect(THRESHOLDS.G1?.[part], `THRESHOLDS.G1.${part}`).toEqual({ max, activeFrom: 'SP4c' });
      expect(g1, `the G1 row's target ${target}`).toContain(target);
    }
    expect(Object.keys(THRESHOLDS.G1 ?? {}).filter((p) => THRESHOLDS.G1?.[p]?.activeFrom === 'SP4c').sort()).toEqual(parts.map(([p]) => p).sort());
  });

  test('§6.4\'s G2 row and §7\'s terrain Apply line: SP4c records the Apply part, SP10 gates it (SP4c spec §8.2, §8.4, §12)', () => {
    const g2 = text.split('\n').find((l) => l.startsWith('| G2 |'));
    expect(g2, 'no G2 row in §6.4').toBeDefined();
    expect(g2).toContain('terrain Apply: first visible change near the player (SP4c records the Apply part from the bench; SP10 gates it)');
    const apply = text.split('\n').find((l) => l.startsWith('- terrain Apply: first visible change near the player'));
    expect(apply, 'no terrain Apply line in §7').toBeDefined();
    expect(apply).toContain('≤ 0.5 s (recorded from SP4c\'s bench; gated by SP10)');
    // SP5a gates G2's edit part (SP5a spec §6.2), SP5b its flush parts (G2.flush, pinned in the SP5b block); the Apply
    // part has no gated part before SP10.
    expect(Object.keys(THRESHOLDS.G2 ?? {}).filter((p) => THRESHOLDS.G2?.[p]?.activeFrom !== 'SP5b'), 'G2 has no gated Apply part before SP10').toEqual(['editVisibleP95']);
  });

  test('§1\'s test entry lists SP4c\'s test files in their own parentheses, which exist (SP4c spec §8.5, §12)', () => {
    const entry = layoutEntry(/^\s+test\/ unit\/ metrics\//);
    expect(entry).toContain('(SP4c: metrics/apply.metric.ts, integration/apply.test.ts)');
    const named = /\(SP4c: ([^)]*)\)/.exec(entry)![1]!.split(/,\s*/).map((f) => f.trim());
    expect(named).toEqual(['metrics/apply.metric.ts', 'integration/apply.test.ts']);
    for (const f of named) expect(existsSync(`${ROOT_DIR}test/${f}`), `test/${f} does not exist`).toBe(true);
    // SP4b's list still reads alone.
    expect(/\(SP4b: ([^)]*)\)/.exec(entry)![1]).not.toContain('SP4c');
  });

  test('§1 names each SP4c module in its entry, which exists', () => {
    for (const [head, token, file] of SP4C_MODULES) {
      const entry = layoutEntry(head);
      expect(entry, `§1 has no entry matching ${head}`).not.toBe('');
      expect(entry, `§1's ${head} entry does not name ${token}`).toContain(token);
      expect(existsSync(`${ROOT_DIR}${file}`), `${file} does not exist`).toBe(true);
    }
  });

  test('the readout was built and the cache was not, so SP4c\'s cut line moves the cache to SP10 alone (SP4c spec §6.4, §13)', () => {
    // Built: the overlay's header writes the readout (SP4c spec §2.1, §13).
    expect(readFileSync(`${ROOT_DIR}src/ui/world/mapOverlay.ts`, 'utf8')).toContain('readout.textContent = `Regenerating ${stale} / ${readNeeded}`');
    // Not built: no module under src/ names a climate grid (SP2b spec §2.9's per-worker cache).
    const src = readdirSync(`${ROOT_DIR}src`, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const f of src) expect(readFileSync(`${ROOT_DIR}src/${f}`, 'utf8'), `src/${f} names a climate grid`).not.toMatch(/climate.?grid/i);
    const cut = spEntry('SP4c', 'SP5a').split('\n').find((l) => l.startsWith('- **Cut line:**'));
    expect(cut).toBe('- **Cut line:** the climate-grid cache and the map\'s regeneration readout (→ SP10). The readout was not cut: it shipped in SP4c. The climate-grid cache moved to SP10: in the production check the in-world preview landed within 160 ms of each edit in mode B, against the SP4c spec §6.4\'s 500 ms, and the user found the map in mode B acceptable.');
    expect(text).toContain('SP4c climate-grid cache → SP10 (moved: the in-world preview\'s `lastLatencyMs` stayed within the SP4c spec §6.4\'s 500 ms and the user found the map in mode B acceptable); SP4c map\'s regeneration readout → SP10 (delivered in SP4c, so nothing moved);');
    const sp10 = spEntry('SP10', 'SP11').split('\n');
    const received = sp10.find((l) => l.startsWith('- Received from SP4c (its spec §6.4, §13; amended by SP4c):'));
    expect(received, 'SP10 has no "Received from SP4c" line').toBeDefined();
    expect(received).toContain('SP2b\'s climate-grid cache (a per-worker cache of the climate grid, the SP2b spec §2.9) for the map\'s preview while the world regenerates');
    expect(received).not.toContain('readout');
    expect(sp10.find((l) => l.startsWith('- **Exit:**'))).toContain('the climate-grid cache received from SP4c');
  });

  test('§1\'s ci.yml line names the metrics-fast shards beside the unit shards (SP4c spec §9\'s CI note)', () => {
    const entry = layoutEntry(/^\s+\.github\/workflows\/ci\.yml /);
    expect(entry).toContain('the two unit shards (`.github/scripts/unitShards.mjs`), the metrics-fast shards (`.github/scripts/fastShards.mjs`) and the metrics-quick shards (cached)');
    expect(entry).toContain('(amended 2026-10-20: parallel CI jobs; SP4b: the unit shards; SP4c: the metrics-fast shards)');
    expect(existsSync(`${ROOT_DIR}.github/scripts/fastShards.mjs`)).toBe(true);
  });
});

describe('master spec amendments (SP5a §9)', () => {
  /** [§1 entry head, the token its entry holds, the file on disk]; Tasks 2, 7-10, 20, 22, 23, 26-28, 31, 36, 38 and 45b append theirs. */
  const SP5A_MODULES: Array<[head: RegExp, token: string, file: string]> = [
    [/^\s+blocks\/kinds\.ts /, 'tags.ts (SP5a)', 'src/world/blocks/tags.ts'],
    [/^\s+light\/initial\.ts /, 'relight.ts (SP5a)', 'src/light/relight.ts'],
    [/^\s+sim\/fluidSim\.ts /, 'edits.ts diffStore.ts (SP5a)', 'src/sim/diffStore.ts'],
    [/^\s+sim\/fluidSim\.ts /, 'edits.ts diffStore.ts (SP5a)', 'src/sim/edits.ts'],
    [/^\s+workers\/protocol\.ts /, 'sim.worker.ts simHandler.ts (SP5a)', 'src/workers/sim.worker.ts'],
    [/^\s+coordinator\.ts /, 'simClient.ts (SP5a)', 'src/engine/simClient.ts'],
    [/^\s+mesh\/greedy\.ts /, 'boxes.ts (SP5a, provisional until SP8a)', 'src/mesh/boxes.ts'],
    [/^\s+blocks\/kinds\.ts /, 'provisionalBoxes.ts (SP5a, provisional until SP8a)', 'src/world/blocks/provisionalBoxes.ts'],
    [/^\s+player\/fly\.ts /, 'walk.ts physics.ts raycast.ts interaction.ts hotbar.ts sprintTap.ts (SP5a)', 'src/player/raycast.ts'],
    [/^\s+player\/fly\.ts /, 'walk.ts physics.ts raycast.ts interaction.ts hotbar.ts sprintTap.ts (SP5a)', 'src/player/interaction.ts'],
    [/^\s+player\/fly\.ts /, 'walk.ts physics.ts raycast.ts interaction.ts hotbar.ts sprintTap.ts (SP5a)', 'src/player/hotbar.ts'],
    [/^\s+player\/fly\.ts /, 'walk.ts physics.ts raycast.ts interaction.ts hotbar.ts sprintTap.ts (SP5a)', 'src/player/walk.ts'],
    [/^\s+player\/fly\.ts /, 'walk.ts physics.ts raycast.ts interaction.ts hotbar.ts sprintTap.ts (SP5a)', 'src/player/physics.ts'],
    [/^\s+player\/fly\.ts /, 'walk.ts physics.ts raycast.ts interaction.ts hotbar.ts sprintTap.ts (SP5a)', 'src/player/sprintTap.ts'],
    [/^\s+ui\/world\/\* /, 'buildHud.ts blockHistory.ts (SP5a)', 'src/ui/world/buildHud.ts'],
    [/^\s+ui\/world\/\* /, 'buildHud.ts blockHistory.ts (SP5a)', 'src/ui/world/blockHistory.ts'],
    [/^\s+renderer\.ts /, 'selection.ts (SP5a)', 'src/render/selection.ts'],
    [/^\s+ui\/shell\.ts /, 'palette.ts (SP5a)', 'src/ui/palette.ts'],
    [/^\s+test\/ unit\/ metrics\//, '(SP5a: metrics/edit.metric.ts, integration/edit.test.ts)', 'test/metrics/edit.metric.ts'],
    [/^\s+test\/ unit\/ metrics\//, '(SP5a: metrics/edit.metric.ts, integration/edit.test.ts)', 'test/integration/edit.test.ts'],
  ];

  test('the split', () => {
    expect(text).toContain('SP5 was split on 2026-10-27 into SP5a (build and walk), SP5b (saved worlds) and SP5c (the selection tool), proposed in brainstorming because it grew past M and accepted by the user ("Vamos con esta partición")');
    const sp5a = spEntry('SP5a', 'SP5b');
    expect(sp5a.startsWith('**SP5a — Build and walk** (L; SP4b, SP4c). Spec: `2026-10-27-sp5a-build-and-walk-design.md`'), 'the SP5a header').toBe(true);
    expect(sp5a).toContain('**Deliverable:** build and walk in the world; edits kept for the session.');
    expect(sp5a).toContain('**Exit:** as the SP5a spec §12');
    expect(sp5a).toContain('walk mode\'s teleport (the SP4c spec §3.5)');
    expect(sp5a.split('\n').some((l) => l.startsWith('- **Cut line:** palette search (→ SP10)')), 'the SP5a entry has no `- **Cut line:** palette search (→ SP10)` line').toBe(true);
    // Moved from the SP4b block: SP5a does not carry the old SP5 entry's conditional either.
    expect(sp5a).not.toContain('If SP4b\'s cut line moved');
    expect(spEntry('SP5c', 'SP6').startsWith('**SP5c — The selection tool** (M; SP5b)'), 'the SP5c header').toBe(true);
    expect(text).toContain('SP4b deferred-reclamation primitive → SP5 (delivered in SP4b, so nothing moved);');
    const critical = text.split('\n').find((l) => l.startsWith('Critical path: '));
    expect(critical).toContain('SP4c → SP5a → SP5b → SP5c → SP6');
  });

  test('SP7 hands swimming and the buckets to SP5a; SP10 and SP8b receive from SP5a', () => {
    const sp7 = spEntry('SP7', 'SP8a');
    expect(sp7).not.toContain('swimming');
    expect(sp7).not.toContain('the empty bucket');
    expect(spEntry('SP10', 'SP11').split('\n').some((l) => l.startsWith('- Received from SP5a (its spec §10; amended by SP5a): sneaking')), 'SP10 has no "Received from SP5a" line').toBe(true);
    expect(spEntry('SP8b', 'SP8c').split('\n').some((l) => l.startsWith('- Received from SP5a (its spec §10, D20, D23):')), 'SP8b has no "Received from SP5a" line').toBe(true);
  });

  test('§0.7, §2.5\'s setLight and §3.7 name SP5a and SP5c', () => {
    expect(text).toContain('region editing tools beyond SP5c\'s selection tool (sphere fill, brushes)');
    const setLight = text.split('\n').find((l) => l.trimStart().startsWith('setLight(sy:number'));
    expect(setLight, 'no `setLight(sy:number …` line in §2.5').toBeDefined();
    expect(setLight).toContain('SP5a\'s relight');
    const at = text.indexOf('### 3.7 surfaceEstimate and surfaceWaterLevel');
    expect(text.slice(at, text.indexOf('### 3.8 ', at))).toContain('in walk mode (SP5a)');
  });

  test('the SP8a header runs in parallel with SP5a-SP7 and needs SP5a for boxes', () => {
    const sp8a = spEntry('SP8a', 'SP8b');
    expect(sp8a).toContain('in parallel with SP5a-SP7');
    expect(sp8a).toContain('SP5a for collision/raycast/orientation against boxes');
  });

  test('the split\'s other §10 lines, §2.3 and §4.12\'s deferred parts (SP5a spec §9; risk 1\'s Kill line moved to the SP5b block)', () => {
    expect(spEntry('SP6', 'SP7').startsWith('**SP6 — Caves, carvers and cave biomes** (L; SP3c, SP5c; walking for in-game review from SP5a)'), 'the SP6 header').toBe(true);
    expect(spEntry('SP7', 'SP8a').startsWith('**SP7 — Water and fluids** (L; SP6, SP5a)'), 'the SP7 header').toBe(true);
    expect(spEntry('SP8c', 'SP9').startsWith('**SP8c — Audio** (M; SP7, SP5a;'), 'the SP8c header').toBe(true);
    expect(spEntry('SP8a', 'SP8b')).toContain('the replacement of SP5a\'s provisional boxes, glass frame and log-end layer');
    expect(spEntry('SP4a', 'SP4b')).toContain('(the full start and worlds menu is SP5b\'s)');
    const parallel = text.split('\n').find((l) => l.startsWith('In parallel: '));
    expect(parallel).toContain('its shape collision/raycast parts after SP5a');
    const visible = text.split('\n').find((l) => l.startsWith('Visible value in every SP: '));
    expect(visible).toContain('building and walking in SP5a, saved worlds in SP5b, the selection tool in SP5c');
    expect(visible).toContain('→ IDB → reload in SP3a-SP5b');
    const reclamation = text.split('\n').find((l) => l.startsWith('**Reclamation.**'));
    expect(reclamation).toContain('SP5a\'s sim worker 15');
    expect(reclamation).not.toMatch(/\bSP5's/);
    const at412 = text.indexOf('### 4.12 ');
    const s412 = text.slice(at412, text.indexOf('### 4.13 ', at412));
    expect(s412).toContain('schedules fluid ticks for the 6 neighbours (SP7)');
    expect(s412).toContain('RMB on a door, trapdoor or fence gate toggles `open` (both door halves) instead of placing (SP8a)');
    expect(s412).toContain('(two entries for doors and double plants, applied atomically; SP8a)');
  });

  test('§2.2\'s box-model, tags, ice and enum-code lines name SP5a (SP5a spec §9)', () => {
    const at = text.indexOf('### 2.2 ');
    const s22 = text.slice(at, text.indexOf('### 2.3 ', at));
    expect(s22).toContain('(SP5a: torch, wall torch and ladder use SHAPE box with provisional boxes and FULL_FACES 0, so a torch\'s light leaves its voxel)');
    expect(s22).toContain('in SP5a, in `tags.ts`, with `SLIPPERY` and `CLIMBABLE`');
    expect(s22).not.toContain('`category` in SP5,');
    expect(s22).toContain('(SP5a appends `ice`)');
    expect(s22).toContain(', wool 12 (SP5a; a value list only appends, and no code changes)');
  });

  test('§2.5\'s interface ColumnWriter names replaceBlocks and setDiffFlag (SP5a spec §2.2, §2.5, §9)', () => {
    const at = text.indexOf('interface ColumnWriter {');
    expect(at, 'no `interface ColumnWriter {` in §2.5').toBeGreaterThanOrEqual(0);
    const writer = text.slice(at, text.indexOf('interface ProtoWriter', at));
    expect(writer).toContain('replaceBlocks(sy:number, blocks:Uint16Array, fluid:Uint8Array): void /* copy-on-write, blocks and fluid only (SP5a) */');
    expect(writer).toContain('setDiffFlag(): void /* REC_DIFF_FLAG (SP5a) */');
  });

  test('§2.7\'s generated value is read from the retained proto (SP5a spec §2.4, D20, §9)', () => {
    const at = text.indexOf('### 2.7 ');
    const s27 = text.slice(at, text.indexOf('## 3. Generation', at));
    expect(s27).toContain('so reverting removes the entry (SP5a: an edit equal to the column\'s current generated value, read from its retained proto, removes the entry)');
  });

  test('risk 7 names SP5a\'s edit gate in place of the edits-during-light fuzz (SP5a spec §2.1, §9)', () => {
    const at8 = text.indexOf('## 8. Risks');
    const risk7 = text.slice(at8).split('\n').find((l) => l.startsWith('7. '));
    expect(risk7, 'no risk 7 in §8').toBeDefined();
    expect(risk7).toContain('edits never run beside a light job that reads them (SP5a\'s edit gate), and L3 checks incremental against full light after random edits');
    expect(risk7).not.toContain('edits-during-light fuzz');
  });

  test('§4.17\'s Fly line and §5.9 name SP5a\'s wheel, Ctrl+wheel and Ctrl+Z / Ctrl+Y (SP5a spec §4.1, §4.5, §9)', () => {
    const at417 = text.indexOf('### 4.17 Player');
    const fly = text.slice(at417, text.indexOf('### 4.18 ', at417)).split('\n').find((l) => l.startsWith('- **Fly:**'));
    expect(fly, 'no `- **Fly:**` line in §4.17').toBeDefined();
    expect(fly).toContain('until SP5a\'s hotbar took the wheel; Ctrl+wheel and `+`/`-` since SP5a');
    expect(fly).not.toContain('SP5 choosing its modifier');
    const at59 = text.indexOf('### 5.9 Controls');
    const s59 = text.slice(at59, text.indexOf('## 6. ', at59));
    expect(s59).toContain('Ctrl+Z / Ctrl+Y (blocks while the world owns the controls, the map\'s settings while the map does; SP5a)');
    expect(s59).toContain('1-9 and wheel (hotbar), Ctrl+wheel and `+`/`-` (fly speed)');
    expect(s59.match(/\(fly speed\)/g), '§5.9 names the fly speed once').toHaveLength(1);
  });

  test('§4.17\'s Fly line and §5.9 name the sprint on R or a double-tapped W, not Ctrl (Task 45b: Ctrl+W closes the tab; SP5a spec §9)', () => {
    const at417 = text.indexOf('### 4.17 Player');
    const fly = text.slice(at417, text.indexOf('### 4.18 ', at417)).split('\n').find((l) => l.startsWith('- **Fly:**'));
    expect(fly, 'no `- **Fly:**` line in §4.17').toBeDefined();
    expect(fly).toContain('sprint ×4 on R or a double-tapped W (SP5a; Ctrl until then)');
    expect(fly).not.toContain('Ctrl sprint');
    const at59 = text.indexOf('### 5.9 Controls');
    const s59 = text.slice(at59, text.indexOf('## 6. ', at59));
    expect(s59).toContain('R or double-tap W (sprint; SP5a, Ctrl+W closes the tab)');
    expect(s59).not.toContain('Ctrl (sprint)');
  });

  test('§4.12\'s Actions name the body in flight and hold to repeat (SP5a spec §4.1, §4.2, D6, §9)', () => {
    const at412 = text.indexOf('### 4.12 ');
    const s412 = text.slice(at412, text.indexOf('### 4.13 ', at412));
    const actions = s412.split('\n').find((l) => l.startsWith('**Actions.**'));
    expect(actions, 'no `**Actions.**` line in §4.12').toBeDefined();
    expect(actions).toContain('(SP5a: the player\'s body counts in flight too; one action per click, or, with the \'Hold mouse button to repeat\' setting, repeated while held: break every 0.3 s, place every 0.2 s)');
  });

  test('§4.17\'s Walk lines name the in-water gravity, lava, the unstuck rule, the 20 Hz values and SLIPPERY (SP5a spec §3.2, D2-D5, D29, §9)', () => {
    const at417 = text.indexOf('### 4.17 Player');
    const s417 = text.slice(at417, text.indexOf('### 4.18 ', at417)).split('\n');
    const walk = s417.findIndex((l) => l.startsWith('- **Walk:**'));
    expect(walk, 'no `- **Walk:**` line in §4.17').toBeGreaterThanOrEqual(0);
    const lines: string[] = [];
    for (let i = walk + 1; i < s417.length && s417[i]!.startsWith('  - '); i++) lines.push(s417[i]!);
    const swim = lines.find((l) => l.startsWith('  - swimming:'));
    expect(swim).toBe('  - swimming: fluids never collide, in-water gravity 0.005 per tick and drag 0.8 (SP5a, its Point 5; the alternative: a 0.005 lift while the eye is under water); lava: gravity 0.02, drag 0.5;');
    expect(lines.join('\n')).not.toContain('buoyancy');
    expect(lines).toContain('  - unstuck scan upward at F, after a teleport and on any tick the body intersects a colliding block (SP5a); near plane 0.05;');
    expect(lines.join('\n')).not.toContain('unstuck scan upward at spawn');
    expect(lines[lines.length - 1]).toBe('  - the SP5a spec §3.2\'s per-tick values at a fixed 20 Hz; `SLIPPERY` blocks (ice, packed ice) slip 0.98.');
  });

  test('§6.4\'s E1-E6 row splits edit→unload→reload between SP5a and SP5b (SP5a spec §6.1, §9)', () => {
    const e = text.split('\n').find((l) => l.startsWith('| E1-E6 |'));
    expect(e, 'no E1-E6 row in §6.4').toBeDefined();
    expect(e).toContain('edit→unload→reload returns the latest diff (the session part SP5a, the flush part SP5b)');
  });

  test('§6.4\'s G2 row and §4.12\'s Target: the edit part gated from SP5a\'s bench leg L10 (SP5a spec §6.2, D26, §9)', () => {
    const g2 = text.split('\n').find((l) => l.startsWith('| G2 |'));
    expect(g2, 'no G2 row in §6.4').toBeDefined();
    expect(g2).toContain('edit → visible p95 (the edit part gated from SP5a\'s bench leg L10)');
    expect(g2, 'the G2 row\'s edit target').toContain('≤ 50 ms');
    const at412 = text.indexOf('### 4.12 ');
    const s412 = text.slice(at412, text.indexOf('### 4.13 ', at412));
    const target = s412.split('\n').find((l) => l.startsWith('Target:'));
    expect(target, 'no `Target:` line in §4.12').toBeDefined();
    expect(target).toContain('(SP5a: gated from the bench\'s L10)');
    expect(THRESHOLDS.G2?.editVisibleP95, 'THRESHOLDS.G2.editVisibleP95').toEqual({ max: 50, activeFrom: 'SP5a' });
  });

  test('§1 names each SP5a module in its entry, which exists', () => {
    for (const [head, token, file] of SP5A_MODULES) {
      const entry = layoutEntry(head);
      expect(entry, `§1 has no entry matching ${head}`).not.toBe('');
      expect(entry, `§1's ${head} entry does not name ${token}`).toContain(token);
      expect(existsSync(`${ROOT_DIR}${file}`), `${file} does not exist`).toBe(true);
    }
  });

  test('§4.13\'s read-through passes the D job\'s diff, cloned with the decorate message (SP5a spec §2.5, §9)', () => {
    const at = text.indexOf('### 4.13 ');
    const readThrough = text.slice(at, text.indexOf('### 4.14 ', at)).split('\n').find((l) => l.startsWith('- **Read-through:**'));
    expect(readThrough, 'no `- **Read-through:**` line in §4.13').toBeDefined();
    expect(readThrough).toContain('passes it in the job (SP5a: cloned with the decorate message; only the sim\'s diff reply is transferred)');
    expect(readThrough).not.toContain('transfers it in the job');
  });

  test('palette search was built, so SP5a\'s cut line was not taken and nothing moved to SP10 (SP5a spec §11)', () => {
    // Built: the palette's search box filters its groups by the typed text (SP5a spec §4.4).
    const palette = readFileSync(`${ROOT_DIR}src/ui/palette.ts`, 'utf8');
    expect(palette).toContain('search.type = \'search\';');
    expect(palette).toContain('paletteGroups(search.value)');
    const cut = spEntry('SP5a', 'SP5b').split('\n').find((l) => l.startsWith('- **Cut line:**'));
    expect(cut).toBe('- **Cut line:** palette search (→ SP10). It was not taken: palette search shipped in SP5a, so nothing moved.');
    expect(text).toContain('SP5a palette search → SP10 (delivered in SP5a, so nothing moved);');
    const received = spEntry('SP10', 'SP11').split('\n').find((l) => l.startsWith('- Received from SP5a (its spec §10; amended by SP5a):'));
    expect(received, 'SP10 has no "Received from SP5a" line').toBeDefined();
    expect(received).not.toContain('palette search if');
    expect(received).toContain('Palette search, SP5a\'s cut line, was delivered in SP5a, so nothing moved here.');
  });

  test('a bare SP5 is left only in the §10 split paragraph and the pinned historical receivers (SP5a spec §8)', () => {
    const kept = ['SP5 was split on '];
    const historical = ['SP4b deferred-reclamation primitive → SP5', '- **Cut line:** deferred reclamation\'s primitive (→ SP5)'];
    const bare = text.split('\n').filter((l) => /\bSP5\b/.test(l));
    for (const l of bare) {
      if (kept.some((k) => l.startsWith(k))) continue;
      const rest = historical.reduce((s, h) => s.split(h).join(''), l);
      expect(rest, `a bare SP5 outside the split and the historical receivers: ${l.slice(0, 120)}`).not.toMatch(/\bSP5\b/);
    }
    for (const k of kept) expect(bare.some((l) => l.startsWith(k)), `no line starts with ${k}`).toBe(true);
    for (const h of historical) expect(bare.some((l) => l.includes(h)), `no line holds ${h}`).toBe(true);
  });
});

describe('master spec amendments (SP5b §9)', () => {
  /** [§1 entry head, the token its entry holds, the file on disk]; Tasks 2, 3, 4, 6, 10, 12, 19, 20, 22, 24, 26, 27, 28 and 30 append theirs. */
  const SP5B_MODULES: Array<[head: RegExp, token: string, file: string]> = [
    [/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/kv.ts'],
    [/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/memory.ts'],
    [/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/kvContract.ts'],
    [/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/diffCodec.ts'],
    [/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/saves.ts'],
    [/^\s+persist\/kv\.ts /, 'idb.ts memory.ts kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/idb.ts'],
    [/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/stateBounds.ts'],
    [/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/autosave.ts'],
    [/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/worldLock.ts'],
    [/^\s+ui\/shell\.ts /, 'worldsMenu.ts settingsPanel.ts (SP5b)', 'src/ui/worldsMenu.ts'],
    [/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/wiworld.ts'],
    [/^\s+ui\/common\/\* /, 'files.ts (SP5b: downloadBlob, readBinaryFile)', 'src/ui/common/files.ts'],
    [/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/modifyMode.ts'],
    [/^\s+engine\/\s/, '(SP5b: session.ts\'s setWritable)', 'src/engine/session.ts'],
    [/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/places.ts'],
    [/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/placeDialog.ts'],
    [/^\s+ui\/map\/\* /, 'placesTab.ts (SP5b)', 'src/ui/map/placesTab.ts'],
    [/^\s+ui\/shell\.ts /, 'worldsMenu.ts settingsPanel.ts (SP5b)', 'src/ui/settingsPanel.ts'],
    [/^\s+test\/ unit\/ metrics\//, '(SP5b: metrics/persist.metric.ts)', 'test/metrics/persist.metric.ts'],
  ];

  test('§10\'s SP5b entry and its receivers (SP5b spec §9, §11)', () => {
    const sp5b = spEntry('SP5b', 'SP5c');
    expect(sp5b.startsWith('**SP5b — Saved worlds** (L; SP5a). Spec: `2026-10-29-sp5b-saved-worlds-design.md`'), 'the SP5b header').toBe(true);
    expect(sp5b).toContain('saved places as a section of each saved world\'s map');
    expect(sp5b).toContain('the Settings screen (G; Graphics and Controls)');
    expect(sp5b).toContain('**Exit:** as the SP5b spec §12 (E1-E4, E5\'s flush part, E6 as redefined there, E7; the failure criteria\'s gates `G2.flush` and `G1.enter`, with the SP5b spec\'s thresholds; the user\'s check)');
    expect(sp5b.split('\n').some((l) => l.startsWith('- **Cut line:** the Load list\'s place count ("· n places" on Load world\'s rows) (→ SP10)')), 'the SP5b entry has no `- **Cut line:** the Load list\'s place count` line').toBe(true);
    expect(text).toContain('SP5a palette search → SP10 (delivered in SP5a, so nothing moved); SP5b worlds-menu polish (the Load list\'s place count) → SP10');
    expect(spEntry('SP10', 'SP11').split('\n').some((l) => l.startsWith('- Received from SP5b (its spec §10; amended by SP5b): the preset library (master §2.7\'s `presets` store); touchpad sensitivity in Settings\' Controls tab (the SP4a spec :729)')), 'SP10 has no "Received from SP5b" line').toBe(true);
    const sp8c = spEntry('SP8c', 'SP9');
    expect(sp8c).toContain('Adds the **Audio** tab to SP5b\'s `ui/settingsPanel.ts`');
    expect(sp8c).toContain('(the `packs` store, by a `wi10` version bump)');
    expect(sp8c).not.toContain('Creates `ui/settingsPanel.ts`');
    expect(spEntry('SP11', 'SP12')).toContain('fills SP5b\'s Graphics tab: the quality preset and the greyed rows (fog distance, clouds, shadows)');
    expect(spEntry('SP5c', 'SP6')).toContain('(stored in IndexedDB `wi10`, its `meta` store or a store of its own by a version bump; a paste is one block-history step, which SP5b persists)');
  });

  test('§10\'s Exit names `G2.flush` and `G1.enter`, and THRESHOLDS holds their rows as SP5b spec §6.2 and §12 state them (SP5b spec §6.2, §12, D28)', () => {
    expect(spEntry('SP5b', 'SP5c')).toContain('the failure criteria\'s gates `G2.flush` and `G1.enter`, with the SP5b spec\'s thresholds');
    const sp5b = readFileSync(fileURLToPath(new URL('../../docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md', import.meta.url)), 'utf8');
    const flushRow = sp5b.split('\n').find((l) => l.startsWith('| saving stutters while building |'));
    expect(flushRow, 'no `saving stutters while building` row in SP5b §6.2').toBeDefined();
    const exitFlush = sp5b.split('\n').find((l) => l.startsWith('| saving does not stutter: `G2.flush`'));
    expect(exitFlush, 'no `G2.flush` criterion in SP5b §12').toBeDefined();
    // The five gated G2.flush parts: the §6.2 row's limit and the §12 criterion's, each equal to THRESHOLDS.
    const flush: Array<[part: string, max: number, row: string, exit: string]> = [
      ['over33Added', 1, '`over33Added` (the "on" parts\' sum − the "off" parts\') max 1', '`over33Added` ≤ 1'],
      ['p95AddedMs', 4.17, '`p95AddedMs` (the "on" parts\' mean p95 − the "off" parts\') max 4.17', '`p95AddedMs` ≤ 4.17'],
      ['editVisibleAddedMs', 8.33, '`editVisibleAddedMs` (the same difference of `editVisibleP95`) max 8.33', '`editVisibleAddedMs` ≤ 8.33'],
      ['flushEditVisibleP95', 50, '`flushEditVisibleP95` (the larger of the "on" parts\' `editVisibleP95`', '`flushEditVisibleP95` ≤ 50'],
      ['replyDuringFlushP95Ms', 5, '`replyDuringFlushP95Ms` max 5', '`replyDuringFlushP95Ms` ≤ 5'],
    ];
    for (const [part, max, row, exit] of flush) {
      expect(THRESHOLDS.G2?.[part], `THRESHOLDS.G2.${part}`).toEqual({ max, activeFrom: 'SP5b' });
      expect(flushRow, `SP5b §6.2's G2.flush ${part}`).toContain(row);
      expect(exitFlush, `SP5b §12's G2.flush ${part}`).toContain(exit);
    }
    expect(flushRow).toContain(') max 50 (G2)');
    // The sixth, `flushMainP95Ms` max 0.3, is held pending the user's check (D28): recorded by G2.flush, not a row, and
    // the Threshold log and the exit evidence say so.
    expect(flushRow).toContain('`flushMainP95Ms` max 0.3');
    expect(exitFlush).toContain('`flushMainP95Ms` ≤ 0.3');
    expect(THRESHOLDS.G2?.flushMainP95Ms, 'THRESHOLDS.G2.flushMainP95Ms is held pending the user\'s check').toBeUndefined();
    const log = sp5b.slice(sp5b.indexOf('## Threshold log'));
    expect(log).toContain('flushMainP95Ms max 0.3 (G2.flush) is held pending the user\'s check (D28, R10)');
    expect(sp5b.slice(0, sp5b.indexOf('## Threshold log'))).toContain('so `flushMainP95Ms` max 0.3 is held pending the user\'s check (D28, R10)');
    expect(Object.keys(THRESHOLDS.G2 ?? {}).filter((p) => THRESHOLDS.G2?.[p]?.activeFrom === 'SP5b').sort()).toEqual(flush.map(([p]) => p).sort());
    // G1.enter: `enterRatio` max 1.10.
    const enterRow = sp5b.split('\n').find((l) => l.startsWith('| entering a saved world clearly slower than a new one |'));
    expect(enterRow, 'no `entering a saved world` row in SP5b §6.2').toBeDefined();
    expect(enterRow).toContain('`G1.enter`: `enterRatio` = the median of the five kept pairs\' ratios (b) / (a), max 1.10');
    expect(sp5b).toContain('`G1.enter` `enterRatio` ≤ 1.10 against the same world opened unsaved at the same pose');
    expect(THRESHOLDS.G1?.enterRatio, 'THRESHOLDS.G1.enterRatio').toEqual({ max: 1.10, activeFrom: 'SP5b' });
    expect(Object.keys(THRESHOLDS.G1 ?? {}).filter((p) => THRESHOLDS.G1?.[p]?.activeFrom === 'SP5b')).toEqual(['enterRatio']);
  });

  test('§2.7\'s `ColumnDiffV1` header genKey is informative (SP5b spec D21, §9)', () => {
    const at = text.indexOf('### 2.7 ');
    const s27 = text.slice(at, text.indexOf('## 3. Generation', at));
    expect(s27.split('\n').some((l) => l === '- header `{v:1, genKey:u32x2, sections:u8}`, its genKey (informative: entries apply under any generator, SP5b);'), 'no informative-genKey header line in §2.7').toBe(true);
  });

  test('§2.7\'s `.wiworld` header is SP5b\'s: the format, the three records and the records by colKey (SP5b spec §2.4, D23, §9)', () => {
    const at = text.indexOf('### 2.7 ');
    const lines = text.slice(at, text.indexOf('## 3. Generation', at)).split('\n');
    const head = lines.indexOf('**Export `.wiworld`.** A gzip `CompressionStream` over:');
    expect(head, 'no `.wiworld` paragraph in §2.7').toBeGreaterThan(-1);
    expect(lines.slice(head + 1, head + 4)).toEqual([
      '- `"WI10"`, `u32 version` = 1, `u32 headerLen`;',
      '- header: UTF-8 canonical JSON `{format: \'wi10-world\', world, state, history}`: the `worlds` record without `id` (its `stateTable` describes the records\' ids), the `state` record without `worldId`, and the `history` record (SP5b);',
      '- records `i32 cx, i32 cz, u32 len, bytes`, one per edited column, sorted by colKey (the stored `ColumnDiffV1`, copied without decoding).',
    ]);
    expect(text).not.toContain('the world record, the full params and the block-state table');
  });

  test('§2.7\'s five IndexedDB stores and their records, the saved params over the profile; §2.2\'s `stateTable` kept equal to the ids on disk (SP5b spec §2.1, D16, D22, D33, §9)', () => {
    const at = text.indexOf('### 2.7 ');
    const s27 = text.slice(at, text.indexOf('## 3. Generation', at));
    const lines = s27.split('\n');
    expect(lines).toContain('**IndexedDB `wi10` v1** (five stores, split by how often they change; SP5b):');
    expect(lines.some((l) => l.startsWith('- `worlds`: key `id`, `{id, name, seedText, seed: [lo, hi], profile, params, schemaVersion, paramsHash, generatorVersion, genKey, stateTable: string[], created, backupOf: string | null}`')), 'no `worlds` record line in §2.7').toBe(true);
    expect(lines.some((l) => l.startsWith('- `state`: key `worldId`, `{worldId, flushSeq, updated, player: {x, y, z, yaw, pitch, mode, speed} | null, time: {t, speedIndex}, hotbar: {v: 1, active, slots}, places: Place[]}`')), 'no `state` record line in §2.7').toBe(true);
    expect(lines.some((l) => l.startsWith('- `history`: key `worldId`, `{worldId, done: Step[], undone: Step[]}`, each ≤ 100 steps')), 'no `history` record line in §2.7').toBe(true);
    expect(lines).toContain('- `diffs`: key `[worldId, colKey]`, `ColumnDiffV1` bytes;');
    expect(lines).toContain('- `meta`: empty in SP5b.');
    expect(s27).toContain('`packs` (resource-pack and sound-pack blobs plus manifests, with `kind: \'textures\'|\'sounds\'`) and `presets` are added by a `wi10` version bump when SP8c\'s sound packs and SP10\'s preset library need them (SP5b).');
    expect(s27).not.toContain('player:{pos,yaw,pitch,mode}');
    expect(s27).toContain('Saves and `.wiworld` store full params and load as migrate → applyPatch over `resolveProfile(profile)` (SP5b).');
    expect(s27).not.toContain('applyPatch over the defaults');
    const at22 = text.indexOf('### 2.2 ');
    const s22 = text.slice(at22, text.indexOf('### 2.3 ', at22));
    expect(s22).toContain('Each `worlds` record stores `stateTable` (the mapping at save time) (kept equal to the ids on disk: rewritten at an open whose table differs from today\'s, SP5b);');
  });

  test('§1\'s dependency rule: `persist/idb.ts` runs in the sim worker and, for the worlds menu, on the main thread (SP5b spec D17, §9)', () => {
    const lines = text.split('\n');
    expect(lines).toContain('- **Pure layers:** none of the layers above imports three, `document`, `window` or `indexedDB`. The exception is `persist/idb.ts`, which runs in the sim worker and, for the worlds menu, on the main thread (SP5b).');
  });

  test('§4.13\'s World open loads all of the world\'s diffs in one key-range read, and the Prefetch line is gone (SP5b spec D19, §9)', () => {
    const at = text.indexOf('### 4.13 ');
    const lines = text.slice(at, text.indexOf('### 4.14 ', at)).split('\n');
    expect(lines).toContain('- **World open:** the sim worker loads all of the world\'s diffs in one key-range read (SP5b; no prefetch).');
    expect(lines.some((l) => l.startsWith('- **Prefetch:**')), 'a `- **Prefetch:**` line is left in §4.13').toBe(false);
    expect(text).not.toContain('`getAllKeys`');
  });

  test('§4.13\'s Flush writes the dirty diffs, the `state` record and, when changed, the `history` record in one transaction (SP5b spec D16, D18, §9)', () => {
    const at = text.indexOf('### 4.13 ');
    const lines = text.slice(at, text.indexOf('### 4.14 ', at)).split('\n');
    expect(lines).toContain('- **Flush:** every 2 s, and on `visibilitychange` / `pagehide`, the sim worker writes all dirty diffs plus the `state` record (player, time, hotbar, places, `flushSeq`) and, when changed, the `history` record, in **one readwrite transaction**. Commit is confirmed by `oncomplete`, so at most 2 s of edits can be lost. `navigator.storage.persist()` is requested once.');
  });

  test('§4.17 restores the player\'s mode, position, yaw, pitch and flying speed per saved world, after Keys (SP5b spec D4, §3.4 step 5, §9)', () => {
    const at = text.indexOf('### 4.17 Player');
    const lines = text.slice(at, text.indexOf('### 4.18 ', at)).split('\n');
    const restored = lines.indexOf('- **Restored per saved world** (SP5b): the player\'s mode, position, yaw, pitch and flying speed.');
    expect(restored, 'no "Restored per saved world" bullet in §4.17').toBeGreaterThan(-1);
    expect(lines[restored - 1]).toBe('- **Keys:** cleared on blur, and ignored while focus is in a text input.');
  });

  test('§4.12\'s Block undo keeps the last 100 undo and 100 redo steps per world across reloads, and the hotbar persists in the `state` store (SP5b spec D6, §3.4 step 6, §9)', () => {
    const at412 = text.indexOf('### 4.12 ');
    const s412 = text.slice(at412, text.indexOf('### 4.13 ', at412));
    const lines = s412.split('\n');
    expect(lines).toContain('**Block undo** (SP5a): Ctrl+Z / Ctrl+Y undo and redo block edits while the world owns the controls, the last 100 undo and 100 redo steps per world, kept across reloads (SP5b), separate from the map\'s history.');
    expect(s412).not.toContain('100 steps per session');
    expect(s412).toContain('Hotbar slots persist per world by type name (SP5b, in the `state` store), never by state id.');
  });

  test('§1\'s ui/world line names the start and worlds menus at `/`; §2.7\'s Session keeps the open world in the URL and the map\'s URL for the map and unsaved worlds; §5.2\'s World names the start screen\'s menus (SP5b spec §1.1, D1, D2, §9)', () => {
    const entry = layoutEntry(/^\s+ui\/world\/\* /);
    expect(entry).toContain('(SP4a) the 3D page: the start and worlds menus at `/` (SP5b: `ui/worldsMenu.ts`), the world page,');
    expect(entry).not.toContain('the minimal start screen at `/`');
    const session = text.split('\n').find((l) => l.startsWith('**Session.** '));
    expect(session, 'no **Session.** paragraph in §2.7').toBeDefined();
    expect(session!.startsWith('**Session.** Settings and panel layout go to localStorage behind try/catch; the open world is in the URL (`/?world=<id>`; SP5b). The world URL `?map#base64url(canonicalJSON({v: 1, seed, profile, patch, view}))`, for the map and for unsaved worlds (SP5b), makes a world shareable:')).toBe(true);
    expect(session).not.toContain('last world');
    const at52 = text.indexOf('### 5.2 ');
    const lines52 = text.slice(at52, text.indexOf('### 5.3 ', at52)).split('\n');
    expect(lines52).toContain('- **World:** seed (typed seed is authoritative; separate "Regenerate same seed" and "New seed" buttons), profile, presets, worlds (the start screen\'s menus, SP5b).');
  });

  test('an older generator opens with today\'s terrain and a notice: §2.7\'s save rule, §6.2\'s Dev saves, risk 13 and §9\'s save binding (SP5b spec D8, §9)', () => {
    const at27 = text.indexOf('### 2.7 ');
    const s27 = text.slice(at27, text.indexOf('## 3. Generation', at27));
    expect(s27).toContain('Live and Remesh params never affect genKey. A world whose stored genKey differs from today\'s opens with today\'s terrain, its edits at their coordinates, with a notice and an \'older generator\' badge in the list (SP5b).');
    expect(text).not.toContain('A save is valid only for its genKey.');
    const at62 = text.indexOf('### 6.2 ');
    const lines62 = text.slice(at62, text.indexOf('### 6.3 ', at62)).split('\n');
    expect(lines62).toContain('- **Dev saves** whose genKey no longer matches open with today\'s terrain and a notice (§2.7, SP5b).');
    expect(text).not.toContain('go through the fork dialog of §2.7');
    const at8 = text.indexOf('## 8. Risks');
    const lines8 = text.slice(at8, text.indexOf('## 9. ', at8)).split('\n');
    expect(lines8).toContain('13. **Save and golden churn during development.** An older generator opens with today\'s terrain (§2.7, SP5b).');
    const at9 = text.indexOf('## 9. ');
    const lines9 = text.slice(at9, text.indexOf('## 10. ', at9)).split('\n');
    expect(lines9).toContain('| save binding | (generatorVersion, seed, stageHash(\'decorate\'), i.e. generation-scope params only) (SP5b: a mismatch opens with today\'s terrain and a notice) | (seed, paramsHash) only (silent misalignment after generator changes) |');
  });

  test('§2.7\'s fork dialog is replaced by the world-modification mode and its backup (SP5b spec D10, D11, §9)', () => {
    const at = text.indexOf('### 2.7 ');
    const s27 = text.slice(at, text.indexOf('## 3. Generation', at));
    expect(s27.split('\n')).toContain('**World-modification mode and backup (SP5b).** Terrain changes from a saved world\'s map need the world-modification mode, off whenever a world opens; the first terrain change made while the mode is on in a world with edits first copies the world, as it was before the change, to a new world named \'<name> (before the change)\'; the world keeps its id.');
    expect(s27).not.toContain('**Fork dialog.**');
    expect(s27).not.toContain('**Rebase:**');
    expect(text).not.toContain('During development this dialog is expected often');
  });

  test('§5.9 names G for the Settings and B to save a place (SP5b spec §3.7, §9)', () => {
    const at59 = text.indexOf('### 5.9 Controls');
    const s59 = text.slice(at59, text.indexOf('## 6. ', at59));
    expect(s59).toContain('P (params); G (settings; SP5b); B (save a place; SP5b); E (creative palette);');
    expect(s59).not.toContain('G (graphics)');
  });

  test('§5.6\'s saved places: coloured dots, a Places tab, B in the world and \'+ Add at the pin\' on the map (SP5b spec §3.7, D12, D13, §9)', () => {
    const at56 = text.indexOf('### 5.6 Map view');
    const s56 = text.slice(at56, text.indexOf('### 5.7 ', at56));
    expect(s56.split('\n')).toContain('  - spawn, player with view cone, grid, column-status heatmap, saved places per saved world (SP5b: a section of each saved world\'s map, one map per saved world; coloured dots; a Places tab; B in the world and \'+ Add at the pin\' on the map).');
  });

  test('§1\'s settings block is replaced by the Settings screen; §4.16 and §5.2 name its Graphics and Controls (SP5b spec §1.4, D9, §9)', () => {
    // Moved from the SP5a describe (SP5b spec §8), with the amendment it pins.
    const entry = layoutEntry(/^\s+ui\/world\/\* /);
    expect(entry).toContain('the world\'s small settings block (replaced by SP5b\'s Settings screen, `ui/settingsPanel.ts`);');
    expect(entry).not.toContain('(SP5b\'s graphics settings screen replaces it)');
    const at416 = text.indexOf('### 4.16 ');
    const lines416 = text.slice(at416, text.indexOf('### 4.17 ', at416)).split('\n');
    expect(lines416.some((l) => l.startsWith('- Every setting can be overridden individually (SP5b: the Settings screen, G: Graphics with RD, FPS cap, FOV and brightness, the rest greyed until SP11; Controls with mouse sensitivity and hold to repeat): RD, LOD,')), 'no amended "Every setting can be overridden" line in §4.16').toBe(true);
    const at52 = text.indexOf('### 5.2 ');
    const lines52 = text.slice(at52, text.indexOf('### 5.3 ', at52)).split('\n');
    expect(lines52).toContain('- **Settings:** Graphics and Controls (SP5b), Audio (SP8c) (master, music, sfx and ambient volumes; music frequency Always / Frequent / Standard / Never; sound pack).');
  });

  test('§6.4\'s E1-E6 row ends with E6 as SP5b redefines it and E7 restores time, history and places per world; §6.3\'s Persistence names E1-E7 and the Palette\'s hotbar round-trips per world (SP5b spec §6.1, §9)', () => {
    const e = text.split('\n').find((l) => l.startsWith('| E1-E6 |'));
    expect(e, 'no E1-E6 row in §6.4').toBeDefined();
    expect(e).toContain('(the session part SP5a, the flush part SP5b)');
    expect(e!.endsWith('; an older generator opens with today\'s terrain and its edits, with the notice and no copy; the first terrain change in the modification mode in a world with edits makes exactly one backup equal to the world before it (redefined by the SP5b spec) | exact |'), 'the E1-E6 row\'s last clause').toBe(true);
    expect(e).not.toContain('fork dialog');
    const e7 = text.split('\n').find((l) => l.startsWith('| E7 |'));
    expect(e7, 'no E7 row in §6.4').toBeDefined();
    expect(e7).toContain('hotbar and player restored per world / time, history and places restored per world / `stateTable` remap on load');
    const at63 = text.indexOf('### 6.3 ');
    const lines63 = text.slice(at63, text.indexOf('### 6.4 ', at63)).split('\n');
    expect(lines63).toContain('- **Persistence:** codec, `.wiworld` and fault-injection round-trips (E1-E7).');
    expect(lines63.some((l) => l.startsWith('- **Palette:**') && l.endsWith('hotbar round-trips by type name per world.')), 'no Palette line ending "per world." in §6.3').toBe(true);
  });

  test('§8 risk 1\'s Kill line is closed at SP5b, which met no isolation or concurrency problem it could not fix; the SP4b parenthesis is kept verbatim (SP5b spec §8, §9)', () => {
    // Moved from the SP5a describe (SP5b spec §8), with the amendment it pins; the SP4c block's pin of the parenthesis stays.
    const at8 = text.indexOf('## 8. Risks');
    const kill = text.slice(at8, text.indexOf('\n2. ', at8)).split('\n').find((l) => l.trimStart().startsWith('- Kill:'));
    expect(kill, 'risk 1 has no `- Kill:` line').toBeDefined();
    expect(kill).toBe('   - Kill: not taken; its window closed at SP5b. No SP of SP3a-SP5b met an isolation or concurrency problem it could not fix, so the store stays on the SAB and the switch to transferable snapshots is not made (amended by SP4b: the split moved Apply\'s rewrites of Published columns to SP4c, and SP5a\'s sim worker is deferred reclamation\'s first necessary consumer; SP4c\'s Apply frees and regenerates instead of rewriting). SP5b\'s saved worlds kept the sim worker the only writer of the open world, a Web Lock holds one tab per world, and every flush is one transaction carrying its `flushSeq`; the ordering problems found while planning and reviewing it (a replaced flush\'s reply, a rewrite at open that does not commit, a page restored from the back/forward cache, a backup\'s state built before an awaited read) were fixed inside that design. gen/light/mesh already run on plain ArrayBuffers in the harness, so a later switch would change only `store` and the transport.');
    expect(kill).not.toContain('if SP3a-SP5b shows an unfixable isolation or concurrency problem');
  });

  test('§1 names each SP5b module in its entry, which exists', () => {
    expect(SP5B_MODULES.length, 'SP5B_MODULES has no rows').toBeGreaterThan(0);
    for (const [head, token, file] of SP5B_MODULES) {
      const entry = layoutEntry(head);
      expect(entry, `§1 has no entry matching ${head}`).not.toBe('');
      expect(entry, `§1's ${head} entry does not name ${token}`).toContain(token);
      expect(existsSync(`${ROOT_DIR}${file}`), `${file} does not exist`).toBe(true);
    }
  });
});

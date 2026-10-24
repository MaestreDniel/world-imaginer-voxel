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
    expect(spEntry('SP4c', 'SP5').startsWith('**SP4c — The map in the world and live editing** (M; SP4b)')).toBe(true);
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
    expect(s41).toContain('- Mesh jobs and the main thread only read (SP4b: the main thread frees unloaded columns and protos, at zero reader pins; `T(protoOnly)` rewrites only the proto descriptors and alive bit of a Decorated or Published column, never its final set; the sim worker\'s ownership, SP5, is of the final set).');
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

  test('§2.3\'s epoch-cell sentence carries every job\'s scope (SP4b spec §2.7, §13)', () => {
    const cell = text.split('\n').find((l) => l.startsWith('**Epoch cell.**'));
    expect(cell, 'no `**Epoch cell.**` paragraph').toBeDefined();
    expect(cell).toContain('SP4b wires them in place of SP2b\'s pool-wide cell (every job carries its configure generation and its phase\'s cell value at issue, `scope`, and stops when the cell moves; `configure` stores the generation into all four; Apply bumps from the dirty stage, SP4c)');
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

  test('§1 names each SP4b module in its entry, which exists', () => {
    for (const [head, token, file] of SP4B_MODULES) {
      const entry = layoutEntry(head);
      expect(entry, `§1 has no entry matching ${head}`).not.toBe('');
      expect(entry, `§1's ${head} entry does not name ${token}`).toContain(token);
      expect(existsSync(`${ROOT_DIR}${file}`), `${file} does not exist`).toBe(true);
    }
  });
});

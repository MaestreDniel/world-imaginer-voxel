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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SUB_PROJECTS, type SubProjectId } from '../../src/core/ids';
import { DEFAULTS } from '../../src/core/params/defaults';
import { REGISTRY } from '../../src/world/blocks';
import { SP_DEPS } from '../harness/sp';
import { DET_FILES } from './rules/banned';

// Resolved from this file, not the cwd (SP3b spec §7), so the test also runs from another directory.
const MASTER = fileURLToPath(new URL('../../docs/superpowers/specs/2026-09-26-architecture-design.md', import.meta.url));
const text = readFileSync(MASTER, 'utf8');
const API = fileURLToPath(new URL('../../src/world/store/api.ts', import.meta.url));
const METRICS = fileURLToPath(new URL('../../src/metrics/', import.meta.url));
const SURFACE = fileURLToPath(new URL('../../src/gen/surface/', import.meta.url));
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
  test.each(['ColumnWriter', 'ColumnView', 'NeighborhoodReader'])('§2.5 %s names every method of world/store/api.ts', (name) => {
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

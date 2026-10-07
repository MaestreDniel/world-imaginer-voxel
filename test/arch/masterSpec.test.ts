/**
 * The master spec's sub-project list agrees with the code (SP3a spec §11: the master §2.5 and §10 amendments): the
 * `SubProjectId` type of §2.5 lists `SUB_PROJECTS` in order, §10 has one header per sub-project in that order whose
 * parenthetical names every dependency `SP_DEPS` transcribes from it, and the critical path is a dependency chain.
 * SP3b (its spec §14): §2.5's store interfaces name every method of `world/store/api.ts`, and §3.6's default
 * expression states the density noises and amplitudes of the schema defaults, so a retune must amend the master.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SUB_PROJECTS, type SubProjectId } from '../../src/core/ids';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SP_DEPS } from '../harness/sp';

// Resolved from this file, not the cwd (SP3b spec §7), so the test also runs from another directory.
const MASTER = fileURLToPath(new URL('../../docs/superpowers/specs/2026-09-26-architecture-design.md', import.meta.url));
const text = readFileSync(MASTER, 'utf8');
const API = fileURLToPath(new URL('../../src/world/store/api.ts', import.meta.url));
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

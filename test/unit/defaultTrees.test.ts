import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { checkJson, countTreeNodes, type JsonFormat, type JsonValue } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import type { DensityParams, SurfaceParams } from '../../src/core/params/schema';
import { legacyDefaultDensityExpr, legacyDefaultSurfaceRules } from '../harness/legacyTrees';

const FIXTURE = new URL('../fixtures/sp3c-default-rules.json', import.meta.url);
const fixture = (): unknown => JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every container (object or array) of a value, the value included. */
function containers(v: unknown): object[] {
  const out: object[] = [];
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x !== 'object' || x === null) continue;
    out.push(x);
    for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push(c);
  }
  return out;
}

/** The first path where two trees differ (numbers compared with Object.is, so −0 ≠ +0; key order ignored), or null. */
function treeDiff(a: unknown, b: unknown, path = ''): string | null {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path}: array shape`;
    for (let i = 0; i < a.length; i++) {
      const d = treeDiff(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isRec(a) && isRec(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) {
      const d = treeDiff(a[k], b[k], path === '' ? k : `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

/**
 * The default density tree with §2.1's three substitutions undone, as the legacy builder computes them:
 * `recip(param jag.clampSigma)` → const(1 / cs), `add(param hi, neg(param lo))` → const(hi − lo), `param lo` → const(lo).
 * Any other `param` or `recip` is an error. Returns the tree and the number of substitutions undone.
 */
function densityUndone(tree: unknown, p: DensityParams): { tree: unknown; undone: number } {
  let undone = 0;
  const isParam = (v: unknown, path: string): boolean => isRec(v) && v['op'] === 'param' && v['path'] === path;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRec(v)) return v;
    if (v['op'] === 'recip' && isParam(v['x'], 'density.noises.jag.clampSigma')) {
      undone++;
      return { op: 'const', v: 1 / p.noises.jag.clampSigma };
    }
    const b = v['b'];
    if (v['op'] === 'add' && isParam(v['a'], 'density.detailAmpHi') && isRec(b) && b['op'] === 'neg' && isParam(b['x'], 'density.detailAmpLo')) {
      undone++;
      return { op: 'const', v: p.detailAmpHi - p.detailAmpLo };
    }
    if (isParam(v, 'density.detailAmpLo')) {
      undone++;
      return { op: 'const', v: p.detailAmpLo };
    }
    if (v['op'] === 'param' || v['op'] === 'recip') throw new Error(`unexpected ${String(v['op'])} node`);
    const o: Rec = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    return o;
  };
  return { tree: walk(tree), undone };
}

/** The four surface parameters a default-rules ref may name (§2.2), read from `p`. */
const surfaceTargets = (p: SurfaceParams): ReadonlyMap<string, number> => new Map([
  ['surface.patchThreshold', p.patchThreshold],
  ['surface.cliffSteep', p.cliffSteep],
  ['surface.cliffMinY', p.cliffMinY],
  ['surface.snowline', p.snowline],
]);

/** The default rules with each `{param, neg?}` ref replaced by its value (`0 − v` when negated); the refs it met. */
function surfaceAt(tree: unknown, p: SurfaceParams): { tree: unknown; refs: string[] } {
  const targets = surfaceTargets(p);
  const refs: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (!isRec(v)) return v;
    if (Object.hasOwn(v, 'param')) {
      const name = v['param'] as string;
      const t = targets.get(name);
      if (t === undefined) throw new Error(`unknown ref ${name} at ${path}`);
      const neg = v['neg'] === true;
      refs.push(`${path} ${neg ? '-' : ''}${name}`);
      return neg ? 0 - t : t;
    }
    const o: Rec = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, `${path}.${k}`);
    return o;
  };
  return { tree: walk(tree, 'root'), refs };
}

const withDensity = (patch: Partial<DensityParams>, clampSigma?: number): DensityParams => {
  const d = DEFAULTS.density;
  const noises = clampSigma === undefined ? d.noises : { ...d.noises, jag: { ...d.noises.jag, clampSigma } };
  return { ...d, ...patch, noises };
};
const withSurface = (patch: Partial<SurfaceParams>): SurfaceParams => ({ ...DEFAULTS.surface, ...patch });

const CASES: ReadonlyArray<[string, JsonValue, string, JsonFormat]> = [
  ['DEFAULT_DENSITY_TREE', DEFAULT_DENSITY_TREE, 'density.defs', 'density'],
  ['DEFAULT_SURFACE_RULES', DEFAULT_SURFACE_RULES, 'surface.rules', 'surfaceRules'],
];

describe('the default trees as data (SP3d spec §2)', () => {
  test.each(CASES)('%s is tier 1\'s registered clone: checkJson returns it as itself, with no issue', (_, tree, path, format) => {
    const out: Issue[] = [];
    expect(checkJson(tree, path, out, format)).toBe(tree);
    expect(out).toEqual([]);
  });

  test.each(CASES)('%s passes tier 1 when checked afresh (a plain copy gives no issue and the same canonical text)', (_, tree, path, format) => {
    const out: Issue[] = [];
    const copy = JSON.parse(JSON.stringify(tree)) as unknown;
    const again = checkJson(copy, path, out, format);
    expect(out).toEqual([]);
    expect(again).toBeDefined();
    expect(again).not.toBe(copy);
    expect(canonicalJSON(again)).toBe(canonicalJSON(tree));
  });

  test.each(CASES)('%s is frozen at every depth and stores its object keys sorted', (_, tree) => {
    const all = containers(tree);
    expect(all.length).toBeGreaterThan(50);
    for (const c of all) {
      expect(Object.isFrozen(c)).toBe(true);
      if (!Array.isArray(c)) expect(Object.keys(c)).toEqual(Object.keys(c).sort());
    }
    expect(() => { (tree as Rec)['x'] = 1; }).toThrow(TypeError);
  });

  test('DEFAULT_DENSITY_TREE is the whole expression {root, defs} with no defs', () => {
    expect(Object.keys(DEFAULT_DENSITY_TREE)).toEqual(['defs', 'root']);
    expect((DEFAULT_DENSITY_TREE as Rec)['defs']).toEqual({});
  });

  test('DEFAULT_DENSITY_TREE with its three substitutions undone equals legacyDefaultDensityExpr at DEFAULTS (Object.is on every number)', () => {
    const { tree, undone } = densityUndone(DEFAULT_DENSITY_TREE, DEFAULTS.density);
    expect(undone).toBe(3);
    expect(treeDiff(tree, legacyDefaultDensityExpr(DEFAULTS.density))).toBeNull();
  });

  test.each([1, 3, 7.3, 8])('… and at density.noises.jag.clampSigma %s', (cs) => {
    const p = withDensity({}, cs);
    expect(treeDiff(densityUndone(DEFAULT_DENSITY_TREE, p).tree, legacyDefaultDensityExpr(p))).toBeNull();
  });

  test.each([[0, 0], [0, 8], [8, 0], [0.35, 1.05]])('… and at detailAmpLo %s, detailAmpHi %s', (lo, hi) => {
    const p = withDensity({ detailAmpLo: lo, detailAmpHi: hi });
    expect(treeDiff(densityUndone(DEFAULT_DENSITY_TREE, p).tree, legacyDefaultDensityExpr(p))).toBeNull();
  });

  test('DEFAULT_DENSITY_TREE has 4 nodes more than the legacy tree (recip + param for one const; add, param, neg, param for one)', () => {
    // Nodes as the README counts them (every occurrence; the legacy builder's three `y` are one shared object).
    const legacy = legacyDefaultDensityExpr(DEFAULTS.density);
    expect(countTreeNodes(legacy as unknown as JsonValue, 'density')).toBe(56);
    expect(countTreeNodes(DEFAULT_DENSITY_TREE, 'density')).toBe(60);
  });

  test('DEFAULT_SURFACE_RULES holds exactly §2.2\'s 15 refs', () => {
    const { refs } = surfaceAt(DEFAULT_SURFACE_RULES, DEFAULTS.surface);
    const by = (name: string): number => refs.filter((r) => r.endsWith(` ${name}`)).length;
    expect(refs.length).toBe(15);
    expect(by('surface.patchThreshold')).toBe(10);
    expect(by('-surface.patchThreshold')).toBe(2);
    expect(by('surface.cliffSteep')).toBe(1);
    expect(by('surface.cliffMinY')).toBe(1);
    expect(by('surface.snowline')).toBe(1);
    // Every ref sits in the field the builder writes the parameter to (P.min, Pn.max, steep.min, yAbove.minY, temperatureBelow.t).
    for (const r of refs) expect(r).toMatch(/\.(?:if\.min |if\.max -|if\.minY |if\.t )surface\./);
  });

  test('DEFAULT_SURFACE_RULES with its refs substituted at DEFAULTS canonicalises to test/fixtures/sp3c-default-rules.json', () => {
    expect(canonicalJSON(surfaceAt(DEFAULT_SURFACE_RULES, DEFAULTS.surface).tree)).toBe(canonicalJSON(fixture()));
  });

  test.each([
    ['patchThreshold 0 (+0 in Pn.max)', { patchThreshold: 0 }],
    ['patchThreshold 3', { patchThreshold: 3 }],
    ['cliffSteep 0, cliffMinY −64, snowline −1', { cliffSteep: 0, cliffMinY: -64, snowline: -1 }],
    ['cliffSteep 8, cliffMinY 319, snowline 1', { cliffSteep: 8, cliffMinY: 319, snowline: 1 }],
  ] as const)('… and equals legacyDefaultSurfaceRules at %s', (_, patch) => {
    const p = withSurface(patch);
    expect(canonicalJSON(surfaceAt(DEFAULT_SURFACE_RULES, p).tree)).toBe(canonicalJSON(legacyDefaultSurfaceRules(p)));
  });

  test('DEFAULT_SURFACE_RULES has as many rule and condition nodes as the fixture (refs are not nodes)', () => {
    expect(countTreeNodes(DEFAULT_SURFACE_RULES, 'surfaceRules')).toBe(countTreeNodes(fixture() as JsonValue, 'surfaceRules'));
    expect(countTreeNodes(DEFAULT_SURFACE_RULES, 'surfaceRules')).toBe(163);
  });
});

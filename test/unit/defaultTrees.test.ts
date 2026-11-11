import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { checkJson, countTreeNodes, type JsonFormat, type JsonValue } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import type { DensityParams, SurfaceParams } from '../../src/core/params/schema';
import { ctxFor } from '../harness/gen';
import { legacyDefaultDensityExpr, legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { cavesMuted, cavesMutedDiff, SP5C_COLUMNS, sp5cPair, sp5cTrees } from '../harness/sp5cTrees';

const FIXTURE = new URL('../fixtures/sp3c-default-rules.json', import.meta.url);
const fixture = (): unknown => JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The node at a dotted path (`root.a.b`, `defs.body.x`). */
const nodeAt = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n as Rec)[k], v);

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

  test('DEFAULT_DENSITY_TREE is the whole expression {root, defs} with the defs body, pillars and wetSteep (SP6a §1.1, §1.4)', () => {
    expect(Object.keys(DEFAULT_DENSITY_TREE)).toEqual(['defs', 'root']);
    expect(Object.keys((DEFAULT_DENSITY_TREE as Rec)['defs'] as Rec)).toEqual(['body', 'pillars', 'wetSteep']);
    // S_w = 128·h_w at voxel level (SP6a §1.4, Spec correction 14; test/unit/caveTerms.test.ts checks its terms).
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'defs.wetSteep')).toMatchObject({ op: 'mul', a: { op: 'const', v: 128 }, b: { op: 'mul' } });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'defs.pillars')).toMatchObject({ op: 'tap', name: 'pillars', x: { op: 'interpolated' } });
  });

  test('defs.body is the SP5c default\'s terrain body (its root.a.a.x.x), unchanged', () => {
    expect(treeDiff(nodeAt(DEFAULT_DENSITY_TREE, 'defs.body'), nodeAt(sp5cTrees().default, 'root.a.a.x.x'))).toBeNull();
  });

  test('the root: max(min(min(tap precave(add(tap terrain(interpolated(ref body)), detailG)), add(caves slot, ref wetSteep)), add(noodle slot, ref wetSteep)), tap islands)', () => {
    const sp5c = sp5cTrees().default;
    const op = (path: string): unknown => (nodeAt(DEFAULT_DENSITY_TREE, path) as Rec)['op'];
    expect([op('root'), op('root.a'), op('root.a.a')]).toEqual(['max', 'min', 'min']);
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a')).toMatchObject({ op: 'tap', name: 'precave' });
    expect(Object.keys(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a') as Rec)).toEqual(['name', 'op', 'x']);
    expect(op('root.a.a.a.x')).toBe('add');
    expect(treeDiff(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a.x.a'), { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: { op: 'ref', name: 'body' } } })).toBeNull();
    // detailG = rangeChoice(interpolated(ref body), −1e9, 16, detail, 0) (SP6a §1.1, Spec correction 6), the detail term unchanged.
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a.x.b')).toMatchObject({ op: 'rangeChoice', lo: -1e9, hi: 16, outside: { op: 'const', v: 0 } });
    expect(treeDiff(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a.x.b.x'), { op: 'interpolated', x: { op: 'ref', name: 'body' } })).toBeNull();
    expect(treeDiff(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a.x.b.inside'), nodeAt(sp5c, 'root.a.b')), 'the detail term').toBeNull();
    // The caves slot max(min(min(min(E, C), S3), S2), keep) and the noodle (SP6a §1.1; test/unit/caveTerms.test.ts checks
    // their terms).
    // Each under the wet roof's steep part (Task 9): add(caves slot, ref wetSteep), add(noodle, ref wetSteep).
    expect([op('root.a.a.b'), op('root.a.b')]).toEqual(['add', 'add']);
    expect([nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.b.b'), nodeAt(DEFAULT_DENSITY_TREE, 'root.a.b.b')]).toEqual([{ op: 'ref', name: 'wetSteep' }, { op: 'ref', name: 'wetSteep' }]);
    expect([op('root.a.a.b.a'), op('root.a.a.b.a.a'), op('root.a.a.b.a.a.a'), op('root.a.a.b.a.a.a.a')]).toEqual(['max', 'min', 'min', 'min']);
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.b.a.a.a.a.a')).toMatchObject({ op: 'tap', name: 'entrances' });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.b.a.a.a.a.b')).toMatchObject({ op: 'tap', name: 'cheese' });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.b.a.a.a.b')).toMatchObject({ op: 'tap', name: 'spag3d' });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.b.a.a.b')).toMatchObject({ op: 'tap', name: 'spag2d' });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.b.a.b')).toMatchObject({ op: 'rangeChoice', outside: { op: 'ref', name: 'pillars' } });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.b.a')).toMatchObject({ op: 'tap', name: 'noodle' });
    expect(treeDiff(nodeAt(DEFAULT_DENSITY_TREE, 'root.b'), nodeAt(sp5c, 'root.b')), 'the islands tap').toBeNull();
  });

  test('defs.body and the detail term with their three substitutions undone equal legacyDefaultDensityExpr\'s at DEFAULTS (Object.is on every number)', () => {
    const legacy = legacyDefaultDensityExpr(DEFAULTS.density);
    const body = densityUndone(nodeAt(DEFAULT_DENSITY_TREE, 'defs.body'), DEFAULTS.density);
    const detail = densityUndone(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a.x.b.inside'), DEFAULTS.density);
    expect(body.undone + detail.undone).toBe(3);
    expect(treeDiff(body.tree, nodeAt(legacy, 'root.a.a.x.x'))).toBeNull();
    expect(treeDiff(detail.tree, nodeAt(legacy, 'root.a.b'))).toBeNull();
  });

  test.each([1, 3, 7.3, 8])('… and at density.noises.jag.clampSigma %s', (cs) => {
    const p = withDensity({}, cs);
    expect(treeDiff(densityUndone(nodeAt(DEFAULT_DENSITY_TREE, 'defs.body'), p).tree, nodeAt(legacyDefaultDensityExpr(p), 'root.a.a.x.x'))).toBeNull();
  });

  test.each([[0, 0], [0, 8], [8, 0], [0.35, 1.05]])('… and at detailAmpLo %s, detailAmpHi %s', (lo, hi) => {
    const p = withDensity({ detailAmpLo: lo, detailAmpHi: hi });
    expect(treeDiff(densityUndone(nodeAt(DEFAULT_DENSITY_TREE, 'root.a.a.a.x.b.inside'), p).tree, nodeAt(legacyDefaultDensityExpr(p), 'root.a.b'))).toBeNull();
  });

  test.each(SP5C_COLUMNS)('with the carving family taps muted to 1e6, the default is SP5c\'s at every voxel where T < 16 and its solidity everywhere, column (%i, %i)', (cx, cz) => {
    // The cave terms are the only change but detailG (SP6a §1.1): muting the carving families (entrances, cheese, spag3d,
    // spag2d and the noodle) makes the caves slot max(1e6, keep) = 1e6 and the noodle 1e6, so the root is SP5c's
    // wherever detailG is the detail term (interpolated(ref body) < 16); at
    // T ≥ 16 detailG is 0, both roots are > 0 (|detail| ≤ 4.5) and the solid arrays agree.
    const { today, sp5c } = sp5cPair(ctxFor('42'), cavesMuted(DEFAULT_DENSITY_TREE), 'default');
    const { diff, skipped } = cavesMutedDiff(today, sp5c, cx, cz);
    expect(diff).toBeNull();
    expect(skipped).toBeGreaterThan(0);
  });

  test('DEFAULT_DENSITY_TREE\'s node count (SP6a: the SP5c tree\'s 60 plus precave, ref, the two mins and the two slots: 66; then the cave terms: 178; then spaghetti and the noodle: 616)', () => {
    // Nodes as the README counts them (every occurrence; the legacy builder's three `y` are one shared object).
    expect(countTreeNodes(legacyDefaultDensityExpr(DEFAULTS.density) as unknown as JsonValue, 'density')).toBe(56);
    expect(countTreeNodes(sp5cTrees().default as JsonValue, 'density')).toBe(60);
    // The cave terms: detailG's rangeChoice, interpolated, ref and const 0 around the detail term (+4), the caves slot
    // max(min(E 36, C 40), keep 6) = 84 nodes in place of its const (+83; E's Ne·recip(const 6) 3 of them) and defs.pillars
    // (+25): 178. Task 7: the caves slot max(min(min(min(E 36, C 40), S3 199), S2 159), keep 6) = 444 nodes (+360: each
    // spaghetti rarity blend is 78 (3D, four bands) or 101 (2D, five bands) nodes) and the noodle tap's 79 in place of its
    // const (+78): 616. Task 8: each family's cap `+ G·min(1, g) + 128·min(1, h)` is 48 nodes (g 17, h 21, their mins,
    // muls and constants 9, the add joining it 1) in each of the five families (+240), and `nb`'s maxY test reads
    // `neg(param)` in place of a const (+1 in each of the noodle's four slots): 860. Task 9: the island cap's g_i (12
    // nodes) and h_i (9), and the two adds joining them to g_f and h_f, in each of the five caps (+115): 975. Task 9's wet
    // roof: g_w = wet′·clamp((waterDepth + 8 + s − d)·recip(s), 0, 1) is 17 nodes with d = `ref body` (wet′ =
    // clamp(4·wetMask) 4 of them) and 18 with the noodle's d = interpolated(ref body), plus the add joining it to g_f, in
    // each of the five caps (+91); defs.wetSteep = 128·wet′·clamp((waterDepth + 8 − d)·0.125, 0, 1) (+17); the root's two
    // `add(…, ref wetSteep)` (+4): 1087. The user's check (R31): the noodle toggle's `add(…, neg(param threshold))` (+3):
    // 1090 (README's row).
    expect(countTreeNodes(DEFAULT_DENSITY_TREE, 'density')).toBe(1090);
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

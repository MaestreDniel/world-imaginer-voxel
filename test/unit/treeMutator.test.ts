import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import type { JsonFormat } from '../../src/core/params/json';
import { applyPatch, type Issue } from '../../src/core/params/kit';
import { SCHEMA, type Params } from '../../src/core/params/schema';
import { buildColumnSample, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { compileDensity, cornerValueIndex } from '../../src/gen/density/compile';
import { densityNoiseSource } from '../../src/gen/density/context';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { resolveDensity } from '../../src/gen/density/source';
import { terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { compileSurfaceRules } from '../../src/gen/surface/compile';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { createSurfaceReference } from '../../src/gen/surface/reference';
import { newSurfaceScan, runAt, type SurfaceScan } from '../../src/gen/surface/scan';
import { resolveRules } from '../../src/gen/surface/source';
import { validateParamTrees } from '../../src/gen/trees';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';
import { SCHEMA_SURFACE_NOISES, SURFACE_FUZZ_NOISES } from '../harness/surfaceFuzz';
import {
  BREAKING_MUTATIONS, cloneTree, mutateTree, mutationBase, mutationsOf, PRESERVING_MUTATIONS, type MutationName,
} from '../harness/treeMutator';

/**
 * The untrusted-JSON fuzz (SP3d spec §10): 2,000 mutated values per format, each judged as the session judges a leaf
 * value (tier 1 through `applyPatch`, then tier 2 through `validateParamTrees`). A refused value never throws and every
 * issue path is the leaf path followed by the path of the value itself, a node or a field of the value (an existing
 * one, or a missing field of an existing node); an accepted value prints canonically, resolves, and its compiled tree
 * equals the reference evaluator (`Object.is`, every value finite) at sampled voxels and corners of two real columns
 * of seed '42'; for rules the fast path equals full evaluation there.
 */
const CTX = ctxFor('42');
const COLUMNS: readonly (readonly [number, number])[] = [[3, -2], [-40, 25]];
const LEAF: Readonly<Record<JsonFormat, string>> = { density: 'density.defs', surfaceRules: 'surface.rules' };
const VALUES = 2000;

interface Judged { readonly issues: readonly Issue[]; readonly params: Params | null }

/** The value as the session would judge it as its leaf (DEFAULTS ⊕ the leaf). */
function judge(value: unknown, format: JsonFormat): Judged {
  const patch = format === 'density' ? { density: { defs: value } } : { surface: { rules: value } };
  const r = applyPatch(SCHEMA, DEFAULTS, patch);
  if (!r.ok) return { issues: r.issues, params: null };
  const issues = validateParamTrees(r.value);
  return { issues, params: issues.length > 0 ? null : r.value };
}

/**
 * The segments of a node path after the leaf path (`.root.a.x`, `.defs."__proto__"`, `.root.rules[1].if.biomes[0]`):
 * names, array indices, and quoted keys (`complete` false for a key cut to 40 characters). Null when it does not parse.
 */
function segments(rest: string): Array<{ key: string; index: boolean; complete: boolean }> | null {
  const out: Array<{ key: string; index: boolean; complete: boolean }> = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '[') {
      const j = rest.indexOf(']', i);
      if (j < 0 || !/^\d+$/.test(rest.slice(i + 1, j))) return null;
      out.push({ key: rest.slice(i + 1, j), index: true, complete: true });
      i = j + 1;
    } else if (rest[i] === '.' && rest[i + 1] === '"') {
      let j = i + 2;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === '\\' ? 2 : 1;
      if (j >= rest.length) {
        out.push({ key: rest.slice(i + 1), index: false, complete: false });
        i = rest.length;
      } else {
        out.push({ key: JSON.parse(rest.slice(i + 1, j + 1)) as string, index: false, complete: true });
        i = j + 1;
      }
    } else if (rest[i] === '.') {
      const m = /^[^.[]+/.exec(rest.slice(i + 1));
      if (m === null) return null;
      out.push({ key: m[0], index: false, complete: true });
      i += 1 + m[0].length;
    } else {
      return null;
    }
  }
  return out;
}

/** Whether issue `path` is the leaf path plus the path of the value, a node or a field of `value` (see the file comment). */
function namesNodeOrField(value: unknown, format: JsonFormat, path: string): boolean {
  const leaf = LEAF[format];
  if (path === leaf) return true;
  if (!path.startsWith(`${leaf}.`) && !path.startsWith(`${leaf}[`)) return false;
  const segs = segments(path.slice(leaf.length));
  if (segs === null) return false;
  if (format === 'surfaceRules') {
    // Rule ids start at `root`, the value itself (§1.2).
    if (segs.length === 0 || segs[0]!.key !== 'root' || segs[0]!.index || !segs[0]!.complete) return false;
    segs.shift();
  }
  let cur: unknown = value;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    const last = k === segs.length - 1;
    if (typeof cur !== 'object' || cur === null) return false;
    if (!s.complete) {
      // A key cut to 40 characters: some own key's quoted form starts with it.
      return last && !Array.isArray(cur) && Object.keys(cur).some((key) => JSON.stringify(key).startsWith(s.key));
    }
    if (Array.isArray(cur) !== s.index) return false;
    if (Object.hasOwn(cur, s.key)) cur = (cur as Record<string, unknown>)[s.key];
    else return last; // a missing field of an existing node
  }
  return true;
}

/** A failure description, or null: the value's issues name its nodes and fields. */
function pathProblem(value: unknown, format: JsonFormat, issues: readonly Issue[]): string | null {
  if (issues.length === 0) return 'refused without an issue';
  for (const i of issues) if (!namesNodeOrField(value, format, i.path)) return `issue path ${i.path} (${i.code}) names no node or field`;
  return null;
}

// ---------------------------------------------------------------- density: compiled == reference on two real columns
const D_NOISES = densityNoiseSource(CTX);
const D_SAMPLES: readonly ColumnSample[] = COLUMNS.map(([cx, cz]) => buildColumnSample(CTX, cx, cz, newColumnSample()));

/** Mismatches of an accepted density value: compiled ≠ reference or a non-finite value at 8 voxels and their cell corners per column. */
function densityProblems(params: Params, next: () => number): string[] {
  const out: string[] = [];
  canonicalJSON(params.density.defs);
  const expr = resolveDensity(params.density.defs, params);
  const c = compileDensity(expr, D_NOISES);
  const ref = createDensityReference(expr, D_NOISES);
  const interp = interpolatedNodes(expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
  for (const s of D_SAMPLES) {
    c.columnFn(s);
    c.positionFn(s);
    for (let k = 0; k < 8; k++) {
      const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
      const x = 16 * s.cx + lx, z = 16 * s.cz + lz;
      const v = c.voxelFn(lx, y, lz), rv = ref.voxel(s, x, y, z);
      if (!Object.is(v, rv) || !Number.isFinite(v)) out.push(`voxel (${x}, ${y}, ${z}): compiled ${v}, reference ${rv}`);
      const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
      c.cellCorners(ci, ck, cj);
      for (const { inner, slot } of interp) {
        for (let d = 0; d < 8; d++) {
          const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
          const cv = c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!, rc = ref.corner(s, inner, ii, kk, jj);
          if (!Object.is(cv, rc) || !Number.isFinite(cv)) out.push(`corner (${ii}, ${kk}, ${jj}) of (${s.cx}, ${s.cz}): compiled ${cv}, reference ${rc}`);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- rules: compiled == reference, fast == full on two real columns
const SC = surfaceContextOf(CTX);
const SCANS: readonly SurfaceScan[] = COLUMNS.map(([cx, cz]) => {
  const scan = newSurfaceScan();
  terrainSurfaceDebug(CTX, cx, cz, scan);
  return scan;
});
const FAST = new Uint16Array(98304);
const FULL = new Uint16Array(98304);

/**
 * Mismatches of an accepted rule value at 16 solid voxels per column (10 within 11 voxels of the sky-open top, 6
 * anywhere), and, when the tree has a fast path, the voxels where the fast path's whole-column fill ≠ full evaluation.
 */
function rulesProblems(params: Params, next: () => number): string[] {
  const out: string[] = [];
  canonicalJSON(params.surface.rules);
  const rules = resolveRules(params.surface.rules, params);
  const compiled = compileSurfaceRules(CTX.seed, rules, SC.noises, SC.settings, SC.bands);
  const reference = createSurfaceReference(CTX.seed, rules, SC.noises, SC.bands);
  for (const [n, scan] of SCANS.entries()) {
    for (let k = 0; k < 16; k++) {
      const p = next() % 256;
      const first = scan.runFirst[p]!;
      const y = k < 10 && first < scan.runFirst[p + 1]! ? scan.runTop[first]! - (next() % 12) : -63 + (next() % 383);
      if (y < -63 || runAt(scan, p, y) < 0) continue;
      const cs = compiled.state(scan, p, y), rs = reference.state(scan, SC.settings, p, y);
      if (cs !== rs) out.push(`column ${n} (${p}, ${y}): compiled state ${cs}, reference ${rs}`);
    }
    if (compiled.fastPath !== null) {
      FAST.fill(0);
      FULL.fill(0);
      compiled.fillColumn(scan, FAST, true);
      compiled.fillColumn(scan, FULL, false);
      let diff = 0;
      for (let i = 0; i < 98304; i++) if (FAST[i] !== FULL[i]) diff++;
      if (diff > 0) out.push(`column ${n}: fast path ≠ full evaluation at ${diff} voxels`);
    }
  }
  return out;
}

interface FuzzStats {
  readonly accepted: number;
  readonly byName: Map<MutationName, { accepted: number; refused: number }>;
  readonly problems: string[];
}

function fuzz(format: JsonFormat, seed: number): FuzzStats {
  const next = testRng(seed);
  const byName = new Map<MutationName, { accepted: number; refused: number }>();
  const problems: string[] = [];
  let accepted = 0;
  for (let i = 0; i < VALUES; i++) {
    const base = mutationBase(next, format);
    const m = mutateTree(next, base, format, { count: 1 + (next() % 2) });
    const at = `value ${i} (${m.names.join(' + ')})`;
    let judged: Judged;
    try {
      judged = judge(m.value, format);
    } catch (e) {
      problems.push(`${at}: validation threw ${(e as Error).message}`);
      continue;
    }
    const ok = judged.params !== null;
    for (const name of m.names) {
      const s = byName.get(name) ?? { accepted: 0, refused: 0 };
      if (ok) s.accepted++;
      else s.refused++;
      byName.set(name, s);
    }
    if (!ok) {
      const p = pathProblem(m.value, format, judged.issues);
      if (p !== null) problems.push(`${at}: ${p}`);
      continue;
    }
    accepted++;
    try {
      const ps = format === 'density' ? densityProblems(judged.params!, next) : rulesProblems(judged.params!, next);
      for (const p of ps.slice(0, 3)) problems.push(`${at}: ${p}`);
    } catch (e) {
      problems.push(`${at}: accepted, then threw ${(e as Error).message}`);
    }
  }
  return { accepted, byName, problems };
}

describe('treeMutator: the untrusted-JSON fuzz (SP3d spec §10)', () => {
  for (const format of ['density', 'surfaceRules'] as const) {
    test(`${format}: 2,000 mutated values are refused with node paths or accepted and sound; ≥ 25 % accepted`, () => {
      const r = fuzz(format, format === 'density' ? 1601 : 1602);
      expect(r.problems.slice(0, 10), `${r.problems.length} problems`).toEqual([]);
      expect(r.accepted).toBeGreaterThanOrEqual(VALUES / 4);
      // Every mutation of the format occurs; breaking ones are mostly refused, preserving ones mostly accepted.
      for (const cls of ['breaking', 'preserving'] as const) {
        let acc = 0, all = 0;
        for (const name of mutationsOf(format, cls)) {
          const s = r.byName.get(name);
          expect(s, `${format}: ${name} never applied`).toBeDefined();
          acc += s!.accepted;
          all += s!.accepted + s!.refused;
        }
        if (cls === 'breaking') expect(acc / all).toBeLessThan(0.25);
        else expect(acc / all).toBeGreaterThan(0.5);
      }
      // About 5 s alone (rules); twice it ran over the default 30 s under `npm run test:goldens`' full load.
    }, 120_000);
  }
});

describe('treeMutator: the mutator', () => {
  test('mutations never change their base, are reproducible from the seed and keep −0 and own __proto__ keys', () => {
    for (const format of ['density', 'surfaceRules'] as const) {
      const a = testRng(7), b = testRng(7);
      for (let i = 0; i < 300; i++) {
        const base = mutationBase(a, format);
        const before = JSON.stringify(base);
        const m = mutateTree(a, base, format);
        expect(JSON.stringify(base)).toBe(before);
        const m2 = mutateTree(b, mutationBase(b, format), format);
        expect(m2.names).toEqual(m.names);
        expect(JSON.stringify(m2.value)).toBe(JSON.stringify(m.value));
      }
    }
    const v = { a: -0, b: [-0, { c: 1 }] } as Record<string, unknown>;
    Object.defineProperty(v, '__proto__', { value: { op: 'y' }, enumerable: true, writable: true, configurable: true });
    const c = cloneTree(v) as Record<string, unknown>;
    expect(Object.is(c['a'], -0)).toBe(true);
    expect(Object.is((c['b'] as unknown[])[0], -0)).toBe(true);
    expect(Object.hasOwn(c, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(c).not.toBe(v);
  });

  test('the class option draws only that class; the catalogue per format', () => {
    const next = testRng(8);
    for (const format of ['density', 'surfaceRules'] as const) {
      for (const cls of ['breaking', 'preserving'] as const) {
        for (let i = 0; i < 100; i++) {
          const m = mutateTree(next, format === 'density' ? DEFAULT_DENSITY_TREE : DEFAULT_SURFACE_RULES, format, { cls, count: 3 });
          expect(m.cls).toBe(cls);
          expect(m.names).toHaveLength(3);
          for (const n of m.names) expect(n === 'wrap' || mutationsOf(format, cls).includes(n)).toBe(true);
        }
      }
    }
    expect(mutationsOf('density', 'breaking')).not.toContain('airBlock');
    expect(mutationsOf('surfaceRules', 'breaking')).not.toContain('refCycle');
    expect(mutationsOf('surfaceRules', 'preserving')).not.toContain('muteTap');
    expect(new Set([...BREAKING_MUTATIONS, ...PRESERVING_MUTATIONS]).size).toBe(BREAKING_MUTATIONS.length + PRESERVING_MUTATIONS.length);
  });

  test('knotsGrow: a slide of more than 64 knots is refused (TOO_MANY_KNOTS at its knots), one of 64 mostly accepted', () => {
    // SP3d final review (untrusted I1): tier 2 caps a slide's knots, since every cost model charges a slide 1.
    const longest = (v: unknown): number => {
      let most = 0;
      const stack: unknown[] = [v];
      while (stack.length > 0) {
        const x = stack.pop();
        if (typeof x !== 'object' || x === null) continue;
        if (!Array.isArray(x) && x['op' as never] === 'slide') most = Math.max(most, (x['knots' as never] as unknown[]).length);
        for (const y of Object.values(x)) stack.push(y);
      }
      return most;
    };
    const next = testRng(12);
    let refused = 0, at64 = 0, accepted64 = 0;
    for (let i = 0; i < 2000; i++) {
      const m = mutateTree(next, DEFAULT_DENSITY_TREE, 'density', { cls: 'breaking', count: 1 });
      if (m.names[0] !== 'knotsGrow') continue;
      const j = judge(m.value, 'density');
      if (longest(m.value) > 64) {
        expect(j.params).toBeNull();
        expect(j.issues.some((x) => x.code === 'TOO_MANY_KNOTS' && x.path.startsWith('density.defs.') && x.path.endsWith('.knots'))).toBe(true);
        refused++;
      } else {
        expect(longest(m.value)).toBe(64);
        at64++;
        if (j.params !== null) accepted64++;
      }
    }
    expect(refused).toBeGreaterThan(50);
    expect(at64).toBeGreaterThan(10);
    expect(accepted64 / at64).toBeGreaterThan(0.5);
  });

  test('preserving mutations of the defaults are accepted and differ from the default most of the time', () => {
    for (const format of ['density', 'surfaceRules'] as const) {
      const next = testRng(9);
      const base = format === 'density' ? DEFAULT_DENSITY_TREE : DEFAULT_SURFACE_RULES;
      const text = canonicalJSON(base);
      let kept = 0;
      for (let i = 0; i < 200; i++) {
        const m = mutateTree(next, base, format, { cls: 'preserving', count: 1 + (next() % 3) });
        const j = judge(m.value, format);
        if (j.params !== null && canonicalJSON(format === 'density' ? j.params.density.defs : j.params.surface.rules) !== text) kept++;
      }
      expect(kept, format).toBeGreaterThan(120);
    }
  });

  test('the bases: the defaults and fuzz trees over the schema noises, which pass both tiers (density: with negativeZero false)', () => {
    for (const format of ['density', 'surfaceRules'] as const) {
      const next = testRng(10);
      let defaults = 0, valid = 0;
      for (let i = 0; i < 200; i++) {
        const b = mutationBase(next, format);
        if (b === DEFAULT_DENSITY_TREE || b === DEFAULT_SURFACE_RULES) { defaults++; continue; }
        if (judge(b, format).params !== null) valid++;
      }
      expect(defaults).toBeGreaterThan(70);
      expect(defaults).toBeLessThan(130);
      expect(valid, format).toBe(200 - defaults);
    }
  });
});

describe('the fuzz harness options for json leaves (SP3d spec §10)', () => {
  test('randomDensityExpr negativeZero false: the same trees with every −0 written +0', () => {
    const throws = (v: unknown): boolean => {
      try { canonicalJSON(v); return false; } catch { return true; }
    };
    const a = testRng(21), b = testRng(21);
    let withNegativeZero = 0;
    for (let i = 0; i < 300; i++) {
      const x = randomDensityExpr(a, { noises: SCHEMA_DENSITY_NOISES });
      const y = randomDensityExpr(b, { noises: SCHEMA_DENSITY_NOISES, negativeZero: false });
      // JSON prints −0 as 0: equal texts mean equal trees but for the sign of their zeros (and the streams stayed aligned).
      expect(JSON.stringify(y)).toBe(JSON.stringify(x));
      expect(throws(y)).toBe(false);
      if (throws(x)) withNegativeZero++;
    }
    expect(withNegativeZero).toBeGreaterThan(10);
  });

  test('SCHEMA_SURFACE_NOISES: the schema surface noises, none of the fuzz-only ones', () => {
    expect(SCHEMA_SURFACE_NOISES).toEqual(['surface.noises.depth', 'surface.noises.patch', 'surface.noises.bandOffset']);
    for (const id of SURFACE_FUZZ_NOISES) if (!SCHEMA_SURFACE_NOISES.includes(id)) expect(id).toBe('surface.noises.fuzzB');
  });
});

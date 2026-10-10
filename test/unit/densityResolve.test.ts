/**
 * Resolution and freezing of density source trees (SP3d spec §1.5, §1.6, §2.1, §3.4; D6, D10): `resolveDensity`
 * (substitution, `recip`, mutes, constant folding, paths preserved, −0 kept, a fresh frozen output, tier 2 first),
 * `resolveDensityNode` (the inspector's selected-node expression), `freezeTree` and the DensityContext's frozen tree,
 * and §2.1's bit-identity of the resolved default with the legacy builder.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { checkJson, type JsonValue } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import { SCHEMA, type Params, type ParamsPatch } from '../../src/core/params/schema';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { exprHash, ExprValidationError, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { createDensityReference, findTap } from '../../src/gen/density/reference';
import {
  densitySourceValidations, freezeTree, resolveDensity, resolveDensityNode, type DensitySource,
} from '../../src/gen/density/source';
import { ctxFor, paramsWith } from '../harness/gen';
import { legacyDefaultDensityExpr } from '../harness/legacyTrees';
import { randomValue } from '../harness/params';
import { testRng } from '../harness/stats';

const P = paramsWith();
const COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [5, -7], [-68, 100]];

/** −0-aware deep equality: the same keys (any order), arrays of the same length, numbers by `Object.is`. */
function sameTree(a: unknown, b: unknown, path = ''): string | null {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`;
  for (const k of ka) {
    const d = sameTree((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d !== null) return d;
  }
  return null;
}

/** Every container of `v` is frozen. */
function frozenEverywhere(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return true;
  if (!Object.isFrozen(v)) return false;
  return Object.values(v).every(frozenEverywhere);
}

const C = (v: number) => ({ op: 'const', v });
const Y = { op: 'y' };
const src = (root: unknown, defs: Record<string, unknown> = {}): DensitySource => ({ root, defs }) as unknown as DensitySource;
const rootOf = (e: DensityExpr): Record<string, unknown> => e.root as unknown as Record<string, unknown>;
const codes = (f: () => unknown): string[] => {
  try { f(); } catch (e) {
    if (e instanceof ExprValidationError) return e.issues.map((i) => `${i.path}: ${i.code}`);
    throw e;
  }
  return [];
};

describe('resolveDensity (§1.6)', () => {
  test('param nodes and ref-valued fields become numbers (0 − v for neg, never −0)', () => {
    const p = paramsWith({ density: { detailAmpLo: 0, detailAmpHi: 2.5, noises: { jag: { clampSigma: 7.3 } } }, surface: { snowline: 0.5, cliffMinY: 140 } });
    const e = resolveDensity(src({
      op: 'add',
      a: { op: 'clamp', x: Y, lo: { param: 'density.detailAmpLo', neg: true }, hi: { param: 'density.detailAmpHi' } },
      b: { op: 'add',
        a: { op: 'slide', x: { op: 'noise', id: 'detail' }, knots: [[{ param: 'density.detailAmpHi', neg: true }, { param: 'surface.snowline' }], [10, { param: 'density.noises.jag.clampSigma' }]] },
        b: { op: 'tap', name: 't', x: Y, mute: { param: 'surface.cliffMinY', neg: true } } },
    }), p);
    const r = rootOf(e);
    const clamp = r['a'] as { lo: number; hi: number };
    expect(Object.is(clamp.lo, 0)).toBe(true); // 0 − 0 = +0
    expect(clamp.hi).toBe(2.5);
    const slide = (r['b'] as Record<string, unknown>)['a'] as { knots: number[][] };
    expect(slide.knots).toEqual([[-2.5, 0.5], [10, 7.3]]);
    expect((r['b'] as Record<string, unknown>)['b']).toEqual({ op: 'tap', name: 't', x: { op: 'const', v: -140 } });

    const q = resolveDensity(src({ op: 'add', a: { op: 'param', path: 'density.noises.jag.clampSigma' }, b: Y }), p);
    expect(rootOf(q)).toEqual({ op: 'add', a: { op: 'const', v: 7.3 }, b: { op: 'y' } });
  });

  test('recip becomes const(1 / c), the same double the builder computes', () => {
    for (const cs of [1, 3, 7.3, 8, 2.9]) {
      const p = paramsWith({ density: { noises: { jag: { clampSigma: cs } } } });
      const v = p.density.noises.jag.clampSigma;
      const e = resolveDensity(src({ op: 'mul', a: { op: 'noise2', id: 'jag' }, b: { op: 'recip', x: { op: 'param', path: 'density.noises.jag.clampSigma' } } }), p);
      expect(Object.is((rootOf(e)['b'] as { v: number }).v, 1 / v)).toBe(true);
    }
    const k = resolveDensity(src({ op: 'mul', a: Y, b: { op: 'recip', x: C(-3) } }), P);
    expect(rootOf(k)['b']).toEqual({ op: 'const', v: 1 / -3 });
  });

  test('a muted tap keeps the tap and yields its mute; the subtree below leaves the resolved tree', () => {
    const e = resolveDensity(src({ op: 'add', a: { op: 'tap', name: 'm', mute: -1e6, x: { op: 'add', a: { op: 'noise', id: 'detail' }, b: { op: 'tap', name: 'inner', x: Y } } }, b: Y }), P);
    expect(rootOf(e)['a']).toEqual({ op: 'tap', name: 'm', x: { op: 'const', v: -1e6 } });
    expect(findTap(e, 'inner')).toBeUndefined();
    expect(findTap(e, 'm')).toBeDefined();
    // A mute of 0 under a muted tap stays +0; a tap of a const is never folded (`islands`).
    const z = resolveDensity(src({ op: 'max', a: { op: 'tap', name: 'z', mute: 0, x: Y }, b: { op: 'tap', name: 'islands', x: C(-1e6) } }), P);
    expect(rootOf(z)).toEqual({ op: 'max', a: { op: 'tap', name: 'z', x: { op: 'const', v: 0 } }, b: { op: 'tap', name: 'islands', x: { op: 'const', v: -1e6 } } });
  });

  test('constant folding with nodes.ts\'s value functions, bottom-up; −0 kept', () => {
    const fold = (root: unknown, p: Params = P): Record<string, unknown> => rootOf(resolveDensity(src(root), p));
    expect(fold({ op: 'add', a: C(0.1), b: C(0.2) })).toEqual({ op: 'const', v: 0.1 + 0.2 });
    expect(fold({ op: 'mul', a: C(3), b: { op: 'square', x: { op: 'abs', x: C(-2) } } })).toEqual({ op: 'const', v: 12 });
    expect(fold({ op: 'min', a: C(1), b: C(-1) })).toEqual({ op: 'const', v: -1 });
    expect(fold({ op: 'max', a: C(1), b: C(5) })).toEqual({ op: 'const', v: 5 });
    expect(fold({ op: 'clamp', x: C(7), lo: 0, hi: { param: 'density.detailAmpHi' } })).toEqual({ op: 'const', v: DEFAULTS.density.detailAmpHi });
    // min/max return a on ties (+0 against −0), as valMin / valMax.
    expect(Object.is((fold({ op: 'max', a: { op: 'neg', x: C(0) }, b: C(0) }) as { v: number }).v, -0)).toBe(true);
    expect(Object.is((fold({ op: 'min', a: C(0), b: { op: 'neg', x: C(0) } }) as { v: number }).v, 0)).toBe(true);
    // neg(param p) with p = 0, and neg(const 0), fold to −0.
    const neg0 = fold({ op: 'neg', x: { op: 'param', path: 'density.detailAmpLo' } }, paramsWith({ density: { detailAmpLo: 0 } }));
    expect(Object.is(neg0['v'], -0)).toBe(true);
    expect(Object.is((fold({ op: 'neg', x: C(0) }) as { v: number }).v, -0)).toBe(true);
    // ampHi − ampLo: add(param hi, neg(param lo)) → const(hi + (−lo)).
    const p = paramsWith({ density: { detailAmpLo: 0.35, detailAmpHi: 1.05 } });
    const lo = p.density.detailAmpLo, hi = p.density.detailAmpHi;
    expect(Object.is((fold({ op: 'add', a: { op: 'param', path: 'density.detailAmpHi' }, b: { op: 'neg', x: { op: 'param', path: 'density.detailAmpLo' } } }, p) as { v: number }).v, hi - lo)).toBe(true);
  });

  test('tap, interpolated, slide, rangeChoice and ref are never folded; a def is folded inside itself', () => {
    const e = resolveDensity(src({
      op: 'add',
      a: { op: 'add', a: { op: 'tap', name: 't', x: C(1) }, b: { op: 'interpolated', x: { op: 'add', a: C(1), b: C(2) } } },
      b: { op: 'add',
        a: { op: 'slide', x: C(2), knots: [[0, 1], [10, 0]] },
        b: { op: 'add', a: { op: 'rangeChoice', x: C(0.5), lo: 0, hi: 1, inside: C(1), outside: C(2) }, b: { op: 'ref', name: 'd' } } },
    }, { d: { op: 'mul', a: C(2), b: { op: 'neg', x: C(4) } } }), P);
    expect(rootOf(e)).toEqual({
      op: 'add',
      a: { op: 'add', a: { op: 'tap', name: 't', x: C(1) }, b: { op: 'interpolated', x: C(3) } },
      b: { op: 'add',
        a: { op: 'slide', x: C(2), knots: [[0, 1], [10, 0]] },
        b: { op: 'add', a: { op: 'rangeChoice', x: C(0.5), lo: 0, hi: 1, inside: C(1), outside: C(2) }, b: { op: 'ref', name: 'd' } } },
    });
    expect(e.defs).toEqual({ d: C(-8) });
  });

  test('paths are preserved: every surviving node keeps its source path', () => {
    const e = resolveDensity(DEFAULT_DENSITY_TREE, P);
    const at = (v: unknown, path: string): Record<string, unknown> => path.split('.').reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, v as Record<string, unknown>);
    const recipPath = 'root.a.a.x.x.a.a.a.a.b.b.x.b.x.x.b';
    expect(at(DEFAULT_DENSITY_TREE, recipPath)['op']).toBe('recip');
    expect(at(e, recipPath)).toEqual({ op: 'const', v: 1 / P.density.noises.jag.clampSigma });
    expect(at(e, 'root.a.b.b.a')).toEqual({ op: 'const', v: P.density.detailAmpLo });
    expect(at(e, 'root.a.b.b.b.a')).toEqual({ op: 'const', v: P.density.detailAmpHi - P.density.detailAmpLo });
    expect(at(e, 'root.a.a')['op']).toBe('tap');
    expect(at(e, 'root.b')).toEqual({ op: 'tap', name: 'islands', x: C(-1e6) });
  });

  test('a fresh, deep-frozen output; the source is neither changed nor frozen', () => {
    const s = { root: { op: 'add', a: { op: 'param', path: 'density.detailAmpLo' }, b: { op: 'clamp', x: Y, lo: 0, hi: { param: 'density.detailAmpHi' } } }, defs: { d: Y } };
    const before = JSON.stringify(s);
    const a = resolveDensity(s, P), b = resolveDensity(s, P);
    expect(a).not.toBe(b);
    expect(sameTree(a, b)).toBeNull();
    expect(frozenEverywhere(a)).toBe(true);
    expect(JSON.stringify(s)).toBe(before);
    expect(Object.isFrozen(s) || Object.isFrozen(s.root)).toBe(false);
    expect(frozenEverywhere(resolveDensity(DEFAULT_DENSITY_TREE, P))).toBe(true);
  });

  test('tier 2 runs first: an invalid source throws ExprValidationError with its source paths', () => {
    expect(codes(() => resolveDensity(src({ op: 'param', path: 'climate.T' }), P))).toEqual(['root.path: UNKNOWN_PARAM']);
    expect(codes(() => resolveDensity(src({ op: 'recip', x: { op: 'param', path: 'density.detailAmpLo' } }), P))).toEqual(['root.x: RECIP_ZERO']);
    expect(codes(() => resolveDensity(src({ op: 'mul', a: Y, b: C(1e10) }), P))).toEqual(['root.b.v: LITERAL_RANGE']);
    // A tier-1-valid REF_CYCLE source (tier 1 knows nothing of refs) is refused instead of overflowing the stack.
    const issues: Issue[] = [];
    const cyclic = checkJson({ root: { op: 'ref', name: 'a' }, defs: { a: { op: 'ref', name: 'b' }, b: { op: 'neg', x: { op: 'ref', name: 'a' } } } }, 'density.defs', issues, 'density');
    expect(issues).toEqual([]);
    expect(codes(() => resolveDensity(cyclic, P)).map((c) => c.split(': ')[1])).toContain('REF_CYCLE');
    expect(() => resolveDensity(cyclic, P)).toThrow(ExprValidationError);
  });

  test('the validation memo: a frozen source is validated once (the default across contexts), an unfrozen one every call', () => {
    resolveDensity(DEFAULT_DENSITY_TREE, P);
    const n0 = densitySourceValidations();
    resolveDensity(DEFAULT_DENSITY_TREE, paramsWith({ density: { detailAmpHi: 3 } }));
    createDensityContext(ctxFor('42'));
    createDensityContext(ctxFor('7', { density: { detailAmpLo: 0.1 } }));
    expect(densitySourceValidations()).toBe(n0);
    const loose = { root: Y, defs: {} };
    resolveDensity(loose, P);
    resolveDensity(loose, P);
    expect(densitySourceValidations()).toBe(n0 + 2);
  });
});

/** The resolved default and the legacy builder's tree for `p`: equal hash and −0-aware deep equality. */
function checkIdentity(p: Params, what: string): DensityExpr {
  const e = resolveDensity(DEFAULT_DENSITY_TREE, p);
  const legacy = legacyDefaultDensityExpr(p.density);
  expect(exprHash(e.root), what).toBe(exprHash(legacy.root));
  expect(sameTree(e, legacy), what).toBeNull();
  return e;
}

/** Compiled corner and voxel values (Object.is) of the resolved default and the legacy tree at the three columns. */
function checkCompiled(seedText: string, patch: ParamsPatch, what: string, voxelStride: number): void {
  const c = ctxFor(seedText, patch);
  const a = createDensityContext(c);
  const b = createDensityContext(c, legacyDefaultDensityExpr(c.params.density));
  const shape = (dc: DensityContext): number[] => [dc.compiled.nodes.length, dc.compiled.positionSlotCount, dc.compiled.columnSlotCount, dc.compiled.interpolatedSlotCount];
  expect(shape(a), what).toEqual(shape(b));
  // §2.1: 51 nodes, 2 position slots, 2 column slots (at clampSigma 1 the constant 1 / 1 merges with the 1 of J: 50).
  if (seedText === '42' && Object.keys(patch).length === 0) expect(shape(a)).toEqual([51, 2, 2, 1]);
  const eq = (dc: DensityContext, cx: number, cz: number): void => { dc.column(cx, cz); };
  for (const [cx, cz] of COLUMNS) {
    eq(a, cx, cz);
    eq(b, cx, cz);
    for (let k = 0; k <= 48; k++) {
      for (let j = 0; j <= 4; j++) {
        for (let i = 0; i <= 4; i++) {
          a.compiled.cornerFn(i, k, j);
          b.compiled.cornerFn(i, k, j);
          const ix = cornerValueIndex(0, i, k, j);
          if (!Object.is(a.compiled.cornerValues[ix], b.compiled.cornerValues[ix])) throw new Error(`${what}: corner (${i}, ${k}, ${j}) of (${cx}, ${cz})`);
        }
      }
    }
    for (let v = 0; v < 98304; v += voxelStride) {
      const lx = v & 15, lz = (v >> 4) & 15, y = (v >> 8) - 64;
      const va = a.compiled.voxelFn(lx, y, lz), vb = b.compiled.voxelFn(lx, y, lz);
      if (!Object.is(va, vb)) throw new Error(`${what}: voxel (${lx}, ${y}, ${lz}) of (${cx}, ${cz}): ${va} vs ${vb}`);
    }
  }
}

describe('§2.1 bit-identity: the resolved default is the legacy builder\'s tree', () => {
  test('at DEFAULTS and at clampSigma ∈ {1, 3, 7.3, 8}: equal exprHash, −0-aware equality, equal compiled values at every corner and voxel', () => {
    checkIdentity(P, 'DEFAULTS');
    checkCompiled('42', {}, 'DEFAULTS', 1);
    for (const cs of [1, 3, 7.3, 8]) {
      const patch: ParamsPatch = { density: { noises: { jag: { clampSigma: cs } } } };
      checkIdentity(paramsWith(patch), `clampSigma ${cs}`);
      checkCompiled('42', patch, `clampSigma ${cs}`, 1);
    }
  });

  test('at 64 random schema-valid density groups (noise leaves included, q15 through the schema; every corner, every 61st voxel)', () => {
    const next = testRng(808);
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    for (let t = 0; t < 64; t++) {
      const noises: Record<string, unknown> = {};
      const density: Record<string, unknown> = { noises };
      for (const { path, leaf } of leaves) {
        const key = path.slice('density.'.length);
        if (key.startsWith('noises.')) noises[key.slice('noises.'.length)] = randomValue(leaf, next);
        else density[key] = randomValue(leaf, next);
      }
      const patch = { density } as ParamsPatch;
      const what = `group ${t}: ${JSON.stringify(density)}`;
      checkIdentity(paramsWith(patch), what);
      checkCompiled('42', patch, what, 61);
    }
  });

  test('the default DensityContext compiles the resolved default (one frozen tree)', () => {
    const dc = createDensityContext(ctxFor('42'));
    expect(exprHash(dc.expr.root)).toBe(exprHash(legacyDefaultDensityExpr(DEFAULTS.density).root));
    expect(dc.compiled.expr).toBe(dc.expr);
    expect(frozenEverywhere(dc.expr)).toBe(true);
  });
});

describe('resolveDensityNode (§3.4)', () => {
  /** The default tree with the terrain tap muted to 0 (U2's density perturbation). */
  const muted = (() => {
    const t = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { a: { a: Record<string, unknown> } } };
    t.root.a.a['mute'] = 0;
    return t as unknown as DensitySource;
  })();
  const ctx = ctxFor('42');
  const dc = createDensityContext(ctx);

  test('a node under a muted tap is evaluated from the source: the muted terrain tap and its interpolated sum give the unmuted terrain', () => {
    const full = createDensityReference(resolveDensity(DEFAULT_DENSITY_TREE, P), dc.noises);
    const tapNode = resolveDensityNode(muted, 'root.a.a', P);
    expect(rootOf(tapNode)['op']).toBe('tap');
    expect(rootOf(tapNode)['x']).toMatchObject({ op: 'interpolated' });
    const inner = resolveDensityNode(muted, 'root.a.a.x.x', P);
    expect(rootOf(inner)['op']).toBe('interpolated'); // wrapped: it has an interpolated ancestor
    expect(sameTree(rootOf(inner)['x'], (rootOf(resolveDensity(DEFAULT_DENSITY_TREE, P))['a'] as { a: { x: { x: unknown } } }).a.x.x)).toBeNull();
    const rTap = createDensityReference(tapNode, dc.noises), rInner = createDensityReference(inner, dc.noises);
    const mutedRoot = createDensityReference(resolveDensity(muted, P), dc.noises);
    const next = testRng(809);
    for (let n = 0; n < 300; n++) {
      const [cx, cz] = COLUMNS[n % COLUMNS.length]!;
      const s = dc.columns.get(cx, cz);
      const x = 16 * cx + (next() % 16), z = 16 * cz + (next() % 16), y = -64 + (next() % 384);
      const want = full.tap(s, 'terrain', x, y, z);
      expect(Object.is(rTap.voxel(s, x, y, z), want)).toBe(true);
      expect(Object.is(rInner.voxel(s, x, y, z), want)).toBe(true);
      expect(mutedRoot.tap(s, 'terrain', x, y, z)).toBe(0);
    }
  });

  test('the root is the final density (its own mute applies there); a node with no interpolated ancestor is not wrapped', () => {
    expect(sameTree(resolveDensityNode(muted, 'root', P), resolveDensity(muted, P))).toBeNull();
    const detail = resolveDensityNode(muted, 'root.a.b', P);
    expect(sameTree(detail.root, (rootOf(resolveDensity(DEFAULT_DENSITY_TREE, P))['a'] as { b: unknown }).b)).toBeNull();
    expect(detail.defs).toEqual({});
    // An interpolated node itself is not wrapped again.
    expect(rootOf(resolveDensityNode(muted, 'root.a.a.x', P))['op']).toBe('interpolated');
    expect((rootOf(resolveDensityNode(muted, 'root.a.a.x', P))['x'] as { op: string }).op).toBe('add');
    // A param operand of recip is a node too: its value.
    expect(resolveDensityNode(DEFAULT_DENSITY_TREE, 'root.a.a.x.x.a.a.a.a.b.b.x.b.x.x.b.x', P).root)
      .toEqual({ op: 'interpolated', x: C(P.density.noises.jag.clampSigma) });
  });

  test('a def, and a node inside it, take the placement of the def\'s first reference; an unreachable def is at voxel placement', () => {
    const s = src(
      { op: 'add', a: { op: 'interpolated', x: { op: 'add', a: { op: 'ref', name: 'inner' }, b: { op: 'tap', name: 't', x: Y } } }, b: { op: 'ref', name: 'amp' } },
      {
        amp: { op: 'mul', a: { op: 'noise', id: 'detail' }, b: { op: 'ref', name: 'inner' } },
        inner: { op: 'add', a: { op: 'col', field: 'offset' }, b: { op: 'neg', x: Y } },
        lone: { op: 'add', a: { op: 'ref', name: 'amp' }, b: { op: 'tap', name: 'u', mute: 0, x: Y } },
      },
    );
    // inner is first referenced inside interpolated (root.a.x.a), although amp also reads it at voxel placement.
    const inner = resolveDensityNode(s, 'defs.inner', P);
    expect(inner.root).toEqual({ op: 'interpolated', x: { op: 'add', a: { op: 'col', field: 'offset' }, b: { op: 'neg', x: Y } } });
    expect(inner.defs).toEqual({});
    expect(resolveDensityNode(s, 'defs.inner.b.x', P).root).toEqual({ op: 'interpolated', x: Y });
    // amp is first referenced at voxel placement; its own output carries the defs it reaches.
    const amp = resolveDensityNode(s, 'defs.amp', P);
    expect(amp.root).toEqual({ op: 'mul', a: { op: 'noise', id: 'detail' }, b: { op: 'ref', name: 'inner' } });
    expect(Object.keys(amp.defs)).toEqual(['inner']);
    // lone is unreachable: voxel placement; its muted tap applies inside it, the selected tap's own mute does not.
    const lone = resolveDensityNode(s, 'defs.lone', P);
    expect(lone.root).toEqual({ op: 'add', a: { op: 'ref', name: 'amp' }, b: { op: 'tap', name: 'u', x: C(0) } });
    expect(Object.keys(lone.defs).sort()).toEqual(['amp', 'inner']);
    expect(resolveDensityNode(s, 'defs.lone.b', P).root).toEqual({ op: 'tap', name: 'u', x: Y });
    // Every output compiles and evaluates.
    const s0 = dc.columns.get(0, 0);
    for (const path of ['defs.inner', 'defs.inner.b.x', 'defs.amp', 'defs.lone', 'defs.lone.b', 'root', 'root.a', 'root.a.x.b']) {
      const r = createDensityReference(resolveDensityNode(s, path, P), dc.noises);
      expect(Number.isFinite(r.voxel(s0, 3, 70, 5)), path).toBe(true);
    }
    expect(frozenEverywhere(amp)).toBe(true);
  });

  test('a path that names no node throws a RangeError; an invalid source throws ExprValidationError', () => {
    expect(() => resolveDensityNode(DEFAULT_DENSITY_TREE, 'root.q', P)).toThrow(RangeError);
    expect(() => resolveDensityNode(DEFAULT_DENSITY_TREE, 'root.a.b.b.b.b.lo', P)).toThrow(RangeError);
    expect(() => resolveDensityNode(DEFAULT_DENSITY_TREE, 'defs.nope', P)).toThrow(RangeError);
    expect(() => resolveDensityNode(DEFAULT_DENSITY_TREE, '', P)).toThrow(RangeError);
    expect(() => resolveDensityNode(src({ op: 'bogus' }), 'root', P)).toThrow(ExprValidationError);
  });
});

describe('freezeTree and the DensityContext\'s frozen tree (D10)', () => {
  test('freezeTree deep-freezes in place, identity kept, also below an already-frozen node; shared and cyclic objects once', () => {
    const leaf = { op: 'y' };
    const mid = Object.freeze({ op: 'neg', x: { op: 'abs', x: leaf } }); // frozen, its child not
    const tree = { root: { op: 'add', a: mid, b: leaf }, defs: { d: { op: 'slide', x: leaf, knots: [[0, 1], [2, 3]] } } };
    expect(freezeTree(tree)).toBe(tree);
    expect(frozenEverywhere(tree)).toBe(true);
    const cyc: Record<string, unknown> = { op: 'neg' };
    cyc['x'] = cyc;
    expect(freezeTree(cyc)).toBe(cyc);
    expect(Object.isFrozen(cyc)).toBe(true);
    expect(freezeTree(5)).toBe(5);
    const typed = new Float64Array(2);
    expect(() => freezeTree({ a: typed })).not.toThrow();
    expect(Object.isFrozen(typed)).toBe(false);
  });

  test('an explicit tree is frozen in place (identity kept): mutating dc.expr at any depth throws', () => {
    const inner = Object.freeze({ op: 'add', a: { op: 'noise', id: 'detail' }, b: { op: 'y' } });
    const e = { root: { op: 'max', a: inner, b: { op: 'tap', name: 'islands', x: { op: 'const', v: -1e6 } } }, defs: {} } as unknown as DensityExpr;
    const dc2 = createDensityContext(ctxFor('42'), e);
    expect(dc2.expr).toBe(e);
    expect(dc2.compiled.expr).toBe(e);
    expect(frozenEverywhere(e)).toBe(true);
    expect(() => { (rootOf(e)['b'] as Record<string, unknown>)['name'] = 'x'; }).toThrow(TypeError);
    expect(() => { ((inner as unknown as { a: Record<string, unknown> }).a)['id'] = 'jag'; }).toThrow(TypeError);
    expect(() => { (e.defs as Record<string, Expr>)['n'] = { op: 'y' }; }).toThrow(TypeError);
  });

  test('the default context\'s tree is frozen at every depth', () => {
    const dc3 = createDensityContext(ctxFor('42'));
    expect(() => { (rootOf(dc3.expr)['b'] as Record<string, unknown>)['name'] = 'x'; }).toThrow(TypeError);
    const tap = rootOf(dc3.expr)['a'] as { a: { x: { x: Record<string, unknown> } } };
    expect(() => { tap.a.x.x['op'] = 'mul'; }).toThrow(TypeError);
    expect(() => { (dc3.expr as unknown as Record<string, unknown>)['root'] = null; }).toThrow(TypeError);
  });

  test('the default tree is JSON data: resolution reads it, never mutates it', () => {
    const text = JSON.stringify(DEFAULT_DENSITY_TREE as JsonValue);
    resolveDensity(DEFAULT_DENSITY_TREE, paramsWith({ density: { detailAmpLo: 2 } }));
    expect(JSON.stringify(DEFAULT_DENSITY_TREE)).toBe(text);
  });
});

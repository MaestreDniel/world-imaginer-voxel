import { describe, expect, test } from 'vitest';
import { toUniform, uMax } from '../../src/core/noise/cdf';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { metaOf, PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { checkRegistry, STAGES } from '../../src/core/stage/registry';
import { islandMaskAt, islandMaskOfU } from '../../src/gen/column/islands';
import { createGenContext, noiseFor } from '../../src/gen/context';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

/** Task 3's `islands.enabled` doc: the mask only (water v0's island rule lands with its code, SP3e spec §3.5). */
const ENABLED_DOC = 'Computes the island cluster mask `islandMask` (off: 0); on in floating_islands.';
const FLOATING = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));

/** n points uniform over the colKey window [−2^19, 2^19)², from testRng(seed). */
const points = (n: number, seed: number): Array<readonly [number, number]> => {
  const next = testRng(seed);
  return Array.from({ length: n }, () => [-524288 + 1048576 * testFloat(next), -524288 + 1048576 * testFloat(next)] as const);
};

describe('SP3e islands group (spec §2.1, D9, D10)', () => {
  test('four leaves, last in the schema, scope terrain and stage shape; the group is the last top-level section', () => {
    expect(PARAM_META.filter((m) => m.path.startsWith('islands.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`)).toEqual([
      'islands.enabled:bool:terrain:shape',
      'islands.noise:noise:terrain:shape',
      'islands.lo:number:terrain:shape',
      'islands.hi:number:terrain:shape',
    ]);
    expect(PARAM_META.slice(-4).map((m) => m.path)).toEqual(['islands.enabled', 'islands.noise', 'islands.lo', 'islands.hi']);
    expect(Object.keys(DEFAULTS).at(-1)).toBe('islands');
    const g = SCHEMA.byPath.get('islands');
    expect(g?.tag).toBe('group');
    if (g?.tag === 'group') expect(g.label).toBe('Islands');
  });

  test('meta: the docs, the noise\'s wavelength range and dims, lo and hi in [−1, 1] step 0.01', () => {
    expect(metaOf('islands.enabled')).toMatchObject({ kind: 'bool', label: 'Enabled', doc: ENABLED_DOC });
    expect(metaOf('islands.enabled')?.min).toBeUndefined();
    expect(metaOf('islands.noise')).toMatchObject({ kind: 'noise', dims: 2, min: 16, max: 8192, doc: 'u = U(z2) of this noise sets the mask.' });
    expect(metaOf('islands.lo')).toMatchObject({ min: -1, max: 1, step: 0.01, doc: 'u where `islandMask` starts to rise from 0.' });
    expect(metaOf('islands.hi')).toMatchObject({ min: -1, max: 1, step: 0.01, doc: 'u from which `islandMask` is 1 (lo ≥ hi: a step at lo).' });
  });

  test('defaults: off, λ 700 × 2 octaves remapped uniform (double, clampSigma 3), lo 0.55, hi 0.8', () => {
    const d = DEFAULTS.islands;
    expect(d.enabled).toBe(false);
    const n = d.noise;
    expect([n.wavelength, n.octaves, n.persistence, n.lacunarity, n.remap, n.double, n.clampSigma, n.amplitudes]).toEqual([700, 2, 0.5, 2, 'uniform', true, 3, null]);
    expect([d.lo, d.hi]).toEqual([0.55, 0.8]);
  });

  test('a bool leaf: enabled refuses a non-boolean; lo ≥ hi is a legal state (no cross-leaf check); the ranges hold', () => {
    const codes = (patch: unknown) => {
      const r = applyPatch(SCHEMA, DEFAULTS, patch);
      return r.ok ? [] : r.issues.map((i) => `${i.path} ${i.code}`).sort();
    };
    expect(codes({ islands: { enabled: 1 } })).toEqual(['islands.enabled NOT_BOOL']);
    expect(codes({ islands: { lo: 0.8, hi: 0.55 } })).toEqual([]);
    expect(codes({ islands: { lo: 0.5, hi: 0.5 } })).toEqual([]);
    expect(codes({ islands: { lo: -1.01, hi: 1.01 } })).toEqual(['islands.hi OUT_OF_RANGE', 'islands.lo OUT_OF_RANGE']);
    expect(codes({ islands: { noise: { wavelength: 8193 } } })).toEqual(['islands.noise.wavelength OUT_OF_RANGE']);
  });

  test('the shape stage hashes the group (U4 registry invariants hold); the noise instance is seeded by its path, 2D', () => {
    expect(STAGES.find((s) => s.id === 'shape')!.params).toEqual(['shape', 'rivers', 'lakes', 'islands']);
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
    const inst = noiseInstances(SCHEMA, DEFAULTS).filter((i) => i.path.startsWith('islands.'));
    expect(inst.map((i) => `${i.seedName}|${i.dims}`)).toEqual(['islands.noise|2']);
  });

  test('floating_islands\' overlay enables the mask (SP3e spec §1.1; its trees arrive with their tasks)', () => {
    expect(resolveProfile('floating_islands').islands).toEqual({ ...DEFAULTS.islands, enabled: true });
    for (const p of ['default', 'large_biomes', 'archipelago', 'amplified'] as const) expect(resolveProfile(p).islands.enabled, p).toBe(false);
  });
});

describe('islandMaskOfU: smoothstep(lo, hi, u), a step at lo when lo ≥ hi (SP3e spec §2.2)', () => {
  const um = uMax(3);
  test('at u = lo +0 (never −0), at u = hi 1; at −uMax 0 and at +uMax 1 with the defaults; the middle 0.5', () => {
    expect(Object.is(islandMaskOfU(0.55, 0.55, 0.8), 0)).toBe(true);
    expect(islandMaskOfU(0.8, 0.55, 0.8)).toBe(1);
    expect(Object.is(islandMaskOfU(-um, 0.55, 0.8), 0)).toBe(true);
    expect(islandMaskOfU(um, 0.55, 0.8)).toBe(1);
    expect(islandMaskOfU(0.675, 0.55, 0.8)).toBeCloseTo(0.5, 12);
    expect(Object.is(islandMaskOfU(-0, 0, 0.5), 0)).toBe(true);
    expect(Object.is(islandMaskOfU(0, -0, 0.5), 0)).toBe(true);
  });

  test('lo ≥ hi: the literals 1 at u ≥ lo and +0 below, lo = hi included (unguarded, lo = hi would give 0/0 = NaN)', () => {
    expect(islandMaskOfU(0.5, 0.5, 0.5)).toBe(1);
    expect(Object.is(islandMaskOfU(0.4999, 0.5, 0.5), 0)).toBe(true);
    expect(islandMaskOfU(0.8, 0.8, 0.55)).toBe(1);
    expect(Object.is(islandMaskOfU(0.7, 0.8, 0.55), 0)).toBe(true);
    expect(Object.is(islandMaskOfU(-um, 0.8, 0.55), 0)).toBe(true);
  });

  test('a subnormal hi − lo: ±Infinity for t, clamped to +0 or 1', () => {
    expect(islandMaskOfU(0.1, 0, 5e-324)).toBe(1);
    expect(Object.is(islandMaskOfU(-0.1, 0, 5e-324), 0)).toBe(true);
  });

  test('m ∈ {+0} ∪ (0, 1] over a fine sweep of u and of the edges', () => {
    for (const [lo, hi] of [[0.55, 0.8], [-1, 1], [0.3, 0.3], [0.9, -0.9], [0.999, 1]] as const) {
      for (let i = -1000; i <= 1000; i++) {
        const m = islandMaskOfU((i / 1000) * um, lo, hi);
        expect(m >= 0 && m <= 1 && !Object.is(m, -0), `lo ${lo} hi ${hi} u ${(i / 1000) * um}: ${m}`).toBe(true);
      }
    }
  });
});

describe('islandMaskAt (SP3e spec §2.2, D11)', () => {
  test('off (every profile but floating_islands): the literal +0', () => {
    const ctx = ctxFor('42');
    for (const [x, z] of points(2000, 3101)) expect(Object.is(islandMaskAt(ctx, x, z), 0)).toBe(true);
    const lb = createGenContext(seedFromInput('42'), resolveProfile('large_biomes'));
    for (const [x, z] of points(200, 3102)) expect(Object.is(islandMaskAt(lb, x, z), 0)).toBe(true);
  });

  test('on: islandMaskOfU of u = toUniform(z2) of islands.noise at the unscaled, unwarped coordinates', () => {
    const n = noiseFor(FLOATING, 'islands.noise');
    const p = FLOATING.params.islands;
    for (const [x, z] of points(2000, 3103)) expect(Object.is(islandMaskAt(FLOATING, x, z), islandMaskOfU(toUniform(n.z2(x, z)), p.lo, p.hi))).toBe(true);
    // climate.scaleMul zooms the climate, not the clusters (D11).
    const zoomed = createGenContext(seedFromInput('42'), (() => {
      const r = applyPatch(SCHEMA, FLOATING.params, { climate: { scaleMul: 4 } });
      if (!r.ok) throw new Error('bad patch');
      return r.value;
    })());
    for (const [x, z] of points(200, 3104)) expect(Object.is(islandMaskAt(zoomed, x, z), islandMaskAt(FLOATING, x, z))).toBe(true);
  });

  test('on, 10⁵ points over the colKey window: m ∈ [0, 1], never −0; m > 0 on ≈ 22 % and m = 1 on ≈ 10 % (theory 22.5 % / 10 %)', () => {
    let positive = 0;
    let full = 0;
    const pts = points(100_000, 3105);
    for (const [x, z] of pts) {
      const m = islandMaskAt(FLOATING, x, z);
      expect(m >= 0 && m <= 1 && !Object.is(m, -0), `(${x}, ${z}): ${m}`).toBe(true);
      if (m > 0) positive++;
      if (m === 1) full++;
    }
    const share = (k: number) => k / pts.length;
    expect(share(positive)).toBeGreaterThan(0.2);
    expect(share(positive)).toBeLessThan(0.25);
    expect(share(full)).toBeGreaterThan(0.085);
    expect(share(full)).toBeLessThan(0.115);
  });

  test('on with lo ≥ hi (lo = hi included): only the literals +0 and 1', () => {
    for (const islands of [{ lo: 0.6, hi: 0.6 }, { lo: 0.7, hi: 0.2 }]) {
      const ctx = createGenContext(seedFromInput('7'), (() => {
        const r = applyPatch(SCHEMA, FLOATING.params, { islands });
        if (!r.ok) throw new Error('bad patch');
        return r.value;
      })());
      const seen = new Set<string>();
      for (const [x, z] of points(4000, 3106)) seen.add(Object.is(islandMaskAt(ctx, x, z), -0) ? '-0' : String(islandMaskAt(ctx, x, z)));
      expect([...seen].sort(), JSON.stringify(islands)).toEqual(['0', '1']);
    }
  });
});

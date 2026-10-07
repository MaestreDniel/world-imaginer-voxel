import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import { latticeIndex, type ColumnSample } from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { fillDensityColumn } from '../../src/gen/density/bounds';
import { createDensityContext, densityNoiseSource, type DensityContext } from '../../src/gen/density/context';
import { defaultDensityExpr } from '../../src/gen/density/defaults';
import { validateExpr, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { cornerY } from '../../src/gen/density/nodes';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, findTap, interpolatedNodes } from '../../src/gen/density/reference';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { randomValue } from '../harness/params';
import { testRng } from '../harness/stats';

const CTX = ctxFor('42');
/** Land (0, 0) and (5, −7); mountains (σ > 11, jag up to 37) at (−68, 100) and (−1022, −786); ocean (offset < 17) at (205, −181). */
const COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [5, -7], [-68, 100], [-1022, -786], [205, -181]];

function walk(e: Expr, visit: (e: Expr) => void): void {
  visit(e);
  for (const k of ['a', 'b', 'x', 'inside', 'outside'] as const) {
    const c = (e as unknown as Record<string, Expr | undefined>)[k];
    if (c !== undefined && typeof c === 'object') walk(c, visit);
  }
}
const ops = (e: DensityExpr): Expr[] => { const out: Expr[] = []; walk(e.root, (n) => out.push(n)); return out; };
const consts = (e: DensityExpr): number[] => ops(e).flatMap((n) => (n.op === 'const' ? [n.v] : []));

describe('the default expression (SP3b spec §3.1)', () => {
  test('it validates against the schema density noises', () => {
    const e = defaultDensityExpr(DEFAULTS.density);
    expect(validateExpr(e, densityNoiseSource(CTX))).toEqual([]);
    expect(Object.keys(e.defs)).toEqual([]);
    const noiseIds = ops(e).flatMap((n) => (n.op === 'noise2' || n.op === 'noise' ? [`${n.op}:${n.id}`] : []));
    expect(noiseIds.sort()).toEqual(['noise2:jag', 'noise:detail', 'noise:overhang']);
    const slides = ops(e).flatMap((n) => (n.op === 'slide' ? [n.knots] : []));
    expect(slides).toEqual([[[-64, 0], [-40, 1], [240, 1], [320, 0]]]);
  });

  test('taps: terrain outside interpolated (its value is the interpolated field), islands −1e6', () => {
    const e = defaultDensityExpr(DEFAULTS.density);
    expect(findTap(e, 'terrain')).toMatchObject({ inside: false, node: { x: { op: 'interpolated' } } });
    expect(findTap(e, 'islands')).toMatchObject({ inside: false, node: { x: { op: 'const', v: -1e6 } } });
    expect(interpolatedNodes(e)).toHaveLength(1);
  });

  test('placement: one interpolated slot; detail is VOXEL and reads amp from a position slot (bilinear E)', () => {
    const dc = createDensityContext(CTX);
    const c = dc.compiled;
    expect(c.interpolatedSlotCount).toBe(1);
    const detail = c.nodes.find((n) => n.op === 'noise' && (n.expr as { id: string }).id === 'detail')!;
    expect([detail.cls, detail.inside]).toEqual(['voxel', false]);
    const parent = c.nodes.find((n) => n.op === 'mul' && n.kids.includes(c.nodes.indexOf(detail)))!;
    const amp = c.nodes[parent.kids.find((k) => k !== c.nodes.indexOf(detail))!]!;
    expect([amp.op, amp.cls, amp.posSlot >= 0]).toEqual(['add', 'column', true]);
    // y and slide are never COLUMN (spec §2.1).
    for (const n of c.nodes) if (n.op === 'y' || n.op === 'slide') expect(n.cls, n.op).toBe('cell');
  });

  test('the tunables come from params.density: 1 / jag clampSigma, ampLo and ampHi − ampLo', () => {
    const base = consts(defaultDensityExpr(DEFAULTS.density));
    expect(base).toContain(1 / 3);
    expect(base).toContain(0.6);
    expect(base).toContain(1.5 - 0.6);
    const d = { ...DEFAULTS.density, noises: { ...DEFAULTS.density.noises, jag: { ...DEFAULTS.density.noises.jag, clampSigma: 2.5 } }, detailAmpLo: 0.25, detailAmpHi: 4 };
    const moved = consts(defaultDensityExpr(d));
    expect(moved).toContain(1 / 2.5);
    expect(moved).toContain(0.25);
    expect(moved).toContain(3.75);
    expect(moved).not.toContain(1 / 3);
  });
});

describe('DensityContext (spec §2.3)', () => {
  test('the noise source is the GenContext\'s density.noises.<id> NormalNoises, with the schema dims', () => {
    const src = densityNoiseSource(CTX);
    for (const [id, dims] of [['jag', 2], ['overhang', 3], ['detail', 3]] as const) {
      const n = src(id)!;
      const nn = CTX.noise.get(`density.noises.${id}`)!;
      expect([n.dims, n.remap, n.clampSigma]).toEqual([dims, 'none', nn.clamp]);
      for (const [x, y, z] of [[0, 0, 0], [123, -17, -4567], [-99999, 300, 31337]] as const) {
        expect(n.z2(x, z)).toBe(nn.z2(x, z));
        expect(n.z3(x, y, z)).toBe(nn.z3(x, y, z));
      }
    }
    expect(SCHEMA_DENSITY_NOISES).toEqual([{ id: 'jag', dims: 2 }, { id: 'overhang', dims: 3 }, { id: 'detail', dims: 3 }]);
    expect(src('climate.C')).toBeUndefined();
    expect(src('nope')).toBeUndefined();
  });

  test('column(cx, cz) reuses the current column and the ColumnCache', () => {
    const dc = createDensityContext(CTX);
    const s = dc.column(3, -4);
    expect([s.cx, s.cz, dc.compiled.hasPositions(3, -4), dc.columns.size]).toEqual([3, -4, true, 1]);
    expect(dc.column(3, -4)).toBe(s);
    dc.column(4, -4);
    expect([dc.compiled.hasPositions(3, -4), dc.compiled.hasPositions(4, -4), dc.columns.size]).toEqual([false, true, 2]);
    expect(dc.column(3, -4)).toBe(s);
  });

  test('a custom expression compiles over the same noises', () => {
    const e: DensityExpr = { root: { op: 'add', a: { op: 'noise', id: 'detail' }, b: { op: 'y' } }, defs: {} };
    const dc = createDensityContext(CTX, e);
    expect(probe(dc, 17, 5, -3)).toBe(CTX.noise.get('density.noises.detail')!.z3(17, 5, -3) + 5);
    expect(() => createDensityContext(CTX, { root: { op: 'noise', id: 'jag' }, defs: {} })).toThrow(/NOISE_DIMS/);
  });
});

/**
 * The default expression at a lattice-aligned voxel (lx, lz ∈ {0, 4, 8, 12}, y = −64 + 8k), by hand: every
 * interpolation weight is 0, so the terrain is its corner value and the bilinear E is the lattice E.
 */
function byHand(s: ColumnSample, i: number, k: number, j: number): { terrain: number; final: number } {
  const x = 16 * s.cx + 4 * i, y = cornerY(k), z = 16 * s.cz + 4 * j, l = latticeIndex(i, j);
  const n = (id: string) => CTX.noise.get(`density.noises.${id}`)!;
  const p = DEFAULTS.density;
  const q = 1 - Math.abs(n('jag').z2(x, z) * (1 / p.noises.jag.clampSigma));
  const J = q * q;
  // slide(N3) over [(−64, 0), (−40, 1), (240, 1), (320, 0)]
  const sAt = y < -40 ? 0 + (y - -64) * ((1 - 0) / (-40 - -64)) : y < 240 ? 1 + (y - -40) * ((1 - 1) / (240 - -40)) : y < 320 ? 1 + (y - 240) * ((0 - 1) / (320 - 240)) : 0;
  let t = s.f.offset[l]! + s.f.jag[l]! * J;
  t = t + -y;
  t = t + s.f.sigma[l]! * (n('overhang').z3(x, y, z) * sAt);
  t = t + 2 * Math.max(0, -56 + -y);
  t = t + -(2 * Math.max(0, y + -296));
  const amp = p.detailAmpLo + (p.detailAmpHi - p.detailAmpLo) * Math.min(1, Math.max(0, (s.f.E[l]! + 1) * 0.5));
  const v = t + n('detail').z3(x, y, z) * amp;
  return { terrain: t, final: v > -1e6 ? v : -1e6 };
}

describe('probe (spec §2.3)', () => {
  test('hand-checked values at lattice-aligned voxels: final, the terrain tap and the islands tap', () => {
    const dc = createDensityContext(CTX);
    let checked = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.columns.get(cx, cz);
      for (const [i, j] of [[0, 0], [1, 2], [3, 3], [2, 0]] as const) {
        for (const k of [0, 1, 2, 10, 15, 16, 20, 25, 30, 40, 48]) {
          if (k === 48) continue; // y 320 is above the world.
          const x = 16 * cx + 4 * i, y = cornerY(k), z = 16 * cz + 4 * j;
          const h = byHand(s, i, k, j);
          expect(probe(dc, x, y, z), `(${x}, ${y}, ${z})`).toBe(h.final);
          expect(probe(dc, x, y, z, 'terrain'), `terrain (${x}, ${y}, ${z})`).toBe(h.terrain);
          expect(probe(dc, x, y, z, 'islands')).toBe(-1e6);
          checked++;
        }
      }
    }
    expect(checked).toBe(5 * 4 * 10);
  });

  test('probe == the reference interpreter (Object.is) at random voxels, across column switches', () => {
    const dc = createDensityContext(CTX);
    const ref = createDensityReference(dc.expr, dc.noises);
    const next = testRng(601);
    for (let n = 0; n < 600; n++) {
      const [cx, cz] = COLUMNS[next() % COLUMNS.length]!;
      const x = 16 * cx + (next() % 16), z = 16 * cz + (next() % 16), y = -64 + (next() % 384);
      const s = dc.columns.get(cx, cz);
      const tap = n % 3 === 0 ? 'terrain' : undefined;
      const want = tap === undefined ? ref.voxel(s, x, y, z) : ref.tap(s, tap, x, y, z);
      const got = probe(dc, x, y, z, tap);
      if (!Object.is(got, want)) throw new Error(`probe(${x}, ${y}, ${z}${tap ? `, ${tap}` : ''}) = ${got}, reference ${want}`);
    }
  });

  test('arguments: integers, y in −64 … 319, (x, z) in the world window; unknown taps throw', () => {
    const dc = createDensityContext(CTX);
    expect(() => probe(dc, 0, -65, 0)).toThrow(RangeError);
    expect(() => probe(dc, 0, 320, 0)).toThrow(RangeError);
    expect(() => probe(dc, 0.5, 0, 0)).toThrow(RangeError);
    expect(() => probe(dc, 0, 0, 524288)).toThrow(RangeError);
    expect(() => probe(dc, 0, 0, 0, 'nope')).toThrow(/no tap "nope"/);
    expect(Number.isFinite(probe(dc, -524288, 319, 524287))).toBe(true);
  });
});

/** Column-wide voxel index, as the T stage's sections: ((y + 64)·16 + lz)·16 + lx. */
const vIdx = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;
const hull = (a: Float64Array, ls: readonly number[]): [number, number] => {
  let lo = Infinity, hi = -Infinity;
  for (const l of ls) { lo = Math.min(lo, a[l]!); hi = Math.max(hi, a[l]!); }
  return [lo, hi];
};

describe('early-outs of the default expression (spec §3.2) and the driver on it', () => {
  test('cells above offset + jag + cs·σ + cs·ampHi are air and cells the floor term keeps positive are solid, without evaluation; driver == probe', () => {
    const dc = createDensityContext(CTX);
    const cs = DEFAULTS.density.noises.overhang.clampSigma, csD = DEFAULTS.density.noises.detail.clampSigma, ampHi = DEFAULTS.density.detailAmpHi;
    const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
    let above = 0, below = 0, evaluated = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.columns.get(cx, cz);
      expect(fillDensityColumn(dc.bounds, s, solid, values, mask, () => false)).toBe(true);
      for (let ck = 0; ck < 48; ck++) {
        const y0 = cornerY(ck);
        for (let cj = 0; cj < 4; cj++) {
          for (let ci = 0; ci < 4; ci++) {
            const ls = [latticeIndex(ci, cj), latticeIndex(ci + 1, cj), latticeIndex(ci, cj + 1), latticeIndex(ci + 1, cj + 1)];
            const [offLo, offHi] = hull(s.f.offset, ls), [jagLo, jagHi] = hull(s.f.jag, ls), [sgLo, sgHi] = hull(s.f.sigma, ls);
            const sg = Math.max(Math.abs(sgLo), Math.abs(sgHi));
            const top = offHi + Math.max(0, jagHi) + cs * sg + csD * ampHi;
            const low = offLo + Math.min(0, jagLo) - (y0 + 8) - cs * sg + 2 * Math.max(0, -56 - (y0 + 8)) - 2 * Math.max(0, y0 + 8 - 296) - csD * ampHi;
            let masked = 0, solids = 0;
            for (let y = y0; y < y0 + 8; y++) {
              for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
                for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
                  const v = vIdx(lx, y, lz);
                  masked += mask[v]!;
                  solids += solid[v]!;
                }
              }
            }
            if (masked > 0) evaluated++;
            if (y0 > top + 1e-3) { above++; expect([masked, solids], `cell (${ci}, ${ck}, ${cj}) of (${cx}, ${cz})`).toEqual([0, 0]); }
            if (low > 1e-3) { below++; expect([masked, solids], `cell (${ci}, ${ck}, ${cj}) of (${cx}, ${cz})`).toEqual([0, 128]); }
          }
        }
      }
      // Driver == probe (no early-outs) at every voxel: solidity, and the value where the driver evaluated.
      for (let y = -64; y < 320; y++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const v = vIdx(lx, y, lz);
            const p = probe(dc, 16 * cx + lx, y, 16 * cz + lz);
            if (solid[v] !== (p > 0 ? 1 : 0)) throw new Error(`(${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): solid ${solid[v]}, probe ${p}`);
            if (mask[v] === 1 && !Object.is(values[v], p)) throw new Error(`(${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): driver ${values[v]}, probe ${p}`);
          }
        }
      }
    }
    // Both rules apply to most cells; few cells straddle the surface. Before the §8.4 retune: 3,269 of 3,840 cells
    // decided by the rules, 177 evaluated; after it (larger σ, a wider open band): 3,029 and 289.
    expect(above + below).toBeGreaterThan(0.75 * COLUMNS.length * 768);
    expect(below).toBeGreaterThan(COLUMNS.length * 16 * 4);
    expect(evaluated / (COLUMNS.length * 768)).toBeLessThan(0.1);
  });
});

describe('compile == reference over the schema density noises (fuzz)', () => {
  test('random trees over jag / overhang / detail, Object.is at random voxels', () => {
    const noises = densityNoiseSource(CTX);
    const next = testRng(602);
    const s = createDensityContext(CTX).columns.get(-68, 100);
    for (let t = 0; t < 60; t++) {
      const e = randomDensityExpr(next, { noises: SCHEMA_DENSITY_NOISES });
      const dc = createDensityContext(CTX, e);
      const ref = createDensityReference(e, noises);
      for (let n = 0; n < 16; n++) {
        const x = 16 * s.cx + (next() % 16), z = 16 * s.cz + (next() % 16), y = -64 + (next() % 384);
        const got = probe(dc, x, y, z), want = ref.voxel(s, x, y, z);
        if (!Object.is(got, want)) throw new Error(`tree ${t} at (${x}, ${y}, ${z}): compiled ${got}, reference ${want}\n${JSON.stringify(e)}`);
      }
    }
  });
});

/** A shape spline that is `y` everywhere. */
const flatSpline = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });

/**
 * Column (cx, cz) of `c`: the driver (bounds and early-outs) against the probe (none) at all 98,304 voxels, solidity and
 * Object.is where the driver evaluated; the probe against the reference interpreter at 48 random voxels. Returns the
 * number of cells whose voxels the driver evaluated.
 */
function checkColumn(c: GenContext, cx: number, cz: number, next: () => number, what: string): number {
  const dc = createDensityContext(c);
  const dcProbe = createDensityContext(c);
  const ref = createDensityReference(dc.expr, dc.noises);
  const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
  const s = dc.columns.get(cx, cz);
  expect(fillDensityColumn(dc.bounds, s, solid, values, mask, () => false)).toBe(true);
  let masked = 0;
  for (let y = -64; y < 320; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const v = vIdx(lx, y, lz);
        const p = probe(dcProbe, 16 * cx + lx, y, 16 * cz + lz);
        if (solid[v] !== (p > 0 ? 1 : 0)) throw new Error(`${what}, (${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): solid ${solid[v]}, probe ${p}`);
        if (mask[v] === 1 && !Object.is(values[v], p)) throw new Error(`${what}, (${cx}, ${cz}) voxel (${lx}, ${y}, ${lz}): driver ${values[v]}, probe ${p}`);
        masked += mask[v]!;
      }
    }
  }
  for (let n = 0; n < 48; n++) {
    const x = 16 * cx + (next() % 16), z = 16 * cz + (next() % 16), y = -64 + (next() % 384);
    const got = probe(dcProbe, x, y, z), want = ref.voxel(s, x, y, z);
    if (!Object.is(got, want)) throw new Error(`${what} at (${x}, ${y}, ${z}): compiled ${got}, reference ${want}`);
  }
  return masked / 128;
}

describe('the density at its parameter extremes (spec §1.2, §2.4: early-outs exact and bounds sound for every valid value)', () => {
  /** Schema extremes of the density leaves and of the shape splines the expression reads; all valid. */
  const EXTREMES: ReadonlyArray<readonly [string, ParamsPatch]> = [
    ['detail amplitudes inverted (Lo 8, Hi 0)', { density: { detailAmpLo: 8, detailAmpHi: 0 } }],
    ['detail amplitudes both 8', { density: { detailAmpLo: 8, detailAmpHi: 8 } }],
    ['detail noise λ 4, 16 octaves, lacunarity 4, persistence 1, clampSigma 8', { density: { noises: { detail: { wavelength: 4, octaves: 16, lacunarity: 4, persistence: 1, clampSigma: 8 } } } }],
    ['overhang noise λ 16, 1 octave, yScale 100, clampSigma 8', { density: { noises: { overhang: { wavelength: 16, octaves: 1, yScale: 100, clampSigma: 8 } } } }],
    ['overhang noise λ 8192, 16 octaves, yScale 0.01, clampSigma 1', { density: { noises: { overhang: { wavelength: 8192, octaves: 16, yScale: 0.01, clampSigma: 1 } } } }],
    ['jag noise λ 16, 1 octave, clampSigma 1', { density: { noises: { jag: { wavelength: 16, octaves: 1, clampSigma: 1 } } } }],
    ['jag noise λ 8192, clampSigma 8', { density: { noises: { jag: { wavelength: 8192, clampSigma: 8 } } } }],
    ['σ 64 and jag 128 everywhere', { shape: { sigma: flatSpline(64), jag: flatSpline(128) } }],
    ['offset 320 (the ceiling), σ 64, jag 128', { shape: { offset: flatSpline(320), sigma: flatSpline(64), jag: flatSpline(128) } }],
    ['offset −64 (the floor), σ 64', { shape: { offset: flatSpline(-64), sigma: flatSpline(64) } }],
    ['σ and jag at their minimum −16 (clamped at 0)', { shape: { sigma: flatSpline(-16), jag: flatSpline(-16) } }],
  ];

  test.each(EXTREMES)('%s: driver == probe at every voxel, probe == reference, and the bounds still decide most cells', (what, patch) => {
    const c = ctxFor('42', patch);
    const next = testRng(605);
    let evaluated = 0;
    for (const [cx, cz] of COLUMNS) evaluated += checkColumn(c, cx, cz, next, what);
    // The T stays far from full evaluation (≈ 9 ms per column): at these extremes a quarter of the cells at most
    // evaluate their voxels (σ 64 with jag 128 the most).
    expect(evaluated / (COLUMNS.length * 768)).toBeLessThan(0.4);
  });

  test('random valid density groups (the params harness) compile, and their driver equals the probe', () => {
    const next = testRng(606);
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    for (let t = 0; t < 8; t++) {
      const noises: Record<string, unknown> = {};
      const density: Record<string, unknown> = { noises };
      for (const { path, leaf } of leaves) {
        const key = path.slice('density.'.length);
        if (key.startsWith('noises.')) noises[key.slice('noises.'.length)] = randomValue(leaf, next);
        else density[key] = randomValue(leaf, next);
      }
      const what = `group ${t}: ${JSON.stringify(density)}`;
      // A schema-valid group must compile: validateExpr rejected a 'uniform' jag (NOISE_REMAP) before the schema refused it.
      const c = ctxFor('42', { density } as ParamsPatch);
      const [cx, cz] = COLUMNS[t % COLUMNS.length]!;
      checkColumn(c, cx, cz, next, what);
    }
  });
});

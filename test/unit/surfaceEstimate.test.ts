import { describe, expect, test } from 'vitest';
import { readField } from '../../src/gen/column/columnStage';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import type { GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import type { DensityExpr, Expr } from '../../src/gen/density/expr';
import { probe } from '../../src/gen/density/probe';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const CTX = ctxFor('42');
/** A shape spline that is `y` everywhere. */
const flat = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });

const c = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
/** A `terrain` tap over `x` (the only tap surfaceEst3 reads). */
const terrainOf = (x: Expr): DensityExpr => ({ defs: {}, root: { op: 'tap', name: 'terrain', x } });
/** terrain(y) = H − y: solid exactly below H, so the top is H − 1. */
const linear = (H: number): DensityExpr => terrainOf({ op: 'add', a: c(H), b: { op: 'neg', x: Y } });
/** terrain(y) = 1 inside one of the half-open bands [lo, hi), else −1. */
const bands = (list: ReadonlyArray<readonly [number, number]>): DensityExpr => terrainOf(list.reduce<Expr>(
  (acc, [lo, hi]) => ({ op: 'max', a: acc, b: { op: 'rangeChoice', x: Y, lo, hi, inside: c(1), outside: c(-1) } }), c(-1)));

const dcFor = (expr: DensityExpr, ctx: GenContext = CTX): DensityContext => createDensityContext(ctx, expr);
/** ⌊offset⌋ at (x, z), the search's start before the clamp to [−64, 319]. */
const startOf = (ctx: GenContext, x: number, z: number): number =>
  Math.floor(readField(createDensityContext(ctx).column(x >> 4, z >> 4), 'offset', x, z));

/** Land positions of seed '42' with ⌊offset⌋ well inside the world (the start y of the search). */
const POSITIONS: ReadonlyArray<readonly [number, number]> = [[3, 5], [-17, 40], [90, -122], [-1088 + 7, 1600 + 9]];

describe('surfaceEst3 on hand-built fields (SP3b spec §5)', () => {
  test('the positions start inside the world', () => {
    for (const [x, z] of POSITIONS) {
      const o = startOf(CTX, x, z);
      expect(o).toBeGreaterThan(-30);
      expect(o).toBeLessThan(280);
    }
  });

  test('a single surface H − y gives H − 1 from either side of the start, clamped to the ends', () => {
    for (const [x, z] of POSITIONS) {
      const o = startOf(CTX, x, z);
      for (let H = o - 40; H <= o + 40; H++) expect(surfaceEst3(dcFor(linear(H)), x, z), `H ${H}, start ${o}`).toBe(H - 1);
      for (const H of [-500, -65, -64, -63, -62, 318, 319, 320, 321, 1000]) {
        expect(surfaceEst3(dcFor(linear(H)), x, z), `H ${H}`).toBe(Math.min(319, Math.max(-64, H - 1)));
      }
    }
  });

  test('bisection: midpoints a + 4, then ± 2, then ± 1 inside the bracket [a, a + 8]', () => {
    const [x, z] = POSITIONS[0]!;
    const o = startOf(CTX, x, z);
    // terrain(o) > 0 ≥ terrain(o + 8): the bracket is [o, o + 8]; o + 4 is solid, o + 6 and o + 5 are not.
    expect(surfaceEst3(dcFor(bands([[-1000, o + 1], [o + 4, o + 5]])), x, z)).toBe(o + 4);
    // o + 4 is not solid, o + 2 is, o + 3 is not.
    expect(surfaceEst3(dcFor(bands([[-1000, o + 3], [o + 9, o + 12]])), x, z)).toBe(o + 2);
    // Downward: terrain(o) ≤ 0, terrain(o − 8) > 0: the bracket is [o − 8, o].
    expect(surfaceEst3(dcFor(bands([[-1000, o - 5]])), x, z)).toBe(o - 6);
    // o − 4 is solid, o − 2 and o − 3 are not.
    expect(surfaceEst3(dcFor(bands([[-1000, o - 7], [o - 4, o - 3]])), x, z)).toBe(o - 4);
  });

  test('the 8-step scan crosses gaps it steps over (§5 "Gaps")', () => {
    const [x, z] = POSITIONS[1]!;
    const o = startOf(CTX, x, z);
    // Up: o and o + 8 are solid, o + 16 is not: the overhang's top o + 11, above the air at o + 3 … o + 7.
    expect(surfaceEst3(dcFor(bands([[-1000, o + 3], [o + 8, o + 12]])), x, z)).toBe(o + 11);
    // Down: o and o − 8 are air, o − 16 is solid: the ground under the overhang o − 6 … o − 5 is returned.
    expect(surfaceEst3(dcFor(bands([[-1000, o - 12], [o - 6, o - 4]])), x, z)).toBe(o - 13);
  });

  test('ends: solid up to 319 gives 319, air down to −64 gives −64, bedrock-only gives −64', () => {
    for (const [x, z] of POSITIONS) {
      expect(surfaceEst3(dcFor(bands([[-1000, 1000]])), x, z)).toBe(319);
      expect(surfaceEst3(dcFor(terrainOf(c(-1))), x, z)).toBe(-64);
      expect(surfaceEst3(dcFor(terrainOf(c(0))), x, z)).toBe(-64);
      expect(surfaceEst3(dcFor(bands([[-64, -63]])), x, z)).toBe(-64);
      expect(surfaceEst3(dcFor(bands([[-1000, 319]])), x, z)).toBe(318);
    }
  });

  test('the start is clamped to 319 (offset 320) and a bracket cut by 319 is bisected to its top', () => {
    const high = ctxFor('42', { shape: { offset: flat(320) } });
    const [x, z] = POSITIONS[0]!;
    expect(readField(createDensityContext(high).column(x >> 4, z >> 4), 'offset', x, z)).toBeGreaterThanOrEqual(320);
    for (let H = 290; H <= 330; H++) expect(surfaceEst3(dcFor(linear(H), high), x, z), `H ${H}`).toBe(Math.min(319, H - 1));
    const near = ctxFor('42', { shape: { offset: flat(315) } });
    const o = startOf(near, x, z);
    expect(o).toBe(315);
    // Up from o: the next step is cut at 319, so the bracket is [o, 319] or o reaches 319 itself.
    for (let H = o + 1; H <= 321; H++) expect(surfaceEst3(dcFor(linear(H), near), x, z), `H ${H}, start ${o}`).toBe(Math.min(319, H - 1));
    expect(surfaceEst3(dcFor(bands([[-1000, o + 1], [o + 2, o + 3]]), near), x, z)).toBe(o + 2);
  });

  test('arguments: integer x and z in the world window; the expression must have a terrain tap', () => {
    const dc = dcFor(linear(70));
    expect(() => surfaceEst3(dc, 0.5, 0)).toThrow(RangeError);
    expect(() => surfaceEst3(dc, 0, Number.NaN)).toThrow(RangeError);
    expect(() => surfaceEst3(dc, 1 << 19, 0)).toThrow(RangeError);
    expect(() => surfaceEst3(dcFor({ defs: {}, root: { op: 'tap', name: 'other', x: c(1) } }), 0, 0)).toThrow(/no tap "terrain"/);
  });
});

describe('surfaceEst3 on the default terrain', () => {
  test('a sign change of the terrain tap, and the top of every single-surface position', () => {
    const dc = createDensityContext(CTX);
    const r = testRng(903);
    let single = 0;
    for (let n = 0; n < 160; n++) {
      const x = -4096 + (r() % 8192);
      const z = -4096 + (r() % 8192);
      const b = surfaceEst3(dc, x, z);
      const t = (y: number): number => probe(dc, x, y, z, 'terrain');
      if (b === 319) expect(t(319)).toBeGreaterThan(0);
      else if (b === -64) expect(t(-64)).toBeLessThanOrEqual(0);
      else {
        expect(t(b), `(${x}, ${z}) at ${b}`).toBeGreaterThan(0);
        expect(t(b + 1), `(${x}, ${z}) at ${b + 1}`).toBeLessThanOrEqual(0);
      }
      let changes = 0;
      let top = -64;
      for (let y = -63; y <= 319; y++) {
        const solid = t(y) > 0;
        if (solid) top = y;
        if (!solid && t(y - 1) > 0) changes++;
      }
      if (changes === 1) {
        single++;
        expect(b, `(${x}, ${z})`).toBe(top);
      }
    }
    expect(single).toBeGreaterThan(120);
  });
});

describe('surfaceEst3 at the world\'s vertical ends (the default expression)', () => {
  test.each([
    // The start is clamped from 320 to 319 and most positions are solid up to 319 (the end).
    ['the ceiling: offset 320, σ 64, jag 128', { shape: { offset: flat(320), sigma: flat(64), jag: flat(128) } }, 16],
    // The start is y −64, the floor term keeps it solid, and the search steps up; floating rocks make many positions
    // multi-surface.
    ['the floor: offset −64, σ 64', { shape: { offset: flat(-64), sigma: flat(64) } }, 0],
  ] as const)('%s: an end or a sign change of the terrain tap, and the top of every single-surface position', (_what, patch, minTopEnds) => {
    const dc = createDensityContext(ctxFor('42', patch));
    const r = testRng(904);
    let single = 0, topEnds = 0;
    for (let n = 0; n < 64; n++) {
      const x = -4096 + (r() % 8192);
      const z = -4096 + (r() % 8192);
      const b = surfaceEst3(dc, x, z);
      const t = (y: number): number => probe(dc, x, y, z, 'terrain');
      expect(Number.isInteger(b) && b >= -64 && b <= 319, `(${x}, ${z}): ${b}`).toBe(true);
      // The ends (§5 step 4): 319 when solid there; −64 when not solid there. Otherwise a sign change at b.
      if (b === 319) expect(t(319), `(${x}, ${z})`).toBeGreaterThan(0);
      else if (b !== -64 || t(-64) > 0) {
        expect(t(b), `(${x}, ${z}) at ${b}`).toBeGreaterThan(0);
        expect(t(b + 1), `(${x}, ${z}) at ${b + 1}`).toBeLessThanOrEqual(0);
      }
      if (b === 319) topEnds++;
      // Solid→air transitions from y −64 up; a position solid up to 319 has none and its top is 319.
      let changes = 0;
      let top = -64;
      for (let y = -63; y <= 319; y++) {
        const solid = t(y) > 0;
        if (solid) top = y;
        if (!solid && t(y - 1) > 0) changes++;
      }
      if (changes === 1 || (changes === 0 && top === 319)) {
        single++;
        expect(b, `(${x}, ${z})`).toBe(top);
      }
    }
    // About 60 (ceiling) and 30 (floor) of the 64 positions are single-surface; about 45 end at 319 on the ceiling.
    expect(single).toBeGreaterThan(16);
    expect(topEnds).toBeGreaterThanOrEqual(minTopEnds);
  });
});

/**
 * U2's liveness tests (`src/metrics/liveness.ts`), SP6a's depth-band leaves and the island cap's capTop. Split by leaf group in SP6b Task 58 (ruling U14) so CI's
 * unit shards run them in parallel; the pins and helpers they share are in `fixtures/liveness.ts`.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, getPath } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import {
  amplifiedBandWitness, bandWindow, bandWitness, capTopWitness, CAVE_SLOTS, caveColumn, intendedClass, leafLiveness, perturbations, stageOutputHash,
  type LivenessColumn,
} from '../../src/metrics/liveness';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import {
  ISLAND_PIN, BAND_LEAVES, BAND_PINS, CAP_TOP, CAP_TOP_PIN, leaf, CTX, moved, columns,
} from './fixtures/liveness';

describe('the depth-band leaves (SP6a Task 8; rulings P3, P4, R5)', () => {
  let found: LivenessColumn[] | null = null;
  /** The class columns with the two cave columns (searched once per describe). */
  const all = (): LivenessColumn[] => (found ??= [...columns(), ...CAVE_SLOTS.map((s) => caveColumn(CTX, s)!)]);
  /** The family's air above y `above` on (cx, cz) of `ctx`: voxels the pre-cave density holds solid where its tap is ≤ 0. */
  const airAbove = (ctx: GenContext, tap: string, cx: number, cz: number, above: number): number => {
    const dc = createDensityContext(ctx);
    dc.column(cx, cz);
    let n = 0;
    for (let y = above + 1; y < 320; y++) {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        if (dc.compiled.tapFn('precave', lx, y, lz) > 0 && dc.compiled.tapFn(tap, lx, y, lz) <= 0) n++;
      }
    }
    return n;
  };
  const columnOf = (via: string): [number, number] => via.slice(via.indexOf('(') + 1, -1).split(', ').map(Number) as [number, number];

  test('each band leaf is live: on a class column, else on its band witness (the amplified base for three maxY leaves)', () => {
    for (const p of BAND_LEAVES) {
      expect(intendedClass(p)).toBe('cave');
      const r = leafLiveness(CTX, p, all());
      expect([p, r.live, r.via]).toEqual([p, true, BAND_PINS[p]]);
    }
  }, 120_000); // about 8 s alone (the default base's 2,048-column maxY scan among them), 37 s under test:goldens

  test('the windows: every y a step of the leaf can change, 7 blocks past the steps, clipped to y −63 … 319', () => {
    expect(bandWindow(CTX, 'caves.cheese.maxY')).toEqual([265, 319]);
    // SP6b ruling R10: cheese's minY −55 (steps −63, −47) and the entrances' −54 (−62, −46); [−63, −41] and [−63, −47]
    // at SP6a's −56 and −64.
    expect(bandWindow(CTX, 'caves.cheese.minY')).toEqual([-63, -40]);
    expect(bandWindow(CTX, 'caves.entrances.minY')).toEqual([-63, -39]);
    expect(bandWindow(CTX, 'caves.noodles.maxY')).toEqual([34, 319]);
    expect(bandWindow(CTX, 'caves.spaghetti2d.maxY')).toEqual([176, 319]);
    expect(() => bandWindow(CTX, 'caves.limits.bandSpan')).toThrow('not a depth-band leaf');
    expect(() => bandWitness(CTX, 'caves.noodles.regional')).toThrow('not a depth-band leaf');
    expect(() => amplifiedBandWitness(CTX, 'caves.noodles.maxY')).toThrow('not decided on an amplified base');
  });

  test('P3: the maxY 320 of cheese, spaghetti 3D and the entrances has no witness on the default base; each has one on the amplified base, holding its air above y 272', () => {
    const amplified = createGenContext(seedFromInput('42'), resolveProfile('amplified'));
    const draws: Record<string, number> = { 'caves.cheese.maxY': 123, 'caves.spaghetti3d.maxY': 412, 'caves.entrances.maxY': 677 };
    const taps: Record<string, string> = { 'caves.cheese.maxY': 'cheese', 'caves.spaghetti3d.maxY': 'spag3d', 'caves.entrances.maxY': 'entrances' };
    for (const p of Object.keys(draws)) {
      expect(getPath(DEFAULTS, p)).toBe(320);
      // The default base: 2,048 columns of sp6a.liveness.mountain examined, none with the family's air in y 265 … 319.
      expect([p, bandWitness(CTX, p, all())]).toEqual([p, { via: null, draws: 2048, examined: 2048, checks: 0, span: [265, 319] }]);
      const w = amplifiedBandWitness(CTX, p);
      expect([p, w.via, w.draws]).toEqual([p, BAND_PINS[p as (typeof BAND_LEAVES)[number]], draws[p]]);
      const [cx, cz] = columnOf(w.via!);
      expect([p, airAbove(amplified, taps[p]!, cx, cz, 272) > 0]).toEqual([p, true]);
    }
  });

  test('R5: spaghetti 2D\'s maxY 215 is the highest default from 208 to 244 whose lower step has a witness, and moves no generated output', () => {
    expect(DEFAULTS.caves.spaghetti2d.maxY).toBe(215);
    // 215's steps are 183 and 247; on the witness the lower one changes the T column, the upper one does not.
    expect(perturbations(leaf('caves.spaghetti2d.maxY'), 215)).toEqual([183, 247]);
    const w = bandWitness(CTX, 'caves.spaghetti2d.maxY', all());
    expect([w.via, w.draws, w.checks, w.span]).toEqual([BAND_PINS['caves.spaghetti2d.maxY'], 28559, 1, [176, 319]]);
    const [cx, cz] = columnOf(w.via!);
    const at = (maxY: number) => stageOutputHash(moved('caves.spaghetti2d.maxY', maxY), 'terrain', cx, cz);
    expect([at(183) !== at(215), at(247) !== at(215)]).toEqual([true, false]);
    // The layer is never open above y 208, so maxY 208 … 244 changes no output: here 215 gives the T column of 320.
    expect(at(320)).toBe(at(215));
    expect(airAbove(CTX, 'spag2d', cx, cz, 183)).toBeGreaterThan(0);
    expect(airAbove(CTX, 'spag2d', cx, cz, 208)).toBe(0);
    // 216 (step 184) has none: the witness's highest air is at y 184, which a cap from 184 does not reach.
    const w216 = bandWitness(moved('caves.spaghetti2d.maxY', 216), 'caves.spaghetti2d.maxY', all());
    expect([w216.via, w216.draws]).toEqual([null, 32768]);
  });

  test('P4: each minY leaf (and the noodle\'s maxY) also has its own band witness off the class columns, near the bottom', () => {
    // SP6b Task 19: at the R10 values (−55; entrances −54), each witness lies where the floor leaves corner −48
    // unsaturated (floorY < −56); before the floor: (−26773, −930) 2, (12710, −20366) 5, (−17888, 14467) 8, the noodle's
    // the same, (10701, −27440) 13. Task 25's lever 25d (`caves.floor.amp` 5 → 7) moved only the noodle's minY witness:
    // (−1578, −11634) at draw 3 before it; lever 25c (`caves.floor.y` −60) moved it again, from (21447, 18469) at draw 9.
    const pins: Array<[string, string, number]> = [
      ['caves.cheese.minY', 'witness column (-11258, 17222)', 20],
      ['caves.spaghetti3d.minY', 'witness column (-14676, -24410)', 45],
      ['caves.spaghetti2d.minY', 'witness column (-4103, 15609)', 146],
      ['caves.noodles.minY', 'witness column (30642, 22358)', 76],
      ['caves.entrances.minY', 'witness column (-19897, -15804)', 112],
      ['caves.noodles.maxY', 'witness column (-22165, -25285)', 3],
    ];
    for (const [p, via, draws] of pins) {
      const w = bandWitness(CTX, p, all());
      expect([p, w.via, w.draws]).toEqual([p, via, draws]);
      expect(w.checks).toBeLessThanOrEqual(64);
    }
  });
});

describe('the island cap\'s capTop (SP6a Task 9; spec §1.4, §4)', () => {
  const FLOATING = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
  /** Noise-cave air of (cx, cz) in y 176 … 200 on `ctx`: the pre-cave density holds the voxel solid, the root does not. */
  const caveAir = (ctx: GenContext, cx: number, cz: number): number => {
    const dc = createDensityContext(ctx);
    dc.column(cx, cz);
    let n = 0;
    for (let y = 176; y <= 200; y++) {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        if (dc.compiled.tapFn('precave', lx, y, lz) > 0 && !(dc.compiled.voxelFn(lx, y, lz) > 0)) n++;
      }
    }
    return n;
  };

  test('capTop is live on its floating_islands witness, not on the default base\'s class columns or the island class column', () => {
    expect(intendedClass(CAP_TOP)).toBe('cave');
    // Its default 344 lies above the world: U2's one step (292) changes no class column of the default base.
    expect(perturbations(leaf(CAP_TOP), 344)).toEqual([292]);
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const r = leafLiveness(CTX, CAP_TOP, all);
    expect(r).toEqual({ path: CAP_TOP, live: true, via: CAP_TOP_PIN.via, cls: null });
    expect(capTopWitness(CTX)).toEqual(CAP_TOP_PIN);
    // On floating_islands capTop is 180; its lower step clamps back to 180, so 207 is U2's one effective step.
    expect(FLOATING.params.caves.limits.capTop).toBe(180);
    expect(perturbations(leaf(CAP_TOP), 180)).toEqual([207]);
    const [cx, cz] = CAP_TOP_PIN.via.slice(CAP_TOP_PIN.via.indexOf('(') + 1, -1).split(', ').map(Number) as [number, number];
    expect([cx, cz]).not.toEqual([ISLAND_PIN.cx, ISLAND_PIN.cz]);
    // The witness: noise-cave air in y 176 … 200 at capTop 207, none at 180, and a pre-cave top at y ≥ 200.
    const at207 = createGenContext(FLOATING.seed, (() => {
      const p = applyPatch(SCHEMA, FLOATING.params, { caves: { limits: { capTop: 207 } } });
      if (!p.ok) throw new Error('bad capTop patch');
      return p.value;
    })());
    expect(caveAir(at207, cx, cz)).toBeGreaterThan(0);
    expect(caveAir(FLOATING, cx, cz)).toBe(0);
    const dc = createDensityContext(FLOATING);
    dc.column(cx, cz);
    let top = -64;
    for (let y = 319; y >= -63 && top === -64; y--) for (let p = 0; p < 256; p++) if (dc.compiled.tapFn('precave', p & 15, y, p >> 4) > 0) { top = y; break; }
    expect(top).toBeGreaterThanOrEqual(200);
    expect(stageOutputHash(at207, 'terrain', cx, cz)).not.toBe(stageOutputHash(FLOATING, 'terrain', cx, cz));
  }, 120_000); // 21-27 s on CI's unit (rest) at the generator push (run 43642270084), near the 30 s default
});

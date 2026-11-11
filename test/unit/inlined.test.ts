/**
 * SP6a §10.5, the kill criterion (master :1640): `test/bench/inlined.ts`, the default density expression hand-written,
 * is bit-exact against the compiled tree, `inlinedCorner` on all 1,225 corners (5 × 49 × 5) of four columns of seed 42
 * (land, sea, mountain and the default tree's cave class column) and `inlinedVoxel` against `voxelFn` at every voxel
 * T evaluates there (the straddling cells' voxels, `fillDensityColumn`'s mask), with the cells' min skips and without;
 * and on one column with moved leaves, so that the comparator reads its leaves from `InlinedLeaves`, not the defaults.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { fillDensityColumn } from '../../src/gen/density/bounds';
import { createDensityContext } from '../../src/gen/density/context';
import { columnPoint } from '../../src/gen/column/columnPoint';
import {
  INLINED_MIN_SLOTS, INLINED_SLOTS, inlinedColumn, inlinedCorner, inlinedLeavesOf, inlinedNoisesOf, inlinedVoxel,
} from '../bench/inlined';
import { paramsWith } from '../harness/gen';

/**
 * Seed 42's columns: land ([40, 900], SP5c's value-check column), sea (`WET_COLUMNS.sea` of caveTerms.test.ts: all 25
 * corners at sea, so the wet roof is on), mountain ([−40, 0], offset ≈ 197 at its centre) and the cave class column
 * (`CAVE_COLUMN`, `caveColumn` of src/metrics/liveness.ts, pinned in liveness.test.ts).
 */
const COLUMNS = { land: [40, 900], sea: [18896, 17558], mountain: [-40, 0], cave: [546, 25857] } as const satisfies Record<string, readonly [number, number]>;
const NEVER = (): boolean => false;

/** The two doubles' bit patterns are equal (+0 ≠ −0; NaN by payload). */
const bits = new Float64Array(2);
const bitsView = new BigUint64Array(bits.buffer);
const sameBits = (a: number, b: number): boolean => { bits[0] = a; bits[1] = b; return bitsView[0] === bitsView[1]; };

interface ColumnCheck {
  readonly corners: number; readonly cornerMismatches: number; readonly firstCorner: string | null;
  readonly voxels: number; readonly voxelMismatches: number; readonly firstVoxel: string | null;
  readonly skipped: number;
}

/** The comparison at column (cx, cz) of `params`, seed 42. */
function check(params: Params, cx: number, cz: number): ColumnCheck {
  const gen = createGenContext(seedFromInput('42'), params);
  const dc = createDensityContext(gen);
  const c = dc.compiled;
  const s = buildColumnSample(gen, cx, cz, newColumnSample());
  const solid = new Uint8Array(98304), mask = new Uint8Array(98304);
  // T's density phase: the straddling cells' corners, their min skips and the mask of the voxels it evaluates.
  fillDensityColumn(dc.bounds, s, solid, null, mask, NEVER);
  for (let k = 0; k < 49; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) c.cornerFn(i, k, j);
  const p = inlinedLeavesOf(params), n = inlinedNoisesOf(gen);
  const out = new Float64Array(INLINED_SLOTS.length * 1225).fill(NaN);
  inlinedColumn(s, p, n);
  for (let k = 0; k < 49; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) inlinedCorner(s, p, n, i, k, j, out);
  let cornerMismatches = 0, firstCorner: string | null = null;
  for (let q = 0; q < out.length; q++) {
    if (sameBits(out[q]!, c.cornerValues[q]!)) continue;
    cornerMismatches++;
    firstCorner ??= `slot ${INLINED_SLOTS[Math.floor(q / 1225)]} corner ${q % 1225}: ${out[q]} vs ${c.cornerValues[q]}`;
  }
  let voxels = 0, voxelMismatches = 0, skipped = 0, firstVoxel: string | null = null;
  for (let v = 256; v < 98304; v++) {
    if (mask[v] === 0) continue;
    const lx = v & 15, lz = (v >> 4) & 15, y = (v >> 8) - 64;
    const cell = (((y + 64) >> 3) * 4 + (lz >> 2)) * 4 + (lx >> 2);
    const base = c.minSkipReady[cell] === 1 ? cell * c.minSlotCount : -1;
    if (base >= 0) for (let m = 0; m < c.minSlotCount; m++) if (c.minSkips[base + m] !== 0) { skipped++; break; }
    const want = c.voxelFn(lx, y, lz);
    const got = inlinedVoxel(out, s, p, n, lx, y, lz, c.minSkips, base);
    const plain = inlinedVoxel(out, s, p, n, lx, y, lz, c.minSkips, -1);
    voxels++;
    if (sameBits(got, want) && sameBits(plain, want)) continue;
    voxelMismatches++;
    firstVoxel ??= `(${lx}, ${y}, ${lz}): ${got} / ${plain} without skips vs ${want}`;
  }
  return { corners: out.length, cornerMismatches, firstCorner, voxels, voxelMismatches, firstVoxel, skipped };
}

describe('the hand-inlined default expression (SP6a §10.5, the kill criterion)', () => {
  test('the four columns are land, sea, mountain and the cave class column', () => {
    const gen = createGenContext(seedFromInput('42'), DEFAULTS);
    const offset = (key: keyof typeof COLUMNS): number => columnPoint(gen, 16 * COLUMNS[key][0] + 8, 16 * COLUMNS[key][1] + 8).offset;
    expect(offset('land')).toBeGreaterThan(63);
    expect(offset('land')).toBeLessThan(120);
    expect(offset('sea')).toBeLessThan(40);
    expect(offset('mountain')).toBeGreaterThan(150);
  });

  test('the compiled default tree has the slots and min chains the comparator mirrors', () => {
    const c = createDensityContext(createGenContext(seedFromInput('42'), DEFAULTS)).compiled;
    expect(c.interpolatedSlotCount).toBe(INLINED_SLOTS.length);
    expect(c.columnSlotCount).toBe(7);
    expect(c.positionSlotCount).toBe(3);
    expect(c.minSlotCount).toBe(INLINED_MIN_SLOTS.count);
    // Each tap's interpolated slot is its INLINED_SLOTS entry (the noodle's four slots sit under the noodle tap).
    const slotOfTap = (name: string): number => {
      const tap = c.nodes.find((x) => x.op === 'tap' && (x.expr as { name: string }).name === name)!;
      return c.nodes[tap.kids[0]!]!.interpSlot;
    };
    for (const name of ['terrain', 'entrances', 'cheese', 'spag3d', 'spag2d', 'pillars'] as const) expect([name, slotOfTap(name)]).toEqual([name, INLINED_SLOTS.indexOf(name)]);
    // The min chains from the root: max(min(min(precave, add(caves, S_w)), add(noodle, S_w)), islands).
    const node = (id: number) => c.nodes[id]!;
    const root = node(c.root);
    const m6 = node(root.kids[0]!), m5 = node(m6.kids[0]!);
    expect([m6.op, m6.minSlot, m5.op, m5.minSlot]).toEqual(['min', INLINED_MIN_SLOTS.root, 'min', INLINED_MIN_SLOTS.precave]);
    const cavesMax = node(node(m5.kids[1]!).kids[0]!);
    const m2 = node(cavesMax.kids[0]!), m1 = node(m2.kids[0]!), m0 = node(m1.kids[0]!);
    expect([cavesMax.op, m2.minSlot, m1.minSlot, m0.minSlot]).toEqual(['max', INLINED_MIN_SLOTS.s2, INLINED_MIN_SLOTS.s3, INLINED_MIN_SLOTS.ec]);
    expect([node(m0.kids[0]!).expr, node(m0.kids[1]!).expr].map((e) => (e as { name: string }).name)).toEqual(['entrances', 'cheese']);
    expect(c.minChains.map((ch) => ch.mins.map((m) => node(m).minSlot))).toEqual([[0, 1, 2], [3], [4], [5, 6]]);
    // The noodle cap's gentle min(1, ·) has slot 3; its steep one (slot 4) is a y node, never skipped.
    expect(c.yNodes.some((id) => node(id).kids.some((k) => node(k).minSlot === INLINED_MIN_SLOTS.noodleSteep))).toBe(true);
  });

  for (const [name, [cx, cz]] of Object.entries(COLUMNS)) {
    test(`${name} column (${cx}, ${cz}): every corner and every straddling voxel bit for bit`, () => {
      const r = check(DEFAULTS, cx, cz);
      expect(r.corners).toBe(1225 * INLINED_SLOTS.length);
      expect([r.cornerMismatches, r.firstCorner]).toEqual([0, null]);
      expect(r.voxels, 'the column has straddling voxels').toBeGreaterThan(0);
      expect([r.voxelMismatches, r.firstVoxel]).toEqual([0, null]);
    });
  }

  test('the cells of the four columns use their min skips somewhere (the skip path is exercised)', () => {
    let skipped = 0;
    for (const [cx, cz] of Object.values(COLUMNS)) skipped += check(DEFAULTS, cx, cz).skipped;
    expect(skipped).toBeGreaterThan(0);
  });

  test('moved leaves (a narrower band span, other offsets, thicknesses, scales and depths): bit for bit on the cave column', () => {
    const params = paramsWith({
      density: { detailAmpLo: 0.5, detailAmpHi: 1.25 },
      caves: {
        limits: { bandSpan: 10, waterDepth: 20, surfaceDepth: 6, capTop: 250 },
        entrances: { offset: 0.2, threshold: 0.1, minY: -40, maxY: 200 },
        cheese: { offset: 0.2, regional: 0.15, layerAmp: 3, roofDepth: 14, minY: -50, maxY: 180 },
        pillars: { threshold: 0.05 },
        spaghetti3d: { thickness: 0.09, thicknessVar: 0.02, regional: 0.07, minY: -48, maxY: 150, scales: { s0: 0.8, s1: 1.1, s2: 1.4, s3: 1.9 } },
        spaghetti2d: { thickness: 0.9, layerAmp: 6, minY: -60, maxY: 160, scales: { s0: 0.6, s1: 0.8, s2: 1.1, s3: 1.8, s4: 2.5 } },
        noodles: { thickness: 0.06, ridgeMul: 1.4, regional: 0.12, threshold: 0.4, minY: -50, maxY: 40 },
      },
    });
    const r = check(params, COLUMNS.cave[0], COLUMNS.cave[1]);
    expect([r.cornerMismatches, r.firstCorner]).toEqual([0, null]);
    expect(r.voxels).toBeGreaterThan(0);
    expect([r.voxelMismatches, r.firstVoxel]).toEqual([0, null]);
  });
});

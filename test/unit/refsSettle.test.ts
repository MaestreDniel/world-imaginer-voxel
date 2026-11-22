/**
 * The global settle reference `referenceSettle` (SP7a spec §4.1, §13.4; `DT1.settleReference`, `test/harness/refs.ts`),
 * on hand-built 4 × 4-column views (a plain store's proto, chunks −2 … 1 on each axis):
 * - it reproduces Task 3's converged shapes (`settle.test.ts`: F1's diamond, the fall, the 2-source infinite source,
 *   the cap and the water/lava contact) and equals `settleWindow` over the whole view on each;
 * - on a random view whose fronts cross the column borders, `settleWindow` run per interior column over that column's
 *   3 × 3 (the windowed kernel D runs, §4.2) equals the reference over the view on the column, at every voxel.
 */
import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, FLUID_CAP_LAVA, FLUID_CAP_WATER, MIN_Y } from '../../src/core/constants';
import { Xoshiro128 } from '../../src/core/rng';
import { createSettleScratch, settleWindow, type SettleSource } from '../../src/gen/fluids/settle';
import { FLUID_LAVA, FLUID_WATER, LAVA_SOURCE, NO_FLUID, fluidType, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { referenceSettle, referenceSettleKey } from '../harness/refs';
import { regionView, type RegionView } from '../harness/region';

const MiB = 1 << 20;
const water = (level: number, falling = false, unsettled = false): number => packFluid(FLUID_WATER, level, falling, unsettled);
const lava = (level: number, falling = false, unsettled = false): number => packFluid(FLUID_LAVA, level, falling, unsettled);
/** The abyss's cave byte (nibble 3 in bits 4-7). */
const ABYSS_CAVE = CAVE_BIOME.abyss << 4;

/** The hand-built views' chunks: −2 … 1 on each axis, so x and z run −32 … 31. */
const CX0 = -2;
const SIDE = 4;
const X0 = 16 * CX0;
const X1 = X0 + 16 * SIDE;
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * A hand-built proto: `block(x, y, z)` everywhere, then AIR holding the byte at each `fluid` entry, and the cave
 * bytes at each `cave` entry.
 */
interface Hand {
  readonly block: (x: number, y: number, z: number) => number;
  readonly fluid: Map<string, number>;
  readonly cave: Map<string, number>;
}

const hand = (block: Hand['block']): Hand => ({ block, fluid: new Map(), cave: new Map() });

/** The hand-built proto as a 4 × 4 view over a plain store (each column committed at Proto). */
function viewOf(h: Hand): RegionView {
  const s = createStore({ shared: false, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
  const blocks = new Uint16Array(4096);
  const fluids = new Uint8Array(4096);
  const caves = new Uint8Array(4096);
  for (let cz = CX0; cz < CX0 + SIDE; cz++) {
    for (let cx = CX0; cx < CX0 + SIDE; cx++) {
      const w = s.claimColumn(cx, cz, 0);
      for (let sy = 0; sy < 24; sy++) {
        for (let i = 0; i < 4096; i++) {
          const x = 16 * cx + (i & 15);
          const y = MIN_Y + 16 * sy + (i >> 8);
          const z = 16 * cz + ((i >> 4) & 15);
          const k = key(x, y, z);
          const f = h.fluid.get(k) ?? NO_FLUID;
          blocks[i] = f !== NO_FLUID ? AIR : h.block(x, y, z);
          fluids[i] = f;
          caves[i] = h.cave.get(k) ?? 0;
        }
        w.setProto(sy, blocks, fluids, caves);
      }
      w.commit(1);
    }
  }
  return regionView(s, CX0, CX0, SIDE, SIDE);
}

/** The view's proto as a `SettleSource` over the window x0 ≤ x < x0 + width (likewise z). */
function sourceOf(view: RegionView, x0: number, z0: number, width: number): SettleSource {
  const col = (x: number, z: number) => view.store.proto(x >> 4, z >> 4)!;
  return {
    x0, z0, x1: x0 + width, z1: z0 + width,
    block: (x, y, z) => col(x, z).block(x & 15, y, z & 15),
    fluid: (x, y, z) => col(x, z).fluid(x & 15, y, z & 15),
    cave: (x, y, z) => col(x, z).cave(x & 15, y, z & 15),
  };
}

/**
 * `settleWindow` over the window (x0, z0, width) of the view, seeded with every proto fluid voxel of the window, on
 * `box`; its sink keyed by `referenceSettleKey`.
 */
function windowed(view: RegionView, x0: number, z0: number, width: number, box: readonly number[]): Map<number, number> {
  const src = sourceOf(view, x0, z0, width);
  const seeds: number[] = [];
  for (let y = -64; y < 320; y++) {
    for (let z = z0; z < z0 + width; z++) {
      for (let x = x0; x < x0 + width; x++) if (src.fluid(x, y, z) !== NO_FLUID) seeds.push(((y - MIN_Y) * width + (z - z0)) * width + (x - x0));
    }
  }
  const out = new Map<number, number>();
  const sink = { set: (x: number, y: number, z: number, byte: number) => { out.set(referenceSettleKey(view, x, y, z), byte); } };
  const visits = settleWindow(src, Int32Array.from(seeds), seeds.length, Int32Array.from(box), sink, createSettleScratch(), () => false);
  expect(visits).toBeGreaterThan(0);
  return out;
}

/** The reference over the whole view, `at` reading its settled byte (else the proto's), and the whole-view kernel's. */
function settleBoth(h: Hand): { ref: Map<number, number>; at: (x: number, y: number, z: number) => number; kernel: Map<number, number> } {
  const view = viewOf(h);
  const ref = referenceSettle(view, { x0: X0, z0: X0, x1: X1, z1: X1 });
  const at = (x: number, y: number, z: number): number => ref.get(referenceSettleKey(view, x, y, z)) ?? view.fluid(x, y, z);
  return { ref, at, kernel: windowed(view, X0, X0, X1 - X0, [X0, X0, X1, X1]) };
}

/** A stone plane (y ≤ 0) under air. */
const plane = (): Hand => hand((_x, y) => (y <= 0 ? STONE : AIR));

/**
 * Task 3's staircase: solid rock up to y 19 with a corridor along +x at z = 0, one block down every 2 blocks (the
 * fluid's row at x is y = 12 − ⌊x/2⌋, air above it up to y 13), and a source of `byte` at (0, 12, 0).
 */
function staircase(byte: number): Hand {
  const h = hand((x, y, z) => (y > 19 || (z === 0 && x >= 0 && x < 28 && y >= 12 - (x >> 1) && y <= 13) ? AIR : STONE));
  h.fluid.set(key(0, 12, 0), byte);
  return h;
}

describe('referenceSettle: Task 3\'s shapes (SP7a spec §4.1, §13.4)', () => {
  test("F1's diamond: one source on a plane gives levels 1 … 7 at Manhattan distance 1 … 7 and nothing beyond; equal to settleWindow", () => {
    const h = plane();
    h.fluid.set(key(0, 1, 0), WATER_SOURCE);
    const r = settleBoth(h);
    expect(r.ref.size).toBe(112);
    for (let z = -12; z <= 12; z++) {
      for (let x = -12; x <= 12; x++) {
        const m = Math.abs(x) + Math.abs(z);
        expect(r.at(x, 1, z)).toBe(m === 0 ? WATER_SOURCE : m <= 7 ? water(m) : NO_FLUID);
        expect(r.at(x, 2, z)).toBe(NO_FLUID);
      }
    }
    expect(r.ref).toEqual(r.kernel);
  });

  test('the fall: a source on a 1 × 1 pillar 9 high falls on each side and spills radius 7 from each landing; equal to settleWindow', () => {
    const h = hand((x, y, z) => (y <= 0 || (x === 0 && z === 0 && y <= 9) ? STONE : AIR));
    h.fluid.set(key(0, 10, 0), WATER_SOURCE);
    const r = settleBoth(h);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      expect(r.at(dx, 10, dz)).toBe(water(1));
      for (let y = 1; y <= 9; y++) expect(r.at(dx, y, dz)).toBe(water(0, true));
    }
    expect(r.at(2, 1, 0)).toBe(water(1));
    expect(r.at(8, 1, 0)).toBe(water(7));
    expect(r.at(9, 1, 0)).toBe(NO_FLUID);
    expect(r.at(-8, 1, 0)).toBe(water(7));
    expect(r.at(0, 1, -9)).toBe(NO_FLUID);
    expect(r.ref).toEqual(r.kernel);
  });

  test('the 2-source infinite source: proto sources at (0, 0) and (2, 0) make (1, 0) a source; equal to settleWindow', () => {
    const h = plane();
    h.fluid.set(key(0, 1, 0), WATER_SOURCE).set(key(2, 1, 0), WATER_SOURCE);
    const r = settleBoth(h);
    expect(r.at(1, 1, 0)).toBe(WATER_SOURCE);
    expect(r.at(1, 1, 1)).toBe(water(1));
    expect(r.ref).toEqual(r.kernel);
  });

  test('the cap: down a staircase water runs 12 blocks (bit 6 at distance 12, 13 dry) and lava 14; equal to settleWindow', () => {
    const rw = settleBoth(staircase(WATER_SOURCE));
    expect(rw.at(1, 12, 0)).toBe(water(1));
    expect(rw.at(2, 11, 0)).toBe(water(0, true));
    expect(rw.at(12, 7, 0)).toBe(water(2));
    expect(rw.at(12, 6, 0)).toBe(water(0, true, true));
    for (let y = -4; y <= 13; y++) expect(rw.at(13, y, 0)).toBe(NO_FLUID);
    for (const byte of rw.ref.values()) if (byte !== water(0, true, true)) expect(byte & 64).toBe(0);
    expect(rw.ref).toEqual(rw.kernel);
    expect(FLUID_CAP_WATER).toBe(12);

    const rl = settleBoth(staircase(LAVA_SOURCE));
    expect(rl.at(1, 12, 0)).toBe(lava(2));
    expect(rl.at(2, 11, 0)).toBe(lava(0, true));
    expect(rl.at(14, 6, 0)).toBe(lava(4));
    expect(rl.at(14, 5, 0)).toBe(lava(0, true, true));
    for (let y = -4; y <= 13; y++) expect(rl.at(15, y, 0)).toBe(NO_FLUID);
    expect(rl.ref).toEqual(rl.kernel);
    expect(FLUID_CAP_LAVA).toBe(14);
  });

  test('the contact: a water source and a lava source 4 apart give lava with bit 6 where both reach; equal to settleWindow', () => {
    const h = plane();
    h.fluid.set(key(0, 1, 0), WATER_SOURCE).set(key(4, 1, 0), LAVA_SOURCE);
    const r = settleBoth(h);
    expect(r.at(1, 1, 0)).toBe(lava(6, false, true));
    expect(r.at(2, 1, 0)).toBe(lava(4, false, true));
    expect(r.at(3, 1, 0)).toBe(lava(2, false, true));
    expect(r.at(4, 1, 0)).toBe(LAVA_SOURCE);
    expect(r.at(0, 1, 0)).toBe(WATER_SOURCE);
    expect(r.at(-1, 1, 0)).toBe(water(1));
    expect(r.at(6, 1, 0)).toBe(lava(4));
    expect(r.ref).toEqual(r.kernel);
  });
});

/**
 * A random 4 × 4-column proto: terrain of random heights (y 0 … 31 per 4 × 4 block, 14 % holes, a solid floor at
 * y 0), open air above, abyss cave bytes on 600 air voxels, and 40 water sources, 12 lava sources and 16 source pairs
 * two apart on random air voxels (y 1 … 40).
 */
function randomHand(seed: number): Hand {
  const rng = new Xoshiro128(seed);
  const heights = new Int32Array(256);
  for (let i = 0; i < 256; i++) heights[i] = 8 + rng.nextInt(24);
  const holes = new Set<string>();
  for (let i = 0; i < 64 * 64 * 4; i++) holes.add(key(X0 + rng.nextInt(64), 1 + rng.nextInt(31), X0 + rng.nextInt(64)));
  const h = hand((x, y, z) => {
    if (y < 0) return STONE;
    if (y >= heights[((z - X0) >> 2) * 16 + ((x - X0) >> 2)]!) return AIR;
    return y === 0 || !holes.has(key(x, y, z)) ? STONE : AIR;
  });
  const air = (): [number, number, number] => {
    for (;;) {
      const x = X0 + rng.nextInt(64);
      const y = 1 + rng.nextInt(40);
      const z = X0 + rng.nextInt(64);
      if (h.block(x, y, z) === AIR && !h.fluid.has(key(x, y, z))) return [x, y, z];
    }
  };
  for (let i = 0; i < 600; i++) h.cave.set(key(...air()), ABYSS_CAVE);
  for (let i = 0; i < 40; i++) h.fluid.set(key(...air()), WATER_SOURCE);
  for (let i = 0; i < 12; i++) h.fluid.set(key(...air()), LAVA_SOURCE);
  for (let i = 0; i < 16; i++) {
    const [x, y, z] = air();
    if (x + 2 < X1 && h.block(x + 2, y, z) === AIR) h.fluid.set(key(x, y, z), WATER_SOURCE).set(key(x + 2, y, z), WATER_SOURCE);
  }
  return h;
}

describe('referenceSettle: the windowed kernel per column (SP7a spec §4.1\'s radius, §4.2)', () => {
  test('on random 4 × 4 views, settleWindow over each interior column\'s 3 × 3 equals the reference on that column', () => {
    let compared = 0;
    let crossings = 0;
    let contacts = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const view = viewOf(randomHand(seed));
      for (let cz = CX0 + 1; cz < CX0 + SIDE - 1; cz++) {
        for (let cx = CX0 + 1; cx < CX0 + SIDE - 1; cx++) {
          const box = { x0: 16 * cx, z0: 16 * cz, x1: 16 * cx + 16, z1: 16 * cz + 16 };
          const ref = referenceSettle(view, box);
          const got = windowed(view, 16 * (cx - 1), 16 * (cz - 1), 48, [box.x0, box.z0, box.x1, box.z1]);
          expect([seed, cx, cz, got]).toEqual([seed, cx, cz, ref]);
          compared += ref.size;
          for (const [k, byte] of ref) {
            const x = 16 * CX0 + (k % (16 * SIDE));
            if ((x & 15) === 0 || (x & 15) === 15) crossings++;
            if ((byte & 64) !== 0 && fluidType(byte) === FLUID_LAVA) contacts++;
          }
        }
      }
    }
    // The fronts reach the interior columns' borders, and the views hold contacts (lava with bit 6).
    expect(compared).toBeGreaterThan(2000);
    expect(crossings).toBeGreaterThan(100);
    expect(contacts).toBeGreaterThan(0);
  });
});

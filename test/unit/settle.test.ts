import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, FLUID_CAP_LAVA, FLUID_CAP_WATER, MIN_Y } from '../../src/core/constants';
import { Xoshiro128 } from '../../src/core/rng';
import { createSettleScratch, settleWindow, type SettleScratch, type SettleSource } from '../../src/gen/fluids/settle';
import { FLUID_LAVA, FLUID_WATER, LAVA_SOURCE, NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, COBBLESTONE, FLUID_MODE, SANDSTONE, STONE } from '../../src/world/blocks/index';
import { FLUID_MODE_DISPLACE, FLUID_MODE_HOLD } from '../../src/world/blocks/kinds';

/** The abyss's cave byte (nibble 3 in bits 4-7). */
const ABYSS_CAVE = CAVE_BIOME.abyss << 4;
const water = (level: number, falling = false, unsettled = false): number => packFluid(FLUID_WATER, level, falling, unsettled);
const lava = (level: number, falling = false, unsettled = false): number => packFluid(FLUID_LAVA, level, falling, unsettled);

/**
 * A hand-built proto window over arrays: x0 ≤ x < x0 + W, z0 ≤ z < z0 + W, the band yLo ≤ y < yLo + H stored, stone
 * below the band and air above it; no fluid and cave byte 0 outside the band.
 */
class World implements SettleSource {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly W: number;
  readonly yLo: number;
  readonly H: number;
  readonly blocks: Int32Array;
  readonly fluids: Uint8Array;
  readonly caves: Uint8Array;
  constructor(x0: number, z0: number, W: number, yLo: number, H: number, fill: (y: number) => number) {
    this.x0 = x0;
    this.z0 = z0;
    this.x1 = x0 + W;
    this.z1 = z0 + W;
    this.W = W;
    this.yLo = yLo;
    this.H = H;
    this.blocks = new Int32Array(W * W * H);
    this.fluids = new Uint8Array(W * W * H);
    this.caves = new Uint8Array(W * W * H);
    for (let y = 0; y < H; y++) this.blocks.fill(fill(yLo + y), y * W * W, (y + 1) * W * W);
  }
  private index(x: number, y: number, z: number): number {
    if (x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1) throw new Error(`read outside the window at ${x},${y},${z}`);
    return y < this.yLo || y >= this.yLo + this.H ? -1 : ((y - this.yLo) * this.W + (z - this.z0)) * this.W + (x - this.x0);
  }
  block(x: number, y: number, z: number): number {
    const i = this.index(x, y, z);
    return i >= 0 ? this.blocks[i]! : y < this.yLo ? STONE : AIR;
  }
  fluid(x: number, y: number, z: number): number { const i = this.index(x, y, z); return i >= 0 ? this.fluids[i]! : NO_FLUID; }
  cave(x: number, y: number, z: number): number { const i = this.index(x, y, z); return i >= 0 ? this.caves[i]! : 0; }
  setBlock(x: number, y: number, z: number, state: number): this { this.blocks[this.index(x, y, z)] = state; return this; }
  setFluid(x: number, y: number, z: number, byte: number): this { this.blocks[this.index(x, y, z)] = AIR; this.fluids[this.index(x, y, z)] = byte; return this; }
  setCave(x: number, y: number, z: number, byte: number): this { this.caves[this.index(x, y, z)] = byte; return this; }
  /** Every proto fluid voxel of the band, packed as `settleWindow`'s seeds. */
  seeds(): Int32Array {
    const out: number[] = [];
    for (let y = this.yLo; y < this.yLo + this.H; y++) {
      for (let z = this.z0; z < this.z1; z++) {
        for (let x = this.x0; x < this.x1; x++) if (this.fluid(x, y, z) !== NO_FLUID) out.push(((y - MIN_Y) * this.W + (z - this.z0)) * this.W + (x - this.x0));
      }
    }
    return Int32Array.from(out);
  }
}

/** A stone plane (y ≤ 0) under air, the window centred on the origin. */
const plane = (): World => new World(-16, -16, 32, -4, 24, (y) => (y <= 0 ? STONE : AIR));
/** Solid stone everywhere: the test carves its passages. */
const rock = (x0 = -16): World => new World(x0, -16, 32, -4, 24, () => STONE);

interface Settled {
  visits: number;
  /** The sink's calls in order, as `x,y,z` → byte. */
  set: Map<string, number>;
  /** The sink's calls in order, as `x,y,z=byte` strings. */
  calls: string[];
  s: SettleScratch;
  /** The final byte: the sink's, else the proto's. */
  at(x: number, y: number, z: number): number;
}

function settle(w: World, o: { box?: number[]; s?: SettleScratch; stop?: () => boolean; modes?: ArrayLike<number>; seeds?: Int32Array } = {}): Settled {
  const set = new Map<string, number>();
  const calls: string[] = [];
  const s = o.s ?? createSettleScratch();
  const seeds = o.seeds ?? w.seeds();
  const box = Int32Array.from(o.box ?? [w.x0, w.z0, w.x1, w.z1]);
  const sink = { set(x: number, y: number, z: number, byte: number) { set.set(`${x},${y},${z}`, byte); calls.push(`${x},${y},${z}=${byte}`); } };
  const visits = settleWindow(w, seeds, seeds.length, box, sink, s, o.stop ?? (() => false), o.modes ?? FLUID_MODE);
  return { visits, set, calls, s, at: (x, y, z) => set.get(`${x},${y},${z}`) ?? w.fluid(x, y, z) };
}

/**
 * A staircase corridor along +x at z = 0 in solid rock (one block down every 2 blocks): the fluid's row at x is
 * y = 12 − ⌊x/2⌋ (x ≥ 0), with air above it up to y 13; a source of `byte` at (0, 12, 0), stone west of it.
 */
function staircase(byte: number): World {
  const w = rock(-4);
  for (let x = 0; x < 28; x++) for (let y = 12 - (x >> 1); y <= 13; y++) w.setBlock(x, y, 0, AIR);
  return w.setFluid(0, 12, 0, byte);
}

describe('settleWindow: the converged shapes (SP7a spec §4.1, §13.7)', () => {
  test("F1's diamond: one source on a plane gives levels 1 … 7 at Manhattan distance 1 … 7 and nothing beyond (113 voxels)", () => {
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE);
    const r = settle(w);
    expect(r.set.size).toBe(112);
    let count = 0;
    for (let z = -12; z <= 12; z++) {
      for (let x = -12; x <= 12; x++) {
        const m = Math.abs(x) + Math.abs(z);
        expect(r.at(x, 1, z)).toBe(m === 0 ? WATER_SOURCE : m <= 7 ? water(m) : NO_FLUID);
        expect(r.at(x, 2, z)).toBe(NO_FLUID);
        if (r.at(x, 1, z) !== NO_FLUID) count++;
      }
    }
    expect(count).toBe(113);
    expect(r.s.distAt(7, 1, 0)).toBe(7);
    expect(r.s.distAt(4, 1, -3)).toBe(7);
    expect(r.s.distAt(8, 1, 0)).toBe(-1);
  });

  test('a fall: a source on a 1 × 1 pillar 9 high gives falling voxels on each side down to the plane and spills of radius 7 from each landing', () => {
    const w = plane();
    for (let y = 1; y <= 9; y++) w.setBlock(0, y, 0, STONE);
    w.setFluid(0, 10, 0, WATER_SOURCE);
    const r = settle(w);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      expect(r.at(dx, 10, dz)).toBe(water(1));
      for (let y = 1; y <= 9; y++) expect(r.at(dx, y, dz)).toBe(water(0, true));
    }
    expect(r.at(2, 1, 0)).toBe(water(1));
    expect(r.s.distAt(2, 1, 0)).toBe(2);
    expect(r.at(8, 1, 0)).toBe(water(7));
    expect(r.s.distAt(8, 1, 0)).toBe(8);
    expect(r.at(9, 1, 0)).toBe(NO_FLUID);
    expect(r.at(-8, 1, 0)).toBe(water(7));
    expect(r.at(0, 1, -9)).toBe(NO_FLUID);
  });

  test('a 2-source infinite source: proto sources at (0, 0) and (2, 0) make (1, 0) a source, not falling', () => {
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE).setFluid(2, 1, 0, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(1, 1, 0)).toBe(WATER_SOURCE);
    expect(r.s.distAt(1, 1, 0)).toBe(1);
    expect(r.at(1, 1, 1)).toBe(water(1));
  });

  test('a 3-source pool: an L of three sources makes the corner between them a source', () => {
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE).setFluid(1, 1, 0, WATER_SOURCE).setFluid(0, 1, 1, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(1, 1, 1)).toBe(WATER_SOURCE);
    expect(r.at(-1, 1, 0)).toBe(water(1));
    expect(r.at(2, 1, 0)).toBe(water(1));
  });

  test('new sources from proto sources only: (0, 0), (2, 0), (0, 2) make (1, 0) and (0, 1) sources; (1, 1) stays flowing level 1', () => {
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE).setFluid(2, 1, 0, WATER_SOURCE).setFluid(0, 1, 2, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(1, 1, 0)).toBe(WATER_SOURCE);
    expect(r.at(0, 1, 1)).toBe(WATER_SOURCE);
    expect(r.at(1, 1, 1)).toBe(water(1));
    expect(r.s.distAt(1, 1, 1)).toBe(2);
  });

  test('the distance belongs to the level\'s own derivation (Spec correction 13; rulings R9)', () => {
    // Fed at level 2 from 9 blocks along a corridor with a fall on the way (B at (−7, 4, 0): 7 blocks east on y 4,
    // down the shaft at x 0, 2 blocks east on y 1) and at level 3 from 3 blocks across (A at (5, 1, 0)).
    const w = rock();
    for (let x = 0; x <= 5; x++) w.setBlock(x, 1, 0, AIR);
    w.setBlock(0, 2, 0, AIR).setBlock(0, 3, 0, AIR);
    for (let x = -7; x <= 0; x++) w.setBlock(x, 4, 0, AIR);
    w.setFluid(-7, 4, 0, WATER_SOURCE).setFluid(5, 1, 0, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(0, 4, 0)).toBe(water(7));
    expect(r.at(0, 1, 0)).toBe(water(0, true));
    expect(r.s.distAt(0, 1, 0)).toBe(7);
    // The voxel's level 2 comes from B's path, so its distance is that path's 9, not A's 3; A's own voxels keep A's.
    expect(r.at(2, 1, 0)).toBe(water(2));
    expect(r.s.distAt(2, 1, 0)).toBe(9);
    expect(r.at(3, 1, 0)).toBe(water(2));
    expect(r.s.distAt(3, 1, 0)).toBe(2);
    // Without A the same voxel reads the same level at the same distance.
    w.setFluid(5, 1, 0, NO_FLUID);
    const onlyB = settle(w);
    expect(onlyB.at(2, 1, 0)).toBe(water(2));
    expect(onlyB.s.distAt(2, 1, 0)).toBe(9);
  });

  test('the cap: down a staircase water runs 12 blocks (bit 6 at distance 12, 13 dry) and lava 14', () => {
    const rw = settle(staircase(WATER_SOURCE));
    expect(rw.at(1, 12, 0)).toBe(water(1));
    expect(rw.at(2, 12, 0)).toBe(water(2));
    expect(rw.at(2, 11, 0)).toBe(water(0, true));
    expect(rw.at(11, 7, 0)).toBe(water(1));
    expect(rw.at(12, 7, 0)).toBe(water(2));
    expect(rw.at(12, 6, 0)).toBe(water(0, true, true));
    expect(rw.s.distAt(12, 6, 0)).toBe(FLUID_CAP_WATER);
    for (let y = -4; y <= 13; y++) expect(rw.at(13, y, 0)).toBe(NO_FLUID);
    for (const byte of rw.set.values()) if (byte !== water(0, true, true)) expect(byte & 64).toBe(0);

    const rl = settle(staircase(LAVA_SOURCE));
    expect(rl.at(1, 12, 0)).toBe(lava(2));
    expect(rl.at(2, 12, 0)).toBe(lava(4));
    expect(rl.at(2, 11, 0)).toBe(lava(0, true));
    expect(rl.at(13, 6, 0)).toBe(lava(2));
    expect(rl.at(14, 6, 0)).toBe(lava(4));
    expect(rl.at(14, 5, 0)).toBe(lava(0, true, true));
    expect(rl.s.distAt(14, 5, 0)).toBe(FLUID_CAP_LAVA);
    for (let y = -4; y <= 13; y++) expect(rl.at(15, y, 0)).toBe(NO_FLUID);
  });

  test('a nearer feeder at a higher level spreads along its own derivation: past the next fall the cap counts from it, and a front it frees loses bit 6', () => {
    // A second source falls down a shaft at z = 1 and enters the staircase's landing (6, 9, 0) sideways at level 1,
    // distance 1, beside the staircase's own fall (value falling, distance 6). The landing reads falling at 6 (its
    // value's derivation), its level-1 derivation spreads level 2 at distance 2, and the next fall takes the least.
    const w = staircase(WATER_SOURCE);
    for (let y = 9; y <= 19; y++) w.setBlock(6, y, 1, AIR);
    w.setFluid(6, 19, 1, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(6, 9, 0)).toBe(water(0, true));
    expect(r.s.distAt(6, 9, 0)).toBe(6);
    expect(r.at(7, 9, 0)).toBe(water(1));
    expect(r.s.distAt(7, 9, 0)).toBe(7);
    expect(r.at(8, 8, 0)).toBe(water(0, true));
    expect(r.s.distAt(8, 8, 0)).toBe(3);
    expect(r.at(12, 6, 0)).toBe(water(0, true));
    expect(r.s.distAt(12, 6, 0)).toBe(7);
    expect(r.at(17, 4, 0)).toBe(water(1, false, true));
    expect(r.s.distAt(17, 4, 0)).toBe(FLUID_CAP_WATER);
    for (let y = -4; y <= 13; y++) expect(r.at(18, y, 0)).toBe(NO_FLUID);
    expect([...r.set.entries()].filter(([, byte]) => (byte & 64) !== 0).map(([key]) => key)).toEqual(['17,4,0']);
  });

  test('`unsettled` only at the cap with a passable target: a front at the cap against a wall has no bit 6', () => {
    const r = settle(staircase(WATER_SOURCE).setBlock(13, 6, 0, STONE));
    expect(r.at(12, 6, 0)).toBe(water(0, true));
    for (const byte of r.set.values()) expect(byte & 64).toBe(0);
  });

  test('the nearest drop: a hole 3 east sends the flow east only; holes 3 east and 3 west, both', () => {
    const east = settle(plane().setBlock(3, 0, 0, AIR).setFluid(0, 1, 0, WATER_SOURCE));
    expect(east.at(1, 1, 0)).toBe(water(1));
    expect(east.at(2, 1, 0)).toBe(water(2));
    expect(east.at(3, 1, 0)).toBe(water(3));
    expect(east.at(3, 0, 0)).toBe(water(0, true));
    for (const [x, z] of [[-1, 0], [0, 1], [0, -1], [1, 1], [1, -1]] as const) expect(east.at(x, 1, z)).toBe(NO_FLUID);

    const both = settle(plane().setBlock(3, 0, 0, AIR).setBlock(-3, 0, 0, AIR).setFluid(0, 1, 0, WATER_SOURCE));
    expect(both.at(1, 1, 0)).toBe(water(1));
    expect(both.at(-1, 1, 0)).toBe(water(1));
    expect(both.at(-3, 0, 0)).toBe(water(0, true));
    expect(both.at(0, 1, 1)).toBe(NO_FLUID);
    expect(both.at(0, 1, -1)).toBe(NO_FLUID);
  });

  test("lava's reach: levels 2, 4, 6 at distances 1, 2, 3, nothing at 4", () => {
    const r = settle(plane().setFluid(0, 1, 0, LAVA_SOURCE));
    expect(r.at(1, 1, 0)).toBe(lava(2));
    expect(r.at(2, 1, 0)).toBe(lava(4));
    expect(r.at(3, 1, 0)).toBe(lava(6));
    expect(r.at(1, 1, -1)).toBe(lava(4));
    expect(r.at(4, 1, 0)).toBe(NO_FLUID);
    expect(r.at(2, 1, 2)).toBe(NO_FLUID);
    expect(r.set.size).toBe(24);
  });

  test('hold and displace on a synthetic modes table: the target keeps its state and takes the byte (passable)', () => {
    const modes = Uint8Array.from(FLUID_MODE);
    modes[COBBLESTONE] = FLUID_MODE_HOLD;
    modes[SANDSTONE] = FLUID_MODE_DISPLACE;
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE).setBlock(1, 1, 0, COBBLESTONE).setBlock(-1, 1, 0, SANDSTONE).setBlock(0, 1, 1, STONE);
    const r = settle(w, { modes });
    expect(r.at(1, 1, 0)).toBe(water(1));
    expect(r.at(-1, 1, 0)).toBe(water(1));
    expect(r.at(2, 1, 0)).toBe(water(2));
    expect(r.at(0, 1, 1)).toBe(NO_FLUID);
    expect(w.block(1, 1, 0)).toBe(COBBLESTONE);
    expect(w.block(-1, 1, 0)).toBe(SANDSTONE);
    // Under the registry's own table both are `block`.
    const d = settle(w);
    expect(d.at(1, 1, 0)).toBe(NO_FLUID);
    expect(d.at(-1, 1, 0)).toBe(NO_FLUID);
  });
});

describe('settleWindow: the two fixed points, the proto reads and the abyss (SP7a spec §4.1, D22)', () => {
  test('a water source and a lava source 4 apart: the voxels both reach are lava with bit 6; water never enters the lava source', () => {
    const r = settle(plane().setFluid(0, 1, 0, WATER_SOURCE).setFluid(4, 1, 0, LAVA_SOURCE));
    expect(r.at(1, 1, 0)).toBe(lava(6, false, true));
    expect(r.at(2, 1, 0)).toBe(lava(4, false, true));
    expect(r.at(3, 1, 0)).toBe(lava(2, false, true));
    expect(r.set.has('4,1,0')).toBe(false);
    expect(r.at(4, 1, 0)).toBe(LAVA_SOURCE);
    expect(r.set.has('0,1,0')).toBe(false);
    expect(r.at(-1, 1, 0)).toBe(water(1));
    expect(r.at(6, 1, 0)).toBe(lava(4));
  });

  test("a stream reaching a proto lake spreads over it: the lake's voxels stay sources, the stream's voxel over it flows", () => {
    const w = rock();
    for (let x = 0; x <= 8; x++) w.setBlock(x, 2, 0, AIR);
    for (let x = 3; x <= 8; x++) w.setFluid(x, 1, 0, WATER_SOURCE);
    w.setFluid(0, 2, 0, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(2, 2, 0)).toBe(water(2));
    expect(r.at(3, 2, 0)).toBe(water(3));
    expect(r.at(4, 2, 0)).toBe(water(4));
    expect(r.at(7, 2, 0)).toBe(water(7));
    expect(r.at(8, 2, 0)).toBe(NO_FLUID);
    for (let x = 3; x <= 8; x++) expect(r.set.has(`${x},1,0`)).toBe(false);
  });

  test('a stream reaching a pool the settle made falls into it: that voxel becomes falling', () => {
    const w = rock();
    for (let x = 0; x <= 8; x++) w.setBlock(x, 2, 0, AIR);
    for (let x = 3; x <= 8; x++) w.setBlock(x, 1, 0, AIR);
    w.setFluid(0, 2, 0, WATER_SOURCE).setFluid(8, 1, 0, WATER_SOURCE);
    const r = settle(w);
    expect(r.at(3, 2, 0)).toBe(water(3));
    expect(r.at(3, 1, 0)).toBe(water(0, true));
    expect(r.at(4, 1, 0)).toBe(water(1));
    expect(r.at(4, 2, 0)).toBe(NO_FLUID);
    // Without the stream, the pool voxel holds the source's level 5.
    w.setFluid(0, 2, 0, NO_FLUID);
    expect(settle(w).at(3, 1, 0)).toBe(water(5));
  });

  test('the abyss: water never enters a voxel whose cave nibble is 3, and its front there carries no bit 6', () => {
    const p = settle(plane().setFluid(0, 1, 0, WATER_SOURCE).setCave(1, 1, 0, ABYSS_CAVE));
    expect(p.at(1, 1, 0)).toBe(NO_FLUID);
    expect(p.at(2, 1, 0)).toBe(water(4));
    for (const byte of p.set.values()) expect(byte & 64).toBe(0);

    // A source whose only open neighbours, beside and below, are abyss air: nothing moves.
    const w = rock().setBlock(1, 1, 0, AIR).setCave(1, 1, 0, ABYSS_CAVE).setBlock(0, 0, 0, AIR).setCave(0, 0, 0, ABYSS_CAVE).setFluid(0, 1, 0, WATER_SOURCE);
    const e = settle(w);
    expect(e.set.size).toBe(0);
    expect(e.visits).toBe(1);

    // At the cap, an abyss target is no target: no bit 6.
    const c = settle(staircase(WATER_SOURCE).setCave(13, 6, 0, ABYSS_CAVE));
    expect(c.at(12, 6, 0)).toBe(water(0, true));
    expect(c.at(13, 6, 0)).toBe(NO_FLUID);
    // Lava ignores the nibble.
    const l = settle(plane().setFluid(0, 1, 0, LAVA_SOURCE).setCave(1, 1, 0, ABYSS_CAVE));
    expect(l.at(1, 1, 0)).toBe(lava(2));
  });

  test('seeds farther than the type\'s cap from the box (Manhattan) are skipped', () => {
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE);
    expect(settle(w, { box: [FLUID_CAP_WATER + 1, -16, 16, 16] }).visits).toBe(0);
    expect(settle(w, { box: [FLUID_CAP_WATER, -16, 16, 16] }).visits).toBeGreaterThan(0);
    expect(settle(w, { box: [7, 7, 16, 16] }).visits).toBe(0);
    const near = settle(w, { box: [3, 3, 16, 16] });
    expect(near.set.size).toBe(3);
    for (const key of near.set.keys()) {
      const [x, , z] = key.split(',').map(Number);
      expect(x! >= 3 && z! >= 3).toBe(true);
    }
    const l = plane().setFluid(0, 1, 0, LAVA_SOURCE);
    expect(settle(l, { box: [FLUID_CAP_LAVA + 1, -16, 16, 16] }).visits).toBe(0);
    expect(settle(l, { box: [FLUID_CAP_LAVA, -16, 16, 16] }).visits).toBeGreaterThan(0);
  });
});

/**
 * A random window 32 × 48 × 32 (y 0 … 47): stone up to a stepped height with random holes, water and lava sources on
 * random air voxels (some in pairs two apart, for the new-source rule), and abyss nibbles on some air voxels.
 */
function randomWorld(seed: number): World {
  const rng = new Xoshiro128(seed);
  const w = new World(100, -40, 32, 0, 48, () => AIR);
  const heights = new Int32Array(64);
  for (let i = 0; i < 64; i++) heights[i] = 8 + rng.nextInt(24);
  for (let z = -40; z < -8; z++) {
    for (let x = 100; x < 132; x++) {
      const h = heights[((z + 40) >> 2) * 8 + ((x - 100) >> 2)]!;
      for (let y = 0; y < h; y++) if (rng.nextInt(100) >= 14 || y === 0) w.setBlock(x, y, z, STONE);
    }
  }
  const air = (): [number, number, number] => {
    for (;;) {
      const x = 100 + rng.nextInt(32);
      const y = 1 + rng.nextInt(40);
      const z = -40 + rng.nextInt(32);
      if (w.block(x, y, z) === AIR && w.fluid(x, y, z) === NO_FLUID) return [x, y, z];
    }
  };
  for (let i = 0; i < 300; i++) { const [x, y, z] = air(); w.setCave(x, y, z, ABYSS_CAVE); }
  for (let i = 0; i < 14; i++) { const [x, y, z] = air(); w.setFluid(x, y, z, WATER_SOURCE); }
  for (let i = 0; i < 5; i++) { const [x, y, z] = air(); w.setFluid(x, y, z, LAVA_SOURCE); }
  for (let i = 0; i < 6; i++) {
    const [x, y, z] = air();
    if (x + 2 < 132 && w.block(x + 2, y, z) === AIR) w.setFluid(x, y, z, WATER_SOURCE).setFluid(x + 2, y, z, WATER_SOURCE);
  }
  return w;
}

describe('settleWindow: the least fixed point, the visits and stop (SP7a spec §4.1, §4.2)', () => {
  test('order independence: 50 random pop orders on 8 random windows give byte-identical sinks', () => {
    const s = createSettleScratch(1 << 10);
    let flowing = 0;
    let contacts = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const w = randomWorld(seed);
      s.popOrder = 0;
      const ref = settle(w, { s });
      expect(ref.visits).toBeGreaterThan(0);
      for (const byte of ref.set.values()) {
        if ((byte & 7) !== 0 || (byte & 8) !== 0) flowing++;
        if ((byte & 64) !== 0) contacts++;
      }
      for (let order = 1; order <= 50; order++) {
        s.popOrder = seed * 1000 + order;
        const r = settle(w, { s });
        expect(r.calls).toEqual(ref.calls);
      }
    }
    expect(flowing).toBeGreaterThan(1000);
    expect(contacts).toBeGreaterThan(0);
  });

  test('the visits returned equal the pops: 1 for an enclosed source, 2 with one open neighbour', () => {
    const one = settle(rock().setBlock(0, 1, 0, AIR).setFluid(0, 1, 0, WATER_SOURCE));
    expect(one.visits).toBe(1);
    expect(one.set.size).toBe(0);
    const two = settle(rock().setBlock(1, 1, 0, AIR).setFluid(0, 1, 0, WATER_SOURCE));
    expect(two.visits).toBe(2);
    expect(two.calls).toEqual([`1,1,0=${water(1)}`]);
    const both = settle(rock().setBlock(1, 1, 0, AIR).setFluid(0, 1, 0, WATER_SOURCE).setBlock(5, 1, 0, AIR).setFluid(4, 1, 0, LAVA_SOURCE));
    expect(both.visits).toBe(4);
  });

  test('stop is polled once per 1,024 visits, from the first', () => {
    const w = randomWorld(3);
    let polls = 0;
    const r = settle(w, { stop: () => { polls++; return false; } });
    expect(r.visits).toBeGreaterThan(2048);
    expect(polls).toBe(Math.ceil(r.visits / 1024));
  });

  test('stop: true at the first poll, or at the second, returns −1 and the sink receives nothing', () => {
    const first = settle(plane().setFluid(0, 1, 0, WATER_SOURCE), { stop: () => true });
    expect(first.visits).toBe(-1);
    expect(first.set.size).toBe(0);
    let polls = 0;
    const second = settle(randomWorld(5), { stop: () => ++polls >= 2 });
    expect(second.visits).toBe(-1);
    expect(polls).toBe(2);
    expect(second.set.size).toBe(0);
  });

  test('the box does not change the result on the box: S1 beyond the cap, falling onto S2\'s landing (review T3 Important 1)', () => {
    // S1 at (−7, 4, 0) runs 7 blocks east on y 4 and falls down the shaft at x 0 onto the landing L (0, 1, 0); S2, a
    // pocket source at (0, 1, 1), feeds L sideways at distance 1; the lower corridor runs east on y 1 to x 15.
    const w = rock();
    for (let x = 0; x <= 15; x++) w.setBlock(x, 1, 0, AIR);
    w.setBlock(0, 2, 0, AIR).setBlock(0, 3, 0, AIR);
    for (let x = -7; x <= 0; x++) w.setBlock(x, 4, 0, AIR);
    w.setFluid(-7, 4, 0, WATER_SOURCE).setFluid(0, 1, 1, WATER_SOURCE);
    const full = settle(w);
    const boxed = settle(w, { box: [6, -16, 16, 16] });
    for (let x = 6; x <= 15; x++) for (let y = -4; y <= 13; y++) expect([x, y, boxed.at(x, y, 0)]).toEqual([x, y, full.at(x, y, 0)]);
  });

  test('the box does not change the result on the box: random windows, 4 boxes each (review T3 Important 1)', () => {
    let compared = 0;
    for (let seed = 21; seed <= 36; seed++) {
      const w = randomWorld(seed);
      const full = settle(w);
      for (const box of [[100, -40, 116, -24], [116, -40, 132, -24], [100, -24, 116, -8], [110, -30, 122, -18]]) {
        const boxed = settle(w, { box });
        for (const [key, byte] of full.set) {
          const [x, , z] = key.split(',').map(Number);
          if (x! < box[0]! || x! >= box[2]! || z! < box[1]! || z! >= box[3]!) continue;
          expect([key, boxed.set.get(key)]).toEqual([key, byte]);
          compared++;
        }
        for (const key of boxed.set.keys()) expect([key, full.set.has(key)]).toEqual([key, true]);
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  test('a scratch is reused across windows and grows by doubling: the results equal a fresh scratch', () => {
    const small = createSettleScratch(16);
    for (let seed = 11; seed <= 13; seed++) {
      const w = randomWorld(seed);
      expect(settle(w, { s: small }).calls).toEqual(settle(w).calls);
    }
    const w = plane().setFluid(0, 1, 0, WATER_SOURCE);
    expect(settle(w, { s: small }).calls).toEqual(settle(w).calls);
  });

  test('the packed keys need a square window with W at most 2,364: anything else throws (review T3 minor 1)', () => {
    const run = (x1: number, z1: number) => () => settleWindow({ x0: 0, z0: 0, x1, z1, block: () => STONE, fluid: () => NO_FLUID, cave: () => 0 },
      new Int32Array(0), 0, Int32Array.from([0, 0, 1, 1]), { set() {} }, createSettleScratch(16), () => false);
    expect(run(32, 48)).toThrow(/square/);
    expect(run(48, 32)).toThrow(/square/);
    expect(run(2365, 2365)).toThrow(/square/);
    expect(run(2364, 2364)()).toBe(0);
  });
});

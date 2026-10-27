/**
 * The exact initial light job (SP4a spec §4.1, §4.2): `lightRegion` on hand-filled light regions (open sky, water,
 * a sealed cavity, a shaft, partial faces and emitters through injected tables), the centre of a 3 × 3 synthetic
 * store against the global `referenceLight`, the uniform section outputs, and `fillColumnL`'s commit and versions.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { writeFinalHeightmaps } from '../../src/gen/pipeline/finalHeightmaps';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion, type LightScratch, type LightTables } from '../../src/light/initial';
import { FLUID_LAVA, NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, DIRT, STONE } from '../../src/world/blocks/index';
import { FACE_DOWN, FACE_UP } from '../../src/world/blocks/kinds';
import { fallBlocked } from '../../src/world/blocks/light';
import { finalAt, SECTIONS, STATUS_DECORATED, STATUS_PUBLISHED } from '../../src/world/store/columnTable';
import { LIGHT_H, LIGHT_LO, LIGHT_W, lightIndex } from '../../src/world/store/padded';
import { FINAL_LIGHT, uniformCode } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { fillColumnL } from '../../src/workers/worldJobs';
import { referenceLight } from '../harness/refs';

const MiB = 1 << 20;
const NEVER = () => false;
const LAVA = packFluid(FLUID_LAVA, 0);
const LO = LIGHT_LO;
const HI = LIGHT_LO + LIGHT_W;

type At = (x: number, y: number, z: number) => number;
const noFluid: At = () => NO_FLUID;

/**
 * Fills the region's blocks and fluid from `blockAt`/`fluidAt` (column-local x, z in [−15, 31), absolute y), and its
 * `lightBlocking` by the straight fall under `t` (1 + the highest y the fall does not enter, −64 when none).
 */
function fill(s: LightScratch, blockAt: At, fluidAt: At = noFluid, t: LightTables = DEFAULT_LIGHT_TABLES): void {
  const r = s.region;
  for (let z = LO; z < HI; z++) {
    for (let x = LO; x < HI; x++) {
      let lb = -64;
      let above = AIR;
      for (let y = 319; y >= -64; y--) {
        const i = lightIndex(x, y, z);
        const b = blockAt(x, y, z);
        const f = fluidAt(x, y, z);
        r.blocks[i] = b;
        r.fluid[i] = f;
        if (lb === -64 && fallBlocked(b, f, above, t)) lb = y + 1;
        above = b;
      }
      r.lightBlocking[(z - LO) * LIGHT_W + (x - LO)] = lb;
    }
  }
}

const skyAt = (s: LightScratch, x: number, y: number, z: number) => s.region.light[lightIndex(x, y, z)]! >> 4;
const blockAt = (s: LightScratch, x: number, y: number, z: number) => s.region.light[lightIndex(x, y, z)]! & 15;

/** The registry's tables with DIRT re-defined (OPACITY, FULL_FACES, EMIT), the injected state of these tests. */
function injected(opacity: number, fullFaces: number, emit: number): LightTables {
  const t = {
    opacity: new Uint8Array(DEFAULT_LIGHT_TABLES.opacity),
    fullFaces: new Uint8Array(DEFAULT_LIGHT_TABLES.fullFaces),
    emit: new Uint8Array(DEFAULT_LIGHT_TABLES.emit),
  };
  t.opacity[DIRT] = opacity;
  t.fullFaces[DIRT] = fullFaces;
  t.emit[DIRT] = emit;
  return t;
}

describe('lightRegion (SP4a spec §4.1, §4.2)', () => {
  let s: LightScratch;
  beforeAll(() => {
    s = createLightScratch();
  });

  test('createLightScratch: the light region, a 4096-byte section output and an empty queue', () => {
    expect(s.region.light.length).toBe(LIGHT_W * LIGHT_H * LIGHT_W);
    expect(s.out.length).toBe(4096);
    expect(s.queue.length).toBe(0);
  });

  test('open sky: every voxel at or above the surface + 1 reads sky 15', () => {
    const h = (x: number, z: number) => 60 + ((x * 3 + z * 5) & 7);
    fill(s, (x, y, z) => (y <= h(x, z) ? STONE : AIR));
    lightRegion(s);
    let bad = 0;
    for (let z = LO; z < HI; z++) {
      for (let x = LO; x < HI; x++) {
        for (let y = h(x, z) + 1; y <= 319; y++) if (s.region.light[lightIndex(x, y, z)] !== 0xF0) bad++;
        if (s.region.light[lightIndex(x, h(x, z), z)] !== 0) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(s.queue.length).toBe(0);
  });

  test('sky 14, 13, 12 at 1-3 blocks under open still water', () => {
    // A 13-deep sea over the whole region: y 50 … 62 water on stone, air above.
    fill(s, (_x, y) => (y < 50 ? STONE : AIR), (_x, y) => (y >= 50 && y <= 62 ? WATER_SOURCE : NO_FLUID));
    lightRegion(s);
    for (const [x, z] of [[0, 0], [15, 15], [7, 3], [-15, 30]] as const) {
      expect([63, 62, 61, 60].map((y) => skyAt(s, x, y, z)), `(${x}, ${z})`).toEqual([15, 14, 13, 12]);
      expect(skyAt(s, x, 50, z)).toBe(2);
      expect(skyAt(s, x, 49, z)).toBe(0);
    }
  });

  test('above y 319 is air with sky 15: water in the top voxel reads 14, and the reference agrees', () => {
    const top: At = (_x, y) => (y >= 318 ? WATER_SOURCE : NO_FLUID);
    const rock: At = (_x, y) => (y <= 60 ? STONE : AIR);
    fill(s, rock, top);
    expect(s.region.lightBlocking[0]).toBe(320);
    lightRegion(s);
    expect([319, 318, 317].map((y) => skyAt(s, 4, y, 4))).toEqual([14, 13, 12]);
    const ref = referenceLight({ x0: 0, z0: 0, w: 3, h: 3 }, rock, top);
    expect([319, 318, 317].map((y) => ref[((y + 64) * 3 + 1) * 3 + 1]! >> 4)).toEqual([14, 13, 12]);
  });

  test('a sealed cavity reads 0', () => {
    const inBox = (x: number, y: number, z: number) => x >= 2 && x <= 10 && y >= 20 && y <= 30 && z >= 2 && z <= 10;
    fill(s, (x, y, z) => (y <= 100 && !inBox(x, y, z) ? STONE : AIR));
    lightRegion(s);
    let lit = 0;
    for (let y = 20; y <= 30; y++) {
      for (let z = 2; z <= 10; z++) for (let x = 2; x <= 10; x++) if (s.region.light[lightIndex(x, y, z)] !== 0) lit++;
    }
    expect(lit).toBe(0);
    expect(skyAt(s, 5, 101, 5)).toBe(15);
  });

  test('a 1-wide shaft lights sideways by −1 per block', () => {
    // Rock up to y 100, a shaft at (0, 50 … 100, 0) and a 1 × 1 tunnel along +x at y 50.
    const open = (x: number, y: number, z: number) => z === 0 && ((x === 0 && y >= 50) || (y === 50 && x >= 0));
    fill(s, (x, y, z) => (y <= 100 && !open(x, y, z) ? STONE : AIR));
    lightRegion(s);
    for (let y = 50; y <= 100; y++) expect(skyAt(s, 0, y, 0), `shaft y ${y}`).toBe(15);
    for (let k = 1; k < HI; k++) expect(skyAt(s, k, 50, 0), `tunnel x ${k}`).toBe(Math.max(0, 15 - k));
  });

  test('FULL_FACES crossing with an injected bottom-slab table', () => {
    // A layer of slabs (DIRT) at y 100 over the whole region, with one air hole at (0, 100, 0); rock up to y 60.
    const scene: At = (x, y, z) => (y <= 60 ? STONE : y === 100 && (x !== 0 || z !== 0) ? DIRT : AIR);
    const bottom = injected(0, 1 << FACE_DOWN, 0);
    fill(s, scene, noFluid, bottom);
    expect(s.region.lightBlocking[(5 - LO) * LIGHT_W + (5 - LO)]).toBe(100);
    lightRegion(s, bottom);
    // The fall enters a bottom slab (15), but no light leaves it downwards: under the layer, light comes only
    // sideways from the hole's shaft, −1 per block.
    expect(skyAt(s, 5, 100, 0)).toBe(15);
    expect(skyAt(s, 3, 99, 3)).toBe(9);
    for (let k = 0; k < HI; k++) expect(skyAt(s, k, 99, 0), `under the layer, x ${k}`).toBe(Math.max(0, 15 - k));
    expect(skyAt(s, 20, 99, 20)).toBe(0);
    // A top slab: the fall does not enter it, and light enters it sideways only (from the hole), −1 per block; it
    // passes down out of it.
    const top = injected(0, 1 << FACE_UP, 0);
    fill(s, scene, noFluid, top);
    expect(s.region.lightBlocking[(5 - LO) * LIGHT_W + (5 - LO)]).toBe(101);
    lightRegion(s, top);
    expect(skyAt(s, 5, 100, 0)).toBe(10);
    expect(skyAt(s, 5, 99, 0)).toBe(10);
    expect(skyAt(s, 3, 100, 3)).toBe(9);
  });

  test('block BFS from an injected emitter (emit 14) and from air + lava (15) falls by 1 per block', () => {
    // A sealed cave y 10 … 40 over the whole region (no sky), an emitter at (−5, 20, 0) and a lava source at (20, 30, 15).
    const t = injected(0, 0, 14);
    const scene: At = (x, y, z) => (x === -5 && y === 20 && z === 0 ? DIRT : y <= 100 && (y < 10 || y > 40) ? STONE : AIR);
    const lava: At = (x, y, z) => (x === 20 && y === 30 && z === 15 ? LAVA : NO_FLUID);
    fill(s, scene, lava, t);
    lightRegion(s, t);
    for (let d = 0; d <= 16; d++) {
      expect(blockAt(s, -5 + d, 20, 0), `emitter +x ${d}`).toBe(Math.max(0, 14 - d));
      expect(blockAt(s, -5, 20 + d, 0), `emitter +y ${d}`).toBe(Math.max(0, 14 - d));
      expect(blockAt(s, 20 - d, 30, 15), `lava −x ${d}`).toBe(Math.max(0, 15 - d));
      expect(blockAt(s, 20, 30 - d, 15), `lava −y ${d}`).toBe(Math.max(0, 15 - d));
    }
    expect(skyAt(s, 0, 20, 0)).toBe(0);
    // Without the injected table DIRT is an opaque full cube that emits nothing.
    fill(s, scene, lava);
    lightRegion(s);
    expect(blockAt(s, -4, 20, 0)).toBe(0);
    expect(blockAt(s, 19, 30, 15)).toBe(14);
  });

  test('an injected emitting table seeds the block BFS in a region without lava (the table check alone, Task P1)', () => {
    // No fluid anywhere, so only the injected table's emitter (emit 13) can seed: lightRegion must check `t.emit`.
    const t = injected(0, 0, 13);
    const scene: At = (x, y, z) => (x === 7 && y === 25 && z === 3 ? DIRT : y <= 100 && (y < 10 || y > 40) ? STONE : AIR);
    fill(s, scene, noFluid, t);
    expect(s.region.fluid.every((f) => f === NO_FLUID)).toBe(true);
    lightRegion(s, t);
    for (let d = 0; d <= 15; d++) {
      expect(blockAt(s, 7 - d, 25, 3), `emitter −x ${d}`).toBe(Math.max(0, 13 - d));
      expect(blockAt(s, 7, 25 - d, 3), `emitter −y ${d}`).toBe(Math.max(0, 13 - d));
      expect(blockAt(s, 7, 25, 3 + d), `emitter +z ${d}`).toBe(Math.max(0, 13 - d));
    }
    expect(skyAt(s, 7, 25, 3)).toBe(0);
  });

  test('without an emitting state lava alone seeds the block BFS: in every byte lane of a word and with any level, falling, unsettled or bit 7; water and type 3 seed nothing', () => {
    // Tables that emit nothing, so lightRegion seeds the block BFS only when its lava check finds lava (Task P1). The
    // registry's own tables emit since SP5a's torches (SP5a spec §1.2), so the test injects the registry's without EMIT.
    const t: LightTables = { ...DEFAULT_LIGHT_TABLES, emit: new Uint8Array(DEFAULT_LIGHT_TABLES.emit.length) };
    expect(t.emit.every((e) => e === 0)).toBe(true);
    const scene: At = (_x, y) => (y <= 100 && (y < 10 || y > 40) ? STONE : AIR);
    const lavaBytes = [LAVA, packFluid(FLUID_LAVA, 3, true, true), LAVA | 0x80, packFluid(FLUID_LAVA, 7)];
    const lanes = new Set<number>();
    for (let k = 0; k < 4; k++) {
      const x = -4 + k;
      lanes.add(lightIndex(x, 20, 0) % 4);
      fill(s, scene, (xx, yy, zz) => (xx === x && yy === 20 && zz === 0 ? lavaBytes[k]! : NO_FLUID), t);
      lightRegion(s, t);
      expect(blockAt(s, x, 20, 0), `lava byte ${lavaBytes[k]} at region index ${lightIndex(x, 20, 0)}`).toBe(15);
      expect(blockAt(s, x + 3, 20, 0)).toBe(12);
    }
    expect(lanes.size, 'the four voxels cover the four byte lanes of a 32-bit word').toBe(4);
    for (const byte of [WATER_SOURCE, 0x30, WATER_SOURCE | 0x80]) {
      fill(s, scene, (xx, yy, zz) => (xx === 0 && yy === 20 && zz === 0 ? byte : NO_FLUID), t);
      lightRegion(s, t);
      expect(s.region.light.some((l) => (l & 15) !== 0), `fluid byte ${byte} emits nothing`).toBe(false);
    }
  });

  test('centreSection copies the centre column\'s section in voxel order ly<<8 | lz<<4 | lx', () => {
    const r = s.region;
    for (let i = 0; i < r.light.length; i++) r.light[i] = (i * 7) & 0xFF;
    for (const sy of [0, 9, 23]) {
      const out = centreSection(s, sy);
      expect(out).toBe(s.out);
      for (const [lx, ly, lz] of [[0, 0, 0], [15, 15, 15], [3, 9, 12]] as const) {
        expect(out[(ly << 8) | (lz << 4) | lx]).toBe(r.light[lightIndex(lx, 16 * sy - 64 + ly, lz)]);
      }
    }
  });
});

/** The centre column of the synthetic store and its 3 × 3. */
const CX = 3;
const CZ = -2;
const X0 = 16 * CX;
const Z0 = 16 * CZ;

/**
 * A synthetic world around (CX, CZ), in blocks relative to the centre column's origin (u = x − X0, v = z − Z0):
 * rolling ground near y 62, a pond (water 53 … 61), a hill at y 85 with a stone overhang (y 78 … 84) over the low
 * ground, a floating stone slab (y 120 … 123) whose shadow falls on the ground, and a sealed cave.
 */
function worldBlock(x: number, y: number, z: number): number {
  const u = x - X0;
  const v = z - Z0;
  const pond = (u - 20) ** 2 + (v - 6) ** 2 < 49;
  const ground = u < -4 ? 85 : pond ? 52 : 62 + ((u * u + 3 * v) % 7 + 7) % 7;
  if (y >= 20 && y <= 25 && u >= 4 && u <= 8 && v >= 4 && v <= 8) return AIR;
  if (y <= ground) return STONE;
  if (y >= 78 && y <= 84 && u >= -4 && u < 6 && v >= 0 && v < 12) return STONE;
  if (y >= 120 && y <= 123 && u >= -2 && u < 14 && v >= -10 && v < 26) return STONE;
  return AIR;
}
function worldFluid(x: number, y: number, z: number): number {
  const u = x - X0;
  const v = z - Z0;
  return (u - 20) ** 2 + (v - 6) ** 2 < 49 && y >= 53 && y <= 61 ? WATER_SOURCE : NO_FLUID;
}

/**
 * A shared store with the 3 × 3 around (CX, CZ) at Decorated, built as T then the D skeleton build it: the proto
 * set committed at 1, then shared into the final set with an all-zero light and the final heightmaps, committed at 2
 * (blockVersion 2, lightVersion 0).
 */
function syntheticStore(): VoxelStore {
  const st = createStore({ shared: true, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
  const blocks = new Uint16Array(4096);
  const fluid = new Uint8Array(4096);
  const zero = new Uint8Array(4096);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bx = 16 * (CX + dx);
      const bz = 16 * (CZ + dz);
      const w = st.claimColumn(CX + dx, CZ + dz, 0);
      for (let sy = 0; sy < SECTIONS; sy++) {
        for (let i = 0; i < 4096; i++) {
          const x = bx + (i & 15);
          const y = 16 * sy - 64 + (i >> 8);
          const z = bz + ((i >> 4) & 15);
          blocks[i] = worldBlock(x, y, z);
          fluid[i] = worldFluid(x, y, z);
        }
        w.setProto(sy, blocks, fluid);
      }
      w.commit(1);
    }
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bx = 16 * (CX + dx);
      const bz = 16 * (CZ + dz);
      const w = st.reopenColumn(CX + dx, CZ + dz, 1);
      for (let sy = 0; sy < SECTIONS; sy++) w.shareFinal(sy, zero);
      writeFinalHeightmaps((lx, y, lz) => worldBlock(bx + lx, y, bz + lz), (lx, y, lz) => worldFluid(bx + lx, y, bz + lz), w.aux());
      w.commit(2);
    }
  }
  return st;
}

const statusOf = (st: VoxelStore) => st.table.status(st.table.find(CX, CZ));

describe('fillColumnL on a synthetic 3 × 3 store (SP4a spec §2.3, §4.2)', () => {
  let st: VoxelStore;
  let before: Int32Array;
  let got: Int32Array | null;
  beforeAll(() => {
    st = syntheticStore();
    before = st.neighborhood(CX, CZ).versions();
    got = fillColumnL(st, CX, CZ, createLightScratch(), NEVER);
  });

  test('fillColumnL: status 3, lightVersion 1, and the returned versions equal the 3 × 3 versions read before', () => {
    expect(statusOf(st)).toBe(STATUS_PUBLISHED);
    expect([...before.subarray(8, 10)]).toEqual([2, 0]);
    expect([...st.neighborhood(CX, CZ).versions().subarray(8, 10)]).toEqual([2, 1]);
    expect(got).not.toBeNull();
    expect([...got!]).toEqual([...before]);
    // The neighbours are untouched.
    const after = st.neighborhood(CX, CZ).versions();
    for (let k = 0; k < 18; k++) if (k !== 9) expect(after[k], `versions[${k}]`).toBe(before[k]);
  });

  test('the centre equals referenceLight on 3 × 3 synthetic columns (terrain with an overhang, water, a floating slab with its shadow)', () => {
    const ref = referenceLight({ x0: X0 - 16, z0: Z0 - 16, w: 48, h: 48 }, worldBlock, worldFluid);
    expect(ref.length).toBe(48 * 48 * 384);
    const v = st.final(CX, CZ)!;
    let mismatches = 0;
    const seen = new Set<number>();
    for (let y = -64; y <= 319; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const want = ref[((y + 64) * 48 + (lz + 16)) * 48 + (lx + 16)]!;
          if (v.light(lx, y, lz) !== want) mismatches++;
          seen.add(want >> 4);
        }
      }
    }
    expect(mismatches).toBe(0);
    // The scene exercises more than open sky and rock: water, the overhang and the island's shadow give partial levels.
    for (const lvl of [14, 12, 8]) expect(seen.has(lvl), `sky ${lvl} somewhere in the centre`).toBe(true);
    // Water: sky 13 two blocks under the pond's surface (y 61 is its top; u 20, v 6 is in the column (CX + 1, CZ)).
    expect(ref[((60 + 64) * 48 + (6 + 16)) * 48 + (20 + 16)]! >> 4).toBe(13);
    // The island's shadow: on the ground under its middle, sky is above 0 and below 15.
    const under = st.final(CX, CZ)!.light(6, 63 + ((36 + 3 * 8) % 7), 8) >> 4;
    expect(under).toBeGreaterThan(0);
    expect(under).toBeLessThan(15);
  });

  test('uniform outputs: an open-sky section stores no slot (descriptor 0xF0), a sealed rock section 0', () => {
    const base = st.table.find(CX, CZ);
    // sy 23 is y 304 … 319, all air; sy 1 is y −48 … −33, all stone.
    expect(st.table.ints[finalAt(base, 23) + FINAL_LIGHT]).toBe(uniformCode(0xF0));
    expect(st.table.ints[finalAt(base, 1) + FINAL_LIGHT]).toBe(uniformCode(0));
    expect(st.final(CX, CZ)!.sectionLight(23)).toBe(0xF0);
    expect(st.final(CX, CZ)!.sectionLight(1)).toBe(0);
    // A section with the ground surface in it is dense.
    expect(st.final(CX, CZ)!.sectionLight(7)).toBeInstanceOf(Uint8Array);
  });

  test('fillColumnL: a stop leaves the column at Decorated with its versions, and returns null', () => {
    const st2 = syntheticStore();
    const v0 = [...st2.neighborhood(CX, CZ).versions()];
    for (const polls of [1, 2]) {
      let n = 0;
      expect(fillColumnL(st2, CX, CZ, createLightScratch(), () => ++n >= polls)).toBeNull();
      expect(statusOf(st2)).toBe(STATUS_DECORATED);
      expect([...st2.neighborhood(CX, CZ).versions()]).toEqual(v0);
    }
  });
});

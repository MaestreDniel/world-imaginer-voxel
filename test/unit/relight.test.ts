/**
 * The incremental relight (SP5a spec §2.3, D19): `relight` on canned worlds of 5 × 5 columns, through a stub
 * `RelightAccess` over the inner 3 × 3 (local x, z 0 … 47). The initial light and the reference are `lightRegion`
 * (`mayEmit` true) of each of the inner 9 columns, each over its own 3 × 3 within the 5 × 5; every edit lies in the
 * centre column (local x, z 16 … 31), and "equals" compares every voxel of the inner 3 × 3.
 */
import { describe, expect, test } from 'vitest';
import { createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion, type LightScratch, type LightTables } from '../../src/light/initial';
import {
  createRelightScratch, EDGE_E, EDGE_N, EDGE_NE, EDGE_NW, EDGE_S, EDGE_SE, EDGE_SW, EDGE_W, relight,
  type RelightAccess, type RelightReport,
} from '../../src/light/relight';
import { LAVA_SOURCE, NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, DIRT, GLASS, ICE, LADDER, STONE, TORCH, WALL_TORCH } from '../../src/world/blocks/index';
import { FACE_EAST, FACE_UP } from '../../src/world/blocks/kinds';
import { fallBlocked } from '../../src/world/blocks/light';
import { createLightRegion, LIGHT_W } from '../../src/world/store/padded';
import { testRng } from '../harness/stats';

/** The world: 5 × 5 columns, local x, z −16 … 63 (the inner 3 × 3 is 0 … 47), rows 0 … 383 (y + 64). */
const WX = 80;
const OFF = 16;
const H = 384;
/** The inner 3 × 3. */
const L = 48;
const VOXELS = L * H * L;

type Scene = (x: number, r: number, z: number) => number;

interface World {
  readonly t: LightTables;
  readonly blocks: Uint16Array;
  readonly fluid: Uint8Array;
  /** The `LIGHT_BLOCKING` row (0 … 384) of each world column. */
  readonly lb: Int16Array;
  /** The stub's light of the inner 3 × 3. */
  readonly light: Uint8Array;
  /** Sections `setLight` marked, per column of the 3 × 3 (bit sy). */
  readonly dirty: Uint32Array;
  readonly access: RelightAccess;
}

const wi = (x: number, r: number, z: number) => (r * WX + (z + OFF)) * WX + (x + OFF);
const li = (x: number, r: number, z: number) => (r * L + z) * L + x;

function columnLb(w: Pick<World, 't' | 'blocks' | 'fluid'>, x: number, z: number): number {
  let above = AIR;
  for (let r = H - 1; r >= 0; r--) {
    const k = wi(x, r, z);
    if (fallBlocked(w.blocks[k]!, w.fluid[k]!, above, w.t)) return r + 1;
    above = w.blocks[k]!;
  }
  return 0;
}

/**
 * The reference's nine light regions (46 × 384 × 46 each), one per inner column over its own 3 × 3, sharing one queue:
 * `world` fills them and `edit` writes each edit into every region holding it, so a check runs only `lightRegion`.
 * One world is live at a time.
 */
const shared = createLightScratch();
const regions: LightScratch[] = Array.from({ length: 9 }, () => ({ region: createLightRegion(), queue: shared.queue, out: shared.out }));
const regionX0 = (c: number) => 16 * (c % 3) - 15;
const regionZ0 = (c: number) => 16 * Math.floor(c / 3) - 15;

function fillRegions(w: Pick<World, 'blocks' | 'fluid' | 'lb'>): void {
  for (let c = 0; c < 9; c++) {
    const reg = regions[c]!.region;
    const x0 = regionX0(c);
    const z0 = regionZ0(c);
    for (let r = 0; r < H; r++) {
      for (let rz = 0; rz < LIGHT_W; rz++) {
        const from = wi(x0, r, z0 + rz);
        const to = (r * LIGHT_W + rz) * LIGHT_W;
        reg.blocks.set(w.blocks.subarray(from, from + LIGHT_W), to);
        reg.fluid.set(w.fluid.subarray(from, from + LIGHT_W), to);
      }
    }
    for (let rz = 0; rz < LIGHT_W; rz++) {
      for (let rx = 0; rx < LIGHT_W; rx++) reg.lightBlocking[rz * LIGHT_W + rx] = w.lb[(z0 + rz + OFF) * WX + x0 + rx + OFF]! - 64;
    }
  }
}

/** Writes one voxel and its column's LIGHT_BLOCKING into every region holding it. */
function writeRegions(x: number, r: number, z: number, state: number, fluid: number, lb: number): void {
  for (let c = 0; c < 9; c++) {
    const rx = x - regionX0(c);
    const rz = z - regionZ0(c);
    if (rx < 0 || rx >= LIGHT_W || rz < 0 || rz >= LIGHT_W) continue;
    const reg = regions[c]!.region;
    reg.blocks[(r * LIGHT_W + rz) * LIGHT_W + rx] = state;
    reg.fluid[(r * LIGHT_W + rz) * LIGHT_W + rx] = fluid;
    reg.lightBlocking[rz * LIGHT_W + rx] = lb - 64;
  }
}

/** The reference: `lightRegion` of each inner column over its own 3 × 3, its centre copied out. */
function reference(w: World): Uint8Array {
  const out = new Uint8Array(VOXELS);
  for (let c = 0; c < 9; c++) {
    const s = regions[c]!;
    lightRegion(s, w.t, true);
    const x0 = regionX0(c) + 15;
    const z0 = regionZ0(c) + 15;
    for (let r = 0; r < H; r++) {
      for (let lz = 0; lz < 16; lz++) {
        const from = (r * LIGHT_W + lz + 15) * LIGHT_W + 15;
        out.set(s.region.light.subarray(from, from + 16), li(x0, r, z0 + lz));
      }
    }
  }
  return out;
}

function world(scene: Scene, fluidAt: Scene = () => NO_FLUID, t: LightTables = DEFAULT_LIGHT_TABLES): World {
  const blocks = new Uint16Array(WX * WX * H);
  const fluid = new Uint8Array(WX * WX * H);
  for (let r = 0; r < H; r++) {
    for (let z = -OFF; z < WX - OFF; z++) {
      for (let x = -OFF; x < WX - OFF; x++) {
        blocks[wi(x, r, z)] = scene(x, r, z);
        fluid[wi(x, r, z)] = fluidAt(x, r, z);
      }
    }
  }
  const lb = new Int16Array(WX * WX);
  const base = { t, blocks, fluid };
  for (let z = -OFF; z < WX - OFF; z++) for (let x = -OFF; x < WX - OFF; x++) lb[(z + OFF) * WX + x + OFF] = columnLb(base, x, z);
  const light = new Uint8Array(VOXELS);
  const dirty = new Uint32Array(9);
  const toWorld = (i: number) => {
    const x = i % L;
    const row = (i - x) / L;
    const z = row % L;
    return wi(x, (row - z) / L, z);
  };
  const access: RelightAccess = {
    block: (i) => blocks[toWorld(i)]!,
    fluid: (i) => fluid[toWorld(i)]!,
    light: (i) => light[i]!,
    setLight(i, v) {
      light[i] = v;
      const x = i % L;
      const row = (i - x) / L;
      const z = row % L;
      const c = (z >> 4) * 3 + (x >> 4);
      dirty[c] = dirty[c]! | (1 << ((row - z) / L >> 4));
    },
    lightBlocking: (x, z) => lb[(z + OFF) * WX + x + OFF]!,
  };
  const w: World = { t, blocks, fluid, lb, light, dirty, access };
  fillRegions(w);
  light.set(reference(w));
  return w;
}

const scratch = createRelightScratch();

/** Writes (state, fluid) at local (x, r, z) of the centre column, patches the column's LIGHT_BLOCKING and relights. */
function edit(w: World, x: number, r: number, z: number, state: number, fluid = NO_FLUID): RelightReport {
  if (x < 16 || x > 31 || z < 16 || z > 31) throw new Error(`edit (${x}, ${z}) outside the centre column`);
  const k = wi(x, r, z);
  const p = (z + OFF) * WX + x + OFF;
  const before = { state: w.blocks[k]!, fluid: w.fluid[k]!, lightBlocking: w.lb[p]! };
  w.blocks[k] = state;
  w.fluid[k] = fluid;
  w.lb[p] = columnLb(w, x, z);
  writeRegions(x, r, z, state, fluid, w.lb[p]!);
  w.dirty.fill(0);
  return relight(w.access, scratch, li(x, r, z), before, w.t);
}

/** Every voxel of the inner 3 × 3 against the reference; the first mismatch is named. */
function expectEqualsReference(w: World, what: string): void {
  const ref = reference(w);
  let bad = 0;
  let first = '';
  for (let i = 0; i < VOXELS; i++) {
    if (w.light[i] === ref[i]) continue;
    if (bad++ === 0) {
      const x = i % L;
      const row = (i - x) / L;
      const z = row % L;
      first = `(${x}, ${(row - z) / L}, ${z}): relight sky ${w.light[i]! >> 4} block ${w.light[i]! & 15}, reference sky ${ref[i]! >> 4} block ${ref[i]! & 15}`;
    }
  }
  expect(bad, `${what}: ${bad} voxels differ, first ${first}`).toBe(0);
}

const sky = (w: World, x: number, r: number, z: number) => w.light[li(x, r, z)]! >> 4;
const blk = (w: World, x: number, r: number, z: number) => w.light[li(x, r, z)]! & 15;

/** The report the changed voxels imply, from the light before and after. */
function expectedReport(before: Uint8Array, after: Uint8Array): { sections: number[]; edges: number[] } {
  const sections = new Array<number>(9).fill(0);
  const edges = new Array<number>(9).fill(0);
  for (let i = 0; i < VOXELS; i++) {
    if (before[i] === after[i]) continue;
    const x = i % L;
    const row = (i - x) / L;
    const z = row % L;
    const r = (row - z) / L;
    const c = Math.floor(z / 16) * 3 + Math.floor(x / 16);
    const lx = x % 16;
    const lz = z % 16;
    sections[c] = (sections[c]! | (1 << Math.floor(r / 16))) >>> 0;
    let e = 0;
    if (lx === 0) e |= EDGE_W;
    if (lx === 15) e |= EDGE_E;
    if (lz === 0) e |= EDGE_N;
    if (lz === 15) e |= EDGE_S;
    if (lx === 0 && lz === 0) e |= EDGE_NW;
    if (lx === 15 && lz === 0) e |= EDGE_NE;
    if (lx === 0 && lz === 15) e |= EDGE_SW;
    if (lx === 15 && lz === 15) e |= EDGE_SE;
    edges[c] = edges[c]! | e;
  }
  return { sections, edges };
}

/** Rock up to row `ground` (y = row − 64), air above. */
const rock = (ground: number): Scene => (_x, r) => (r <= ground ? STONE : AIR);

/** A closed room deep in rock: x, z 18 … 28, rows 100 … 104. */
const inRoom = (x: number, r: number, z: number) => x >= 18 && x <= 28 && z >= 18 && z <= 28 && r >= 100 && r <= 104;
const room: Scene = (x, r, z) => (inRoom(x, r, z) ? AIR : rock(160)(x, r, z));

/** A 1 × 1 tunnel along x at row 100, z 24, x 17 … 30 (the centre column's walls at x 16 and 31), a torch at x 17. */
const tunnel = (state: (x: number, r: number, z: number) => number | null = () => null): Scene => (x, r, z) => {
  const s = state(x, r, z);
  if (s !== null) return s;
  return r === 100 && z === 24 && x >= 17 && x <= 30 ? (x === 17 ? TORCH : AIR) : rock(160)(x, r, z);
};

/** The registry's tables with DIRT re-defined (OPACITY, FULL_FACES, EMIT), as `lightInitial.test.ts` injects them. */
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

describe('relight: block light (SP5a spec §2.3)', () => {
  test('a torch placed in a closed room, then removed: equals after each', () => {
    const w = world(room);
    expect(blk(w, 23, 102, 23)).toBe(0);
    edit(w, 23, 102, 23, TORCH);
    expectEqualsReference(w, 'torch placed');
    expect(blk(w, 23, 102, 23)).toBe(14);
    expect(blk(w, 28, 102, 23)).toBe(9);
    expect(blk(w, 28, 104, 28)).toBe(2);
    expect(sky(w, 23, 102, 23)).toBe(0);
    edit(w, 23, 102, 23, AIR);
    expectEqualsReference(w, 'torch removed');
    let lit = 0;
    for (let r = 100; r <= 104; r++) for (let z = 18; z <= 28; z++) for (let x = 18; x <= 28; x++) lit += w.light[li(x, r, z)]!;
    expect(lit).toBe(0);
  });

  test('a stone placed between a torch and the wall it lit, then removed', () => {
    const w = world(tunnel());
    expect([21, 29, 30].map((x) => blk(w, x, 100, 24))).toEqual([10, 2, 1]);
    edit(w, 22, 100, 24, STONE);
    expectEqualsReference(w, 'stone placed');
    expect(blk(w, 21, 100, 24)).toBe(10);
    for (let x = 22; x <= 30; x++) expect(blk(w, x, 100, 24), `x ${x}`).toBe(0);
    edit(w, 22, 100, 24, AIR);
    expectEqualsReference(w, 'stone removed');
    expect([22, 29, 30].map((x) => blk(w, x, 100, 24))).toEqual([9, 2, 1]);
  });

  test('a torch beside lava, the lava removed', () => {
    const w = world(
      (x, r, z) => (x === 22 && r === 102 && z === 23 ? TORCH : room(x, r, z)),
      (x, r, z) => (x === 23 && r === 102 && z === 23 ? LAVA_SOURCE : NO_FLUID),
    );
    expect([blk(w, 22, 102, 23), blk(w, 23, 102, 23), blk(w, 26, 102, 23)]).toEqual([14, 15, 12]);
    edit(w, 23, 102, 23, AIR, NO_FLUID);
    expectEqualsReference(w, 'lava removed');
    expect([blk(w, 22, 102, 23), blk(w, 23, 102, 23), blk(w, 26, 102, 23)]).toEqual([14, 13, 10]);
  });

  test('a waterlogged ladder placed in a torch\'s light (fluid effective opacity 1)', () => {
    const w = world((x, r, z) => (x === 23 && r === 102 && z === 23 ? TORCH : room(x, r, z)));
    expect(blk(w, 26, 102, 23)).toBe(11);
    edit(w, 26, 102, 23, LADDER, WATER_SOURCE);
    expectEqualsReference(w, 'waterlogged ladder placed');
    // Entering water costs max(1, 1), as entering air does.
    expect([blk(w, 26, 102, 23), blk(w, 27, 102, 23)]).toEqual([11, 10]);
    edit(w, 26, 102, 23, AIR);
    expectEqualsReference(w, 'ladder removed');
  });
});

describe('relight: sky light (SP5a spec §2.3)', () => {
  test('a 1 × 1 shaft of 12 blocks opened into a closed 5 × 4 × 5 room: the shaft is 15 its full height, the room lit; closed again: equals the closed state', () => {
    // Rock up to row 155; the room x, z 22 … 26, rows 140 … 143; the shaft at (24, 24), rows 144 … 155, capped at 155.
    const scene: Scene = (x, r, z) => {
      if (x >= 22 && x <= 26 && z >= 22 && z <= 26 && r >= 140 && r <= 143) return AIR;
      if (x === 24 && z === 24 && r >= 144 && r <= 154) return AIR;
      return rock(155)(x, r, z);
    };
    const w = world(scene);
    const closed = w.light.slice();
    expect(sky(w, 24, 150, 24)).toBe(0);
    expect(sky(w, 24, 156, 24)).toBe(15);
    edit(w, 24, 155, 24, AIR);
    expectEqualsReference(w, 'shaft opened');
    for (let r = 144; r <= 155; r++) expect(sky(w, 24, r, 24), `shaft row ${r}`).toBe(15);
    for (let r = 140; r <= 143; r++) expect(sky(w, 24, r, 24), `room under the shaft, row ${r}`).toBe(15);
    expect(sky(w, 22, 140, 22)).toBe(11);
    expect(sky(w, 26, 143, 24)).toBe(13);
    edit(w, 24, 155, 24, STONE);
    expectEqualsReference(w, 'shaft closed');
    let diff = 0;
    for (let i = 0; i < VOXELS; i++) if (w.light[i] !== closed[i]) diff++;
    expect(diff, 'voxels differing from the closed state').toBe(0);
  });

  test('glass and ice placed in the sky fall (ice filters by 1, glass by 0)', () => {
    // Two 1 × 1 shafts, rows 150 … 160 open to the sky, in rock up to row 160.
    const shaft = (x: number, z: number) => (x === 20 && z === 20) || (x === 27 && z === 27);
    const w = world((x, r, z) => (shaft(x, z) && r >= 150 ? AIR : rock(160)(x, r, z)));
    expect([sky(w, 20, 150, 20), sky(w, 27, 150, 27)]).toEqual([15, 15]);
    edit(w, 20, 160, 20, GLASS);
    expectEqualsReference(w, 'glass placed');
    expect(w.lb[(20 + OFF) * WX + 20 + OFF]).toBe(150);
    for (let r = 150; r <= 160; r++) expect(sky(w, 20, r, 20), `under glass, row ${r}`).toBe(15);
    edit(w, 27, 160, 27, ICE);
    expectEqualsReference(w, 'ice placed');
    expect(w.lb[(27 + OFF) * WX + 27 + OFF]).toBe(161);
    for (let r = 150; r <= 160; r++) expect(sky(w, 27, r, 27), `under ice, row ${r}`).toBe(14 - (160 - r));
    edit(w, 27, 160, 27, AIR);
    expectEqualsReference(w, 'ice removed');
    expect(sky(w, 27, 150, 27)).toBe(15);
    edit(w, 20, 160, 20, AIR);
    expectEqualsReference(w, 'glass removed');
  });

  test('an edit at y 319 with and without an open top', () => {
    // A stone ceiling at row 383 with one hole at (24, 24), a cavern under it, rock up to row 160. DIRT is injected as a
    // top slab (OPACITY 0, the up face full): the fall does not enter it, nor does the light from above y 319.
    const t = injected(0, 1 << FACE_UP, 0);
    const w = world((x, r, z) => (r === 383 ? (x === 24 && z === 24 ? AIR : STONE) : rock(160)(x, r, z)), undefined, t);
    expect([sky(w, 24, 383, 24), sky(w, 24, 200, 24), sky(w, 27, 200, 24)]).toEqual([15, 15, 12]);
    // Open top: water in the hole takes 15 − 1 from above y 319.
    edit(w, 24, 383, 24, AIR, WATER_SOURCE);
    expectEqualsReference(w, 'water at y 319');
    expect([sky(w, 24, 383, 24), sky(w, 24, 382, 24), sky(w, 24, 200, 24)]).toEqual([14, 13, 0]);
    edit(w, 24, 383, 24, AIR);
    expectEqualsReference(w, 'water removed at y 319');
    expect(sky(w, 24, 200, 24)).toBe(15);
    // Closed top: the slab's up face keeps the light from above out; the cavern goes dark.
    edit(w, 24, 383, 24, DIRT);
    expectEqualsReference(w, 'top slab at y 319');
    expect([sky(w, 24, 383, 24), sky(w, 24, 382, 24), sky(w, 27, 200, 24)]).toEqual([0, 0, 0]);
    edit(w, 24, 383, 24, AIR);
    expectEqualsReference(w, 'top slab removed at y 319');
    expect(sky(w, 27, 200, 24)).toBe(12);
  });
});

describe('relight: full faces (SP5a spec §2.3)', () => {
  test('an injected table with a partial full face blocks across it', () => {
    // DIRT with only its east face full (OPACITY 0): light enters it from the west and does not leave eastwards.
    const t = injected(0, 1 << FACE_EAST, 0);
    const w = world(tunnel(), undefined, t);
    edit(w, 22, 100, 24, DIRT);
    expectEqualsReference(w, 'east-full DIRT placed');
    expect([blk(w, 21, 100, 24), blk(w, 22, 100, 24), blk(w, 23, 100, 24), blk(w, 30, 100, 24)]).toEqual([10, 9, 0, 0]);
    edit(w, 22, 100, 24, AIR);
    expectEqualsReference(w, 'east-full DIRT removed');
    expect(blk(w, 23, 100, 24)).toBe(8);
    // A torch east of the slab, the west one removed: its light stops at the slab's full east face.
    edit(w, 22, 100, 24, DIRT);
    expectEqualsReference(w, 'east-full DIRT placed again');
    edit(w, 17, 100, 24, AIR);
    expectEqualsReference(w, 'the west torch removed');
    edit(w, 25, 100, 24, TORCH);
    expectEqualsReference(w, 'torch east of the slab');
    expect([blk(w, 23, 100, 24), blk(w, 22, 100, 24), blk(w, 21, 100, 24)]).toEqual([12, 0, 0]);
  });
});

describe('relight: the report (SP5a spec §2.3, §2.6)', () => {
  test('a torch at local (15, y, 15) of the centre column in open air: sections and edges mark the centre\'s E, S and SE edges and the E, S and SE columns', () => {
    const w = world(rock(160));
    const rep = edit(w, 31, 170, 31, TORCH);
    expectEqualsReference(w, 'torch at the corner');
    expect(rep.edges[4]).toBe(EDGE_E | EDGE_S | EDGE_SE);
    // Rows 161 … 183 (stone below): sections 10 and 11.
    expect(rep.sections[4]).toBe((1 << 10) | (1 << 11));
    for (const c of [5, 7, 8]) expect(rep.sections[c], `column ${c}`).toBe((1 << 10) | (1 << 11));
    for (const c of [0, 1, 2, 3, 6]) {
      expect(rep.sections[c], `column ${c}`).toBe(0);
      expect(rep.edges[c], `column ${c}`).toBe(0);
    }
    // The E column's changed voxels touch its W border and its S border (lz 15) and SW corner, not its E side.
    expect(rep.edges[5]).toBe(EDGE_W | EDGE_S | EDGE_SW);
    expect(rep.edges[7]).toBe(EDGE_N | EDGE_E | EDGE_NE);
    expect(rep.edges[8]).toBe(EDGE_N | EDGE_W | EDGE_NW);
  });

  test('a removal whose changed voxels stay inside the centre column 2 blocks from every border: edges of the centre 0', () => {
    // A closed room x, z 20 … 27 (column-local 4 … 11), rows 100 … 103, its torch removed.
    const w = world((x, r, z) => (x === 23 && r === 101 && z === 23 ? TORCH : x >= 20 && x <= 27 && z >= 20 && z <= 27 && r >= 100 && r <= 103 ? AIR : rock(160)(x, r, z)));
    const rep = edit(w, 23, 101, 23, AIR);
    expectEqualsReference(w, 'torch removed');
    expect(rep.edges[4]).toBe(0);
    expect(rep.sections[4]).toBe(1 << 6);
    for (const c of [0, 1, 2, 3, 5, 6, 7, 8]) expect([rep.sections[c], rep.edges[c]], `column ${c}`).toEqual([0, 0]);
  });
});

describe('relight: random edits (SP5a spec §2.3)', () => {
  test('500 random edits in the centre column of a canned 5 × 5 (seeded, stone, glass, ice, torch, wall torch, water, lava, at y 0 … 383): equals after each', () => {
    // Rolling ground near row 310, a cave (x, z 18 … 29, rows 280 … 291) with a torch and lava, a tunnel from it to
    // the west column, a pond in the SE column, and a stone over the centre column at row 383. The ground is high so
    // that the 4,500 reference `lightRegion` calls fill fewer sky voxels.
    const ground = (x: number, z: number) => 310 + (((x + 16) * 5 + (z + 16) * 3) & 7);
    const cave = (x: number, r: number, z: number) => x >= 18 && x <= 29 && z >= 18 && z <= 29 && r >= 280 && r <= 291;
    const tunnelW = (x: number, r: number, z: number) => x >= -10 && x < 18 && z === 24 && (r === 284 || r === 285);
    const pond = (x: number, r: number, z: number) => x >= 34 && x <= 40 && z >= 34 && z <= 40 && r >= 306;
    const w = world(
      (x, r, z) => {
        if (x === 20 && r === 383 && z === 20) return STONE;
        if (x === 20 && r === 281 && z === 20) return TORCH;
        if (cave(x, r, z) || tunnelW(x, r, z)) return AIR;
        if (pond(x, r, z)) return AIR;
        return r <= ground(x, z) ? STONE : AIR;
      },
      (x, r, z) => (x === 28 && r === 280 && z === 28 ? LAVA_SOURCE : pond(x, r, z) && r <= 310 ? WATER_SOURCE : NO_FLUID),
    );
    const kinds: Array<[state: number, fluid: number]> = [
      [AIR, NO_FLUID], [AIR, NO_FLUID], [STONE, NO_FLUID], [GLASS, NO_FLUID], [ICE, NO_FLUID], [TORCH, NO_FLUID],
      [WALL_TORCH, NO_FLUID], [LADDER, WATER_SOURCE], [AIR, WATER_SOURCE], [AIR, LAVA_SOURCE],
    ];
    const next = testRng(0x5A5A);
    const rows = new Set<number>();
    for (let n = 0; n < 500; n++) {
      const x = 16 + (next() % 16);
      const z = 16 + (next() % 16);
      const pick = next() % 20;
      const r = pick < 5 ? next() % H : pick < 7 ? 383 - (next() % 2) : 275 + (next() % 60);
      rows.add(r);
      const [state, fluid] = kinds[next() % kinds.length]!;
      const before = w.light.slice();
      const rep = edit(w, x, r, z, state, fluid);
      expectEqualsReference(w, `edit ${n}: (${x}, ${r}, ${z}) state ${state} fluid ${fluid}`);
      const want = expectedReport(before, w.light);
      expect({ sections: [...rep.sections], edges: [...rep.edges] }, `edit ${n}'s report`).toEqual(want);
      for (let c = 0; c < 9; c++) expect(rep.sections[c]! & ~w.dirty[c]!, `edit ${n}: a reported section setLight never wrote`).toBe(0);
    }
    expect(rows.has(383)).toBe(true);
  }, 120_000);
});

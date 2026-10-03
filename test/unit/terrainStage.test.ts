import { describe, expect, test } from 'vitest';
import {
  buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, readLevel, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, COLLIDE, STONE } from '../../src/world/blocks/index';
import type { AuxBView, AuxView, ColumnView, ColumnWriter } from '../../src/world/store/api';
import { protoAt, REC_AUX_B } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;

/**
 * Columns of world seed '42' (default profile) found by a scan: every position of LAND is dry, every position of
 * SEA is open ocean, LAKE lies inside one lake, RIVER crosses a wet river channel next to dry land, COAST mixes sea
 * and land. The category tests below re-derive the categories, so a world change fails loudly here.
 */
const LAND = [-1963, -2000] as const;
const SEA = [-2000, -2000] as const;
const LAKE = [-1001, -2000] as const;
const RIVER = [-742, -2000] as const;
const COAST = [-1667, -2000] as const;

type Kind = 'land' | 'sea' | 'lake' | 'river';

interface Expected { top: Int32Array; swl: Float64Array; kinds: Kind[]; biome: Uint8Array }

/** The §4 inputs per position `lz·16 + lx`, read from the ColumnSample independently of the stage. */
function expectedOf(ctx: GenContext, cx: number, cz: number): Expected {
  const s: ColumnSample = buildColumnSample(ctx, cx, cz, newColumnSample());
  const top = new Int32Array(256);
  const swl = new Float64Array(256);
  const biome = new Uint8Array(256);
  const kinds: Kind[] = [];
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = 16 * cx + lx;
      const z = 16 * cz + lz;
      const p = lz * 16 + lx;
      top[p] = Math.floor(readField(s, 'surfaceEst', x, z));
      swl[p] = readLevel(s, 'surfaceWaterLevel', x, z);
      biome[p] = readBiome(s, ctx, x, z);
      // The nearest quart corner, as readLevel picks it.
      const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
      const wet = (s.flags[k]! & 1) !== 0;
      if (swl[p] === -Infinity) kinds.push('land');
      else if (s.f.lakeMask[k] === 1) kinds.push('lake');
      else if (wet) kinds.push('river');
      else kinds.push('sea');
    }
  }
  return { top, swl, kinds, biome };
}

/** §4's fill rule. */
const blockAt = (top: number, y: number): number => (y === -64 ? BEDROCK : y <= top ? STONE : AIR);
const fluidAt = (top: number, swl: number, y: number): number => (y !== -64 && y > top && y <= swl ? WATER_SOURCE : 0);

function generate(ctx: GenContext, cx: number, cz: number, store: VoxelStore = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB })): { store: VoxelStore; view: ColumnView } {
  const w = store.claimColumn(cx, cz, 0);
  expect(terrainStage(ctx, cx, cz, w, NEVER)).toBe(true);
  w.commit(1);
  return { store, view: store.proto(cx, cz)! };
}

const ctx = ctxFor('42');

describe('fill rule (§4)', () => {
  test.each([
    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST],
  ] as const)('%s column: every voxel follows the rule', (_name, [cx, cz]) => {
    const e = expectedOf(ctx, cx, cz);
    const { view } = generate(ctx, cx, cz);
    let bad = 0;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const p = lz * 16 + lx;
        for (let y = -64; y <= 319; y++) {
          if (view.block(lx, y, lz) !== blockAt(e.top[p]!, y) || view.fluid(lx, y, lz) !== fluidAt(e.top[p]!, e.swl[p]!, y)) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  test('land: dry everywhere, stone up to ⌊surfaceEst⌋, air above', () => {
    const [cx, cz] = LAND;
    const e = expectedOf(ctx, cx, cz);
    expect(new Set(e.kinds)).toEqual(new Set(['land']));
    const { view } = generate(ctx, cx, cz);
    for (const p of [0, 17, 255]) {
      const lx = p & 15, lz = p >> 4, t = e.top[p]!;
      expect([view.block(lx, -64, lz), view.block(lx, t, lz), view.block(lx, t + 1, lz)]).toEqual([BEDROCK, STONE, AIR]);
      expect(view.fluid(lx, t + 1, lz)).toBe(0);
    }
  });

  test('sea: water sources from ⌊surfaceEst⌋ + 1 up to sea level 63, air above', () => {
    const [cx, cz] = SEA;
    const e = expectedOf(ctx, cx, cz);
    expect(new Set(e.kinds)).toEqual(new Set(['sea']));
    const { view } = generate(ctx, cx, cz);
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4, t = e.top[p]!;
      expect(e.swl[p]).toBe(63);
      expect(t).toBeLessThan(63);
      expect([view.block(lx, t, lz), view.fluid(lx, t, lz)]).toEqual([t === -64 ? BEDROCK : STONE, 0]);
      expect([view.block(lx, t + 1, lz), view.fluid(lx, t + 1, lz)]).toEqual([AIR, WATER_SOURCE]);
      expect([view.block(lx, 63, lz), view.fluid(lx, 63, lz)]).toEqual([AIR, WATER_SOURCE]);
      expect([view.block(lx, 64, lz), view.fluid(lx, 64, lz)]).toEqual([AIR, 0]);
    }
  });

  test('lake: water up to the lake level (not sea level), dry land outside', () => {
    const [cx, cz] = LAKE;
    const e = expectedOf(ctx, cx, cz);
    expect(e.kinds.every((k) => k === 'lake')).toBe(true);
    const { view } = generate(ctx, cx, cz);
    let wetCells = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4, t = e.top[p]!, w = Math.floor(e.swl[p]!);
      expect(w).not.toBe(63);
      if (w <= t) continue;
      wetCells++;
      expect(view.fluid(lx, w, lz)).toBe(WATER_SOURCE);
      expect(view.fluid(lx, w + 1, lz)).toBe(0);
    }
    expect(wetCells).toBeGreaterThan(0);
  });

  test('river: wet channel positions hold water up to 63, beside dry land', () => {
    const [cx, cz] = RIVER;
    const e = expectedOf(ctx, cx, cz);
    expect(e.kinds).toContain('land');
    const { view } = generate(ctx, cx, cz);
    let channel = 0;
    for (let p = 0; p < 256; p++) {
      if (e.kinds[p] !== 'river' || e.top[p]! >= 63) continue;
      channel++;
      const lx = p & 15, lz = p >> 4;
      expect([view.fluid(lx, 63, lz), view.fluid(lx, 64, lz), view.fluid(lx, e.top[p]!, lz)]).toEqual([WATER_SOURCE, 0, 0]);
    }
    expect(channel).toBeGreaterThan(0);
  });
});

describe('aux A (§3.4, §4)', () => {
  test.each([
    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST],
  ] as const)('%s: heightmaps by the §3.4 predicates, surfaceBiome = the zoomed biome, other fields 0', (_name, [cx, cz]) => {
    const e = expectedOf(ctx, cx, cz);
    const { store, view } = generate(ctx, cx, cz);
    const aux = view.aux()!;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      let ws = -64, of = -64;
      for (let y = 319; y >= -64 && (ws === -64 || of === -64); y--) {
        const b = view.block(lx, y, lz);
        if (ws === -64 && (b !== AIR || fluidType(view.fluid(lx, y, lz)) !== 0)) ws = y + 1;
        if (of === -64 && COLLIDE[b] !== 0) of = y + 1;
      }
      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([ws, of]);
      // §4: land both ⌊surfaceEst⌋ + 1; under water the top water y + 1 and ⌊surfaceEst⌋ + 1.
      const t = e.top[p]!;
      const wet = Math.floor(e.swl[p]!) > t;
      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([wet ? Math.floor(e.swl[p]!) + 1 : t + 1, t + 1]);
      expect(aux.surfaceBiome[p]).toBe(e.biome[p]);
    }
    for (const f of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking', 'tintTH'] as const) {
      expect(aux[f].every((v) => v === 0)).toBe(true);
    }
    expect(store.table.ints[store.table.find(cx, cz) + REC_AUX_B]).toBe(-1);
  });
});

describe('sections (§4: each channel uniform or dense)', () => {
  test.each([
    ['land', LAND], ['sea', SEA], ['lake', LAKE], ['coast', COAST],
  ] as const)('%s: a channel is uniform exactly when all its 4096 values are equal', (_name, [cx, cz]) => {
    const e = expectedOf(ctx, cx, cz);
    const { store } = generate(ctx, cx, cz);
    const base = store.table.find(cx, cz);
    const ints = store.table.ints;
    let uniformBlocks = 0, uniformFluid = 0;
    for (let sy = 0; sy < 24; sy++) {
      const blocks = new Set<number>();
      const fluid = new Set<number>();
      for (let ly = 0; ly < 16; ly++) {
        const y = -64 + 16 * sy + ly;
        for (let p = 0; p < 256; p++) {
          blocks.add(blockAt(e.top[p]!, y));
          fluid.add(fluidAt(e.top[p]!, e.swl[p]!, y));
        }
      }
      const b = ints[protoAt(base, sy) + PROTO_BLOCKS]!;
      const f = ints[protoAt(base, sy) + PROTO_FLUID]!;
      if (blocks.size === 1) { uniformBlocks++; expect(b).toBe(-1 - [...blocks][0]!); } else expect(b).toBeGreaterThanOrEqual(0);
      if (fluid.size === 1) { uniformFluid++; expect(f).toBe(-1 - [...fluid][0]!); } else expect(f).toBeGreaterThanOrEqual(0);
    }
    // Section 0 holds bedrock and stone (dense); the top section is uniform air without fluid.
    expect(ints[protoAt(base, 0) + PROTO_BLOCKS]).toBeGreaterThanOrEqual(0);
    expect([ints[protoAt(base, 23) + PROTO_BLOCKS], ints[protoAt(base, 23) + PROTO_FLUID]]).toEqual([-1, -1]);
    expect(uniformBlocks).toBeGreaterThan(10);
    expect(uniformFluid).toBeGreaterThan(10);
  });

  test('a full stone section costs no slot (uniform stone, −1 − STONE)', () => {
    const [cx, cz] = LAND;
    const { store } = generate(ctx, cx, cz);
    expect(store.table.ints[protoAt(store.table.find(cx, cz), 1) + PROTO_BLOCKS]).toBe(-1 - STONE);
  });

  test('a full water section of the deep sea costs no slot (air, uniform fluid −1 − WATER_SOURCE)', () => {
    const [cx, cz] = SEA;
    const { store } = generate(ctx, cx, cz);
    const at = protoAt(store.table.find(cx, cz), 7);
    expect([store.table.ints[at + PROTO_BLOCKS], store.table.ints[at + PROTO_FLUID]]).toEqual([-1 - AIR, -1 - WATER_SOURCE]);
  });
});

/** A writer that records the calls (no store). */
function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; commits: number } {
  const log = { sections: [] as number[], aux: 0, commits: 0 };
  const auxView: AuxView = {
    worldSurfaceWG: new Int16Array(256), oceanFloorWG: new Int16Array(256), worldSurface: new Int16Array(256),
    motionBlocking: new Int16Array(256), oceanFloor: new Int16Array(256), lightBlocking: new Int16Array(256),
    surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
  };
  const w: ColumnWriter = {
    cx: 0, cz: 0,
    setProto(sy, blocks, fluid) {
      expect([blocks.length, fluid.length]).toEqual([4096, 4096]);
      log.sections.push(sy);
    },
    setFinal() { throw new Error('the T stage writes no final set'); },
    shareFinal() { throw new Error('the T stage writes no final set'); },
    aux() { log.aux++; return auxView; },
    auxB(): AuxBView { throw new Error('SP3a allocates no aux B'); },
    commit() { log.commits++; },
  };
  return { w, get sections() { return log.sections; }, get aux() { return log.aux; }, get commits() { return log.commits; } };
}

describe('order and abort (§4)', () => {
  test('sections 0 … 23 in order, stop polled once before each, then aux; the stage never commits', () => {
    const spy = spyWriter();
    let polls = 0;
    expect(terrainStage(ctx, 3, -2, spy.w, () => { polls++; return false; })).toBe(true);
    expect(spy.sections).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(polls).toBe(24);
    expect([spy.aux, spy.commits]).toEqual([1, 0]);
  });

  test.each([0, 1, 7, 23])('stop true before section %i: returns false at once, no aux, no commit', (k) => {
    const spy = spyWriter();
    let polls = 0;
    expect(terrainStage(ctx, 3, -2, spy.w, () => ++polls > k)).toBe(false);
    expect(spy.sections).toEqual(Array.from({ length: k }, (_, i) => i));
    expect(polls).toBe(k + 1);
    expect([spy.aux, spy.commits]).toEqual([0, 0]);
  });

  test('deterministic: the same column twice gives the same voxels and aux', () => {
    const a = generate(ctx, ...COAST).view;
    const b = generate(ctx, ...COAST).view;
    for (let sy = 0; sy < 24; sy++) {
      expect(a.sectionBlocks(sy)).toEqual(b.sectionBlocks(sy));
      expect(a.sectionFluid(sy)).toEqual(b.sectionFluid(sy));
    }
    expect(Array.from(a.aux()!.worldSurfaceWG)).toEqual(Array.from(b.aux()!.worldSurfaceWG));
  });
});

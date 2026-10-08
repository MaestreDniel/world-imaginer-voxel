import { describe, expect, test } from 'vitest';
import type { ParamsPatch } from '../../src/core/params/schema';
import {
  buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, readLevel, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { terrainDensityDebug, terrainStage } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, type SurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbe } from '../../src/gen/surface/probe';
import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, COLLIDE, DEEPSLATE, REGISTRY, STONE } from '../../src/world/blocks/index';
import type { AuxBView, AuxView, ColumnView, ColumnWriter } from '../../src/world/store/api';
import { protoAt, REC_AUX_B } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;

/**
 * Columns of world seed '42' (default profile) on the row cz −2000, found by scans: LAND is dry land, SEA open ocean,
 * LAKE inside one lake, RIVER crosses a wet river channel, COAST mixes sea and land (SP3a's fixtures); OVERHANG holds
 * water under stone near the water line and WALL water walls (§4) on the real T. The tests below re-derive what they
 * rely on, so a world change fails loudly here.
 */
const LAND = [-1963, -2000] as const;
const SEA = [-2000, -2000] as const;
const LAKE = [-1001, -2000] as const;
const RIVER = [-742, -2000] as const;
const COAST = [-1667, -2000] as const;
const OVERHANG = [-1238, -2000] as const;
const WALL = [-1689, -2000] as const;
const FIXTURES = [['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST], ['overhang', OVERHANG], ['wall', WALL]] as const;

/** A shape spline that is `y` everywhere. */
const flat = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });

const ctx = ctxFor('42');
/** An extreme but valid shape (σ 40 everywhere): enclosed air far below the water line under the sea. */
const ctx40 = ctxFor('42', { shape: { sigma: flat(40) } });
/** §3.2: σ and jag splines at 0, both detail amplitudes at 0. */
const REDUCED: ParamsPatch = { shape: { sigma: flat(0), jag: flat(0) }, density: { detailAmpLo: 0, detailAmpHi: 0 } };
const ctxReduced = ctxFor('42', REDUCED);

const DCS = new Map<GenContext, DensityContext>();
const dcOf = (c: GenContext): DensityContext => {
  let dc = DCS.get(c);
  if (dc === undefined) DCS.set(c, (dc = createDensityContext(c)));
  return dc;
};
/** A SurfaceContext built apart from the stage's (its own DensityContext, compiled tree and reference evaluator). */
const SCS = new Map<GenContext, SurfaceContext>();
const scOf = (c: GenContext): SurfaceContext => {
  let sc = SCS.get(c);
  if (sc === undefined) SCS.set(c, (sc = createSurfaceContext(c)));
  return sc;
};

/** Voxel index `((y + 64)·16 + lz)·16 + lx`. */
const vi = (lx: number, y: number, lz: number): number => ((y + 64) * 16 + lz) * 16 + lx;

interface Expected {
  readonly s: ColumnSample;
  readonly blocks: Uint16Array;
  readonly fluid: Uint8Array;
  /** Per position `lz·16 + lx`: the highest stone y (−64 when none), and surfaceWaterLevel (nearest corner). */
  readonly top: Int32Array;
  readonly swl: Float64Array;
}

/**
 * SP3b §4 and SP3c §1 independently of the stage: solidity from the density probe (no early-outs), `top` and the
 * water v0 rule; each solid voxel's state from `surfaceProbe` on a SurfaceContext built apart (the reference
 * evaluator, never the fast path; it rebuilds the column with its own early-outs, so a solidity disagreement shows as
 * air).
 */
function expectedOf(c: GenContext, cx: number, cz: number): Expected {
  const dc = dcOf(c);
  const sc = scOf(c);
  const s = buildColumnSample(c, cx, cz, newColumnSample());
  const blocks = new Uint16Array(98304);
  const fluid = new Uint8Array(98304);
  const top = new Int32Array(256).fill(-64);
  const swl = new Float64Array(256);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = 16 * cx + lx;
      const z = 16 * cz + lz;
      blocks[vi(lx, -64, lz)] = BEDROCK;
      for (let y = -63; y <= 319; y++) {
        const solid = probe(dc, x, y, z) > 0;
        blocks[vi(lx, y, lz)] = solid ? surfaceProbe(sc, x, y, z).state : AIR;
        if (solid) top[lz * 16 + lx] = y;
      }
      swl[lz * 16 + lx] = readLevel(s, 'surfaceWaterLevel', x, z);
    }
  }
  for (let p = 0; p < 256; p++) {
    for (let y = -63; y <= 319; y++) {
      const i = vi(p & 15, y, p >> 4);
      if (blocks[i] === AIR && y > top[p]! - 12 && y <= swl[p]!) fluid[i] = WATER_SOURCE;
    }
  }
  return { s, blocks, fluid, top, swl };
}

function generate(c: GenContext, cx: number, cz: number, store: VoxelStore = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB })): { store: VoxelStore; view: ColumnView } {
  const w = store.claimColumn(cx, cz, 0);
  expect(terrainStage(c, cx, cz, w, NEVER)).toBe(true);
  w.commit(1);
  return { store, view: store.proto(cx, cz)! };
}

/** Voxels where the view differs from the expected blocks or fluid. */
function mismatches(view: ColumnView, e: Expected): number {
  let bad = 0;
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      for (let y = -64; y <= 319; y++) {
        const i = vi(lx, y, lz);
        if (view.block(lx, y, lz) !== e.blocks[i] || view.fluid(lx, y, lz) !== e.fluid[i]) bad++;
      }
    }
  }
  return bad;
}

const EXPECTED = new Map<string, Expected>();
const expectedFor = (c: GenContext, [cx, cz]: readonly [number, number]): Expected => {
  const key = `${c === ctx ? 'd' : c === ctx40 ? 's40' : 'r'}|${cx}|${cz}`;
  let e = EXPECTED.get(key);
  if (e === undefined) EXPECTED.set(key, (e = expectedOf(c, cx, cz)));
  return e;
};

describe('fill and water v0 (§4), surface (SP3c §1)', () => {
  test.each(FIXTURES)('%s: every voxel is bedrock at −64, solid ⇔ density > 0 with surfaceProbe\'s state, water by the v0 rule', (_name, col) => {
    const e = expectedFor(ctx, col);
    expect(mismatches(generate(ctx, col[0], col[1]).view, e)).toBe(0);
  });

  test('the fixtures are surfaced: stone, deepslate and more than one other palette state; never a non-solid state', () => {
    const seen = new Set<number>();
    for (const [, [cx, cz]] of FIXTURES) {
      const v = generate(ctx, cx, cz).view;
      for (let y = -63; y <= 319; y++) {
        for (let p = 0; p < 256; p++) seen.add(v.block(p & 15, y, p >> 4));
      }
    }
    expect(seen.has(STONE) && seen.has(DEEPSLATE) && seen.has(BEDROCK)).toBe(true);
    const others = [...seen].filter((b) => b !== AIR && b !== STONE && b !== DEEPSLATE && b !== BEDROCK);
    expect(others.length).toBeGreaterThan(3);
    for (const b of others) expect(COLLIDE[b], REGISTRY.stateKey(b)).not.toBe(0);
  });

  test('σ 40 world: the sea and coast columns follow the rule too', () => {
    for (const col of [SEA, COAST, OVERHANG]) expect(mismatches(generate(ctx40, col[0], col[1]).view, expectedFor(ctx40, col))).toBe(0);
  });

  test('the world\'s vertical ends: stone up to y 319 (offset 320, σ 64, jag 128) and a sea down to the floor (offset −64, σ 64) follow the rule, with their heightmaps', () => {
    const ceiling = ctxFor('42', { shape: { offset: flat(320), sigma: flat(64), jag: flat(128) } });
    const floor = ctxFor('42', { shape: { offset: flat(-64), sigma: flat(64) } });
    let at319 = 0, deepWater = 0;
    for (const [c, [cx, cz]] of [[ceiling, LAND], [ceiling, SEA], [floor, LAND], [floor, SEA]] as const) {
      const e = expectedOf(c, cx, cz);
      const { view } = generate(c, cx, cz);
      expect(mismatches(view, e)).toBe(0);
      const aux = view.aux()!;
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        // WORLD_SURFACE_WG: above the highest non-air or water voxel (320 when it is stone at y 319); OCEAN_FLOOR_WG:
        // above the highest stone (−63: the bedrock, when none).
        let surface = -64;
        for (let y = 319; y > -64; y--) {
          if (e.blocks[vi(lx, y, lz)] !== AIR || e.fluid[vi(lx, y, lz)] !== 0) { surface = y; break; }
        }
        expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([surface + 1, e.top[p]! + 1]);
        if (e.top[p] === 319) at319++;
        for (let y = -63; y <= -40; y++) if (e.fluid[vi(lx, y, lz)] !== 0) deepWater++;
      }
    }
    // Both ends are reached: stone in the top row (no row above it to clip), and water within 24 blocks of the bedrock.
    expect(at319).toBeGreaterThan(64);
    expect(deepWater).toBeGreaterThan(256);
  });

  /**
   * Surface params at their schema ends (the ?map panel's sliders, a URL): SD_MAX from 3 (depthMul 0) to 47 (depthMul 2
   * × depth clampSigma 8), fractional clampSigma, every snow, cliff and patch knob at an end. The stage (compiled tree,
   * fast path with maxSurfaceDepth = SD_MAX + 4) must still equal surfaceProbe's reference walk at every voxel.
   */
  const SURFACE_ENDS: ReadonlyArray<readonly [string, ParamsPatch, number]> = [
    ['depthMul 0 (SD_MAX 3)', { surface: { depthMul: 0 } }, 3],
    ['depthMul 2, depth clampSigma 8 (SD_MAX 47)', { surface: { depthMul: 2, noises: { depth: { clampSigma: 8 } } } }, 47],
    ['depthMul 1.35, depth clampSigma 6.7 (SD_MAX 28)', { surface: { depthMul: 1.35, noises: { depth: { clampSigma: 6.7 } } } }, 28],
    ['lapse 0.05 from y −64, cliffSteep 0 from y −64, patchThreshold 0, snowline 1', { surface: { lapse: 0.05, lapseBase: -64, cliffSteep: 0, cliffMinY: -64, patchThreshold: 0, snowline: 1 } }, 11],
    ['lapse 0, patchThreshold 3, snowline −1, cliffSteep 8 from y 319', { surface: { lapse: 0, patchThreshold: 3, snowline: -1, cliffSteep: 8, cliffMinY: 319 } }, 11],
  ];
  /**
   * Columns where the depth noise peaks (z up to ≈ 2.9; found by a scan of the row cz −2010 at depthMul 2): DEEP
   * (windswept_hills, 822 dirt voxels more than 15 below their top) and DEEP_BED (a frozen_river bed: sand and clay
   * more than 15 below it). At depthMul 2 their skins go deeper than the default fast path's maxSurfaceDepth 15.
   */
  const DEEP = [-1916, -2010] as const;
  const DEEP_BED = [-2031, -2010] as const;
  test.each(SURFACE_ENDS)('surface params at their ends, %s: land, sea, lake, river and deep-skin columns equal the probe at every voxel', (_name, patch, sdMax) => {
    const c = ctxFor('42', patch);
    const sc = scOf(c);
    expect(sc.settings.sdMax).toBe(sdMax);
    expect(sc.compiled.fastPath?.maxSurfaceDepth).toBe(sdMax + 4);
    let deepSkin = 0;
    for (const [cx, cz] of [LAND, SEA, LAKE, RIVER, DEEP, DEEP_BED]) {
      const e = expectedOf(c, cx, cz);
      expect(mismatches(generate(c, cx, cz).view, e), `(${cx}, ${cz})`).toBe(0);
      // Skin blocks (neither stone, deepslate nor bedrock) more than the default's 15 below a sky-open top.
      for (let p = 0; p < 256; p++) {
        for (let y = e.top[p]! - 16; y >= Math.max(-63, e.top[p]! - sdMax - 4); y--) {
          const b = e.blocks[vi(p & 15, y, p >> 4)]!;
          if (b === AIR) break;
          if (b !== STONE && b !== DEEPSLATE && b !== BEDROCK) deepSkin++;
        }
      }
    }
    // At depthMul 2 deep skins exist where the default's fast path (maxSurfaceDepth 15) would cut them.
    if (patch.surface?.depthMul === 2) expect(deepSkin).toBeGreaterThan(800);
    else if (sdMax <= 11) expect(deepSkin).toBe(0);
  });

  test('air under an overhang near the water line fills', () => {
    const e = expectedFor(ctx, OVERHANG);
    const { view } = generate(ctx, ...OVERHANG);
    let under = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y < e.top[p]!; y++) {
        if (view.fluid(lx, y, lz) === 0) continue;
        under++;
        // Stone above it in its own position, and within 12 of the top.
        expect(view.block(lx, y, lz)).toBe(AIR);
        expect(y).toBeGreaterThan(e.top[p]! - 12);
      }
    }
    expect(under).toBeGreaterThan(0);
  });

  test('deeper enclosed air stays dry (σ 40 sea): air at y ≤ top − 12 below the water level holds no water', () => {
    const e = expectedFor(ctx40, SEA);
    const { view } = generate(ctx40, ...SEA);
    let pockets = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= e.top[p]! - 12; y++) {
        if (view.block(lx, y, lz) !== AIR || y > e.swl[p]!) continue;
        pockets++;
        expect(view.fluid(lx, y, lz)).toBe(0);
      }
    }
    expect(pockets).toBeGreaterThan(0);
  });

  test('water walls: water beside a dry position whose own level is −∞ and whose top is below the water', () => {
    const e = expectedFor(ctx, WALL);
    const { view } = generate(ctx, ...WALL);
    let walls = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= 319; y++) {
        if (view.fluid(lx, y, lz) === 0) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = lx + dx, nz = lz + dz;
          if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
          const q = nz * 16 + nx;
          if (view.block(nx, y, nz) === AIR && view.fluid(nx, y, nz) === 0 && e.swl[q] === -Infinity && e.top[q]! < y) walls++;
        }
      }
    }
    expect(walls).toBeGreaterThan(0);
  });
});

describe('reduction to SP3a (§3.2)', () => {
  test.each([['land', LAND], ['sea', SEA], ['lake', LAKE], ['coast', COAST], ['overhang', OVERHANG]] as const)(
    '%s: with σ, jag and detail at 0 the column\'s solidity is SP3a\'s y ≤ ⌊surfaceEst⌋ fill', (_name, [cx, cz]) => {
      const s = buildColumnSample(ctxReduced, cx, cz, newColumnSample());
      // Away from river channels (rivers hard-code σ 0.5 there): every corner column's σ and jag is 0.
      for (let j = 0; j <= 4; j++) {
        for (let i = 0; i <= 4; i++) expect([s.f.sigma[latticeIndex(i, j)], s.f.jag[latticeIndex(i, j)]]).toEqual([0, 0]);
      }
      const { view } = generate(ctxReduced, cx, cz);
      let nearInteger = 0;
      let bad = 0;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const est = readField(s, 'surfaceEst', 16 * cx + lx, 16 * cz + lz);
          if (Math.abs(est - Math.round(est)) < 1e-9) { nearInteger++; continue; }
          const top = Math.floor(est);
          const swl = readLevel(s, 'surfaceWaterLevel', 16 * cx + lx, 16 * cz + lz);
          for (let y = -64; y <= 319; y++) {
            // Solidity only: the surface pass gives the solid voxels their palette states.
            const b = view.block(lx, y, lz);
            const solid = y === -64 ? b === BEDROCK : (b !== AIR) === (y <= top);
            const fluid = y !== -64 && y > top && y <= swl ? WATER_SOURCE : 0;
            if (!solid || view.fluid(lx, y, lz) !== fluid) bad++;
          }
        }
      }
      expect([nearInteger, bad]).toEqual([0, 0]);
    });
});

describe('aux A (SP3a §3.4, §4)', () => {
  test.each(FIXTURES)('%s: heightmaps by the §3.4 predicates, surfaceBiome = the zoomed biome, other fields 0', (_name, [cx, cz]) => {
    const e = expectedFor(ctx, [cx, cz]);
    const { view } = generate(ctx, cx, cz);
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
      expect(aux.oceanFloorWG[p]).toBe(e.top[p]! + 1);
      expect(aux.surfaceBiome[p]).toBe(readBiome(e.s, ctx, 16 * cx + lx, 16 * cz + lz));
    }
    for (const f of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking', 'tintTH'] as const) {
      expect(aux[f].every((v) => v === 0)).toBe(true);
    }
  });
});

describe('aux B (§4)', () => {
  test('surfaceBiomeQ[qz·4 + qx] is lattice point (qx, qz)\'s 2D biome; caveBiomeQ and the rest of the slot are 0', () => {
    let asymmetric = 0;
    for (const [, [cx, cz]] of FIXTURES) {
      const { store, view } = generate(ctx, cx, cz);
      expect(store.table.ints[store.table.find(cx, cz) + REC_AUX_B]).toBeGreaterThanOrEqual(0);
      const b = view.auxB()!;
      const s = buildColumnSample(ctx, cx, cz, newColumnSample());
      for (let qz = 0; qz < 4; qz++) {
        for (let qx = 0; qx < 4; qx++) {
          expect(b.surfaceBiomeQ[qz * 4 + qx]).toBe(s.biome[latticeIndex(qx, qz)]);
          if (s.biome[latticeIndex(qx, qz)] !== s.biome[latticeIndex(qz, qx)]) asymmetric++;
        }
      }
      const slot = new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096);
      let nonZero = 0;
      for (let i = 0; i < 4096; i++) if ((i < 1536 || i >= 1552) && slot[i] !== 0) nonZero++;
      expect(nonZero).toBe(0);
    }
    // Some fixture's quarts are not symmetric, so the test pins qz·4 + qx against qx·4 + qz.
    expect(asymmetric).toBeGreaterThan(0);
  });
});

describe('sections (§4: each channel uniform or dense)', () => {
  test.each(FIXTURES)('%s: a channel is uniform exactly when all its 4096 values are equal', (_name, col) => {
    const e = expectedFor(ctx, col);
    const { store } = generate(ctx, col[0], col[1]);
    const base = store.table.find(col[0], col[1]);
    const ints = store.table.ints;
    for (let sy = 0; sy < 24; sy++) {
      const blocks = new Set(e.blocks.subarray(4096 * sy, 4096 * (sy + 1)));
      const fluid = new Set(e.fluid.subarray(4096 * sy, 4096 * (sy + 1)));
      const b = ints[protoAt(base, sy) + PROTO_BLOCKS]!;
      const f = ints[protoAt(base, sy) + PROTO_FLUID]!;
      if (blocks.size === 1) expect(b).toBe(-1 - [...blocks][0]!); else expect(b).toBeGreaterThanOrEqual(0);
      if (fluid.size === 1) expect(f).toBe(-1 - [...fluid][0]!); else expect(f).toBeGreaterThanOrEqual(0);
    }
    // Section 0 holds bedrock and deepslate (dense); the top section is uniform air without fluid.
    expect(ints[protoAt(base, 0) + PROTO_BLOCKS]).toBeGreaterThanOrEqual(0);
    expect([ints[protoAt(base, 23) + PROTO_BLOCKS], ints[protoAt(base, 23) + PROTO_FLUID]]).toEqual([-1, -1]);
  });

  test('a full deepslate section (y −48 … −33, far below the land top: Decision 6) and a full water section of the deep sea cost no slot', () => {
    const land = generate(ctx, ...LAND).store;
    expect(land.table.ints[protoAt(land.table.find(...LAND), 1) + PROTO_BLOCKS]).toBe(-1 - DEEPSLATE);
    const sea = generate(ctx, ...SEA).store;
    const at = protoAt(sea.table.find(...SEA), 7);
    expect([sea.table.ints[at + PROTO_BLOCKS], sea.table.ints[at + PROTO_FLUID]]).toEqual([-1 - AIR, -1 - WATER_SOURCE]);
  });
});

/** A writer that records the calls (no store). */
function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; auxB: number; commits: number } {
  const log = { sections: [] as number[], aux: 0, auxB: 0, commits: 0 };
  const auxView: AuxView = {
    worldSurfaceWG: new Int16Array(256), oceanFloorWG: new Int16Array(256), worldSurface: new Int16Array(256),
    motionBlocking: new Int16Array(256), oceanFloor: new Int16Array(256), lightBlocking: new Int16Array(256),
    surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
  };
  const auxBView: AuxBView = { caveBiomeQ: new Uint8Array(1536), surfaceBiomeQ: new Uint8Array(16) };
  const w: ColumnWriter = {
    cx: 0, cz: 0,
    setProto(sy, blocks, fluid) {
      expect([blocks.length, fluid.length]).toEqual([4096, 4096]);
      log.sections.push(sy);
    },
    setFinal() { throw new Error('the T stage writes no final set'); },
    shareFinal() { throw new Error('the T stage writes no final set'); },
    aux() { log.aux++; return auxView; },
    auxB() { log.auxB++; return auxBView; },
    commit() { log.commits++; },
  };
  return {
    w, get sections() { return log.sections; }, get aux() { return log.aux; }, get auxB() { return log.auxB; },
    get commits() { return log.commits; },
  };
}

describe('order and abort (§4, SP3c §1)', () => {
  test('6 density polls, 1 before the surface pass, then sections 0 … 23 in order with a poll before each, then aux A and aux B; never commits', () => {
    const spy = spyWriter();
    const at: number[] = [];
    expect(terrainStage(ctx, 3, -2, spy.w, () => { at.push(spy.sections.length); return false; })).toBe(true);
    expect(spy.sections).toEqual(Array.from({ length: 24 }, (_, i) => i));
    // No section is written during the density phase or the surface pass: the first 8 polls see none.
    expect(at).toEqual([0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 24 }, (_, i) => i)]);
    expect([spy.aux, spy.auxB, spy.commits]).toEqual([1, 1, 0]);
  });

  test.each([0, 1, 5, 6, 7, 8, 14, 30])('stop true at poll %i: returns false at once, no aux, no commit', (k) => {
    const spy = spyWriter();
    let polls = 0;
    expect(terrainStage(ctx, 3, -2, spy.w, () => ++polls > k)).toBe(false);
    expect(spy.sections).toEqual(Array.from({ length: Math.max(0, k - 7) }, (_, i) => i));
    expect(polls).toBe(k + 1);
    expect([spy.aux, spy.auxB, spy.commits]).toEqual([0, 0, 0]);
  });

  test('a stop in the density phase or at the surface pass leaves no trace: the next column is generated as if alone', () => {
    for (const k of [3, 6]) {
      let polls = 0;
      expect(terrainStage(ctx, ...OVERHANG, spyWriter().w, () => ++polls > k)).toBe(false);
      expect(mismatches(generate(ctx, ...COAST).view, expectedFor(ctx, COAST))).toBe(0);
    }
  });

  test('deterministic, and one SurfaceContext per GenContext: interleaved contexts do not disturb each other', () => {
    const a = generate(ctx, ...COAST).view;
    const other = generate(ctx40, ...COAST).view;
    const b = generate(ctx, ...COAST).view;
    const fresh = generate(ctxFor('42'), ...COAST).view;
    let differs = 0;
    for (let sy = 0; sy < 24; sy++) {
      expect(a.sectionBlocks(sy)).toEqual(b.sectionBlocks(sy));
      expect(a.sectionFluid(sy)).toEqual(b.sectionFluid(sy));
      expect(fresh.sectionBlocks(sy)).toEqual(a.sectionBlocks(sy));
      const x = other.sectionBlocks(sy), y = a.sectionBlocks(sy);
      if (typeof x !== typeof y || (typeof x === 'number' ? x !== y : !(x as Uint16Array).every((v, i) => v === (y as Uint16Array)[i]))) differs++;
    }
    expect(differs).toBeGreaterThan(0);
    expect(Array.from(a.aux()!.worldSurfaceWG)).toEqual(Array.from(b.aux()!.worldSurfaceWG));
    expect(Array.from(a.auxB()!.surfaceBiomeQ)).toEqual(Array.from(b.auxB()!.surfaceBiomeQ));
  });
});

describe('terrainDensityDebug (§2.3, the DT2 hook)', () => {
  test.each(FIXTURES)('%s: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe\'s (Object.is); whole cells; the rest untouched', (_name, [cx, cz]) => {
    const out = new Float64Array(98304).fill(12345);
    const mask = new Uint8Array(98304).fill(7);
    terrainDensityDebug(ctx, cx, cz, out, mask);
    const dc = dcOf(ctx);
    const e = expectedFor(ctx, [cx, cz]);
    let set = 0;
    const bad: string[] = [];
    for (let y = -64; y <= 319; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const i = vi(lx, y, lz);
          const at = `(${lx}, ${y}, ${lz})`;
          if (mask[i] !== 0 && mask[i] !== 1) bad.push(`${at}: mask ${mask[i]}`);
          // A cell is evaluated whole or not at all: each voxel's mask equals its cell's first voxel's.
          if (mask[i] !== mask[vi(lx & ~3, y - ((y + 64) & 7), lz & ~3)]) bad.push(`${at}: mask differs inside its cell`);
          if (mask[i] === 1) {
            set++;
            const v = probe(dc, 16 * cx + lx, y, 16 * cz + lz);
            if (!Object.is(out[i], v)) bad.push(`${at}: bulk ${out[i]} ≠ probe ${v}`);
            if (y > -64 && (v > 0) !== (e.blocks[i] !== AIR)) bad.push(`${at}: block ${e.blocks[i]} vs value ${v}`);
          } else if (out[i] !== 12345) {
            bad.push(`${at}: out written at an early-out voxel`);
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // Some cells straddle 0 and most early-out (Task 5: about 4 % of the cells evaluate voxels).
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(0.2 * 98304);
    expect(set % 128).toBe(0);
  });

  test('it leaves the T stage unchanged: a column generated after it equals the expected column', () => {
    terrainDensityDebug(ctx, ...OVERHANG, new Float64Array(98304), new Uint8Array(98304));
    expect(mismatches(generate(ctx, ...COAST).view, expectedFor(ctx, COAST))).toBe(0);
  });

  test('out and mask must hold 98,304 entries', () => {
    expect(() => terrainDensityDebug(ctx, ...LAND, new Float64Array(98303), new Uint8Array(98304))).toThrow(RangeError);
    expect(() => terrainDensityDebug(ctx, ...LAND, new Float64Array(98304), new Uint8Array(4096))).toThrow(RangeError);
  });
});

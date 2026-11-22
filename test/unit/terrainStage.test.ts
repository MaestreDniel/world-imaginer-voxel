import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, CAVE_KIND, caveBiomeOf, caveKindOf, ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { hex64 } from '../../src/core/hash';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonValue } from '../../src/core/params/json';
import type { ParamsPatch } from '../../src/core/params/schema';
import {
  buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, readLevel, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { carveColumn, carvedAt, densityTopColumn } from '../../src/gen/caves/carve';
import { caveBiomeOfPass, cavePickerOf, fillCaveColumnPass, newCaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { carverCacheOf } from '../../src/gen/caves/carverCache';
import { caveReadersOf, caveTagAt, tagColumn } from '../../src/gen/caves/tags';
import { fillDensityColumn } from '../../src/gen/density/bounds';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { probe, solidAt } from '../../src/gen/density/probe';
import {
  aquiferColumn, aquiferInputs, aquiferOf, barrierAt, cellStatus, createAquiferScratch, fluidAt, type AquiferInputs,
} from '../../src/gen/fluids/aquifer';
import { DEFAULTS } from '../../src/core/params/defaults';
import { completeNoiseDef } from '../../src/core/noise/types';
import { seedSectionsOf } from '../../src/gen/fluids/settle';
import { terrainSolidAt } from '../../src/gen/fluids/solidAt';
import { newSpringList } from '../../src/gen/fluids/springs';
import { caveBiomeQuarts, terrainDensityDebug, terrainSpringsDebug, terrainStage, terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf, type SurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbe, surfaceProbeColumn } from '../../src/gen/surface/probe';
import { newSurfaceScan, runAt, type SurfaceScan } from '../../src/gen/surface/scan';
import { seedFromInput } from '../../src/core/seed';
import { resolveProfile } from '../../src/core/params/profiles';
import { createGenContext } from '../../src/gen/context';
import { caveBiomeAt } from '../../src/gen/biomes/cavePicker';
import { FLUID_LAVA, fluidType, LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, COLLIDE, DEEPSLATE, GRASS_BLOCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import type { AuxBView, AuxView, ColumnView, ColumnWriter } from '../../src/world/store/api';
import { protoAt, REC_AUX_B } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { CARVERS_OFF } from '../harness/carverParams';
import { ctxFor, paramsWith } from '../harness/gen';
import { isolatedColumn } from '../harness/region';
import { cavesMuted } from '../harness/sp5cTrees';
import { topDownHeightmaps } from '../harness/heightmaps';

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
/** SP6b's rule 4's states (its spec §3.4). */
const RULE4_STATES: ReadonlySet<number> = new Set(['moss_block', 'clay', 'dripstone_block', 'abyss_ash', 'abyss_stone', 'abyss_shale', 'cracked_abyss_stone', 'abyss_stone_veined'].map((k) => REGISTRY.parseStateKey(k)));
const FIXTURES = [['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST], ['overhang', OVERHANG], ['wall', WALL]] as const;

/** A shape spline that is `y` everywhere. */
const flat = (y: number) => ({ coord: 'C' as const, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] });

const ctx = ctxFor('42');
/** An extreme but valid shape (σ 40 everywhere): enclosed air far below the water line under the sea. */
const ctx40 = ctxFor('42', { shape: { sigma: flat(40) } });
/**
 * §3.2: σ and jag splines at 0, both detail amplitudes at 0; SP6a's carving cave taps muted (`cavesMuted`: the caves slot
 * is 1e6) and its carvers off (`CARVERS_OFF`: no source passes its roll), so the solidity is the terrain body's alone.
 */
const REDUCED: ParamsPatch = { ...CARVERS_OFF, shape: { sigma: flat(0), jag: flat(0) }, density: { detailAmpLo: 0, detailAmpHi: 0, defs: cavesMuted(DEFAULT_DENSITY_TREE) as JsonValue } };
const ctxReduced = ctxFor('42', REDUCED);
/** The default world without SP6a's carving cave taps and carvers (the terrain body and detail only). */
const ctxNoCaves = ctxFor('42', { ...CARVERS_OFF, density: { defs: cavesMuted(DEFAULT_DENSITY_TREE) as JsonValue } });

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
 * SP3b §4, SP3c §1 and SP7a §1.7 independently of the stage: solidity from the density probe (no early-outs) after the
 * carvers (`solidAt`: density > 0 and not `carvedAt`, SP6a spec §3.4) and the aquifer's barriers (`barrierAt` at a
 * tagged voxel, D20; together `terrainSolidAt`), `top`; the fluid of a non-solid voxel by D19: untagged (`caveTagAt` 0)
 * water iff y ≤ ⌊surfaceWaterLevel⌋ at the nearest corner, tagged the aquifer's point function `fluidAt`; each solid
 * voxel's state from `surfaceProbe` on a SurfaceContext built apart (the reference evaluator, never the fast path; it
 * rebuilds the column with its own early-outs, so a solidity disagreement shows as air); the springs
 * T's springs step accepts (SP7a D21) as air plus a source.
 */
function expectedOf(c: GenContext, cx: number, cz: number): Expected {
  const dc = dcOf(c);
  const sc = scOf(c);
  const aq = aquiferOf(c);
  const s = buildColumnSample(c, cx, cz, newColumnSample());
  const blocks = new Uint16Array(98304);
  const fluid = new Uint8Array(98304);
  const top = new Int32Array(256).fill(-64);
  const swl = new Float64Array(256);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = 16 * cx + lx;
      const z = 16 * cz + lz;
      const level = readLevel(s, 'surfaceWaterLevel', x, z);
      swl[lz * 16 + lx] = level;
      blocks[vi(lx, -64, lz)] = BEDROCK;
      for (let y = -63; y <= 319; y++) {
        let solid = solidAt(dc, x, y, z);
        if (!solid) {
          if (caveTagAt(dc, x, y, z) === 0) {
            if (y <= Math.floor(level)) fluid[vi(lx, y, lz)] = WATER_SOURCE;
          } else if (barrierAt(aq, dc, x, y, z)) {
            solid = true;
          } else {
            fluid[vi(lx, y, lz)] = fluidAt(aq, dc, x, y, z);
          }
        }
        blocks[vi(lx, y, lz)] = solid ? surfaceProbe(sc, x, y, z).state : AIR;
        if (solid) top[lz * 16 + lx] = y;
      }
    }
  }
  // SP7a D21: the column's springs (`springsColumn`'s list, decided by springs.test.ts' rules) are air plus a source;
  // `top` is unchanged (a spring lies at or below top − 2).
  const springs = newSpringList();
  terrainSpringsDebug(c, cx, cz, springs);
  for (let k = 0; k < springs.n; k++) {
    const j = springs.pos[k]!;
    blocks[j] = AIR;
    fluid[j] = springs.kind[k] === 2 ? LAVA_SOURCE : WATER_SOURCE;
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

describe('fill and the aquifer step (§4, SP7a §1.7), surface (SP3c §1)', () => {
  test.each(FIXTURES)('%s: every voxel is bedrock at −64, solid ⇔ density > 0 and not carved, or a barrier, with surfaceProbe\'s state, fluid by D19\'s rules', (_name, col) => {
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

  test('untagged air under an overhang below the water line fills (D19: sky-open water)', () => {
    const e = expectedFor(ctx, OVERHANG);
    const { view } = generate(ctx, ...OVERHANG);
    let under = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y < e.top[p]!; y++) {
        if (view.block(lx, y, lz) !== AIR || caveKindOf(view.cave(lx, y, lz)) !== 0) continue;
        // Stone above it in its own position; untagged, so its water is the position's level's, whatever the depth.
        expect(view.fluid(lx, y, lz), `(${lx}, ${y}, ${lz})`).toBe(y <= Math.floor(e.swl[p]!) ? WATER_SOURCE : 0);
        if (view.fluid(lx, y, lz) !== 0) under++;
      }
    }
    expect(under).toBeGreaterThan(0);
  });

  test('deeper enclosed untagged air fills to the level (σ 40 sea; D19 retires water v0\'s 12-block rule): untagged air at y ≤ top − 12 below the water level holds water', () => {
    const e = expectedFor(ctx40, SEA);
    const { view } = generate(ctx40, ...SEA);
    let pockets = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= e.top[p]! - 12; y++) {
        if (view.block(lx, y, lz) !== AIR || y > e.swl[p]! || caveKindOf(view.cave(lx, y, lz)) !== 0) continue;
        pockets++;
        expect(view.fluid(lx, y, lz)).toBe(WATER_SOURCE);
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
      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual(topDownHeightmaps(view, lx, lz));
      expect(aux.oceanFloorWG[p]).toBe(e.top[p]! + 1);
      expect(aux.surfaceBiome[p]).toBe(readBiome(e.s, ctx, 16 * cx + lx, 16 * cz + lz));
    }
    for (const f of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking', 'tintTH'] as const) {
      expect(aux[f].every((v) => v === 0)).toBe(true);
    }
  });
});

/**
 * `caveBiomeQ` recomputed from a view's stored cave bytes (SP6b spec §2.2), apart from the stage: per quart
 * (qy·4 + qz)·4 + qx, qy = (y + 64) >> 2, 0 with no tagged voxel (kind ≠ 0), else 1 + the biome (bits 4-7) most of its
 * tagged voxels carry, a tie to the lower id; wet tagged voxels count like dry ones.
 */
function quartMajority(view: ColumnView): Uint8Array {
  const out = new Uint8Array(1536);
  for (let qy = 0; qy < 96; qy++) {
    for (let qz = 0; qz < 4; qz++) {
      for (let qx = 0; qx < 4; qx++) {
        const n = [0, 0, 0, 0];
        for (let dy = 0; dy < 4; dy++) {
          for (let dz = 0; dz < 4; dz++) {
            for (let dx = 0; dx < 4; dx++) {
              const byte = view.cave(4 * qx + dx, 4 * qy + dy - 64, 4 * qz + dz);
              if (caveKindOf(byte) !== 0) n[caveBiomeOf(byte)]!++;
            }
          }
        }
        const most = Math.max(...n);
        out[(qy * 4 + qz) * 4 + qx] = most === 0 ? 0 : 1 + n.indexOf(most);
      }
    }
  }
  return out;
}

describe('aux B (§4)', () => {
  test('surfaceBiomeQ[qz·4 + qx] is lattice point (qx, qz)\'s 2D biome; caveBiomeQ is the quarts\' majority (SP6b §2.2); seedSections at 1552 (SP7a §1.7); the rest of the slot is 0', () => {
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
      expect(b.caveBiomeQ).toEqual(quartMajority(view));
      const slot = new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096);
      let nonZero = 0;
      for (let i = 1556; i < 4096; i++) if (slot[i] !== 0) nonZero++;
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
    // Without SP6a's caves (which carve that section of the land column), the section is uniform deepslate: LAKE's land
    // (LAND's lies under the abyss's climate, so SP6b's rule 4 makes that section the abyss's strata, cave or not).
    const land = generate(ctxNoCaves, ...LAKE).store;
    expect(land.table.ints[protoAt(land.table.find(...LAKE), 1) + PROTO_BLOCKS]).toBe(-1 - DEEPSLATE);
    const sea = generate(ctx, ...SEA).store;
    const at = protoAt(sea.table.find(...SEA), 7);
    expect([sea.table.ints[at + PROTO_BLOCKS], sea.table.ints[at + PROTO_FLUID]]).toEqual([-1 - AIR, -1 - WATER_SOURCE]);
  });
});

describe('the cave channel (SP6a spec §3.1-§3.2, D20)', () => {
  /** The caverns' cave class column of seed 42 (pinned in test/unit/liveness.test.ts). */
  const CAVERNS = [546, 25857] as const;

  test('a column\'s proto cave sections equal the carve\'s tags and then tagColumn\'s after the density fill, section by section, 0 where the aquifer placed a barrier (SP7a D20)', () => {
    for (const col of [CAVERNS, LAND, COAST]) {
      const { view } = generate(ctx, col[0], col[1]);
      const dc = createDensityContext(ctx);
      const solid = new Uint8Array(98304), cells = new Uint8Array(768), tags = new Uint8Array(98304), tops = new Int16Array(256);
      const s = dc.columns.get(col[0], col[1]);
      expect(fillDensityColumn(dc.bounds, s, solid, null, null, NEVER, cells)).toBe(true);
      densityTopColumn(solid, false, tops);
      const cache = carverCacheOf(ctx);
      carveColumn(cache, cache.params, s, col[0], col[1], solid, tops, tags);
      tagColumn(dc.compiled, caveReadersOf(dc.compiled), ctx.params.caves.pillars.threshold, solid, cells, tags, dc.bounds, true);
      // A barrier (air after the carve, rock in T) loses its tag (SP7a D20).
      for (let j = 256; j < 98304; j++) {
        if (solid[j] === 0 && view.block(j & 15, (j >> 8) - 64, (j >> 4) & 15) !== AIR) tags[j] = 0;
      }
      let dense = 0;
      for (let sy = 0; sy < 24; sy++) {
        const want = tags.subarray(4096 * sy, 4096 * (sy + 1));
        const got = view.sectionCave(sy);
        if (typeof got === 'number') expect(want.every((k) => k === caveKindOf(got)), `(${col[0]}, ${col[1]}) section ${sy} uniform ${got}`).toBe(true);
        else {
          expect(got.map(caveKindOf), `(${col[0]}, ${col[1]}) section ${sy}`).toEqual(want);
          dense++;
        }
      }
      if (col === CAVERNS) {
        expect(dense).toBeGreaterThan(0);
        // The caverns' column holds a worm (§3.2 step 4): its carved voxels keep the worm's kind.
        expect(tags.includes(CAVE_KIND.worm)).toBe(true);
      }
    }
  });

  test('a column holding a worm: every voxel the carvers open is air and tagged with its carver kind, the worm\'s 6 among them; nothing else is carved', () => {
    const { view } = generate(ctx, ...CAVERNS);
    const dc = dcOf(ctx);
    let worm = 0;
    const bad: string[] = [];
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4, x = 16 * CAVERNS[0] + lx, z = 16 * CAVERNS[1] + lz;
      for (let y = -63; y <= 319; y++) {
        const tag = caveKindOf(view.cave(lx, y, lz));
        const densitySolid = probe(dc, x, y, z) > 0;
        const carver = tag === CAVE_KIND.worm || tag === CAVE_KIND.ravine || tag === CAVE_KIND.undergroundWorm;
        // Carved ⇔ density-solid and air in T; then its tag is a carver kind, the one carvedAt names.
        const carved = densitySolid && view.block(lx, y, lz) === AIR;
        if (carved !== carver) bad.push(`(${lx}, ${y}, ${lz}): carved ${carved}, tag ${tag}`);
        if (carved && carvedAt(dc, x, y, z) !== tag) bad.push(`(${lx}, ${y}, ${lz}): carvedAt ${carvedAt(dc, x, y, z)} ≠ tag ${tag}`);
        if (tag === CAVE_KIND.worm) worm++;
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(worm).toBeGreaterThan(0);
  });

  test('a ravine floor open to the sky is the scan\'s sky run and gets the biome\'s top (grass); a cave floor under a ceiling gets stone, deepslate or one of rule 4\'s cave states, never grass (D6)', () => {
    // RAVINE: a column a ravine crosses with its floor open to the sky (seed 42, found by a scan of the ravine paths).
    const RAVINE = [4, -10] as const;
    let skyFloors = 0;
    {
      const { view } = generate(ctx, ...RAVINE);
      const scan = newSurfaceScan();
      terrainSurfaceDebug(ctx, ...RAVINE, scan);
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        let top = -64;
        for (let y = 319; y > -64; y--) if (view.block(lx, y, lz) !== AIR) { top = y; break; }
        if (caveKindOf(view.cave(lx, top + 1, lz)) !== CAVE_KIND.ravine) continue;
        skyFloors++;
        expect(scan.runTop[scan.skyRun[p]!], `(${lx}, ${top}, ${lz})`).toBe(top);
        expect(REGISTRY.stateKey(view.block(lx, top, lz)), `(${lx}, ${top}, ${lz})`).toBe('grass_block');
      }
    }
    expect(skyFloors).toBeGreaterThan(0);
    let caveFloors = 0;
    for (const col of [CAVERNS, RAVINE]) {
      const { view } = generate(ctx, col[0], col[1]);
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        let top = -64;
        for (let y = 319; y > -64; y--) if (view.block(lx, y, lz) !== AIR) { top = y; break; }
        for (let y = -63; y < top; y++) {
          const k = caveKindOf(view.cave(lx, y + 1, lz));
          if (view.block(lx, y, lz) === AIR || !(k === CAVE_KIND.worm || k === CAVE_KIND.ravine || k === CAVE_KIND.undergroundWorm)) continue;
          caveFloors++;
          const b = view.block(lx, y, lz);
          // SP6b's rule 4 (its spec §3.4): moss, clay or dripstone on a cave biome's floor, ash or strata in the abyss.
          expect(b === STONE || b === DEEPSLATE || RULE4_STATES.has(b), `(${col[0]}, ${col[1]}) (${lx}, ${y}, ${lz}): ${REGISTRY.stateKey(b)}`).toBe(true);
          expect(b).not.toBe(GRASS_BLOCK);
        }
      }
    }
    expect(caveFloors).toBeGreaterThan(0);
  });

  test('a column with no cave is uniform 0 in every section', () => {
    const { view } = generate(ctxNoCaves, ...LAND);
    for (let sy = 0; sy < 24; sy++) expect(view.sectionCave(sy), `section ${sy}`).toBe(0);
  });
});

describe('the cave biome (SP6b spec §2.1-§2.2, D17)', () => {
  /**
   * Columns of seed 42 found by scans with the default params: ABYSS the first of the chunks (−3000, −1500 + 53i + 11r)
   * … whose tagged air holds more abyss than plain, LUSH the first of (200 + 41r, 400 + 67i − 13r) holding more than 500
   * lush voxels. Their biomes are re-derived below.
   */
  const ABYSS = [-3000, -1182] as const;
  const LUSH = [200, 467] as const;

  test('T writes each tagged voxel\'s cave biome into bits 4-7 (§2.1): caveBiomeOfPass over the column\'s pass where the kind ≠ 0, 0 elsewhere; the kinds unchanged (caveTagAt), 0 at a barrier (barrierAt; SP7a D20)', () => {
    const inp = cavePickerOf(ctx);
    const dc = createDensityContext(ctx);
    const aq = aquiferOf(ctx);
    const seen = new Set<number>();
    for (const [cx, cz] of [[0, 0], COAST, [40, 900], ABYSS, LUSH] as const) {
      const { view } = generate(ctx, cx, cz);
      const pass = fillCaveColumnPass(inp, buildColumnSample(ctx, cx, cz, newColumnSample()), newCaveColumnPass());
      const bad: string[] = [];
      let tagged = 0;
      const n = [0, 0, 0, 0];
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const x = 16 * cx + lx, z = 16 * cz + lz;
          for (let y = -64; y <= 319; y++) {
            const byte = view.cave(lx, y, lz);
            const kind = caveKindOf(byte);
            const tagAt = caveTagAt(dc, x, y, z);
            const wantKind = tagAt !== 0 && barrierAt(aq, dc, x, y, z) ? 0 : tagAt;
            if (kind !== wantKind) bad.push(`(${x}, ${y}, ${z}): kind ${kind}, caveTagAt ${tagAt}, want ${wantKind}`);
            const want = kind === 0 ? 0 : caveBiomeOfPass(inp, pass, x, y, z);
            if (caveBiomeOf(byte) !== want) bad.push(`(${x}, ${y}, ${z}): biome ${caveBiomeOf(byte)}, the pick ${want}`);
            if (kind !== 0) { tagged++; n[want]!++; seen.add(want); }
          }
        }
      }
      expect(bad.slice(0, 10), `(${cx}, ${cz})`).toEqual([]);
      expect(tagged, `(${cx}, ${cz}) holds cave air`).toBeGreaterThan(0);
      if (cx === ABYSS[0] && cz === ABYSS[1]) expect(n[CAVE_BIOME.abyss]).toBeGreaterThan(n[CAVE_BIOME.plain]!);
      if (cx === LUSH[0] && cz === LUSH[1]) expect(n[CAVE_BIOME.lush]).toBeGreaterThan(500);
    }
    // Every cave biome is written somewhere among the columns.
    expect([...seen].sort()).toEqual([CAVE_BIOME.plain, CAVE_BIOME.lush, CAVE_BIOME.dripstone, CAVE_BIOME.abyss]);
  }, 120_000);

  test('caveBiomeQ is the majority (§2.2): a hand-checked quart with 3 lush, 3 dripstone and 1 plain tagged voxels reads 1 + 1 (tie to lush); a quart with no tagged voxel reads 0', () => {
    const tags = new Uint8Array(98304);
    const q = new Uint8Array(1536).fill(9);
    // Quart (qx 1, qy 20, qz 2): voxels lx 4 … 7, y 16 … 19, lz 8 … 11; kinds mixed, biomes in bits 4-7.
    const put = (lx: number, y: number, lz: number, byte: number) => { tags[vi(lx, y, lz)] = byte; };
    put(4, 16, 8, CAVE_KIND.cheese | (CAVE_BIOME.lush << 4));
    put(5, 17, 9, CAVE_KIND.noodle | (CAVE_BIOME.lush << 4));
    put(7, 19, 11, CAVE_KIND.worm | (CAVE_BIOME.lush << 4));
    put(6, 16, 8, CAVE_KIND.cheese | (CAVE_BIOME.dripstone << 4));
    put(4, 18, 10, CAVE_KIND.spaghetti3d | (CAVE_BIOME.dripstone << 4));
    put(7, 17, 8, CAVE_KIND.ravine | (CAVE_BIOME.dripstone << 4));
    put(5, 19, 11, CAVE_KIND.entrance | (CAVE_BIOME.plain << 4));
    // Quart (qx 0, qy 0, qz 0): 2 abyss against 1 plain, so 1 + 3.
    put(0, -63, 0, CAVE_KIND.cheese | (CAVE_BIOME.abyss << 4));
    put(1, -62, 2, CAVE_KIND.cheese | (CAVE_BIOME.abyss << 4));
    put(3, -61, 3, CAVE_KIND.other);
    caveBiomeQuarts(tags, q);
    const at = (qx: number, qy: number, qz: number) => q[(qy * 4 + qz) * 4 + qx];
    expect(at(1, 20, 2)).toBe(1 + CAVE_BIOME.lush);
    expect(at(0, 0, 0)).toBe(1 + CAVE_BIOME.abyss);
    // Every other quart holds no tagged voxel: 0.
    expect(q.filter((v) => v !== 0)).toHaveLength(2);
    // One more dripstone voxel breaks the tie.
    put(6, 18, 9, CAVE_KIND.cheese | (CAVE_BIOME.dripstone << 4));
    caveBiomeQuarts(tags, q);
    expect(at(1, 20, 2)).toBe(1 + CAVE_BIOME.dripstone);
    expect(() => caveBiomeQuarts(tags.subarray(1), q)).toThrow(RangeError);
    expect(() => caveBiomeQuarts(tags, new Uint8Array(1535))).toThrow(RangeError);
  });

  test('caveBiomeQ: tagged voxels holding the aquifer\'s water count (σ 40 sea): quarts whose tagged voxels are all wet read 1 + their majority', () => {
    let allWet = 0, wet = 0;
    for (const col of [OVERHANG, SEA]) {
      const { view } = generate(ctx40, col[0], col[1]);
      const q = view.auxB()!.caveBiomeQ;
      expect(q).toEqual(quartMajority(view));
      for (let k = 0; k < 1536; k++) {
        const qx = k & 3, qz = (k >> 2) & 3, qy = k >> 4;
        let t = 0, w = 0;
        for (let dy = 0; dy < 4; dy++) for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) {
          const lx = 4 * qx + dx, y = 4 * qy + dy - 64, lz = 4 * qz + dz;
          if (caveKindOf(view.cave(lx, y, lz)) === 0) continue;
          t++;
          if (view.fluid(lx, y, lz) === WATER_SOURCE) w++;
        }
        wet += w;
        if (t > 0 && w === t) {
          allWet++;
          expect(q[k], `(${col[0]}, ${col[1]}) quart ${k}`).toBeGreaterThan(0);
        }
      }
    }
    expect(wet).toBeGreaterThan(0);
    expect(allWet).toBeGreaterThan(0);
  });

  test('Review Focus 4: with edgeJitter 4, columns (31, 0) and (32, 0) alone (isolatedColumn) and inside one region give the same nibbles and caveBiomeQ; within 8 blocks of x = 512 every tagged voxel\'s nibble is caveBiomeOfPass over its column\'s pass', async () => {
    const patch = { caves: { biomes: { edgeJitter: 4 } } } as const;
    const c4 = ctxFor('42', patch);
    const region = createStore({ shared: false, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
    genRegionInProcess(region, c4, 28, -2, 8, 4);
    const inp = cavePickerOf(c4);
    let near = 0;
    const seen = new Set<number>();
    for (const cx of [31, 32]) {
      expect(hex64(await isolatedColumn({ seed: '42', params: paramsWith(patch), cx, cz: 0 })), `(${cx}, 0)`).toBe(hex64(regionHash(region, cx, 0, 1, 1)));
      const alone = generate(ctxFor('42', patch), cx, 0).view;
      const inside = region.proto(cx, 0)!;
      expect(alone.auxB()!.caveBiomeQ).toEqual(inside.auxB()!.caveBiomeQ);
      const pass = fillCaveColumnPass(inp, buildColumnSample(c4, cx, 0, newColumnSample()), newCaveColumnPass());
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const x = 16 * cx + lx;
          for (let y = -64; y <= 319; y++) {
            const byte = inside.cave(lx, y, lz);
            expect(alone.cave(lx, y, lz)).toBe(byte);
            if (Math.abs(x - 511.5) > 8 || caveKindOf(byte) === 0) continue;
            near++;
            seen.add(caveBiomeOf(byte));
            expect(caveBiomeOf(byte), `(${x}, ${y}, ${lz})`).toBe(caveBiomeOfPass(inp, pass, x, y, lz));
          }
        }
      }
    }
    expect(near).toBeGreaterThan(0);
    // The border at x = 512 crosses a biome change: more than one biome is written within 8 blocks of it.
    expect(seen.size).toBeGreaterThan(1);
  }, 120_000);
});

/** A writer that records the calls (no store). */
function spyWriter(): { w: ColumnWriter; sections: number[]; aux: number; auxB: number; commits: number } {
  const log = { sections: [] as number[], aux: 0, auxB: 0, commits: 0 };
  const auxView: AuxView = {
    worldSurfaceWG: new Int16Array(256), oceanFloorWG: new Int16Array(256), worldSurface: new Int16Array(256),
    motionBlocking: new Int16Array(256), oceanFloor: new Int16Array(256), lightBlocking: new Int16Array(256),
    surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
  };
  const auxBView: AuxBView = { caveBiomeQ: new Uint8Array(1536), surfaceBiomeQ: new Uint8Array(16), seedSections: new Uint32Array(1) };
  const w: ColumnWriter = {
    cx: 0, cz: 0,
    setProto(sy, blocks, fluid, cave) {
      expect([blocks.length, fluid.length, cave?.length]).toEqual([4096, 4096, 4096]);
      log.sections.push(sy);
    },
    setFinal() { throw new Error('the T stage writes no final set'); },
    shareFinal() { throw new Error('the T stage writes no final set'); },
    setLight() { throw new Error('the T stage writes no light'); },
    resetLight() { throw new Error('the T stage writes no light'); },
    aux() { log.aux++; return auxView; },
    auxB() { log.auxB++; return auxBView; },
    replaceBlocks() { throw new Error('the T stage writes no final set'); },
    replaceFluid() { throw new Error('the T stage writes no final set'); },
    setGeneratedFluid() { throw new Error('the T stage writes no generated-fluid layer'); },
    clearGeneratedFluid() { throw new Error('the T stage writes no generated-fluid layer'); },
    setDiffFlag() { throw new Error('the T stage sets no diff flag'); },
    commit() { log.commits++; },
  };
  return {
    w, get sections() { return log.sections; }, get aux() { return log.aux; }, get auxB() { return log.auxB; },
    get commits() { return log.commits; },
  };
}

describe('order and abort (§4, SP3c §1)', () => {
  test('7 density polls: 6 in the fill, 1 before the carve; 1 before the surface pass; then sections 0 … 23 in order with a poll before each, then aux A and aux B; never commits', () => {
    const spy = spyWriter();
    const at: number[] = [];
    expect(terrainStage(ctx, 3, -2, spy.w, () => { at.push(spy.sections.length); return false; })).toBe(true);
    expect(spy.sections).toEqual(Array.from({ length: 24 }, (_, i) => i));
    // No section is written during the density phase, the carve or the surface pass: the first 9 polls see none.
    expect(at).toEqual([0, 0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 24 }, (_, i) => i)]);
    expect([spy.aux, spy.auxB, spy.commits]).toEqual([1, 1, 0]);
  });

  test.each([0, 1, 5, 6, 7, 8, 9, 14, 31])('stop true at poll %i: returns false at once, no aux, no commit', (k) => {
    const spy = spyWriter();
    let polls = 0;
    expect(terrainStage(ctx, 3, -2, spy.w, () => ++polls > k)).toBe(false);
    expect(spy.sections).toEqual(Array.from({ length: Math.max(0, k - 8) }, (_, i) => i));
    expect(polls).toBe(k + 1);
    expect([spy.aux, spy.auxB, spy.commits]).toEqual([0, 0, 0]);
  });

  test('a stop in the density phase or at the surface pass leaves no trace: the next column is generated as if alone', () => {
    for (const k of [3, 6, 7]) {
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
  test.each(FIXTURES)('%s: mask 1 exactly at the bulk-evaluated voxels, whose values are the probe\'s (Object.is); whole sub-blocks; the rest untouched', (_name, [cx, cz]) => {
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
          // A straddling cell's sub-block (SP6a ruling R13: 2 × 2 × 4 voxels, x and y pairs across the cell's z) is
          // evaluated whole or not at all: each voxel's mask equals its sub-block's first voxel's.
          if (mask[i] !== mask[vi(lx & ~1, y - ((y + 64) & 1), lz & ~3)]) bad.push(`${at}: mask differs inside its sub-block`);
          if (mask[i] === 1) {
            set++;
            const v = probe(dc, 16 * cx + lx, y, 16 * cz + lz);
            if (!Object.is(out[i], v)) bad.push(`${at}: bulk ${out[i]} ≠ probe ${v}`);
            // The block is air where the density is ≤ 0 or a carver carved (SP6a §3.4), unless the aquifer made it a
            // barrier (SP7a D20).
            const carved = v > 0 && carvedAt(dc, 16 * cx + lx, y, 16 * cz + lz) !== 0;
            const barrier = !(v > 0 && !carved) && barrierAt(aquiferOf(ctx), dc, 16 * cx + lx, y, 16 * cz + lz);
            if (y > -64 && ((v > 0 && !carved) || barrier) !== (e.blocks[i] !== AIR)) bad.push(`${at}: block ${e.blocks[i]} vs value ${v}${carved ? ' (carved)' : ''}${barrier ? ' (a barrier)' : ''}`);
          } else if (out[i] !== 12345) {
            bad.push(`${at}: out written at an early-out voxel`);
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // Some cells straddle 0 and most early-out (Task 5: about 4 % of the cells evaluate voxels; with SP6a's cave walls
    // 21-23 % on these fixtures with entrances, cheese and pillars, 30.3 % at most with spaghetti and the noodle).
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(0.4 * 98304);
    expect(set % 16).toBe(0);
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

/** Every field of a scan that `scanColumn` writes (the per-run arrays over the runs in use), as plain arrays. */
function scanSnapshot(scan: SurfaceScan): unknown {
  const runs = scan.runFirst[256]!;
  return {
    cx: scan.cx, cz: scan.cz, runFirst: Array.from(scan.runFirst),
    runTop: Array.from(scan.runTop.subarray(0, runs)), runBottom: Array.from(scan.runBottom.subarray(0, runs)),
    runWaterAbove: Array.from(scan.runWaterAbove.subarray(0, runs)), runWaterTop: Array.from(scan.runWaterTop.subarray(0, runs)),
    steep: Array.from(scan.steep), T: Array.from(scan.T), biome: Array.from(scan.biome),
    lakeLevel: Array.from(scan.lakeLevel), surfaceDepth: Array.from(scan.surfaceDepth),
  };
}

describe('terrainSurfaceDebug (SP3c §5.2, the DT2 surface hook)', () => {
  test.each(FIXTURES)('%s: the stage\'s scan equals the probe column\'s; solid ⇔ block ≠ air; the stage\'s compiled tree gives the stored block at every solid voxel', (_name, [cx, cz]) => {
    const { view } = generate(ctx, cx, cz);
    const scan = newSurfaceScan();
    const evaluated = terrainSurfaceDebug(ctx, cx, cz, scan);
    expect(scanSnapshot(scan)).toEqual(scanSnapshot(surfaceProbeColumn(scOf(ctx), cx, cz).scan));
    const compiled = surfaceContextOf(ctx).compiled;
    const bad: string[] = [];
    let solid = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= 319; y++) {
        const block = view.block(lx, y, lz);
        const r = runAt(scan, p, y);
        if ((r >= 0) !== (block !== AIR)) bad.push(`(${lx}, ${y}, ${lz}): run ${r}, block ${block}`);
        if (r < 0) continue;
        solid++;
        const c = compiled.state(scan, p, y);
        if (c !== block) bad.push(`(${lx}, ${y}, ${lz}): compiled ${c} ≠ block ${block}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // The pass's evaluated-voxel count: some voxels, never all of them (the fast path takes the deep ones).
    expect(evaluated).toBeGreaterThan(0);
    expect(evaluated).toBeLessThan(solid / 2);
  });

  test('the scan passed is the hook\'s alone: a later stage run does not touch it, and the stage is unchanged by the hook', () => {
    const scan = newSurfaceScan();
    terrainSurfaceDebug(ctx, ...OVERHANG, scan);
    const before = scanSnapshot(scan);
    expect(mismatches(generate(ctx, ...COAST).view, expectedFor(ctx, COAST))).toBe(0);
    expect(scanSnapshot(scan)).toEqual(before);
  });
});

describe('T\'s aquifer step (SP7a §1.7, D17-D20)', () => {
  /** floating_islands at seed '42' and SP3e's island class column (test/unit/fixtures/liveness.ts' ISLAND_PIN). */
  const FLOATING = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
  const ISLAND = [975, -735] as const;
  /** (0, 0), the coast, (40, 900) (cave-rich), the open sea, SP6b's abyss column and the island column. */
  const COLUMNS: ReadonlyArray<readonly [string, GenContext, readonly [number, number]]> = [
    ['(0, 0)', ctx, [0, 0]], ['coast', ctx, COAST], ['(40, 900)', ctx, [40, 900]], ['sea', ctx, SEA],
    ['abyss', ctx, [-3000, -1182]], ['floating_islands island', FLOATING, ISLAND],
  ];
  /** Rule 1-4's rock states a barrier can take (the surface pass skins it as rock): stone, deepslate, rule 4's. */
  const BARRIER_STATES: ReadonlySet<number> = new Set([STONE, DEEPSLATE, ...RULE4_STATES]);

  test.each(COLUMNS)('%s: fluid = fluidAt at every non-solid voxel, solidity = terrainSolidAt at every voxel; barriers hold cave byte 0 and rock; tagged water keeps its kind and nibble; the heightmaps are the top-down scan\'s; caveBiomeQ counts no barrier', (name, c, [cx, cz]) => {
    const aq: AquiferInputs = aquiferOf(c);
    expect(aquiferOf(c), 'memoised per context').toBe(aq);
    const dc = dcOf(c);
    const { view } = generate(c, cx, cz);
    // SP7a D21: the column's springs (`springsColumn`'s list): T stores air plus a source where the probes say rock.
    const springs = newSpringList();
    terrainSpringsDebug(c, cx, cz, springs);
    const springAt = new Set(springs.pos.subarray(0, springs.n));
    const aux = view.aux()!;
    const bad: string[] = [];
    let barriers = 0, taggedWater = 0, lava = 0, crack = 0;
    const states = new Set<string>();
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = 16 * cx + lx, z = 16 * cz + lz;
        let top = -64, topFluid = -65;
        for (let y = -63; y <= 319; y++) {
          const block = view.block(lx, y, lz);
          const f = view.fluid(lx, y, lz);
          const solid = block !== AIR;
          const spring = springAt.has((((y + 64) << 4) | lz) << 4 | lx);
          if (!spring && terrainSolidAt(aq, dc, x, y, z) !== solid) bad.push(`(${x}, ${y}, ${z}): terrainSolidAt ≠ stored solidity ${solid}`);
          if (solid) {
            top = y;
            if (f !== 0) bad.push(`(${x}, ${y}, ${z}): fluid ${f} in a solid voxel`);
            if (!solidAt(dc, x, y, z)) {
              barriers++;
              states.add(REGISTRY.stateKey(block));
              if (view.cave(lx, y, lz) !== 0) bad.push(`(${x}, ${y}, ${z}): barrier with cave byte ${view.cave(lx, y, lz)}`);
              if (!BARRIER_STATES.has(block)) bad.push(`(${x}, ${y}, ${z}): barrier state ${REGISTRY.stateKey(block)}`);
              if (!barrierAt(aq, dc, x, y, z)) bad.push(`(${x}, ${y}, ${z}): solid, not density-solid, but barrierAt false`);
            }
            continue;
          }
          const want = fluidAt(aq, dc, x, y, z);
          if (!spring && f !== want) bad.push(`(${x}, ${y}, ${z}): fluid ${f} ≠ fluidAt ${want}`);
          if (f !== 0) topFluid = y;
          if (fluidType(f) === FLUID_LAVA) lava++;
          const byte = view.cave(lx, y, lz);
          if (f !== 0 && caveKindOf(byte) !== 0) {
            taggedWater++;
            // O31: the tag and the nibble are written before the aquifer and kept on fluid voxels.
            const kind = caveTagAt(dc, x, y, z);
            if (byte !== (kind | (caveBiomeAt(dc, x, y, z) << 4))) bad.push(`(${x}, ${y}, ${z}): fluid voxel's cave byte ${byte} ≠ kind ${kind}, nibble ${caveBiomeAt(dc, x, y, z)}`);
          }
        }
        const p = lz * 16 + lx;
        if (topFluid > top) crack++;
        // SP3a §3.4's predicates over the stored column (a fluid voxel above `top` included) and OCEAN_FLOOR_WG = top + 1.
        expect([p, aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([p, ...topDownHeightmaps(view, lx, lz)]);
        expect([p, aux.oceanFloorWG[p], aux.worldSurfaceWG[p]]).toEqual([p, top + 1, Math.max(top, topFluid) + 1]);
      }
    }
    expect(bad.slice(0, 10), name).toEqual([]);
    expect(view.auxB()!.caveBiomeQ).toEqual(quartMajority(view));
    console.log(`T's aquifer step, ${name} (${cx}, ${cz}): ${barriers} barrier voxels (${[...states].join(', ')}), ${taggedWater} tagged fluid voxels, ${lava} lava, ${crack} positions with fluid above top`);
    if (name === 'sea' || name === 'coast') expect(taggedWater, `${name}: caves under the sea flood`).toBeGreaterThan(0);
  }, 300_000);

  test('aux B seedSections equals seedSectionsOf over T\'s arrays on the six columns (SP7a §1.7)', () => {
    const solid = new Uint8Array(98304);
    const fluid = new Uint8Array(98304);
    const masks: number[] = [];
    for (const [name, c, [cx, cz]] of COLUMNS) {
      const { view } = generate(c, cx, cz);
      for (let j = 0; j < 98304; j++) {
        const lx = j & 15, lz = (j >> 4) & 15, y = (j >> 8) - 64;
        solid[j] = view.block(lx, y, lz) !== AIR ? 1 : 0;
        fluid[j] = view.fluid(lx, y, lz);
      }
      const want = seedSectionsOf(solid, fluid);
      expect([name, view.auxB()!.seedSections[0]]).toEqual([name, want]);
      masks.push(want);
    }
    // The coast's shore and the cave water beside cave air seed somewhere; no mask reaches past section 23.
    expect(masks.some((m) => m !== 0)).toBe(true);
    for (const m of masks) expect(m >>> 24).toBe(0);
  }, 120_000);

  test('the columns hold barriers and lava between them (the rules above are exercised)', () => {
    let barriers = 0, lava = 0;
    for (const [, c, [cx, cz]] of COLUMNS) {
      const dc = dcOf(c);
      const { view } = generate(c, cx, cz);
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        for (let y = -63; y <= 319; y++) {
          if (view.block(lx, y, lz) !== AIR && !solidAt(dc, 16 * cx + lx, y, 16 * cz + lz)) barriers++;
          if (fluidType(view.fluid(lx, y, lz)) === FLUID_LAVA) lava++;
        }
      }
    }
    expect(barriers).toBeGreaterThan(0);
    expect(lava).toBeGreaterThan(0);
  }, 120_000);

  test('with aquifer.enabled false no tagged voxel holds fluid, and untagged air keeps D19\'s rule (the sea and the coast fill as before)', () => {
    const off = ctxFor('42', { aquifer: { enabled: false } });
    for (const col of [COAST, SEA, OVERHANG] as const) {
      const e = expectedFor(ctx, col);
      const { view } = generate(off, col[0], col[1]);
      const on = generate(ctx, col[0], col[1]).view;
      let tagged = 0, untagged = 0;
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        for (let y = -63; y <= 319; y++) {
          if (view.block(lx, y, lz) !== AIR) continue;
          const f = view.fluid(lx, y, lz);
          if (caveKindOf(view.cave(lx, y, lz)) !== 0) {
            tagged++;
            expect(f, `(${lx}, ${y}, ${lz})`).toBe(0);
            continue;
          }
          untagged++;
          expect(f, `(${lx}, ${y}, ${lz})`).toBe(y <= Math.floor(e.swl[p]!) ? WATER_SOURCE : 0);
          if (on.block(lx, y, lz) === AIR && caveKindOf(on.cave(lx, y, lz)) === 0) expect(on.fluid(lx, y, lz)).toBe(f);
        }
      }
      expect([tagged > 0, untagged > 0]).toEqual([true, true]);
    }
  }, 120_000);

  test('aquiferOf(ctx) reads ctx.params.aquifer through the schema noises: equal cellStatus with aquiferInputs(ctx, DEFAULTS.aquifer, DEFAULTS.aquifer.noises) at 64 cells of seed \'42\' (rulings P4)', () => {
    const viaSchema = aquiferOf(ctx);
    const viaDefaults = aquiferInputs(ctx, DEFAULTS.aquifer, DEFAULTS.aquifer.noises);
    expect(viaSchema.settings).toEqual(DEFAULTS.aquifer);
    // §1.9's defaults as Tasks 5-6 pinned them before the schema (rulings P5; abyssMargin 0.06, Task 6's m).
    const noise = (wavelength: number) => completeNoiseDef({ wavelength, octaves: 1, double: true, clampSigma: 3 });
    expect(DEFAULTS.aquifer).toEqual({
      enabled: true, surfaceBand: 12, thresholds: { fullInland: 0.8, fullOcean: -0.3, partialInland: 0.4, partialOcean: -0.8 },
      lavaMaxLevel: -10, lavaThreshold: 0.3, lavaLevel: -54, barrierBand: 25, abyssMargin: 0.06,
      noises: { floodedness: noise(128), spread: noise(32), lava: noise(2), barrier: noise(8) },
    });
    let flooded = 0;
    for (let n = 0; n < 64; n++) {
      const i = (n % 4) - 2, j = (n >> 2) % 8 - 6, k = (n >> 5) - 1;
      const s = cellStatus(viaSchema, i * 7, j, k * 5);
      expect([n, s]).toEqual([n, cellStatus(viaDefaults, i * 7, j, k * 5)]);
      if (s !== 0) flooded++;
    }
    expect(flooded).toBeGreaterThan(0);
  });
});

describe('sky-open water under island runs (SP7a D19, O56; SP3e spec §3.5)', () => {
  /** aquiferColumn's index `256·(y + 64) + p`. */
  const wi = (y: number, p: number): number => ((y + 64) << 8) | p;
  /** The SEA fixture's ColumnSample: its surfaceWaterLevel (63 at every position) is all D19's rule reads of it. */
  const S_SEA = buildColumnSample(ctx, SEA[0], SEA[1], newColumnSample());
  const PASS_SEA = fillCaveColumnPass(cavePickerOf(ctx), S_SEA, newCaveColumnPass());
  /** A constructed solidity: at each position p the solid runs `runsAt(p)` ([bottom, top], inclusive). */
  const solidOf = (runsAt: (p: number) => ReadonlyArray<readonly [number, number]>): Uint8Array => {
    const solid = new Uint8Array(98304);
    for (let p = 0; p < 256; p++) {
      for (const [lo, hi] of runsAt(p)) for (let y = lo; y <= hi; y++) solid[wi(y, p)] = 1;
    }
    return solid;
  };
  /** The aquifer step over `solid` with no tagged voxel (every non-solid voxel is the terrain's own air). */
  const fluidOf = (solid: Uint8Array) => {
    const fluid = new Uint8Array(98304), waterV = new Uint8Array(98304), topFluid = new Int32Array(256), tags = new Uint8Array(98304);
    const s = solid.slice();
    aquiferColumn(aquiferOf(ctx), S_SEA, cavePickerOf(ctx), PASS_SEA, s, tags, waterV, fluid, topFluid, createAquiferScratch());
    expect(s).toEqual(solid);
    return { fluid, waterV, topFluid };
  };
  const GROUND = [-63, 20] as const;
  const B = ISLAND_RUN_MIN_BOTTOM;

  test('ISLAND_RUN_MIN_BOTTOM is 181 (§4.1: one constant for the islands branch, the density tops under islands and Z3)', () => {
    expect(ISLAND_RUN_MIN_BOTTOM).toBe(181);
  });

  test('untagged air fills to y 63 under whatever lies above it (D19 reads no top): ground, islands with bottom 180 or 181, stacked islands, an overhang lip, a peak, a floating rock', () => {
    const CASES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
      [GROUND], // the sea fixture's floor
      [GROUND, [B - 1, 230]], // bottom 180: under water v0 a dry hole
      [GROUND, [B, 230]], // bottom 181: an island
      [GROUND, [200, 210], [240, 250]], // stacked islands
      [GROUND, [150, 200]], // an overhang lip reaching above 180
      [[-63, 300]], // a peak: no air at or below 63
      [GROUND, [30, 40], [B + 10, 260]], // a low floating rock under an island
      [[200, 230]], // an island with no ground: the water reaches y −63
    ];
    const solid = solidOf((p) => CASES[p % CASES.length]!);
    const { fluid, waterV, topFluid } = fluidOf(solid);
    for (let p = 0; p < 256; p++) {
      let highest = -65;
      for (let y = -64; y <= 319; y++) {
        const i = wi(y, p);
        const want = y > -64 && solid[i] === 0 && y <= 63 ? WATER_SOURCE : 0;
        if (fluid[i] !== want || waterV[i] !== (want !== 0 ? 1 : 0)) throw new Error(`case ${p % CASES.length}, p ${p}, y ${y}: ${fluid[i]} ≠ ${want}`);
        if (want !== 0) highest = y;
      }
      expect([p, topFluid[p]]).toEqual([p, highest]);
    }
    // The peak holds none; the island with no ground fills y −63 … 63.
    expect(topFluid[5]).toBe(-65);
    expect(fluid.reduce((n, f, i) => n + ((i & 255) === 7 && f !== 0 ? 1 : 0), 0)).toBe(63 + 63 + 1);
  });

  /**
   * A real island over the sea: the default tree with its islands tap's child (`root.b.x`, const −1e6) replaced by a
   * slab, solid at y 200 … 210 everywhere (voxel placement), with `islands.enabled` (the flag); MUTED is the same world
   * with the default tree (the tap muted).
   */
  const slabTree = (): JsonValue => {
    const t = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { b: { x: unknown } } };
    t.root.b.x = { op: 'rangeChoice', x: { op: 'y' }, lo: 200, hi: 211, inside: { op: 'const', v: 1 }, outside: { op: 'const', v: -1000000 } };
    return t as unknown as JsonValue;
  };
  const SLAB = ctxFor('42', { density: { defs: slabTree() }, islands: { enabled: true } });
  const SLAB_OFF = ctxFor('42', { density: { defs: slabTree() } });
  const MUTED = ctxFor('42', { islands: { enabled: true } });

  test('a slab island over the sea fixture: the water under it equals the muted column\'s, flag or not (O56); heightmaps are the island top + 1, the top-down scan', () => {
    const slab = generate(SLAB, ...SEA).view;
    const muted = generate(MUTED, ...SEA).view;
    const off = generate(SLAB_OFF, ...SEA).view;
    const aux = slab.aux()!;
    let under = 0, offUnder = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= 319; y++) {
        const island = y >= 200 && y <= 210;
        // Solidity: the muted column's plus the slab (the slab's states and those under it may differ: D21).
        expect(slab.block(lx, y, lz) !== AIR).toBe(island || muted.block(lx, y, lz) !== AIR);
        expect(slab.fluid(lx, y, lz)).toBe(island ? 0 : muted.fluid(lx, y, lz));
        if (y < 200 && slab.fluid(lx, y, lz) !== 0) under++;
        if (y < 200 && off.fluid(lx, y, lz) !== 0) offUnder++;
        // Flag off, the sea under the slab fills as well (O56): D19's rule reads no top.
        if (y < 200 && off.block(lx, y, lz) === AIR && caveKindOf(off.cave(lx, y, lz)) === 0) expect(off.fluid(lx, y, lz)).toBe(y <= 63 ? WATER_SOURCE : 0);
      }
      expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual([211, 211]);
      expect(topDownHeightmaps(slab, lx, lz)).toEqual([211, 211]);
    }
    expect(under).toBeGreaterThan(256 * 20);
    // Flag off (water v0 left a dry hole there): the sea under the slab fills too (SP7a D19, O56).
    expect(offUnder).toBeGreaterThan(256 * 20);
  });

  test('the probe column and terrainSurfaceDebug pass the flag: the slab column\'s scans agree and the sea floor runs have water above them', () => {
    const scan = newSurfaceScan();
    terrainSurfaceDebug(SLAB, ...SEA, scan);
    const probeScan = surfaceProbeColumn(scOf(SLAB), ...SEA).scan;
    expect(scanSnapshot(scan)).toEqual(scanSnapshot(probeScan));
    let wet = 0;
    for (let p = 0; p < 256; p++) {
      const first = scan.runFirst[p]!;
      // The slab, then the sea floor under 63 with water above its top (SP6a's caves under the sea floor add runs below:
      // the wet roof closes them within 20 blocks of the bed and leaves them open from 40 down, D7, so a third run stays).
      expect(scan.runFirst[p + 1]! - first).toBeGreaterThanOrEqual(2);
      expect([scan.runTop[first], scan.runBottom[first]]).toEqual([210, 200]);
      if (scan.runWaterAbove[first + 1] === 1 && scan.runWaterTop[first + 1] === 63) wet++;
    }
    expect(wet).toBe(256);
  });

  test.each(FIXTURES)('%s: on a default-tree column without a run above y 180 the flag changes nothing (blocks, fluid, heightmaps, aux B)', (_name, [cx, cz]) => {
    const a = generate(ctx, cx, cz).view;
    const b = generate(MUTED, cx, cz).view;
    // The premise: no run whose bottom voxel is ≥ ISLAND_RUN_MIN_BOTTOM (a detached peak above y 180 would lose its
    // sky-open palette with the flag, D21 (b); floatingRules.test.ts pins that on amplified's window).
    let high = 0;
    for (let p = 0; p < 256; p++) {
      for (let y = ISLAND_RUN_MIN_BOTTOM; y <= 319; y++) if (a.block(p & 15, y, p >> 4) !== AIR && a.block(p & 15, y - 1, p >> 4) === AIR) high++;
    }
    expect(high).toBe(0);
    let bad = 0;
    for (let y = -64; y <= 319; y++) {
      for (let p = 0; p < 256; p++) {
        if (a.block(p & 15, y, p >> 4) !== b.block(p & 15, y, p >> 4) || a.fluid(p & 15, y, p >> 4) !== b.fluid(p & 15, y, p >> 4)) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(Array.from(b.aux()!.worldSurfaceWG)).toEqual(Array.from(a.aux()!.worldSurfaceWG));
    expect(Array.from(b.aux()!.oceanFloorWG)).toEqual(Array.from(a.aux()!.oceanFloorWG));
    expect(Array.from(b.aux()!.surfaceBiome)).toEqual(Array.from(a.aux()!.surfaceBiome));
    expect(Array.from(b.auxB()!.surfaceBiomeQ)).toEqual(Array.from(a.auxB()!.surfaceBiomeQ));
  });
});

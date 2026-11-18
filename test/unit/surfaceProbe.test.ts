import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonValue } from '../../src/core/params/json';
import { noiseFor, type GenContext } from '../../src/gen/context';
import { cavePickerOf } from '../../src/gen/biomes/cavePicker';
import { aquiferColumn, aquiferOf, createAquiferScratch } from '../../src/gen/fluids/aquifer';
import { terrainStage, terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf, surfaceNoiseSource, type SurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbe, surfaceProbeColumn } from '../../src/gen/surface/probe';
import { RuleValidationError } from '../../src/gen/surface/rules';
import { newSurfaceScan, surfaceScanSettings, type SurfaceScan } from '../../src/gen/surface/scan';
import { CAVE_KIND, caveKindOf } from '../../src/core/constants';
import { AIR, BEDROCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import { FLUID_WATER, fluidType } from '../../src/world/blocks/fluid';
import { newCaveColumnPass } from '../../src/gen/biomes/cavePicker';
import type { ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { cavesMuted } from '../harness/sp5cTrees';
import { legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { testFloat, testRng } from '../harness/stats';
import { registeredKey, withRegisteredBlocks } from '../harness/surfaceFuzz';

const MiB = 1 << 20;
const NEVER = () => false;

/**
 * Columns of world seed '42' (default profile) from terrainStage.test.ts (SP3a/SP3b fixtures on the row cz −2000):
 * dry land, open sea, a lake, a river channel, a coast, water under an overhang and water walls. The tests re-derive
 * what they rely on.
 */
const LAND = [-1963, -2000] as const;
const SEA = [-2000, -2000] as const;
const LAKE = [-1001, -2000] as const;
const RIVER = [-742, -2000] as const;
const COAST = [-1667, -2000] as const;
const OVERHANG = [-1238, -2000] as const;
const WALL = [-1689, -2000] as const;
const FIXTURES = [['land', LAND], ['sea', SEA], ['lake', LAKE], ['river', RIVER], ['coast', COAST], ['overhang', OVERHANG], ['wall', WALL]] as const;

const CTX = ctxFor('42');
/** The legacy default tree (SP3d: the data default resolves to it, §2.2), as an exact copy of registered keys. */
const RULES = withRegisteredBlocks(legacyDefaultSurfaceRules(CTX.params.surface));
const SC = createSurfaceContext(CTX, RULES);
const DEEPSLATE = REGISTRY.parseStateKey(registeredKey('deepslate'));

function generate(c: GenContext, cx: number, cz: number): ColumnView {
  const store = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
  const w = store.claimColumn(cx, cz, 0);
  expect(terrainStage(c, cx, cz, w, NEVER)).toBe(true);
  w.commit(1);
  return store.proto(cx, cz)!;
}

const VIEWS = new Map<string, ColumnView>();
const viewOf = ([cx, cz]: readonly [number, number]): ColumnView => {
  const key = `${cx}|${cz}`;
  let v = VIEWS.get(key);
  if (v === undefined) VIEWS.set(key, (v = generate(CTX, cx, cz)));
  return v;
};

describe('SurfaceContext (spec §3.6)', () => {
  test('surfaceNoiseSource: the GenContext\'s surface.noises.* NormalNoises by schema path, 2D, remap none, clampSigma 3; nothing else', () => {
    const src = surfaceNoiseSource(CTX);
    const next = testRng(81);
    for (const path of ['surface.noises.depth', 'surface.noises.patch', 'surface.noises.bandOffset']) {
      const n = src(path)!;
      expect([n.dims, n.remap, n.clampSigma]).toEqual([2, 'none', 3]);
      const ref = noiseFor(CTX, path);
      for (let i = 0; i < 200; i++) {
        const x = Math.floor((testFloat(next) - 0.5) * 2e6), z = Math.floor((testFloat(next) - 0.5) * 2e6);
        expect(Object.is(n.z2(x, z), ref.z2(x, z))).toBe(true);
      }
    }
    for (const name of ['density.noises.jag', 'surface.noises.fuzzB', 'depth', 'surface.depthMul']) expect(src(name), name).toBeUndefined();
  });

  test('createSurfaceContext: settings from params.surface, the tree validated, compiled and its reference; its own DensityContext and probe column', () => {
    const set = surfaceScanSettings(CTX.seed, CTX.params.surface, SC.noises);
    expect({ ...SC.settings, depthNoise: null }).toEqual({ ...set, depthNoise: null });
    expect(SC.settings.depthNoise).toBe(SC.noises('surface.noises.depth'));
    expect(SC.settings.sdMax).toBe(11);
    expect(canonicalJSON(SC.rules)).toBe(canonicalJSON(RULES));
    expect(SC.compiled.rules).toBe(SC.rules);
    expect(SC.reference.rules).toBe(SC.rules);
    expect(SC.compiled.settings).toBe(SC.settings);
    expect(SC.compiled.fastPath!.maxSurfaceDepth).toBe(15);
    expect(SC.params).toBe(CTX.params.surface);
    expect(SC.density.ctx).toBe(CTX);
    const other = createSurfaceContext(CTX, RULES);
    expect(other.density).not.toBe(SC.density);
    expect(other.probeColumn).not.toBe(SC.probeColumn);
    expect(other.probeColumn.valid).toBe(false);
    // The settings follow the context's params.
    const flat = createSurfaceContext(ctxFor('42', { surface: { depthMul: 0, lapse: 0.01, lapseBase: 100 } }), RULES);
    expect([flat.settings.sdMax, flat.settings.depthMul, flat.settings.lapse, flat.settings.lapseBase, flat.compiled.fastPath!.maxSurfaceDepth]).toEqual([3, 0, 0.01, 100, 7]);
  });

  test('surfaceContextOf memoises the default SurfaceContext per GenContext; createSurfaceContext(ctx) builds the default tree apart', () => {
    const c = ctxFor('42');
    const sc = surfaceContextOf(c);
    expect(surfaceContextOf(c)).toBe(sc);
    expect(surfaceContextOf(CTX)).not.toBe(sc);
    expect(sc.ctx).toBe(c);
    expect(canonicalJSON(sc.rules)).toBe(canonicalJSON(legacyDefaultSurfaceRules(c.params.surface)));
    const apart = createSurfaceContext(c);
    expect(apart).not.toBe(sc);
    expect(apart.density).not.toBe(sc.density);
    expect(canonicalJSON(apart.rules)).toBe(canonicalJSON(sc.rules));
    // The default tree follows the context's params.
    const warm = surfaceContextOf(ctxFor('42', { surface: { snowline: -0.9, cliffMinY: 120 } }));
    expect(canonicalJSON(warm.rules)).toBe(canonicalJSON(legacyDefaultSurfaceRules(warm.params)));
    expect(canonicalJSON(warm.rules)).not.toBe(canonicalJSON(sc.rules));
  });

  test('an invalid tree throws a RuleValidationError', () => {
    expect(() => createSurfaceContext(CTX, { kind: 'block', state: 'not_a_block' })).toThrow(RuleValidationError);
    expect(() => createSurfaceContext(CTX, { kind: 'condition', if: { kind: 'noiseThreshold', noise: 'surface.noises.missing', min: 0, max: 1 }, then: { kind: 'block', state: 'stone' } })).toThrow(RuleValidationError);
  });
});

describe('the probe\'s column rebuild (spec §3.6): the T stage\'s fill, the carve (SP6a §3.4), the aquifer step (SP7a §1.7) and biome buffer', () => {
  test('8 columns with carvers: the rebuilt solidity and water equal the T stage\'s at every voxel, its states the stored blocks at every solid voxel within 16 blocks below a run\'s top (the carved floors\' skins among them)', () => {
    // Columns a worm, a ravine or an underground worm crosses at seed 42: the caverns' cave class column and its east
    // neighbour, a ravine open to the sky at (4, −10) and the columns along it, and (0, 0) and (3, 0).
    const cols: ReadonlyArray<readonly [number, number]> = [[546, 25857], [547, 25857], [4, -10], [5, -10], [5, -9], [6, -9], [0, 0], [3, 0]];
    const sc = surfaceContextOf(CTX);
    let carved = 0, skins = 0;
    for (const col of cols) {
      const view = generate(CTX, col[0], col[1]);
      const c = surfaceProbeColumn(sc, col[0], col[1]);
      const bad: string[] = [];
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        let runTop = -65;
        for (let y = 319; y >= -63; y--) {
          const i = ((y + 64) << 8) | p;
          const block = view.block(lx, y, lz);
          const k = caveKindOf(view.cave(lx, y, lz));
          if (k === CAVE_KIND.worm || k === CAVE_KIND.ravine || k === CAVE_KIND.undergroundWorm) carved++;
          if ((c.solid[i] !== 0) !== (block !== AIR)) bad.push(`(${lx}, ${y}, ${lz}): rebuilt ${c.solid[i]}, block ${block}`);
          if ((c.water[i] !== 0) !== (fluidType(view.fluid(lx, y, lz)) === FLUID_WATER)) bad.push(`(${lx}, ${y}, ${lz}): rebuilt water ${c.water[i]}`);
          if (block === AIR) { runTop = -65; continue; }
          if (runTop === -65) runTop = y;
          if (runTop - y >= 16) continue;
          skins++;
          const got = surfaceProbe(sc, 16 * col[0] + lx, y, 16 * col[1] + lz).state;
          if (got !== block) bad.push(`(${lx}, ${y}, ${lz}): probe ${REGISTRY.stateKey(got)} ≠ block ${REGISTRY.stateKey(block)}`);
        }
      }
      expect([col, bad.slice(0, 10)]).toEqual([col, []]);
    }
    expect(carved).toBeGreaterThan(0);
    expect(skins).toBeGreaterThan(0);
  });

  test.each(FIXTURES)('%s: solidity and water equal the T stage\'s blocks and water at every voxel; the biome buffer is aux A\'s surfaceBiome', (_name, col) => {
    const view = viewOf(col);
    const c = surfaceProbeColumn(SC, col[0], col[1]);
    expect([c.valid, c.cx, c.cz]).toEqual([true, col[0], col[1]]);
    let bad = 0, solid = 0, water = 0;
    for (let y = -63; y <= 319; y++) {
      for (let p = 0; p < 256; p++) {
        const i = ((y + 64) << 8) | p;
        const lx = p & 15, lz = p >> 4;
        if ((c.solid[i] !== 0) !== (view.block(lx, y, lz) !== AIR)) bad++;
        if ((c.water[i] !== 0) !== (fluidType(view.fluid(lx, y, lz)) === FLUID_WATER)) bad++;
        if (c.solid[i] !== 0) solid++;
        if (c.water[i] !== 0) water++;
      }
    }
    expect(bad).toBe(0);
    expect(solid).toBeGreaterThan(0);
    for (let p = 0; p < 256; p++) expect(c.biomes[p]).toBe(view.aux()!.surfaceBiome[p]);
    if (col !== LAND) expect(water).toBeGreaterThan(0);
  });

  test('SP6b §2.3 (Task 18): the probe tags and picks as T: on 8 columns its scan equals terrainSurfaceDebug\'s (runFloorBiome, runCeilBiome and the cave pass included), its cave bytes T\'s', () => {
    /** Every field `scanColumn` writes, the per-run arrays over the runs in use, and the cave picker's pass. */
    const snapshot = (scan: SurfaceScan): unknown => {
      const runs = scan.runFirst[256]!;
      const per = (a: { subarray(b: number, e: number): ArrayLike<number> }) => Array.from(a.subarray(0, runs));
      const pass = scan.cavePass;
      return {
        cx: scan.cx, cz: scan.cz, runFirst: Array.from(scan.runFirst), skyRun: Array.from(scan.skyRun),
        runTop: per(scan.runTop), runBottom: per(scan.runBottom), runWaterAbove: per(scan.runWaterAbove), runWaterTop: per(scan.runWaterTop),
        runFloorBiome: per(scan.runFloorBiome), runCeilBiome: per(scan.runCeilBiome),
        steep: Array.from(scan.steep), T: Array.from(scan.T), biome: Array.from(scan.biome),
        lakeLevel: Array.from(scan.lakeLevel), surfaceDepth: Array.from(scan.surfaceDepth),
        pass: pass === null ? null : { cx: pass.cx, cz: pass.cz, j: pass.j, c: Array.from(pass.c), e: Array.from(pass.e), h: Array.from(pass.h), y0: Array.from(pass.y0) },
      };
    };
    // The carver columns of the test above (caverns, a ravine, (0, 0)), and Task 17's abyss and lush columns.
    const cols: ReadonlyArray<readonly [number, number]> = [[546, 25857], [547, 25857], [4, -10], [5, -9], [0, 0], [40, 900], [-3000, -1182], [200, 467]];
    const sc = createSurfaceContext(CTX);
    const inputs = cavePickerOf(CTX);
    const floors = new Set<number>(), ceilings = new Set<number>();
    for (const [cx, cz] of cols) {
      const view = generate(CTX, cx, cz);
      const scan = newSurfaceScan();
      terrainSurfaceDebug(CTX, cx, cz, scan);
      const c = surfaceProbeColumn(sc, cx, cz);
      expect(c.scan.cavePicker, `(${cx}, ${cz})`).toBe(inputs);
      expect(scan.cavePicker).toBe(inputs);
      expect(c.scan.cavePass).toBe(c.pass);
      expect(snapshot(c.scan), `(${cx}, ${cz})`).toEqual(snapshot(scan));
      let bad = 0;
      for (let i = 256; i < 98304; i++) if (c.tags[i] !== view.cave(i & 15, (i >> 8) - 64, (i >> 4) & 15)) bad++;
      expect(bad, `(${cx}, ${cz}) cave bytes`).toBe(0);
      for (let r = 0; r < c.scan.runFirst[256]!; r++) {
        floors.add(c.scan.runFloorBiome[r]!);
        ceilings.add(c.scan.runCeilBiome[r]!);
      }
    }
    // Runs under cave air of each biome, and runs with no cave above (−1).
    expect([...floors].sort()).toEqual([-1, 0, 1, 2, 3]);
    expect(ceilings.size).toBeGreaterThan(2);
  }, 120_000);

  test('aquiferColumn checks its array sizes', () => {
    const s = SC.density.columns.get(0, 0);
    const inp = aquiferOf(CTX);
    const pick = cavePickerOf(CTX);
    const pass = newCaveColumnPass();
    const ok = (): Uint8Array => new Uint8Array(98304);
    const sc = createAquiferScratch();
    const t = new Int32Array(256);
    expect(() => aquiferColumn(inp, s, pick, pass, new Uint8Array(4096), ok(), ok(), ok(), t, sc)).toThrow(RangeError);
    expect(() => aquiferColumn(inp, s, pick, pass, ok(), new Uint8Array(4096), ok(), ok(), t, sc)).toThrow(RangeError);
    expect(() => aquiferColumn(inp, s, pick, pass, ok(), ok(), new Uint8Array(256), ok(), t, sc)).toThrow(RangeError);
    expect(() => aquiferColumn(inp, s, pick, pass, ok(), ok(), ok(), new Uint8Array(98303), t, sc)).toThrow(RangeError);
    expect(() => aquiferColumn(inp, s, pick, pass, ok(), ok(), ok(), ok(), new Int32Array(255), sc)).toThrow(RangeError);
  });

  test('SP7a §1.7 (Task 13): on 8 columns with flooded caves the probe\'s scan equals terrainSurfaceDebug\'s, runWaterAbove set on cave runs under aquifer water', () => {
    const cols: ReadonlyArray<readonly [number, number]> = [SEA, COAST, OVERHANG, WALL, RIVER, LAKE, [0, 0], [40, 900]];
    const sc = createSurfaceContext(CTX);
    let caveRunsUnderWater = 0;
    for (const [cx, cz] of cols) {
      const view = generate(CTX, cx, cz);
      const scan = newSurfaceScan();
      terrainSurfaceDebug(CTX, cx, cz, scan);
      const c = surfaceProbeColumn(sc, cx, cz);
      const runs = scan.runFirst[256]!;
      const per = (a: { subarray(b: number, e: number): ArrayLike<number> }) => Array.from(a.subarray(0, runs));
      expect([cx, cz, Array.from(c.scan.runFirst), per(c.scan.runTop), per(c.scan.runBottom), per(c.scan.runWaterAbove), per(c.scan.runWaterTop)])
        .toEqual([cx, cz, Array.from(scan.runFirst), per(scan.runTop), per(scan.runBottom), per(scan.runWaterAbove), per(scan.runWaterTop)]);
      for (let p = 0; p < 256; p++) {
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          if (scan.runWaterAbove[r] !== 1) continue;
          // A run whose water above is cave water: the voxel above its top is a tagged water voxel.
          const y = scan.runTop[r]! + 1;
          if (caveKindOf(view.cave(p & 15, y, p >> 4)) !== 0 && fluidType(view.fluid(p & 15, y, p >> 4)) === FLUID_WATER) caveRunsUnderWater++;
        }
      }
    }
    expect(caveRunsUnderWater).toBeGreaterThan(0);
  }, 120_000);

  test('with islands.enabled the rebuild fills the sea under a slab island as the T stage does (SP3e spec §3.5, SP7a D19)', () => {
    // The default tree with the islands tap's child replaced by a slab solid at y 200 … 210 (voxel placement).
    const tree = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { b: { x: unknown } } };
    tree.root.b.x = { op: 'rangeChoice', x: { op: 'y' }, lo: 200, hi: 211, inside: { op: 'const', v: 1 }, outside: { op: 'const', v: -1000000 } };
    const slab = ctxFor('42', { density: { defs: tree as unknown as JsonValue }, islands: { enabled: true } });
    const view = generate(slab, ...SEA);
    const c = surfaceProbeColumn(createSurfaceContext(slab), ...SEA);
    let bad = 0, under = 0;
    for (let y = -63; y <= 319; y++) {
      for (let p = 0; p < 256; p++) {
        const i = ((y + 64) << 8) | p;
        const lx = p & 15, lz = p >> 4;
        if ((c.solid[i] !== 0) !== (view.block(lx, y, lz) !== AIR)) bad++;
        if ((c.water[i] !== 0) !== (fluidType(view.fluid(lx, y, lz)) === FLUID_WATER)) bad++;
        if (c.water[i] !== 0 && y < 200) under++;
      }
    }
    expect(bad).toBe(0);
    expect(under).toBeGreaterThan(0);
  });

  test('the one-column cache: a second probe in the column reuses it; another column rebuilds it', () => {
    const sc = createSurfaceContext(CTX, RULES);
    const [cx, cz] = LAND;
    const x = 16 * cx + 3, z = 16 * cz + 5;
    surfaceProbe(sc, x, 0, z);
    const c = sc.probeColumn;
    // Poke the cached solidity: the next probe in the column must read it (no rebuild).
    const i = ((319 + 64) << 8) | (5 * 16 + 3);
    expect(c.solid[i]).toBe(0);
    c.solid[i] = 1;
    expect(surfaceProbeColumn(sc, cx, cz).solid[i]).toBe(1);
    surfaceProbe(sc, 16 * SEA[0], 0, 16 * SEA[1]);
    expect([c.cx, c.cz]).toEqual([...SEA]);
    expect(surfaceProbeColumn(sc, cx, cz).solid[i]).toBe(0);
    expect(surfaceProbe(sc, x, 319, z)).toEqual({ state: AIR, path: [] });
  });
});

describe('surfaceProbe (spec §3.6)', () => {
  test.each([['land', LAND], ['sea', SEA], ['overhang', OVERHANG]] as const)('%s: its state equals the compiled tree with the fast path at every solid voxel; its path is a root-to-leaf chain', (_name, col) => {
    const [cx, cz] = col;
    const c = surfaceProbeColumn(SC, cx, cz);
    const out = new Uint16Array(98304);
    const evaluated = SC.compiled.fillColumn(c.scan, out, true);
    let fast = 0, checked = 0;
    for (let p = 0; p < 256; p++) {
      const x = 16 * cx + (p & 15), z = 16 * cz + (p >> 4);
      for (let y = -63; y <= 319; y++) {
        const i = ((y + 64) << 8) | p;
        if (c.solid[i] === 0) continue;
        const r = surfaceProbe(SC, x, y, z);
        checked++;
        if (r.state !== out[i]) throw new Error(`(${x}, ${y}, ${z}): probe ${r.state}, compiled ${out[i]}`);
        if (r.path.length > 0) {
          expect(r.path[0]).toBe('root');
          for (let k = 1; k < r.path.length; k++) expect(r.path[k]!.startsWith(`${r.path[k - 1]}.`)).toBe(true);
        } else {
          expect(r.state).toBe(STONE);
        }
      }
    }
    fast = checked - evaluated;
    expect(fast).toBeGreaterThan(checked / 2);
  });

  test('a fast-path deepslate voxel at y −30 reports the deepslate rule (root.rules[3].then since SP6b\'s rule 4)', () => {
    const [cx, cz] = LAND;
    // Without SP6a's caves (which split the land column's run above y −30), as the SP3c fixture was.
    const noCaves = ctxFor('42', { density: { defs: cavesMuted(DEFAULT_DENSITY_TREE) as JsonValue } });
    const SC = createSurfaceContext(noCaves, RULES);
    const c = surfaceProbeColumn(SC, cx, cz);
    const p = 0;
    const r0 = c.scan.runFirst[p]!;
    // y −30 lies in the land column's sky-open run, more than maxSurfaceDepth below its top: the fast path's band.
    expect(c.scan.runBottom[r0]).toBe(-63);
    expect(c.scan.runTop[r0]! - -30).toBeGreaterThan(SC.compiled.fastPath!.maxSurfaceDepth);
    expect(surfaceProbe(SC, 16 * cx, -30, 16 * cz)).toEqual({ state: DEEPSLATE, path: ['root', 'root.rules[3]', 'root.rules[3].then'] });
  });

  test('a badlands band voxel reports the bandlands leaf ([1][3][1][1]) with the stage\'s terracotta; its top the red_sand leaf', () => {
    // U2's badlands class column (SP3c spec §3.5): every position is badlands, none a cliff.
    const [cx, cz] = [-26426, -31088] as const;
    const c = surfaceProbeColumn(SC, cx, cz);
    const view = viewOf([cx, cz]);
    /** The rule ids from root to a leaf id. */
    const chain = (leaf: string): string[] => {
      const out = ['root'];
      let id = 'root';
      for (const m of leaf.slice(4).matchAll(/\.rules\[\d+\]|\.then/g)) out.push((id += m[0]));
      return out;
    };
    const BADLANDS = 'root.rules[1].then.rules[3].then.rules[1].then';
    let bands = 0;
    for (let p = 0; p < 256; p++) {
      const top = c.scan.runTop[c.scan.runFirst[p]!]!;
      const x = 16 * cx + (p & 15), z = 16 * cz + (p >> 4);
      expect(surfaceProbe(SC, x, top, z)).toEqual({ state: REGISTRY.parseStateKey('red_sand'), path: chain(`${BADLANDS}.rules[0].then`) });
      // Down the sky-open run only: a carver may open a cave within the band (SP6a), and below it lies another run.
      const bottom = c.scan.runBottom[c.scan.runFirst[p]!]!;
      for (let d = 1; d <= c.scan.surfaceDepth[p]! && top - d >= bottom; d++) {
        const got = surfaceProbe(SC, x, top - d, z);
        expect(got.path).toEqual(chain(`${BADLANDS}.rules[1]`));
        expect(REGISTRY.stateKey(got.state)).toMatch(/terracotta$/);
        expect(got.state).toBe(view.block(p & 15, top - d, p >> 4));
        bands++;
      }
    }
    expect(bands).toBeGreaterThan(200);
  });

  test('[] for air, water and y −64 (bedrock); [] and stone for an overhang\'s stone at y ≥ 8 (a run without sky)', () => {
    const [lx0, lz0] = LAND;
    expect(surfaceProbe(SC, 16 * lx0, 319, 16 * lz0)).toEqual({ state: AIR, path: [] });
    expect(surfaceProbe(SC, 16 * lx0 + 7, -64, 16 * lz0 + 9)).toEqual({ state: BEDROCK, path: [] });
    const [sx, sz] = SEA;
    const sea = surfaceProbeColumn(SC, sx, sz);
    expect(sea.scan.runWaterAbove[sea.scan.runFirst[0]!]).toBe(1);
    const wy = sea.scan.runWaterTop[sea.scan.runFirst[0]!]!;
    expect(sea.water[((wy + 64) << 8) | 0]).toBe(1);
    expect(surfaceProbe(SC, 16 * sx, wy, 16 * sz)).toEqual({ state: AIR, path: [] });
    const [ox, oz] = OVERHANG;
    const c = surfaceProbeColumn(SC, ox, oz);
    let found = 0;
    for (let p = 0; p < 256; p++) {
      for (let r = c.scan.runFirst[p]! + 1; r < c.scan.runFirst[p + 1]!; r++) {
        for (let y = Math.max(8, c.scan.runBottom[r]!); y <= c.scan.runTop[r]!; y++) {
          found++;
          expect(surfaceProbe(SC, 16 * ox + (p & 15), y, 16 * oz + (p >> 4))).toEqual({ state: STONE, path: [] });
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  test('a SurfaceContext built apart answers alike', () => {
    const other = createSurfaceContext(CTX, RULES);
    const next = testRng(82);
    for (const [, [cx, cz]] of FIXTURES) {
      for (let i = 0; i < 64; i++) {
        const x = 16 * cx + (next() & 15), z = 16 * cz + (next() & 15), y = 40 + (next() % 60);
        expect(surfaceProbe(other, x, y, z)).toEqual(surfaceProbe(SC, x, y, z));
      }
    }
  });

  test('argument checks: integer coordinates, the world window, y −64 … 319', () => {
    const sc: SurfaceContext = SC;
    expect(() => surfaceProbe(sc, 0.5, 0, 0)).toThrow(RangeError);
    expect(() => surfaceProbe(sc, 0, 0, Number.NaN)).toThrow(RangeError);
    expect(() => surfaceProbe(sc, 524288, 0, 0)).toThrow(RangeError);
    expect(() => surfaceProbe(sc, 0, 0, -524289)).toThrow(RangeError);
    expect(() => surfaceProbe(sc, 0, -65, 0)).toThrow(RangeError);
    expect(() => surfaceProbe(sc, 0, 320, 0)).toThrow(RangeError);
    expect(() => surfaceProbe(sc, 0, 1.5, 0)).toThrow(RangeError);
    expect(surfaceProbe(sc, -524288, 319, 524287)).toEqual({ state: AIR, path: [] });
  });
});

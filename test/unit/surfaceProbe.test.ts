import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { noiseFor, type GenContext } from '../../src/gen/context';
import { columnWaterV0, terrainStage } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf, surfaceNoiseSource, type SurfaceContext } from '../../src/gen/surface/context';
import { defaultSurfaceRules } from '../../src/gen/surface/defaults';
import { surfaceProbe, surfaceProbeColumn } from '../../src/gen/surface/probe';
import { RuleValidationError } from '../../src/gen/surface/rules';
import { surfaceScanSettings } from '../../src/gen/surface/scan';
import { AIR, BEDROCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
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
/** The default tree, with a stand-in for palette keys this branch may not register (an exact copy once it does). */
const RULES = withRegisteredBlocks(defaultSurfaceRules(CTX.params.surface));
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
    expect(canonicalJSON(sc.rules)).toBe(canonicalJSON(defaultSurfaceRules(c.params.surface)));
    const apart = createSurfaceContext(c);
    expect(apart).not.toBe(sc);
    expect(apart.density).not.toBe(sc.density);
    expect(canonicalJSON(apart.rules)).toBe(canonicalJSON(sc.rules));
    // The default tree follows the context's params.
    const warm = surfaceContextOf(ctxFor('42', { surface: { snowline: -0.9, cliffMinY: 120 } }));
    expect(canonicalJSON(warm.rules)).toBe(canonicalJSON(defaultSurfaceRules(warm.params)));
    expect(canonicalJSON(warm.rules)).not.toBe(canonicalJSON(sc.rules));
  });

  test('an invalid tree throws a RuleValidationError', () => {
    expect(() => createSurfaceContext(CTX, { kind: 'block', state: 'not_a_block' })).toThrow(RuleValidationError);
    expect(() => createSurfaceContext(CTX, { kind: 'condition', if: { kind: 'noiseThreshold', noise: 'surface.noises.missing', min: 0, max: 1 }, then: { kind: 'block', state: 'stone' } })).toThrow(RuleValidationError);
  });
});

describe('the probe\'s column rebuild (spec §3.6): the T stage\'s fill, water v0 and biome buffer', () => {
  test.each(FIXTURES)('%s: solidity and water equal the T stage\'s blocks and fluid at every voxel; the biome buffer is aux A\'s surfaceBiome', (_name, col) => {
    const view = viewOf(col);
    const c = surfaceProbeColumn(SC, col[0], col[1]);
    expect([c.valid, c.cx, c.cz]).toEqual([true, col[0], col[1]]);
    let bad = 0, solid = 0, water = 0;
    for (let y = -63; y <= 319; y++) {
      for (let p = 0; p < 256; p++) {
        const i = ((y + 64) << 8) | p;
        const lx = p & 15, lz = p >> 4;
        if ((c.solid[i] !== 0) !== (view.block(lx, y, lz) !== AIR)) bad++;
        if ((c.water[i] !== 0) !== (view.fluid(lx, y, lz) !== 0)) bad++;
        if (c.solid[i] !== 0) solid++;
        if (c.water[i] !== 0) water++;
      }
    }
    expect(bad).toBe(0);
    expect(solid).toBeGreaterThan(0);
    for (let p = 0; p < 256; p++) expect(c.biomes[p]).toBe(view.aux()!.surfaceBiome[p]);
    if (col !== LAND) expect(water).toBeGreaterThan(0);
  });

  test('columnWaterV0 checks its array sizes', () => {
    const s = SC.density.columns.get(0, 0);
    const ok = new Uint8Array(98304);
    expect(() => columnWaterV0(s, new Uint8Array(4096), new Int32Array(256), new Int32Array(256), null)).toThrow(RangeError);
    expect(() => columnWaterV0(s, ok, new Int32Array(255), new Int32Array(256), null)).toThrow(RangeError);
    expect(() => columnWaterV0(s, ok, new Int32Array(256), new Int32Array(256), new Uint8Array(256))).toThrow(RangeError);
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

  test('a fast-path deepslate voxel at y −30 reports the deepslate rule (root.rules[2].then)', () => {
    const [cx, cz] = LAND;
    const c = surfaceProbeColumn(SC, cx, cz);
    const p = 0;
    const r0 = c.scan.runFirst[p]!;
    // y −30 lies in the land column's sky-open run, more than maxSurfaceDepth below its top: the fast path's band.
    expect(c.scan.runBottom[r0]).toBe(-63);
    expect(c.scan.runTop[r0]! - -30).toBeGreaterThan(SC.compiled.fastPath!.maxSurfaceDepth);
    expect(surfaceProbe(SC, 16 * cx, -30, 16 * cz)).toEqual({ state: DEEPSLATE, path: ['root', 'root.rules[2]', 'root.rules[2].then'] });
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
      for (let d = 1; d <= c.scan.surfaceDepth[p]!; d++) {
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

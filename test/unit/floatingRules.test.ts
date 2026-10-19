/**
 * floating_islands' surface rules (SP3e spec §4.1-§4.3, §4.5, D6, D7, D21 (b), user point 1): `FLOATING_SURFACE_RULES`
 * = the default rules with `root.rules[1]` (the sky-open condition) wrapped as `sequence[islands branch, sky-open
 * condition]`, the branch's `minY` built from `ISLAND_RUN_MIN_BOTTOM`; with `islands.enabled` the scan's sky-open run
 * of a position is the highest run whose bottom voxel is below `ISLAND_RUN_MIN_BOTTOM` (off: the first run):
 * - the tree: identity across `resolveProfile`, exactly the wrapper (U2's pinned `root.rules[2]` is still the
 *   deepslate gradient), 181 nodes, tier 2 [], rules column cost 2,409,472, a fast path that is not sky-gated with
 *   `maxSurfaceDepth` = 4 + SD_MAX and the default's bands;
 * - the sky-open run: the scan settings carry the flag (the SurfaceContext's from `islands.enabled`), and the scan's
 *   `skyRun` is the highest run with bottom < 181 (or none) with it, the first run without it;
 * - a constructed column on a floating_islands ColumnSample: grass tops, dirt for the position's surface depth, a
 *   3-voxel stone underside, the rest of the skin stone, thin and stacked islands grass-topped; the ground under an
 *   island (and every run the predicate refuses) keeps the default palette — the default rules' states on the same
 *   column without its island runs — and an overhang lip above y 180 takes the island palette (§4.1: the predicate is
 *   wider than an island run);
 * - real columns of seed 42 (`floatingIslands.test.ts`' fixtures): the stage's states (compiled, fast path) equal the
 *   reference evaluator's on the probe's rebuild of the column at every solid voxel, every island run is grass-topped,
 *   and the ground's top under the islands equals the default world's (Z3's `shadowDiff` ≈ 0).
 */
import { describe, expect, test } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { checkJson, countTreeNodes } from '../../src/core/params/json';
import { FLOATING_DENSITY_TREE, FLOATING_SURFACE_RULES } from '../../src/core/params/presetTrees';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { biomeId, type SurfaceBiome } from '../../src/gen/biomes/registry';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createSurfaceContext, type SurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { newSurfaceScan, scanColumn, surfaceScanSettings, type SurfaceScan } from '../../src/gen/surface/scan';
import { validateRulesSource } from '../../src/gen/surface/source';
import { ruleNodeCount, rulesColumnCost } from '../../src/gen/inspect/cost';
import { validateParamTrees } from '../../src/gen/trees';
import { fillColumnT } from '../../src/metrics/region';
import { treeLints } from '../../src/ui/inspector/form';
import { AIR, GRASS_BLOCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { paramsWith } from '../harness/gen';

type Rec = Record<string, unknown>;
const DIRT = REGISTRY.parseStateKey('dirt');
const FLOATING = resolveProfile('floating_islands');
const ctx: GenContext = createGenContext(seedFromInput('42'), FLOATING);
/** The same params with the default rules: what the islands branch changes is measured against it. */
const ctxDefault: GenContext = createGenContext(seedFromInput('42'), paramsWith({ islands: { enabled: true }, density: { defs: FLOATING_DENSITY_TREE } }));
const sc: SurfaceContext = createSurfaceContext(ctx);
const scDefault: SurfaceContext = createSurfaceContext(ctxDefault);

/** §4.2's branch, written out. */
const BRANCH = {
  kind: 'condition', if: { kind: 'yAbove', minY: 181, runTop: true },
  then: { kind: 'condition', if: { kind: 'stoneDepth', side: 'ceiling', offset: 100, addSurfaceDepth: false },
    then: { kind: 'condition', if: { kind: 'stoneDepth', side: 'floor', offset: 4, addSurfaceDepth: true },
      then: { kind: 'sequence', rules: [
        { kind: 'condition', if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
          then: { kind: 'block', state: 'grass_block' } },
        { kind: 'condition', if: { kind: 'stoneDepth', side: 'ceiling', offset: 2, addSurfaceDepth: false },
          then: { kind: 'block', state: 'stone' } },
        { kind: 'condition', if: { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: true },
          then: { kind: 'block', state: 'dirt' } },
        { kind: 'block', state: 'stone' } ] } } } };

/** The islands branch and the default's sky-open condition, `root.rules[1]`'s two children. */
const wrapped = (t: unknown): unknown[] => ((t as { rules: Array<{ rules: unknown[] }> }).rules[1]!.rules);

describe('FLOATING_SURFACE_RULES (SP3e spec §4.2, §4.3, §4.5, D6, D7, D21 (b))', () => {
  test('the overlay holds the registered tree; resolveProfile keeps its identity; checkJson returns it as itself', () => {
    expect(FLOATING.surface.rules).toBe(FLOATING_SURFACE_RULES);
    expect(resolveProfile('floating_islands').surface.rules).toBe(FLOATING_SURFACE_RULES);
    expect(Object.isFrozen(FLOATING_SURFACE_RULES)).toBe(true);
    expect(checkJson(FLOATING_SURFACE_RULES, 'surface.rules', [], 'surfaceRules')).toBe(FLOATING_SURFACE_RULES);
  });

  test('exactly the wrapper root.rules[1] = sequence[branch, the default\'s sky-open condition]; rules[0], [2] unchanged', () => {
    const t = FLOATING_SURFACE_RULES as unknown as { rules: Rec[] };
    const d = DEFAULT_SURFACE_RULES as unknown as { rules: Rec[] };
    expect(t.rules).toHaveLength(3);
    expect(t.rules[1]!['kind']).toBe('sequence');
    expect(wrapped(t)).toHaveLength(2);
    expect(canonicalJSON(wrapped(t)[0])).toBe(canonicalJSON(BRANCH));
    expect(canonicalJSON(wrapped(t)[1])).toBe(canonicalJSON(d.rules[1]));
    expect((d.rules[1]!['if'] as Rec)['kind']).toBe('skyOpen');
    // Unwrapping gives the default tree back.
    const copy = JSON.parse(JSON.stringify(FLOATING_SURFACE_RULES)) as { rules: unknown[] };
    copy.rules[1] = wrapped(copy)[1];
    expect(canonicalJSON(copy)).toBe(canonicalJSON(DEFAULT_SURFACE_RULES));
    // U2's pinned surface.rules variant path ['rules', 2, 'if'] still names the deepslate gradient.
    expect(t.rules[2]!['if']).toEqual({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 });
    expect(canonicalJSON(t.rules[0])).toBe(canonicalJSON(d.rules[0]));
  });

  test('the branch\'s minY literal is ISLAND_RUN_MIN_BOTTOM (one constant, §4.1)', () => {
    const minY = ((wrapped(FLOATING_SURFACE_RULES)[0] as Rec)['if'] as Rec)['minY'];
    expect(minY).toBe(ISLAND_RUN_MIN_BOTTOM);
    expect(minY).toBe(181);
  });

  test('181 nodes (the default 163 + the branch 17 + the wrapping sequence); tier 2 []; rules column cost 2,409,472; no lint', () => {
    expect(countTreeNodes(FLOATING_SURFACE_RULES, 'surfaceRules')).toBe(181);
    expect(countTreeNodes(DEFAULT_SURFACE_RULES, 'surfaceRules')).toBe(163);
    expect(countTreeNodes(BRANCH, 'surfaceRules')).toBe(17);
    expect(ruleNodeCount(FLOATING_SURFACE_RULES)).toBe(181);
    expect(validateRulesSource(FLOATING_SURFACE_RULES)).toEqual([]);
    expect(validateParamTrees(FLOATING)).toEqual([]);
    expect(rulesColumnCost(FLOATING_SURFACE_RULES)).toBe(2_409_472);
    expect(rulesColumnCost(FLOATING_SURFACE_RULES)).toBe(181 * 256 * 52);
    expect(treeLints(FLOATING)).toEqual([]);
  });

  test('a fast path, not sky-gated (the branch has no skyOpen), with maxSurfaceDepth = 4 + SD_MAX and the default\'s bands', () => {
    const fp = sc.compiled.fastPath;
    expect(fp).not.toBeNull();
    expect(fp!.skyGated).toBe(false);
    expect(fp!.maxSurfaceDepth).toBe(4 + sc.settings.sdMax);
    expect(scDefault.compiled.fastPath!.skyGated).toBe(true);
    expect(fp!.bands).toEqual(scDefault.compiled.fastPath!.bands);
  });
});

/**
 * One constructed column per position p, case p % 10 (y ranges inclusive, every position also holds the stage's
 * bedrock at y −64, which the scan ignores):
 */
const CASES: ReadonlyArray<{ readonly name: string; readonly runs: ReadonlyArray<readonly [bottom: number, top: number]>; readonly water?: readonly [number, number] }> = [
  { name: 'an island over the sea', runs: [[-63, 40], [200, 230]], water: [41, 63] },
  { name: 'an island over nothing', runs: [[220, 240]] },
  { name: 'a one-voxel island over ground', runs: [[-63, 70], [200, 200]] },
  { name: 'a two-voxel island over ground', runs: [[-63, 70], [200, 201]] },
  { name: 'a stacked island (two islands over ground)', runs: [[-63, 70], [200, 215], [240, 255]] },
  { name: 'an island whose bottom voxel is 181', runs: [[-63, 70], [181, 190]] },
  { name: 'a peak resting on the bedrock', runs: [[-63, 250]] },
  { name: 'a detached run whose top is 180', runs: [[-63, 70], [150, 180]] },
  { name: 'an overhang lip above y 180 (bottom 150)', runs: [[-63, 70], [150, 200]] },
  { name: 'a detached run thicker than 100 (100 … 250)', runs: [[-63, 70], [100, 250]] },
];
/** Whether the branch's predicate holds at a run's top voxel: runTop ≥ 181 and top − bottom ≤ 100 (§4.1). */
const takesBranch = (bottom: number, top: number): boolean => top >= ISLAND_RUN_MIN_BOTTOM && top - bottom <= 100;
/** The ground biomes cycled over the positions: none of them reaches an island (D7). */
const GROUND_BIOMES: readonly SurfaceBiome[] = ['desert', 'warm_ocean', 'snowy_plains', 'frozen_peaks', 'plains', 'badlands', 'beach'];
const at = (p: number, y: number): number => ((y + 64) << 8) | p;

/** §4.2's island palette at voxel y of a run [bottom, top] with surface depth sd. */
const islandState = (y: number, bottom: number, top: number, sd: number): number =>
  y === top ? GRASS_BLOCK : y - bottom <= 2 ? STONE : top - y <= sd ? DIRT : STONE;

/** The constructed column's solidity and water, with or without its island runs (bottom ≥ 181). */
function buildColumn(islands: boolean): { solid: Uint8Array; water: Uint8Array } {
  const solid = new Uint8Array(98304), water = new Uint8Array(98304);
  for (let p = 0; p < 256; p++) {
    const c = CASES[p % CASES.length]!;
    solid[at(p, -64)] = 1;
    for (const [b, t] of c.runs) if (islands || b < ISLAND_RUN_MIN_BOTTOM) for (let y = b; y <= t; y++) solid[at(p, y)] = 1;
    if (c.water !== undefined) for (let y = c.water[0]; y <= c.water[1]; y++) water[at(p, y)] = 1;
  }
  return { solid, water };
}

describe('the islands branch on a constructed column (SP3e spec §4.1, §4.2, §4.5, D21 (b))', () => {
  // A real floating_islands ColumnSample for the readouts the scan takes (steep, T, lake level, surface depth): column
  // (10, 10), whose surface depth is 4-7 at seed 42, so the dirt layer shows.
  const s = sc.density.columns.get(10, 10);
  const { solid, water } = buildColumn(true);
  const biomes = new Uint8Array(256);
  for (let p = 0; p < 256; p++) biomes[p] = biomeId(GROUND_BIOMES[p % GROUND_BIOMES.length]!);
  const scan: SurfaceScan = scanColumn(newSurfaceScan(), sc.settings, s, solid, water, biomes);
  const fast = new Uint16Array(98304), full = new Uint16Array(98304);
  sc.compiled.fillColumn(scan, fast, true);
  sc.compiled.fillColumn(scan, full, false);
  // The default rules on the same column without its island runs: what the ground keeps (§4.5).
  const bare = buildColumn(false);
  const bareScan = scanColumn(newSurfaceScan(), scDefault.settings, s, bare.solid, bare.water, biomes);
  const dflt = new Uint16Array(98304);
  scDefault.compiled.fillColumn(bareScan, dflt, true);

  test('the scan settings carry islands.enabled; the sky-open run is the highest run with bottom < 181 with it, the first without', () => {
    expect(sc.settings.islandRuns).toBe(true);
    expect(createSurfaceContext(createGenContext(seedFromInput('42'), DEFAULTS)).settings.islandRuns).toBe(false);
    expect(surfaceScanSettings(ctx.seed, ctx.params.surface, sc.noises).islandRuns).toBe(false);
    expect(surfaceScanSettings(ctx.seed, ctx.params.surface, sc.noises, true).islandRuns).toBe(true);
    const off = scanColumn(newSurfaceScan(), surfaceScanSettings(ctx.seed, ctx.params.surface, sc.noises), s, solid, water, biomes);
    for (let p = 0; p < 256; p++) {
      const runs = CASES[p % CASES.length]!.runs;
      // Runs are stored top-down: run j of the case (bottom-up) is index first + runs.length − 1 − j.
      const first = scan.runFirst[p]!;
      expect(scan.runFirst[p + 1]! - first, `p ${p}`).toBe(runs.length);
      let j = runs.length - 1;
      while (j >= 0 && runs[j]![0] >= ISLAND_RUN_MIN_BOTTOM) j--;
      expect(scan.skyRun[p], `p ${p} on`).toBe(j < 0 ? -1 : first + runs.length - 1 - j);
      expect(off.skyRun[p], `p ${p} off`).toBe(off.runFirst[p]);
    }
    // An island over nothing has no sky-open run; a position without runs neither.
    expect(scan.skyRun[1]).toBe(-1);
    const empty = scanColumn(newSurfaceScan(), surfaceScanSettings(ctx.seed, ctx.params.surface, sc.noises), s, new Uint8Array(98304), new Uint8Array(98304), biomes);
    expect(Array.from(empty.skyRun).every((r) => r === -1)).toBe(true);
  });

  test('fast path == full evaluation == the reference evaluator == compiled.state at every solid voxel', () => {
    let n = 0;
    for (let p = 0; p < 256; p++) {
      for (let y = -63; y <= 319; y++) {
        const i = at(p, y);
        if (solid[i] === 0) continue;
        const ref = sc.reference.state(scan, sc.settings, p, y);
        expect(fast[i], `p ${p} y ${y}`).toBe(ref);
        expect(full[i], `p ${p} y ${y}`).toBe(ref);
        expect(sc.compiled.state(scan, p, y), `p ${p} y ${y}`).toBe(ref);
        n++;
      }
    }
    expect(n).toBeGreaterThan(256 * 100);
  });

  test('the default rules with the flag (sky-gated): fast path == full == reference == compiled.state, skyRun −1 and ≠ runFirst included', () => {
    // A profile with islands.enabled and the default rules (the flag ticked on default or amplified, Review Focus).
    expect(scDefault.settings.islandRuns).toBe(true);
    const sd = scanColumn(newSurfaceScan(), scDefault.settings, s, solid, water, biomes);
    const f = new Uint16Array(98304), g = new Uint16Array(98304);
    scDefault.compiled.fillColumn(sd, f, true);
    scDefault.compiled.fillColumn(sd, g, false);
    let n = 0, none = 0, other = 0;
    for (let p = 0; p < 256; p++) {
      if (sd.skyRun[p] === -1) none++;
      else if (sd.skyRun[p] !== sd.runFirst[p]) other++;
      for (let y = -63; y <= 319; y++) {
        const i = at(p, y);
        if (solid[i] === 0) continue;
        const ref = scDefault.reference.state(sd, scDefault.settings, p, y);
        expect(f[i], `p ${p} y ${y}`).toBe(ref);
        expect(g[i], `p ${p} y ${y}`).toBe(ref);
        expect(scDefault.compiled.state(sd, p, y), `p ${p} y ${y}`).toBe(ref);
        n++;
      }
    }
    expect(none).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(100);
    expect(n).toBeGreaterThan(256 * 100);
  });

  test.each(CASES.map((c, k) => [c.name, k] as const))('%s', (_name, k) => {
    let positions = 0, dirt = 0, islandRuns = 0;
    for (let p = k; p < 256; p += CASES.length) {
      positions++;
      const sd = scan.surfaceDepth[p]!;
      for (const [bottom, top] of CASES[k]!.runs) {
        for (let y = bottom; y <= top; y++) {
          const got = fast[at(p, y)]!;
          if (takesBranch(bottom, top)) {
            // Every run the predicate takes, stacked or not, sky-open or not (D21 (b)).
            expect(got, `p ${p} y ${y} sd ${sd}`).toBe(islandState(y, bottom, top, sd));
            if (got === DIRT) dirt++;
          } else {
            // The ground under an island and every run the predicate refuses: the default palette, voxel for voxel.
            expect(got, `p ${p} y ${y}`).toBe(dflt[at(p, y)]);
          }
        }
        if (bottom >= ISLAND_RUN_MIN_BOTTOM) {
          islandRuns++;
          expect(fast[at(p, top)], `p ${p} island top ${top}`).toBe(GRASS_BLOCK);
        }
      }
    }
    expect(positions).toBeGreaterThan(20);
    if (k === 4) expect(islandRuns).toBe(2 * positions);
    // Thick islands show the dirt layer (surface depth 4-7 here).
    if (k === 0 || k === 1 || k === 4) expect(dirt).toBeGreaterThan(positions * 3);
  });

  test('the ground under an island is not bare stone: its top takes the ground biome\'s palette (no shadow)', () => {
    const tops = new Set<number>();
    for (let p = 0; p < 256; p++) {
      const k = p % CASES.length;
      const runs = CASES[k]!.runs;
      if (runs.length < 2 || runs[runs.length - 1]![0] < ISLAND_RUN_MIN_BOTTOM) continue;
      const groundTop = runs[0]![1];
      tops.add(fast[at(p, groundTop)]!);
      expect(fast[at(p, groundTop)], `p ${p}`).toBe(dflt[at(p, groundTop)]);
    }
    expect(tops.size).toBeGreaterThan(1);
    expect([...tops].some((v) => v !== STONE)).toBe(true);
    expect(tops.has(GRASS_BLOCK)).toBe(true);
  });

  test('the ground biome never reaches an island: its default top would be sand, snow or stone on some positions', () => {
    const island = buildColumn(true);
    const dScan = scanColumn(newSurfaceScan(), scDefault.settings, s, island.solid, island.water, biomes);
    const d = new Uint16Array(98304);
    scDefault.compiled.fillColumn(dScan, d, true);
    const tops = new Set<number>();
    for (let p = 0; p < 256; p += CASES.length) tops.add(d[at(p, 230)]!);
    expect([...tops].some((v) => v !== GRASS_BLOCK)).toBe(true);
    for (let p = 0; p < 256; p += CASES.length) expect(fast[at(p, 230)]).toBe(GRASS_BLOCK);
  });
});

describe('compiled == reference and probe == bulk on real floating_islands columns (seed 42; SP3e spec §4.3, §4.5)', () => {
  /** floatingIslands.test.ts' fixtures: SEA_CORE (m = 1), SEA_EDGE (0.25 < m < 1), LAND_EDGE (land). */
  const COLUMNS: ReadonlyArray<readonly [number, number]> = [[19358, -22222], [2012, -10108], [504, -28536]];
  const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
  const probeSc = createSurfaceContext(ctx);
  const ctxWorld = createGenContext(seedFromInput('42'), DEFAULTS);

  test.each(COLUMNS.map((c) => [`${c[0]}, ${c[1]}`, c] as const))('(%s): every solid voxel; every island run grass-topped; the ground as the default world\'s', (_name, [cx, cz]) => {
    expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
    const view = store.proto(cx, cz)!;
    const c = surfaceProbeColumn(probeSc, cx, cz);
    let voxels = 0, islandRuns = 0, shadowed = 0;
    const states = new Uint16Array(98304);
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= 319; y++) {
        const block = view.block(lx, y, lz);
        states[at(p, y)] = block;
        expect(c.solid[at(p, y)] !== 0, `(${lx}, ${y}, ${lz})`).toBe(block !== AIR);
        if (block === AIR) continue;
        voxels++;
        const ref = probeSc.reference.state(c.scan, probeSc.settings, p, y);
        expect(block, `(${lx}, ${y}, ${lz}) stage ${block} ≠ reference ${ref}`).toBe(ref);
        expect(probeSc.compiled.state(c.scan, p, y), `(${lx}, ${y}, ${lz})`).toBe(ref);
      }
      for (let r = c.scan.runFirst[p]!; r < c.scan.runFirst[p + 1]!; r++) {
        if (c.scan.runBottom[r]! < ISLAND_RUN_MIN_BOTTOM) continue;
        islandRuns++;
        // D21 (b): every island run takes the branch, a stacked one too.
        expect(view.block(lx, c.scan.runTop[r]!, lz), `(${lx}, ${c.scan.runTop[r]}, ${lz})`).toBe(GRASS_BLOCK);
      }
      const sky = c.scan.skyRun[p]!;
      if (sky >= 0 && sky !== c.scan.runFirst[p]) shadowed++;
    }
    store.freeColumn(cx, cz);
    // The default world's column: below y 181 the solidity is the same (the islands term is −1e6 outside y 192-264),
    // and every voxel of a run lying below y 181 has the default world's state (the ground keeps its palette, §4.5).
    expect(fillColumnT(store, ctxWorld, cx, cz, () => false)).toBe(true);
    const world = store.proto(cx, cz)!;
    let ground = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let r = c.scan.runFirst[p]!; r < c.scan.runFirst[p + 1]!; r++) {
        if (c.scan.runTop[r]! >= ISLAND_RUN_MIN_BOTTOM) continue;
        for (let y = c.scan.runTop[r]!; y >= c.scan.runBottom[r]!; y--) {
          expect(states[at(p, y)], `(${lx}, ${y}, ${lz}) vs the default world`).toBe(world.block(lx, y, lz));
          ground++;
        }
      }
    }
    expect(ground).toBeGreaterThan(256 * 50);
    store.freeColumn(cx, cz);
    expect(voxels).toBeGreaterThan(0);
    expect(islandRuns).toBeGreaterThan(0);
    expect(shadowed).toBeGreaterThan(0);
  });
});

/**
 * `Islands > Enabled` on a profile whose trees do not match it (SP3e spec §2.1, Review Focus): the flag switches the
 * mask, water v0's island rule and the scan's sky-open run, never the trees. Window: amplified's golden window (chunk
 * origin (−44, −4), 8 × 8 chunks, seed 42), whose mountains rise above y 180.
 */
describe('islands.enabled on trees that do not match it (amplified\'s window, seed 42; SP3e spec §2.1)', () => {
  const WINDOW: ReadonlyArray<readonly [number, number]> = Array.from({ length: 64 }, (_, k) => [-44 + (k & 7), -4 + (k >> 3)] as const);
  const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
  const seed = seedFromInput('42');
  const withFlag = (params: Params, enabled: boolean): GenContext => createGenContext(seed, { ...params, islands: { ...params.islands, enabled } });
  /** The stage's blocks and fluid of chunk column (cx, cz), indexed `at(p, y)`. */
  const generate = (c: GenContext, cx: number, cz: number): { blocks: Uint16Array; fluid: Uint8Array } => {
    expect(fillColumnT(store, c, cx, cz, () => false)).toBe(true);
    const view = store.proto(cx, cz)!;
    const blocks = new Uint16Array(98304), fluid = new Uint8Array(98304);
    for (let p = 0; p < 256; p++) {
      for (let y = -64; y <= 319; y++) { blocks[at(p, y)] = view.block(p & 15, y, p >> 4); fluid[at(p, y)] = view.fluid(p & 15, y, p >> 4); }
    }
    store.freeColumn(cx, cz);
    return { blocks, fluid };
  };
  /** The run of position p holding voxel y, or −1. */
  const runOf = (scan: SurfaceScan, p: number, y: number): number => {
    for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) if (scan.runBottom[r]! <= y && y <= scan.runTop[r]!) return r;
    return -1;
  };

  test('floating_islands with the flag off: the default world\'s solidity and water; its rules still give runs topped above y 180 the islands palette', () => {
    const off = withFlag(FLOATING, false);
    const world = createGenContext(seed, DEFAULTS);
    const probeSc = createSurfaceContext(off);
    let solidity = 0, fluid = 0, changed = 0, columns = 0, outside = 0;
    for (const [cx, cz] of WINDOW) {
      const a = generate(off, cx, cz), b = generate(world, cx, cz);
      let here = 0;
      let scan: SurfaceScan | null = null;
      for (let p = 0; p < 256; p++) {
        for (let y = -63; y <= 319; y++) {
          const i = at(p, y);
          if ((a.blocks[i] === AIR) !== (b.blocks[i] === AIR)) solidity++;
          if (a.fluid[i] !== b.fluid[i]) fluid++;
          if (a.blocks[i] === b.blocks[i]) continue;
          here++;
          scan ??= surfaceProbeColumn(probeSc, cx, cz).scan;
          // §4.1's predicate: a run topped at y ≥ 181, the voxel within 100 blocks of the run's bottom.
          const r = runOf(scan, p, y);
          if (r < 0 || scan.runTop[r]! < ISLAND_RUN_MIN_BOTTOM || y - scan.runBottom[r]! > 100) outside++;
        }
      }
      changed += here;
      if (here > 0) columns++;
    }
    // Unticking the flag removes the islands (the mask is 0, so the term's gate gives −1e6) and their water rule, not
    // the preset's rules: 47 of the 64 columns keep the islands palette on their peaks (mostly stone → dirt or grass).
    expect({ solidity, fluid, outside, changed, columns }).toEqual({ solidity: 0, fluid: 0, outside: 0, changed: 23585, columns: 47 });
  }, 120_000);

  test.each([['default', 5953, 1373, 34, 0], ['amplified', 4144, 783, 26, 543]] as const)('%s with the flag on: the same solidity and water; states change only where a run lies above y 180, stage == reference == compiled.state there', (id, wantVoxels, wantPositions, wantColumns, wantSnowToStone) => {
    const params = resolveProfile(id);
    const on = withFlag(params, true), off = withFlag(params, false);
    const probeSc = createSurfaceContext(on);
    let solidity = 0, fluid = 0, voxels = 0, positions = 0, columns = 0, noIslandRun = 0, checked = 0, snowToStone = 0;
    const SNOW = REGISTRY.parseStateKey('snow_block');
    for (const [cx, cz] of WINDOW) {
      const a = generate(on, cx, cz), b = generate(off, cx, cz);
      let here = 0;
      let c: ReturnType<typeof surfaceProbeColumn> | null = null;
      for (let p = 0; p < 256; p++) {
        let at_p = 0;
        for (let y = -63; y <= 319; y++) {
          const i = at(p, y);
          if ((a.blocks[i] === AIR) !== (b.blocks[i] === AIR)) solidity++;
          if (a.fluid[i] !== b.fluid[i]) fluid++;
          if (a.blocks[i] !== b.blocks[i]) {
            at_p++;
            if (b.blocks[i] === SNOW && a.blocks[i] === STONE) snowToStone++;
          }
        }
        if (at_p === 0) continue;
        voxels += at_p; here += at_p; positions++;
        c ??= surfaceProbeColumn(probeSc, cx, cz);
        let islandRun = false;
        for (let r = c.scan.runFirst[p]!; r < c.scan.runFirst[p + 1]!; r++) if (c.scan.runBottom[r]! >= ISLAND_RUN_MIN_BOTTOM) islandRun = true;
        if (!islandRun) noIslandRun++;
        expect(c.scan.skyRun[p], `(${cx}, ${cz}) p ${p}`).not.toBe(c.scan.runFirst[p]);
        // The default rules are sky-gated: their fast path must follow the flag's sky-open run.
        for (let y = -63; y <= 319; y++) {
          const i = at(p, y);
          if (a.blocks[i] === AIR) continue;
          const ref = probeSc.reference.state(c.scan, probeSc.settings, p, y);
          expect(a.blocks[i], `(${cx}, ${cz}) p ${p} y ${y} stage ≠ reference`).toBe(ref);
          expect(probeSc.compiled.state(c.scan, p, y), `(${cx}, ${cz}) p ${p} y ${y}`).toBe(ref);
          checked++;
        }
      }
      if (here > 0) columns++;
    }
    expect({ solidity, fluid, noIslandRun }).toEqual({ solidity: 0, fluid: 0, noIslandRun: 0 });
    expect(checked).toBeGreaterThan(positions * 100);
    // A detached peak above y 180 is no longer the sky-open run: its top loses the sky-open palette (snow → stone).
    expect({ id, voxels, positions, columns, snowToStone }).toEqual({ id, voxels: wantVoxels, positions: wantPositions, columns: wantColumns, snowToStone: wantSnowToStone });
  }, 120_000);
});

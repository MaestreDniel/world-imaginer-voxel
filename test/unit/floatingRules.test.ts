/**
 * floating_islands' surface rules (SP3e spec §4.1-§4.3, D6, D7, D21 (a)): `FLOATING_SURFACE_RULES` = the default rules
 * with the islands branch inserted at `root.rules[1].then.rules[0]`, its `minY` built from `ISLAND_RUN_MIN_BOTTOM`:
 * - the tree: identity across `resolveProfile`, exactly the insertion (U2's pinned `root.rules[2]` is still the
 *   deepslate gradient), 180 nodes, tier 2 [], rules column cost 2,396,160, a sky-gated fast path with
 *   `maxSurfaceDepth` = 4 + SD_MAX and the default's bands;
 * - a constructed column on a floating_islands ColumnSample: grass tops, dirt for the position's surface depth, a
 *   3-voxel stone underside, the rest of the skin stone, thin islands grass-topped, a stacked island in band stone
 *   (D21 (a)), the ground under islands in band stone; runs the predicate refuses keep the default palette, and an
 *   overhang lip above y 180 takes the island palette (§4.1: the predicate is wider than an island run);
 * - real columns of seed 42 (`floatingIslands.test.ts`' fixtures): the stage's states (compiled, fast path) equal the
 *   reference evaluator's on the probe's rebuild of the column at every solid voxel, and every island run is
 *   grass-topped.
 */
import { describe, expect, test } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { checkJson, countTreeNodes } from '../../src/core/params/json';
import { FLOATING_DENSITY_TREE, FLOATING_SURFACE_RULES } from '../../src/core/params/presetTrees';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { biomeId, type SurfaceBiome } from '../../src/gen/biomes/registry';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createSurfaceContext, type SurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { newSurfaceScan, scanColumn, type SurfaceScan } from '../../src/gen/surface/scan';
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

const skyChildren = (t: unknown): unknown[] => ((t as { rules: Array<{ then: { rules: unknown[] } }> }).rules[1]!.then.rules);

describe('FLOATING_SURFACE_RULES (SP3e spec §4.2, §4.3, D6, D7)', () => {
  test('the overlay holds the registered tree; resolveProfile keeps its identity; checkJson returns it as itself', () => {
    expect(FLOATING.surface.rules).toBe(FLOATING_SURFACE_RULES);
    expect(resolveProfile('floating_islands').surface.rules).toBe(FLOATING_SURFACE_RULES);
    expect(Object.isFrozen(FLOATING_SURFACE_RULES)).toBe(true);
    expect(checkJson(FLOATING_SURFACE_RULES, 'surface.rules', [], 'surfaceRules')).toBe(FLOATING_SURFACE_RULES);
  });

  test('exactly the insertion at root.rules[1].then.rules[0]; the default\'s children follow at 1-5; rules[0], [2] unchanged', () => {
    const t = FLOATING_SURFACE_RULES as unknown as { rules: unknown[] };
    const d = DEFAULT_SURFACE_RULES as unknown as { rules: unknown[] };
    expect(t.rules).toHaveLength(3);
    expect(canonicalJSON(skyChildren(t)[0])).toBe(canonicalJSON(BRANCH));
    expect(skyChildren(t)).toHaveLength(6);
    skyChildren(d).forEach((c, k) => expect(canonicalJSON(skyChildren(t)[k + 1]), `child ${k}`).toBe(canonicalJSON(c)));
    // Removing the branch gives the default tree back.
    const copy = JSON.parse(JSON.stringify(FLOATING_SURFACE_RULES)) as unknown;
    skyChildren(copy).splice(0, 1);
    expect(canonicalJSON(copy)).toBe(canonicalJSON(DEFAULT_SURFACE_RULES));
    // U2's pinned surface.rules variant path ['rules', 2, 'if'] still names the deepslate gradient.
    expect((t.rules[2] as Rec)['if']).toEqual({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 });
    expect(canonicalJSON(t.rules[0])).toBe(canonicalJSON(d.rules[0]));
  });

  test('the branch\'s minY literal is ISLAND_RUN_MIN_BOTTOM (one constant, §4.1)', () => {
    const minY = ((skyChildren(FLOATING_SURFACE_RULES)[0] as Rec)['if'] as Rec)['minY'];
    expect(minY).toBe(ISLAND_RUN_MIN_BOTTOM);
    expect(minY).toBe(181);
  });

  test('180 nodes (the default 163 + the branch 17); tier 2 []; rules column cost 2,396,160; no lint', () => {
    expect(countTreeNodes(FLOATING_SURFACE_RULES, 'surfaceRules')).toBe(180);
    expect(countTreeNodes(BRANCH, 'surfaceRules')).toBe(17);
    expect(ruleNodeCount(FLOATING_SURFACE_RULES)).toBe(180);
    expect(validateRulesSource(FLOATING_SURFACE_RULES)).toEqual([]);
    expect(validateParamTrees(FLOATING)).toEqual([]);
    expect(rulesColumnCost(FLOATING_SURFACE_RULES)).toBe(2_396_160);
    expect(rulesColumnCost(FLOATING_SURFACE_RULES)).toBe(180 * 256 * 52);
    expect(treeLints(FLOATING)).toEqual([]);
  });

  test('a sky-gated fast path with maxSurfaceDepth = 4 + SD_MAX and the default\'s bands', () => {
    const fp = sc.compiled.fastPath;
    expect(fp).not.toBeNull();
    expect(fp!.skyGated).toBe(true);
    expect(fp!.maxSurfaceDepth).toBe(4 + sc.settings.sdMax);
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
/** The cases whose topmost run takes the island branch. */
const BRANCH_CASES = new Set([0, 1, 2, 3, 4, 5, 8]);
/** The ground biomes cycled over the positions: none of them reaches an island (D7). */
const GROUND_BIOMES: readonly SurfaceBiome[] = ['desert', 'warm_ocean', 'snowy_plains', 'frozen_peaks', 'plains', 'badlands', 'beach'];
const at = (p: number, y: number): number => ((y + 64) << 8) | p;

/** §4.2's island palette at voxel y of a run [bottom, top] with surface depth sd. */
const islandState = (y: number, bottom: number, top: number, sd: number): number =>
  y === top ? GRASS_BLOCK : y - bottom <= 2 ? STONE : top - y <= sd ? DIRT : STONE;

describe('the islands branch on a constructed column (SP3e spec §4.1, §4.2, D21 (a))', () => {
  // A real floating_islands ColumnSample for the readouts the scan takes (steep, T, lake level, surface depth): column
  // (10, 10), whose surface depth is 4-7 at seed 42, so the dirt layer shows.
  const s = sc.density.columns.get(10, 10);
  const solid = new Uint8Array(98304), water = new Uint8Array(98304), biomes = new Uint8Array(256);
  for (let p = 0; p < 256; p++) {
    const c = CASES[p % CASES.length]!;
    solid[at(p, -64)] = 1;
    for (const [b, t] of c.runs) for (let y = b; y <= t; y++) solid[at(p, y)] = 1;
    if (c.water !== undefined) for (let y = c.water[0]; y <= c.water[1]; y++) water[at(p, y)] = 1;
    biomes[p] = biomeId(GROUND_BIOMES[p % GROUND_BIOMES.length]!);
  }
  const scan: SurfaceScan = scanColumn(newSurfaceScan(), sc.settings, s, solid, water, biomes);
  const fast = new Uint16Array(98304), full = new Uint16Array(98304), dflt = new Uint16Array(98304);
  sc.compiled.fillColumn(scan, fast, true);
  sc.compiled.fillColumn(scan, full, false);
  scDefault.compiled.fillColumn(scan, dflt, true);

  test('fast path == full evaluation == the reference evaluator at every solid voxel', () => {
    let n = 0;
    for (let p = 0; p < 256; p++) {
      for (let y = -63; y <= 319; y++) {
        const i = at(p, y);
        if (solid[i] === 0) continue;
        const ref = sc.reference.state(scan, sc.settings, p, y);
        expect(fast[i], `p ${p} y ${y}`).toBe(ref);
        expect(full[i], `p ${p} y ${y}`).toBe(ref);
        n++;
      }
    }
    expect(n).toBeGreaterThan(256 * 100);
  });

  test.each(CASES.map((c, k) => [c.name, k] as const))('%s', (_name, k) => {
    let positions = 0, dirt = 0;
    for (let p = k; p < 256; p += CASES.length) {
      positions++;
      const runs = CASES[k]!.runs;
      const sd = scan.surfaceDepth[p]!;
      // The topmost run is the sky-open one.
      const [bottom, top] = runs[runs.length - 1]!;
      for (let y = bottom; y <= top; y++) {
        const got = fast[at(p, y)]!;
        if (BRANCH_CASES.has(k)) {
          expect(got, `p ${p} y ${y} sd ${sd}`).toBe(islandState(y, bottom, top, sd));
          if (got === DIRT) dirt++;
        } else {
          // The predicate refuses it: the default palette, voxel for voxel.
          expect(got, `p ${p} y ${y}`).toBe(dflt[at(p, y)]);
        }
      }
      // Every lower run is not sky-open: the band state (stone at y ≥ 8; D21 (a): the ground and a stacked island
      // under an island are bare stone), as with the default rules.
      for (const [b, t] of runs.slice(0, -1)) {
        for (let y = b; y <= t; y++) expect(fast[at(p, y)], `p ${p} y ${y}`).toBe(dflt[at(p, y)]);
        if (t >= 8) expect(fast[at(p, t)], `p ${p} run top ${t}`).toBe(STONE);
      }
    }
    expect(positions).toBeGreaterThan(20);
    // Thick islands show the dirt layer (surface depth 4-7 here).
    if (k === 0 || k === 1 || k === 4) expect(dirt).toBeGreaterThan(positions * 3);
  });

  test('the ground biome never reaches an island: its default top would be sand, snow or stone on some positions', () => {
    const tops = new Set<number>();
    for (let p = 0; p < 256; p += CASES.length) tops.add(dflt[at(p, 230)]!);
    expect([...tops].some((v) => v !== GRASS_BLOCK)).toBe(true);
    for (let p = 0; p < 256; p += CASES.length) expect(fast[at(p, 230)]).toBe(GRASS_BLOCK);
  });
});

describe('compiled == reference and probe == bulk on real floating_islands columns (seed 42; SP3e spec §4.3)', () => {
  /** floatingIslands.test.ts' fixtures: SEA_CORE (m = 1), SEA_EDGE (0.25 < m < 1), LAND_EDGE (land). */
  const COLUMNS: ReadonlyArray<readonly [number, number]> = [[19358, -22222], [2012, -10108], [504, -28536]];
  const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
  const probeSc = createSurfaceContext(ctx);

  test.each(COLUMNS.map((c) => [`${c[0]}, ${c[1]}`, c] as const))('(%s): every solid voxel; every island run grass-topped', (_name, [cx, cz]) => {
    expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
    const view = store.proto(cx, cz)!;
    const c = surfaceProbeColumn(probeSc, cx, cz);
    let voxels = 0, islandRuns = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = -63; y <= 319; y++) {
        const block = view.block(lx, y, lz);
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
        // D21 (a): only the sky-open (first) run takes the branch; a stacked island below it is band stone.
        const want = r === c.scan.runFirst[p] ? GRASS_BLOCK : STONE;
        expect(view.block(lx, c.scan.runTop[r]!, lz), `(${lx}, ${c.scan.runTop[r]}, ${lz})`).toBe(want);
      }
    }
    store.freeColumn(cx, cz);
    expect(voxels).toBeGreaterThan(0);
    expect(islandRuns).toBeGreaterThan(0);
  });
});

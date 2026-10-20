import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { WINDOW_HALF } from '../../src/core/coords';
import { PROFILE_IDS, resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { biomeId } from '../../src/gen/biomes/registry';
import { buildColumnSample, newColumnSample, readField, readLevel } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { sp3eWindow } from '../../src/metrics/sp3eGoldens';
import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
import {
  AIR, BEDROCK, BROWN_TERRACOTTA, DIRT, GRASS_BLOCK, LIGHT_GRAY_TERRACOTTA, ORANGE_TERRACOTTA, PACKED_ICE, RED_SAND, RED_TERRACOTTA, SAND,
  SANDSTONE, SNOW_BLOCK, STONE, TERRACOTTA, WHITE_TERRACOTTA, YELLOW_TERRACOTTA,
} from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { encodePng, VOXEL_COLORS } from '../harness/png';
import type { RegionView } from '../harness/region';
import {
  cropProblems, DRAFT_PRESETS, generateLine, generateSite, kindReader, lineSummary, MIN_TOP_POSITIONS, MOUNTAIN_SIGMA, mountainShare,
  needProblems, positionKind, positionVoxels, PRESET_LINE_BLOCKS, presetReviewSite, presetReviewSites, renderSite, REVIEW_KINDS,
  REVIEW_SITES, siteLine, slicesJson, TOP_KINDS, topKind, upscale, writeReviewSlices,
  type BlockXZ, type DraftPresetId, type LineSummary, type ReviewKind, type ReviewSite, type VerticalSite, type WrittenSlice,
} from '../harness/reviewSlices';

const ctx = ctxFor('42');
const params = paramsWith();
const verticals = REVIEW_SITES.filter((s): s is VerticalSite => s.kind === 'vertical');
const site = (name: string): ReviewSite => REVIEW_SITES.find((s) => s.name === name)!;

type Runs = ReadonlyArray<readonly [number, number]>;

/**
 * A hand-built view: position x of the row (any z) holds `cols[x]`'s stone runs and water runs (default: stone up to
 * y 40), bedrock at y −64, and its `top` state (default stone) at its highest solid voxel and its surface biome
 * `biome` (default 0, ocean) in aux A; aux A's heightmaps as SP3a §3.4 computes them (OCEAN_FLOOR_WG over the
 * highest solid voxel, WORLD_SURFACE_WG over the highest solid or water voxel).
 */
interface FakeColumn { readonly stone: Runs; readonly water?: Runs; readonly top?: number; readonly biome?: number }
function fakeView(cols: ReadonlyArray<FakeColumn>): RegionView {
  const at = (x: number): FakeColumn => cols[x] ?? { stone: [[-63, 40]] as Runs };
  const inRuns = (runs: Runs | undefined, y: number) => (runs ?? []).some(([a, b]) => y >= a && y <= b);
  const topOf = (x: number) => Math.max(...at(x).stone.map(([, b]) => b));
  const block = (x: number, y: number) => (y === -64 ? BEDROCK : !inRuns(at(x).stone, y) ? AIR : y === topOf(x) ? at(x).top ?? STONE : STONE);
  const fluid = (x: number, y: number) => (block(x, y) === AIR && inRuns(at(x).water, y) ? WATER_SOURCE : 0);
  const highest = (x: number, wet: boolean) => {
    for (let y = 319; y >= -64; y--) if (block(x, y) !== AIR || (wet && fluid(x, y) !== 0)) return y;
    return -65;
  };
  return {
    cx0: 0, cz0: 0, w: 1, h: 1,
    block: (x: number, y: number) => block(x, y),
    fluid: (x: number, y: number) => fluid(x, y),
    biome: (x: number) => at(x).biome ?? 0,
    worldSurfaceWG: (x: number) => highest(x, true) + 1,
    oceanFloorWG: (x: number) => highest(x, false) + 1,
  } as unknown as RegionView;
}

describe('review sites (SP3b spec §7, §11 visual review)', () => {
  test('the sites: SP3a\'s coast, lake and river, a mountain, a horizontal slice at y 62, and SP3c\'s desert, snow and badlands with their zooms', () => {
    expect(REVIEW_SITES.map((s) => s.name)).toEqual([
      'coast', 'lake', 'river', 'mountain', 'y62', 'desert', 'desert-zoom', 'snow', 'snow-zoom', 'badlands', 'badlands-zoom',
    ]);
    for (const s of REVIEW_SITES) expect(s.file, s.name).toBe(`slice-${s.name}.png`);
    expect(new Set(REVIEW_SITES.map((s) => s.file)).size).toBe(REVIEW_SITES.length);
    const y62 = site('y62');
    expect(y62.kind === 'horizontal' && y62.y).toBe(62);
    for (const s of REVIEW_SITES) {
      expect(s.w, s.name).toBeGreaterThanOrEqual(1);
      expect(s.w, s.name).toBeLessThanOrEqual(64);
      if (s.kind === 'horizontal') {
        expect(s.h).toBeLessThanOrEqual(64);
        expect(s.checkZ >> 4).toBeGreaterThanOrEqual(s.cz0);
        expect(s.checkZ >> 4).toBeLessThan(s.cz0 + s.h);
      }
    }
    // SP3a's lines, unchanged (the coast crop grew to y 159 with the real T's jag spike, SP3b Task 8).
    for (const [name, cx0, w] of [['coast', -1696, 64], ['lake', -1024, 32], ['river', -972, 32]] as const) {
      const s = site(name);
      expect([s.kind, s.cx0, s.w, s.kind === 'vertical' && s.z]).toEqual(['vertical', cx0, w, -31992]);
    }
    expect(siteLine(site('coast'))).toEqual({ z: -31992, x0: -27136, n: 1024 });
    expect(siteLine(site('y62'))).toEqual({ z: -31992, x0: -27136, n: 1024 });
  });

  test('SP3c\'s sites (found by a scan, SP3c spec §6): each needs land and its top kind; each zoom is a 16-column window of its site at 4 px/block', () => {
    expect(TOP_KINDS).toEqual(['desertTop', 'snowTop', 'badlandsTop']);
    expect(MIN_TOP_POSITIONS).toBe(64);
    for (const [name, kind, cx0, z] of [['desert', 'desertTop', 881, -14328], ['snow', 'snowTop', -640, 3080], ['badlands', 'badlandsTop', -110, 2056]] as const) {
      const whole = site(name) as VerticalSite;
      const zoom = site(`${name}-zoom`) as VerticalSite;
      expect([whole.kind, whole.cx0, whole.w, whole.z, whole.yMin, whole.scale, whole.needs]).toEqual(['vertical', cx0, 64, z, -64, 1, ['land', kind]]);
      expect([zoom.kind, zoom.w, zoom.z, zoom.scale, zoom.needs]).toEqual(['vertical', 16, z, 4, ['land', kind]]);
      expect(zoom.cx0).toBeGreaterThanOrEqual(whole.cx0);
      expect(zoom.cx0 + zoom.w).toBeLessThanOrEqual(whole.cx0 + whole.w);
      expect(zoom.yMin).toBeGreaterThan(whole.yMin);
      expect(zoom.yMax).toBeLessThanOrEqual(whole.yMax);
      expect(z & 15).toBe(8);
    }
    // No earlier site needs a top kind.
    for (const s of REVIEW_SITES.slice(0, 5)) expect(s.needs.filter((k) => (TOP_KINDS as readonly string[]).includes(k)), s.name).toEqual([]);
  });

  test('the mountain (found by a scan): its line runs through highland biomes with σ > 8 on the 2D world', () => {
    const m = site('mountain') as VerticalSite;
    expect(m.kind).toBe('vertical');
    expect(MOUNTAIN_SIGMA).toBe(8);
    expect(m.needs).toEqual(['land']);
    expect(m.z & 15).toBe(8);
    // The scan (seed '42', rows cz −1024 … 960 step 64 and −786, 64-column windows over cx −1088 … 1023, the quart
    // points of the row lz 8) ranked this window first, with all 256 points highland and σ > 8; the share over every
    // block position of the line is re-derived here, so a change of the 2D world that moves the massif fails.
    const share = mountainShare(ctx, m);
    expect(share, `highland σ > 8 share ${share}`).toBeGreaterThanOrEqual(0.9);
    expect(mountainShare(ctx, site('coast') as VerticalSite)).toBeLessThan(0.2);
  });
});

describe('positions and lines read from the voxels', () => {
  test('positionVoxels: the true top, the water surface, the open and filled extents, the transitions near the top', () => {
    const v = fakeView([
      { stone: [[-63, 70], [80, 90]] }, // an overhang: a dry pocket 71 … 79 under a stone roof
      { stone: [[-63, 40]], water: [[41, 63]] }, // sea
      { stone: [[-63, 50], [60, 62]], water: [[51, 59]] }, // water under a stone lid
      { stone: [[-63, 10], [20, 25], [40, 45]] }, // two transitions above top − 30, one below
    ]);
    expect(positionVoxels(v, 0, 0)).toEqual({ top: 90, water: null, lowestOpen: 71, highestFilled: 90, transitions: 2, waterUnderTop: 0 });
    expect(positionVoxels(v, 1, 0)).toEqual({ top: 40, water: 63, lowestOpen: 41, highestFilled: 63, transitions: 1, waterUnderTop: 0 });
    expect(positionVoxels(v, 2, 0)).toEqual({ top: 62, water: null, lowestOpen: 51, highestFilled: 62, transitions: 2, waterUnderTop: 9 });
    expect(positionVoxels(v, 3, 0)).toEqual({ top: 45, water: null, lowestOpen: 11, highestFilled: 45, transitions: 2, waterUnderTop: 0 });
  });

  test('cropProblems: read from the voxels, so a pocket under an overhang below the crop fails though its top is inside', () => {
    const v = fakeView([{ stone: [[-63, 70], [80, 90]] }, { stone: [[-63, 40]], water: [[41, 63]] }]);
    const crop = (yMin: number, yMax: number): VerticalSite => ({
      name: 't', file: 't.png', kind: 'vertical', cx0: 0, w: 1, z: 0, yMin, yMax, scale: 1, needs: [],
    });
    // Positions 2 … 15 hold stone up to 40.
    expect(cropProblems(v, crop(41, 90))).toEqual([]);
    expect(cropProblems(v, crop(72, 90))).toEqual([
      '(0, 0): open at y 71, below the crop',
      ...Array.from({ length: 15 }, (_, i) => `(${i + 1}, 0): open at y 41, below the crop`),
    ]);
    expect(cropProblems(v, crop(41, 89))).toEqual(['(0, 0): filled at y 90, above the crop']);
    expect(cropProblems(v, crop(41, 62))).toEqual(['(0, 0): filled at y 90, above the crop', '(1, 0): filled at y 63, above the crop']);
  });

  test('positionKind: wet or dry from the voxels, not from the 2D estimate; a position outside the sample\'s column throws', () => {
    const s = buildColumnSample(ctx, 3, -2, newColumnSample());
    // (48, −32) is dry land on the 2D estimate (no water level above ⌊surfaceEst⌋).
    expect(Math.floor(readLevel(s, 'surfaceWaterLevel', 48, -32))).toBeLessThanOrEqual(Math.floor(readField(s, 'surfaceEst', 48, -32)));
    const dry = fakeView([]);
    const wet = { ...dry, worldSurfaceWG: () => 64 } as RegionView;
    expect(positionKind(dry, s, 48, -32)).toBe('land');
    expect(positionKind(wet, s, 48, -32)).toBe('sea');
    expect(() => positionKind(dry, s, 16 * 3 + 16, -32)).toThrow(RangeError);
    expect(() => positionKind(dry, s, 16 * 3, -33)).toThrow(RangeError);
  });

  test('topKind: a dry top of sand in the desert, snow_block or red_sand, from the voxels and aux A; none under water', () => {
    const desert = biomeId('desert');
    const v = fakeView([
      { stone: [[-63, 70]], top: SAND, biome: desert },
      { stone: [[-63, 70]], top: SAND, biome: biomeId('beach') }, // sand outside the desert
      { stone: [[-63, 90]], top: SNOW_BLOCK, biome: biomeId('plains') }, // any biome's snow top
      { stone: [[-63, 80]], top: RED_SAND, biome: biomeId('badlands') },
      { stone: [[-63, 40]], water: [[41, 63]], top: SAND, biome: desert }, // wet sand
      { stone: [[-63, 40]], water: [[41, 63]], top: SNOW_BLOCK },
      { stone: [[-63, 70]], top: GRASS_BLOCK, biome: desert },
      { stone: [[-63, 70], [80, 90]], top: RED_SAND, biome: desert }, // the top is the highest solid voxel
    ]);
    expect(Array.from({ length: 9 }, (_, x) => topKind(v, x, 0))).toEqual([
      'desertTop', null, 'snowTop', 'badlandsTop', null, null, null, 'badlandsTop', null,
    ]);
  });

  test('needProblems: a kind needs one position, a top kind MIN_TOP_POSITIONS', () => {
    const summary = (land: number, tops: Partial<LineSummary['tops']>): LineSummary => ({
      kinds: { land, sea: 0, lake: 0, river: 0 }, tops: { desertTop: 0, snowTop: 0, badlandsTop: 0, ...tops },
      topMin: 0, topMax: 0, waterMax: null, overhangs: 0, waterWallFaces: 0, waterUnderStone: 0,
    });
    expect(needProblems(['land', 'desertTop'], summary(1, { desertTop: 64 }))).toEqual([]);
    expect(needProblems(['land', 'desertTop'], summary(1, { desertTop: 63, snowTop: 500 }))).toEqual(['needs 64 desertTop positions, has 63']);
    expect(needProblems(['sea', 'snowTop', 'badlandsTop'], summary(1, { snowTop: 64, badlandsTop: 0 }))).toEqual([
      'needs sea, has none', 'needs 64 badlandsTop positions, has 0',
    ]);
    expect(needProblems([], summary(0, {}))).toEqual([]);
  });

  test('lineSummary on a hand-built row: kinds, tops, overhang positions, water-wall faces, water under stone', () => {
    const v = fakeView([
      { stone: [[-63, 70], [80, 90]] },
      { stone: [[-63, 40]], water: [[41, 63]] },
      { stone: [[-63, 30]] },
      { stone: [[-63, 40]], water: [[41, 63]] },
      { stone: [[-63, 50], [60, 62]], water: [[51, 59]] },
    ]);
    const kinds: ReviewKind[] = ['land', 'sea', 'land', 'sea', ...Array<ReviewKind>(12).fill('land')];
    const sum = lineSummary(v, 0, 0, 16, (x) => kinds[x]!);
    expect(sum.kinds).toEqual({ land: 14, sea: 2, lake: 0, river: 0 });
    expect(sum.tops).toEqual({ desertTop: 0, snowTop: 0, badlandsTop: 0 });
    const tops = lineSummary(fakeView([
      { stone: [[-63, 70]], top: SNOW_BLOCK }, { stone: [[-63, 70]], top: RED_SAND }, { stone: [[-63, 70]], top: RED_SAND },
      { stone: [[-63, 70]], top: SAND, biome: biomeId('desert') }, { stone: [[-63, 40]], water: [[41, 63]], top: SNOW_BLOCK },
    ]), 0, 0, 16, () => 'land');
    expect(tops.tops).toEqual({ desertTop: 1, snowTop: 1, badlandsTop: 2 });
    expect([sum.topMin, sum.topMax, sum.waterMax]).toEqual([30, 90, 63]);
    // ≥ 2 solid→air transitions in [top − 30, top] on land: position 0 (the roof) and 4 (the lid).
    expect(sum.overhangs).toBe(2);
    // Water beside dry air along the line: x 1 and x 3 beside x 2 (y 41 … 63: 23 + 23), x 3 beside x 4 at y 63 (1),
    // x 4's water beside x 5 (y 51 … 59: 9).
    expect(sum.waterWallFaces).toBe(56);
    expect(sum.waterUnderStone).toBe(9);
  });

  // The real lines (seed '42', the real T), each generated once.
  const views = new Map<string, RegionView>();
  beforeAll(async () => {
    for (const s of REVIEW_SITES) views.set(s.name, await generateLine('42', params, s));
  }, 120_000);

  test.each(REVIEW_SITES.map((s) => [s.name, s] as const))('%s: the line crosses every kind the site needs, read from the voxels', (_name, s) => {
    const view = views.get(s.name)!;
    const { z, x0, n } = siteLine(s);
    const sum = lineSummary(view, z, x0, n, kindReader(ctx, view, z));
    expect(Object.values(sum.kinds).reduce((a, b) => a + b, 0)).toBe(n);
    expect(needProblems(s.needs, sum), `${s.name}: ${JSON.stringify(sum.kinds)} ${JSON.stringify(sum.tops)}`).toEqual([]);
    const cs = newColumnSample();
    let cx = Number.NaN;
    for (let x = x0; x < x0 + n; x++) {
      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), z >> 4, cs);
      const p = positionVoxels(view, x, z);
      // Wet ⇔ a water voxel at WORLD_SURFACE_WG − 1, and every wet position has a water level (the T's water rule).
      expect(p.water !== null, `(${x}, ${z})`).toBe(fluidType(view.fluid(x, view.worldSurfaceWG(x, z) - 1, z)) !== 0);
      if (p.water !== null) expect(readLevel(cs, 'surfaceWaterLevel', x, z), `(${x}, ${z}) is wet`).not.toBe(-Infinity);
      expect(p.top).toBe(view.oceanFloorWG(x, z) - 1);
      expect(view.block(x, -64, z)).toBe(BEDROCK);
    }
    if (s.kind === 'vertical') expect(cropProblems(view, s), s.name).toEqual([]);
  });

  test('the coast line holds positions the 2D estimate calls land that are wet on the voxels, and they count as water', () => {
    const coast = site('coast');
    const view = views.get('coast')!;
    const { z, x0, n } = siteLine(coast);
    const kindOf = kindReader(ctx, view, z);
    const cs = newColumnSample();
    let cx = Number.NaN;
    let wetOn2dLand = 0;
    for (let x = x0; x < x0 + n; x++) {
      if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), z >> 4, cs);
      const land2d = Math.floor(readLevel(cs, 'surfaceWaterLevel', x, z)) <= Math.floor(readField(cs, 'surfaceEst', x, z));
      if (land2d && positionVoxels(view, x, z).water !== null) {
        wetOn2dLand++;
        expect(kindOf(x), `(${x}, ${z})`).not.toBe('land');
      }
    }
    expect(wetOn2dLand).toBeGreaterThan(0);
  });

  test('every kind occurs on the vertical lines; lake water stands above y 63; the mountain rises above y 200 with overhangs', () => {
    const seen = new Set<ReviewKind>();
    let lakeAbove63 = 0;
    for (const s of verticals) {
      const view = views.get(s.name)!;
      const { z, x0, n } = siteLine(s);
      const kindOf = kindReader(ctx, view, z);
      const sum = lineSummary(view, z, x0, n, kindOf);
      for (const k of REVIEW_KINDS) if (sum.kinds[k] > 0) seen.add(k);
      if (s.name === 'lake') {
        for (let x = x0; x < x0 + n; x++) {
          const water = positionVoxels(view, x, z).water;
          if (kindOf(x) === 'lake' && water !== null && water > 63) lakeAbove63++;
        }
      }
      if (s.name === 'mountain') {
        // The retuned overhang noise (SP3b §8.4): the review mountain shows T2's overhangs (214 of 1024 positions).
        expect(sum.topMax).toBeGreaterThan(200);
        expect(sum.overhangs, 'mountain overhang positions').toBeGreaterThanOrEqual(150);
      }
    }
    expect([...seen].sort()).toEqual([...REVIEW_KINDS].sort());
    expect(lakeAbove63).toBeGreaterThan(0);
  });

  test('SP3c\'s lines show their surfaces on the voxels: sandstone under the desert sand, frozen_peaks packed ice and snow, the terracotta bands', () => {
    const count = (name: string, pick: (x: number, z: number, top: number, view: RegionView) => number): number => {
      const view = views.get(name)!;
      const { z, x0, n } = siteLine(site(name));
      let c = 0;
      for (let x = x0; x < x0 + n; x++) c += pick(x, z, view.oceanFloorWG(x, z) - 1, view);
      return c;
    };
    const within = (view: RegionView, x: number, z: number, from: number, to: number, state: number): number => {
      let c = 0;
      for (let y = from; y >= to; y--) if (view.block(x, y, z) === state) c++;
      return c;
    };
    for (const name of ['desert', 'desert-zoom']) {
      // The desert skin: sand tops over a sandstone band (BAND4) within 16 voxels of the top.
      expect(count(name, (x, z, top, v) => (v.block(x, top, z) === SAND ? 1 : 0)), name).toBeGreaterThanOrEqual(MIN_TOP_POSITIONS);
      expect(count(name, (x, z, top, v) => within(v, x, z, top, top - 16, SANDSTONE)), name).toBeGreaterThan(name === 'desert' ? 2000 : 500);
    }
    for (const name of ['snow', 'snow-zoom']) {
      // frozen_peaks' cliff branch (packed ice) on the zoom, snow tops over stone or dirt, not grass.
      expect(count(name, (x, z, top, v) => (v.block(x, top, z) === PACKED_ICE ? 1 : 0)), name).toBeGreaterThanOrEqual(10);
      expect(count(name, (x, z, top, v) => (v.block(x, top, z) === GRASS_BLOCK ? 1 : 0)), name).toBe(0);
    }
    const bands = [TERRACOTTA, WHITE_TERRACOTTA, ORANGE_TERRACOTTA, YELLOW_TERRACOTTA, BROWN_TERRACOTTA, RED_TERRACOTTA, LIGHT_GRAY_TERRACOTTA];
    for (const name of ['badlands', 'badlands-zoom']) {
      // The bandlands leaf under the red sand: at least 5 of the 7 terracotta colours.
      const colours = bands.filter((b) => count(name, (x, z, top, v) => within(v, x, z, top, top - 16, b)) > 0);
      expect(colours.length, name).toBeGreaterThanOrEqual(5);
      expect(count(name, (x, z, top, v) => within(v, x, z, top, top - 16, DIRT)), name).toBe(0);
    }
  });
});

describe('review slice images', () => {
  test('renderSite: the slice size, the bottom row of bedrock at y −64, the upscale', async () => {
    const coast = verticals.find((s) => s.name === 'coast')!;
    expect([coast.yMin, coast.scale]).toEqual([-64, 1]);
    const img = renderSite(await generateSite('42', params, coast), coast);
    expect([img.width, img.height]).toEqual([16 * coast.w, coast.yMax - coast.yMin + 1]);
    const last = 4 * img.width * (img.height - 1);
    for (let i = 0; i < img.width; i++) {
      expect([...img.rgba.subarray(last + 4 * i, last + 4 * i + 3)]).toEqual([...VOXEL_COLORS.bedrock]);
    }
    const river = verticals.find((s) => s.name === 'river')!;
    const view = await generateSite('42', params, river);
    const one = renderSite(view, { ...river, scale: 1 });
    const two = renderSite(view, river);
    expect(river.scale).toBe(2);
    expect([two.width, two.height]).toEqual([2 * one.width, 2 * one.height]);
    for (const [x, y] of [[0, 0], [17, 9], [one.width - 1, one.height - 1]] as const) {
      const p = [...one.rgba.subarray(4 * (y * one.width + x), 4 * (y * one.width + x) + 4)];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const q = 4 * ((2 * y + dy) * two.width + 2 * x + dx);
        expect([...two.rgba.subarray(q, q + 4)]).toEqual(p);
      }
    }
    expect(() => upscale(one, 0)).toThrow(RangeError);
    expect(upscale(one, 1)).toBe(one);
  });

  test('writeReviewSlices writes each site as the PNG of its slice, with its line summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi10-review-'));
    try {
      const s: VerticalSite = { ...verticals.find((v) => v.name === 'coast')!, w: 4, file: 'small.png' };
      const [written] = await writeReviewSlices(dir, '42', params, [s]);
      expect(written!.path).toBe(join(dir, 'small.png'));
      const bytes = readFileSync(written!.path);
      const view = await generateSite('42', params, s);
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(encodePng(renderSite(view, s))));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 224]);
      expect([written!.width, written!.height, written!.bytes]).toEqual([64, 224, bytes.length]);
      expect(written!.summary).toEqual(lineSummary(view, s.z, 16 * s.cx0, 64, kindReader(ctx, view, s.z)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('npm run docs:review-slices writes SP3e\'s preset assets (the default sites stay in assets/sp3c, SP3a\'s and SP3b\'s in theirs)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['docs:review-slices']).toBe('REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3e vitest run --project unit test/unit/reviewSlices.test.ts');
    // The default world does not change in SP3e, so SP3c's slices of the default sites stay valid where they are.
    for (const s of REVIEW_SITES) expect(existsSync(new URL(`../../docs/superpowers/specs/assets/sp3c/${s.file}`, import.meta.url)), s.file).toBe(true);
  });
});

describe('SP3e preset review sites (SP3e spec §8, §1.5 step 1): fixed lines through the window centres', () => {
  // Constructed data only: the window search (and so the real centres) lands later; any multiple of 16 will do here.
  const centres = { archipelago: { x: -2560, z: 1408 }, amplified: { x: 1280, z: -640 }, floating_islands: { x: 0, z: 37 } } as const;

  test('presetReviewSites: three vertical 512-block lines along x centred on each centre, in PROFILE_IDS order, no needs', () => {
    expect(DRAFT_PRESETS).toEqual(['archipelago', 'amplified', 'floating_islands']);
    expect(DRAFT_PRESETS).toEqual(PROFILE_IDS.filter((p) => p === 'archipelago' || p === 'amplified' || p === 'floating_islands'));
    expect(PRESET_LINE_BLOCKS).toBe(512);
    const sites = presetReviewSites(centres);
    expect(sites.map((s) => [s.name, s.file, s.kind, s.cx0, s.w, s.z, s.yMin, s.yMax, s.scale, s.needs])).toEqual([
      ['archipelago-coast', 'slice-archipelago-coast.png', 'vertical', -176, 32, 1408, -64, 160, 1, []],
      ['amplified-mountain', 'slice-amplified-mountain.png', 'vertical', 64, 32, -640, -64, 319, 1, []],
      ['islands-cluster', 'slice-islands-cluster.png', 'vertical', -16, 32, 37, -64, 319, 1, []],
    ]);
    DRAFT_PRESETS.forEach((p, i) => {
      const c = centres[p];
      expect(sites[i]).toEqual(presetReviewSite(p, c));
      // The line is x − 256 … x + 255 at the centre's z: the middle half of uiSmoke's 1,024-block line (spec §8).
      expect(siteLine(sites[i]!)).toEqual({ z: c.z, x0: c.x - 256, n: 512 });
    });
    // Disjoint from the default sites' names and files (the preset slices live in their own directories anyway).
    const defaults = new Set(REVIEW_SITES.flatMap((s) => [s.name, s.file]));
    for (const s of sites) expect(defaults.has(s.name) || defaults.has(s.file), s.name).toBe(false);
  });

  test('presetReviewSite refuses a centre off the 16-block grid, a non-integer one, a line leaving the world window, a non-draft profile', () => {
    expect(() => presetReviewSite('amplified', { x: 100, z: 0 })).toThrow(RangeError);
    expect(() => presetReviewSite('amplified', { x: 0, z: 0.5 })).toThrow(RangeError);
    // The world window is half-open [−2^19, 2^19): x − 256 … x + 255 must fit.
    expect(presetReviewSite('amplified', { x: -WINDOW_HALF + 256, z: -WINDOW_HALF }).cx0).toBe(-WINDOW_HALF / 16);
    expect(siteLine(presetReviewSite('amplified', { x: WINDOW_HALF - 256, z: WINDOW_HALF - 1 })).x0 + 511).toBe(WINDOW_HALF - 1);
    expect(() => presetReviewSite('amplified', { x: -WINDOW_HALF + 240, z: 0 })).toThrow(RangeError);
    expect(() => presetReviewSite('amplified', { x: WINDOW_HALF - 240, z: 0 })).toThrow(RangeError);
    expect(() => presetReviewSite('amplified', { x: 0, z: WINDOW_HALF })).toThrow(RangeError);
    expect(() => presetReviewSite('default' as DraftPresetId, { x: 0, z: 0 })).toThrow(RangeError);
  });

  // Constructed slices shaped like the three, on the real sites through (256, 0), so the line is positions 0 … 511.
  const at = (p: DraftPresetId): VerticalSite => presetReviewSite(p, { x: 256, z: 0 });

  test('islands-cluster: the crop of :129-141 keeps an island run, the water under it and the ground below whole', () => {
    const site = at('floating_islands');
    const island = { stone: [[-63, 40], [200, 230]], water: [[41, 63]] } as const;
    const stacked = { stone: [[-63, 40], [190, 200], [250, 319]], water: [[41, 63]] } as const;
    const v = fakeView([...Array<FakeColumn>(100).fill(island), stacked]);
    expect(positionVoxels(v, 0, 0)).toEqual({ top: 230, water: null, lowestOpen: 41, highestFilled: 230, transitions: 1, waterUnderTop: 23 });
    expect(cropProblems(v, site)).toEqual([]);
    // The crop rule bites on these columns: a crop at y 120 (the review's defect 28) cuts the islands, one above the
    // sea floor cuts the water under them.
    expect(cropProblems(v, { ...site, yMax: 120 })).toEqual([
      ...Array.from({ length: 100 }, (_, x) => `(${x}, 0): filled at y 230, above the crop`),
      '(100, 0): filled at y 319, above the crop',
    ]);
    expect(cropProblems(v, { ...site, yMin: 42 })).toHaveLength(512);
    // The image keeps every y of the world (its first 16 columns rendered: the fake view is one column wide).
    expect(renderSite(v, site).height).toBe(384);
  });

  test('archipelago-coast: y −64 … 160 removes only dry air above 160 and nothing else', () => {
    const site = at('archipelago');
    const sea = { stone: [[-63, 40]], water: [[41, 63]] } as const;
    const v = fakeView([...Array<FakeColumn>(256).fill(sea), ...Array<FakeColumn>(44).fill({ stone: [[-63, 150]] }), { stone: [[-63, 160]] }]);
    expect(cropProblems(v, site)).toEqual([]);
    // Every voxel above y 160 on the line is dry air; y −64 (bedrock) is the slice's bottom row.
    let notDryAbove = 0;
    for (let x = 0; x < 512; x++) for (let y = 161; y <= 319; y++) if (v.block(x, y, 0) !== AIR || fluidType(v.fluid(x, y, 0)) !== 0) notDryAbove++;
    expect(notDryAbove).toBe(0);
    const img = renderSite(v, site);
    expect([img.width, img.height]).toEqual([16, 225]);
    const last = 4 * img.width * (img.height - 1);
    expect([...img.rgba.subarray(last, last + 3)]).toEqual([...VOXEL_COLORS.bedrock]);
    // A land voxel at y 161 would be cut: the crop is checked, not assumed.
    const spike = fakeView([...Array<FakeColumn>(300).fill(sea), { stone: [[-63, 161]] }]);
    expect(cropProblems(spike, site)).toEqual(['(300, 0): filled at y 161, above the crop']);
  });

  test('amplified-mountain: y −64 … 319 keeps a mountain up to the world top with its overhang', () => {
    const site = at('amplified');
    const v = fakeView([{ stone: [[-63, 250], [260, 319]] }, { stone: [[-63, 300]] }]);
    expect(positionVoxels(v, 0, 0).highestFilled).toBe(319);
    expect(cropProblems(v, site)).toEqual([]);
    expect(cropProblems(v, { ...site, yMax: 318 })).toEqual(['(0, 0): filled at y 319, above the crop']);
  });

  test('slicesJson: slices.json names the profile the caller passes, then each slice with its summary', () => {
    const summary: LineSummary = {
      kinds: { land: 3, sea: 1, lake: 0, river: 0 }, tops: { desertTop: 0, snowTop: 0, badlandsTop: 0 },
      topMin: 40, topMax: 230, waterMax: 63, overhangs: 0, waterWallFaces: 0, waterUnderStone: 23,
    };
    const site = at('floating_islands');
    const written: WrittenSlice[] = [{ site, path: '/x/slice-islands-cluster.png', width: 512, height: 384, bytes: 1234, summary }];
    const text = slicesJson('42', 'floating_islands', written);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['seed', 'profile', 'slices']);
    expect(JSON.parse(text)).toEqual({ seed: '42', profile: 'floating_islands', slices: [{ file: site.file, width: 512, height: 384, site, summary }] });
    // The default sites' file keeps its exact text (the writer below passes 'default').
    const slices = written.map((w) => ({ file: w.site.file, width: w.width, height: w.height, site: w.site, summary: w.summary }));
    expect(slicesJson('42', 'default', written)).toBe(`${JSON.stringify({ seed: '42', profile: 'default', slices }, null, 2)}\n`);
    expect(() => slicesJson('42', 'nope' as DraftPresetId, written)).toThrow(RangeError);
  });
});

/** The SP3e assets directory (spec §8): one directory per draft preset, and the tuning sets (§1.5). */
const SP3E_ASSETS = new URL('../../docs/superpowers/specs/assets/sp3e/', import.meta.url);
const WRITING = process.env.REVIEW_SLICES_DIR !== undefined;

/** A preset's review site at its committed window centre (`sp3eGoldens.ts`, frozen by the goldens). */
const presetSite = (p: DraftPresetId): VerticalSite => {
  const w = sp3eWindow(p);
  return presetReviewSite(p, { x: w.centreX, z: w.centreZ });
};

/**
 * The bottom voxel of the highest solid run of position (x, z) when it is an island run (bottom ≥ ISLAND_RUN_MIN_BOTTOM)
 * with water below it and solid ground below that water; else null.
 */
function islandOverWaterOverGround(view: RegionView, x: number, z: number): number | null {
  let y = 319;
  while (y >= -64 && view.block(x, y, z) === AIR) y--;
  if (y < -64) return null;
  while (y > -64 && view.block(x, y - 1, z) !== AIR) y--;
  if (y < ISLAND_RUN_MIN_BOTTOM) return null;
  let yy = y - 1;
  while (yy >= -64 && !(view.block(x, yy, z) === AIR && fluidType(view.fluid(x, yy, z)) !== 0)) yy--;
  if (yy < -64) return null;
  while (yy >= -64 && view.block(x, yy, z) === AIR) yy--;
  return yy >= -64 ? y : null;
}

describe('SP3e preset review slices on the real lines (spec §8): the committed window centres, each preset\'s params', () => {
  const lines = new Map<DraftPresetId, RegionView>();
  beforeAll(async () => {
    for (const p of DRAFT_PRESETS) lines.set(p, await generateLine('42', resolveProfile(p), presetSite(p)));
  }, 120_000);
  const summaryOf = (p: DraftPresetId): LineSummary => {
    const site = presetSite(p);
    const { z, x0, n } = siteLine(site);
    const view = lines.get(p)!;
    return lineSummary(view, z, x0, n, kindReader(createGenContext(seedFromInput('42'), resolveProfile(p)), view, z));
  };

  test('the lines through the committed centres: archipelago (128, −128), amplified (−640, 0), floating_islands (−768, −1408)', () => {
    expect(DRAFT_PRESETS.map((p) => [presetSite(p).name, siteLine(presetSite(p))])).toEqual([
      ['archipelago-coast', { z: -128, x0: -128, n: 512 }],
      ['amplified-mountain', { z: 0, x0: -896, n: 512 }],
      ['islands-cluster', { z: -1408, x0: -1024, n: 512 }],
    ]);
  });

  test.each(DRAFT_PRESETS.map((p) => [p] as const))('%s: the crop removes only dry air, read from the voxels', (p) => {
    const view = lines.get(p)!;
    expect(cropProblems(view, presetSite(p))).toEqual([]);
    const { z, x0, n } = siteLine(presetSite(p));
    for (let x = x0; x < x0 + n; x++) expect(view.block(x, -64, z)).toBe(BEDROCK);
  });

  test('islands-cluster keeps the island, the water under it and the ground below it whole (y −64 … 319)', () => {
    const view = lines.get('floating_islands')!;
    const site = presetSite('floating_islands');
    const { z, x0, n } = siteLine(site);
    let islands = 0;
    for (let x = x0; x < x0 + n; x++) {
      const bottom = islandOverWaterOverGround(view, x, z);
      if (bottom === null) continue;
      islands++;
      // The whole column is in the slice: the island's top, the water and the ground below it.
      const p = positionVoxels(view, x, z);
      expect(p.highestFilled, `(${x}, ${z})`).toBeLessThanOrEqual(site.yMax);
      expect(p.lowestOpen, `(${x}, ${z})`).toBeGreaterThanOrEqual(site.yMin);
    }
    expect(islands, 'positions with an island run over water over ground').toBeGreaterThanOrEqual(16);
    const sum = summaryOf('floating_islands');
    expect(sum.topMax).toBeGreaterThanOrEqual(ISLAND_RUN_MIN_BOTTOM);
    expect(sum.waterUnderStone).toBeGreaterThan(0);
  });

  test('archipelago-coast crosses a coast and its crop at y 160 removes only dry air', () => {
    const view = lines.get('archipelago')!;
    const { z, x0, n } = siteLine(presetSite('archipelago'));
    const sum = summaryOf('archipelago');
    expect(sum.kinds.sea, JSON.stringify(sum.kinds)).toBeGreaterThan(0);
    expect(sum.kinds.land, JSON.stringify(sum.kinds)).toBeGreaterThan(0);
    let notDryAbove = 0;
    for (let x = x0; x < x0 + n; x++) for (let y = 161; y <= 319; y++) if (view.block(x, y, z) !== AIR || fluidType(view.fluid(x, y, z)) !== 0) notDryAbove++;
    expect(notDryAbove).toBe(0);
    expect(sum.topMax).toBeLessThanOrEqual(160);
  });

  test('amplified-mountain reaches above y 250 on its line', () => {
    expect(summaryOf('amplified').topMax).toBeGreaterThanOrEqual(250);
  });

  test.skipIf(WRITING).each(DRAFT_PRESETS.map((p) => [p] as const))('assets/sp3e/%s holds exactly its slice and slices.json, as generated now', (p) => {
    const dir = new URL(`${p}/`, SP3E_ASSETS);
    const site = presetSite(p);
    expect(readdirSync(dir).sort()).toEqual([site.file, 'slices.json'].sort());
    const png = encodePng(renderSite(lines.get(p)!, site));
    const bytes = new Uint8Array(readFileSync(new URL(site.file, dir)));
    expect(bytes.length, site.file).toBe(png.length);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(png)), site.file).toBe(0);
    const img = renderSite(lines.get(p)!, site);
    const written: WrittenSlice[] = [{ site, path: '', width: img.width, height: img.height, bytes: png.length, summary: summaryOf(p) }];
    expect(readFileSync(new URL('slices.json', dir), 'utf8')).toBe(slicesJson('42', p, written));
    expect((JSON.parse(readFileSync(new URL('slices.json', dir), 'utf8')) as { profile: string }).profile).toBe(p);
  });
});

describe('SP3e tuning sets (spec §1.5, §8): the before set and the approved after set at the review lines', () => {
  const TUNING = new URL('tuning/', SP3E_ASSETS);
  interface SetsJson {
    readonly seed: string;
    readonly lines: Readonly<Record<DraftPresetId, { readonly window: readonly [number, number]; readonly centre: BlockXZ }>>;
    readonly sets: ReadonlyArray<{ readonly name: string }>;
  }
  const sets = (): SetsJson => JSON.parse(readFileSync(new URL('sets.json', TUNING), 'utf8')) as SetsJson;

  test('sets.json names the before and after sets and the lines they were taken on', () => {
    const j = sets();
    expect(j.seed).toBe('42');
    expect(j.sets.map((s) => s.name)).toEqual(['before', 'after']);
    expect(Object.keys(j.lines)).toEqual([...DRAFT_PRESETS]);
    // amplified's and floating_islands' tuning lines are the committed windows' lines; archipelago's is Task 16's first
    // window w(−2, 2), from before the goldens moved its predicate onto the line (w(1, −1)), so its tuning slices and
    // shots show a line that is not the committed one.
    for (const p of ['amplified', 'floating_islands'] as const) {
      const w = sp3eWindow(p);
      expect(j.lines[p], p).toEqual({ window: [w.a, w.b], centre: { x: w.centreX, z: w.centreZ } });
    }
    expect(j.lines.archipelago).toEqual({ window: [-2, 2], centre: { x: -256, z: 256 } });
    expect([sp3eWindow('archipelago').a, sp3eWindow('archipelago').b]).not.toEqual([-2, 2]);
  });

  test.each(['before', 'after'].flatMap((set) => DRAFT_PRESETS.map((p) => [set, p] as const)))('%s/slices/%s: slices.json names the profile and the set\'s line', (set, p) => {
    const dir = new URL(`${set}/slices/${p}/`, TUNING);
    const j = JSON.parse(readFileSync(new URL('slices.json', dir), 'utf8')) as { seed: string; profile: string; slices: Array<{ file: string; site: VerticalSite }> };
    expect([j.seed, j.profile]).toEqual(['42', p]);
    expect(j.slices[0]!.site).toEqual(presetReviewSite(p, sets().lines[p].centre));
    for (const s of j.slices) expect(existsSync(new URL(s.file, dir)), s.file).toBe(true);
  });

  test.each(['before', 'after'])('%s/: the quick metrics of presets.metric.ts and the shots', (set) => {
    const dir = new URL(`${set}/`, TUNING);
    for (const f of ['Z1.json', 'Z2.json', 'Z3.json', 'DT2.presets.json', 'B1.presets.json']) expect(existsSync(new URL(`metrics/${f}`, dir)), f).toBe(true);
    for (const f of ['preset-amplified.png', 'preset-archipelago.png', 'preset-floating_islands.png', 'preset-archipelago-map.png', 'preset-floating_islands-islandMask.png']) {
      expect(existsSync(new URL(`shots/${f}`, dir)), f).toBe(true);
    }
  });
});

/**
 * `npm run docs:review-slices` sets REVIEW_SLICES_DIR to `docs/superpowers/specs/assets/sp3e` and writes each draft
 * preset's review slice into its own directory `<preset>/` with that preset's params (spec §8: `writeReviewSlices`
 * takes one params per call), plus its `slices.json` naming the profile; without it nothing is written. The default
 * sites are not rewritten: the default world does not change, so `assets/sp3c/` stays valid.
 */
test.runIf(WRITING)('write the preset review slices into REVIEW_SLICES_DIR/<preset>', async () => {
  for (const p of DRAFT_PRESETS) {
    const dir = join(process.env.REVIEW_SLICES_DIR!, p);
    const written = await writeReviewSlices(dir, '42', resolveProfile(p), [presetSite(p)]);
    expect(written.map((w) => w.site.file)).toEqual([presetSite(p).file]);
    writeFileSync(join(dir, 'slices.json'), slicesJson('42', p, written));
  }
}, 300_000);

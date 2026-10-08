import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { biomeId } from '../../src/gen/biomes/registry';
import { buildColumnSample, newColumnSample, readField, readLevel } from '../../src/gen/column/columnStage';
import { fluidType, WATER_SOURCE } from '../../src/world/blocks/fluid';
import {
  AIR, BEDROCK, BROWN_TERRACOTTA, DIRT, GRASS_BLOCK, LIGHT_GRAY_TERRACOTTA, ORANGE_TERRACOTTA, PACKED_ICE, RED_SAND, RED_TERRACOTTA, SAND,
  SANDSTONE, SNOW_BLOCK, STONE, TERRACOTTA, WHITE_TERRACOTTA, YELLOW_TERRACOTTA,
} from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { encodePng, VOXEL_COLORS } from '../harness/png';
import type { RegionView } from '../harness/region';
import {
  cropProblems, generateLine, generateSite, kindReader, lineSummary, MIN_TOP_POSITIONS, MOUNTAIN_SIGMA, mountainShare, needProblems,
  positionKind, positionVoxels, renderSite, REVIEW_KINDS, REVIEW_SITES, siteLine, TOP_KINDS, topKind, upscale, writeReviewSlices,
  type LineSummary, type ReviewKind, type ReviewSite, type VerticalSite,
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

  test('npm run docs:review-slices writes SP3c\'s assets (SP3a\'s and SP3b\'s stay)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['docs:review-slices']).toBe('REVIEW_SLICES_DIR=docs/superpowers/specs/assets/sp3c vitest run --project unit test/unit/reviewSlices.test.ts');
  });
});

/**
 * `npm run docs:review-slices` sets REVIEW_SLICES_DIR to `docs/superpowers/specs/assets/sp3c` and writes every site
 * there (the 64 × 64 horizontal slice takes several seconds), plus `slices.json` (each site and its line summary read
 * from the voxels); without it nothing is written.
 */
test.runIf(process.env.REVIEW_SLICES_DIR !== undefined)('write the review slices into REVIEW_SLICES_DIR', async () => {
  const written = await writeReviewSlices(process.env.REVIEW_SLICES_DIR!, '42', params);
  expect(written.map((w) => w.site.file)).toEqual(REVIEW_SITES.map((s) => s.file));
  const slices = written.map((w) => ({ file: w.site.file, width: w.width, height: w.height, site: w.site, summary: w.summary }));
  writeFileSync(join(process.env.REVIEW_SLICES_DIR!, 'slices.json'), `${JSON.stringify({ seed: '42', profile: 'default', slices }, null, 2)}\n`);
}, 300_000);

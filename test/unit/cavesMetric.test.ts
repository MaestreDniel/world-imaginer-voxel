import { describe, expect, test } from 'vitest';
import { CAVE_KIND } from '../../src/core/constants';
import type { CarverPath } from '../../src/gen/caves/carvers';
import {
  aperiodicCounts, aperiodicity, aperiodicLags, bandCounts, bandsMin, borderPlaneRatio, c1c6Parts, C1_C6_PARTS, c7c9Parts,
  C7_C9_PARTS, caveC7C9Counts, caveComponents, caveExamples, caveRegionCounts, COMP_Y_MIN, emptyCaveGrid, flatWallCounts, flatWallDetail,
  floorCounts, floorPeak, GRID_H, GRID_Y0, jensenShannon, kindCounts, landCounts, largestCounts, latticeBias, layerCounts,
  localThickness, logSd, median, nearestEntranceDistances, openingMask, percentile, PILLAR_AREA_MAX, PILLAR_BACK, pillarTiles, PILLAR_VIEW, preCaveTops, ravineCounts,
  setCell, skyCounts, surfaceCounts, switchWall, switchWallCounts, thinnestAxes, typeMixDivergences, verticalStep, verticalStepDetail,
  voidCounts,
  wallResidues, waterWallCount, type CaveGrid,
} from '../harness/caveMetrics';
import { components3d } from '../harness/flood';

const K = CAVE_KIND;

/** A w × d grid at (x0, z0) of rock from y −64 to `top` (air above). */
function rock(w: number, d: number, top: number, x0 = 0, z0 = 0): CaveGrid {
  const g = emptyCaveGrid(x0, z0, w, d);
  for (let y = GRID_Y0; y <= top; y++) for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) setCell(g, x, y, z, 0, true);
  return g;
}

/** Carves the box [x0, x1] × [y0, y1] × [z0, z1] (inclusive) into air of `tag`. */
function carve(g: CaveGrid, tag: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) setCell(g, x, y, z, tag, false);
}

/** A one-ellipsoid ravine path (centre, radii), its box the ellipsoid's. */
function path(x: number, y: number, z: number, rh: number, rv: number): CarverPath {
  return {
    kind: 'ravine', sx: x >> 4, sz: z >> 4, count: 1, ell: Float64Array.of(x, y, z, rh, rv, -Infinity),
    box: Float64Array.of(x - rh, y - rv, z - rh, x + rh, y + rv, z + rh), widthSq: null,
  };
}

/** The carve test of `path`'s ellipsoids: the voxel's centre inside the ellipsoid. */
const inEllipsoid = (p: CarverPath, e: number, x: number, y: number, z: number): boolean => {
  const o = 6 * e;
  const dx = (x + 0.5 - p.ell[o]!) / p.ell[o + 3]!;
  const dy = (y + 0.5 - p.ell[o + 1]!) / p.ell[o + 4]!;
  const dz = (z + 0.5 - p.ell[o + 2]!) / p.ell[o + 3]!;
  return dx * dx + dy * dy + dz * dz < 1;
};

describe('the caves instruments on fixtures (SP6a §10.1, C1-C6)', () => {
  test('a single 10 × 10 × 10 cavern has thinnest axis 10; a straight 4 × 4 tunnel 4; cheese over spaghetti 3D 2.5', () => {
    const g = rock(32, 32, 100);
    carve(g, K.cheese, 2, 11, 10, 19, 2, 11);
    carve(g, K.spaghetti3d, 0, 31, 40, 43, 20, 23);
    const c = caveComponents(g, preCaveTops(g));
    expect(c.size.size).toBe(2);
    const t = thinnestAxes(g, c);
    expect([...t.all].sort((a, b) => a - b)).toEqual([4, 10]);
    expect(t.cheese).toEqual([10]);
    expect(t.spaghetti3d).toEqual([4]);
    // A component under 64 voxels (3 × 3 × 3) is left out.
    carve(g, K.cheese, 20, 22, 10, 12, 2, 4);
    expect(thinnestAxes(g, caveComponents(g, preCaveTops(g))).all.length).toBe(2);
  });

  /**
   * Carves a straight round tube of diameter `dia` along `axis`, from `from` to `to` on that axis, its axis at (a, b)
   * in the two other axes in order (y, z for 'x'; x, z for 'y'; x, y for 'z'): a voxel is in when its centre lies
   * within dia/2 of the tube's axis. An even diameter's axis runs along voxel corners, an odd one's through centres.
   */
  function tube(g: CaveGrid, tag: number, axis: 'x' | 'y' | 'z', dia: number, a: number, b: number, from: number, to: number): void {
    const off = dia % 2 === 0 ? 0 : 0.5;
    const r2 = (dia / 2) * (dia / 2);
    const half = Math.ceil(dia / 2);
    for (let t = from; t <= to; t++) {
      for (let i = a - half; i <= a + half; i++) {
        for (let j = b - half; j <= b + half; j++) {
          const di = i + 0.5 - (a + off);
          const dj = j + 0.5 - (b + off);
          if (di * di + dj * dj >= r2) continue;
          if (axis === 'x') setCell(g, t, i, j, tag, false);
          else if (axis === 'y') setCell(g, i, t, j, tag, false);
          else setCell(g, i, j, t, tag, false);
        }
      }
    }
  }

  test('a round tube of diameter D has thinnest axis D (4, 5, 6, 8, 10) along each axis; a round cavern of diameter 10, 10', () => {
    // The per-voxel shortest axis-aligned run read a round section at about half its width (D 4 → 2, 5 → 3, 6 → 5,
    // 8 → 6, 10 → 8): a round section's edge voxels have short runs. The local thickness reads its diameter.
    const g = rock(40, 40, 140);
    const dias = [4, 5, 6, 8, 10];
    dias.forEach((dia, k) => tube(g, K.spaghetti3d, 'x', dia, -40 + 16 * k, 20, 0, 39));
    const t = thinnestAxes(g, caveComponents(g, preCaveTops(g)));
    expect([...t.all].sort((a, b) => a - b)).toEqual(dias);

    for (const axis of ['y', 'z'] as const) {
      const h = rock(40, 40, 140);
      if (axis === 'y') { tube(h, K.cheese, 'y', 4, 8, 8, 0, 60); tube(h, K.cheese, 'y', 7, 26, 26, 0, 60); }
      else { tube(h, K.cheese, 'z', 4, 10, 8, 0, 39); tube(h, K.cheese, 'z', 7, 30, 26, 0, 39); }
      expect([...thinnestAxes(h, caveComponents(h, preCaveTops(h))).all].sort((a, b) => a - b), axis).toEqual([4, 7]);
    }

    const s = rock(32, 32, 100);
    for (let y = 30; y < 40; y++) for (let z = 10; z < 20; z++) for (let x = 10; x < 20; x++) {
      const dx = x + 0.5 - 15;
      const dy = y + 0.5 - 35;
      const dz = z + 0.5 - 15;
      if (dx * dx + dy * dy + dz * dz < 25) setCell(s, x, y, z, K.cheese, false);
    }
    expect(thinnestAxes(s, caveComponents(s, preCaveTops(s))).all).toEqual([10]);
  });

  test('a diagonal round tube reads within one block of its diameter; a junction of thin tubes stays thin', () => {
    // A tube of diameter 6 along the x = z diagonal, its axis at y 40.
    const g = rock(48, 48, 100);
    for (let y = 30; y < 50; y++) for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) {
      const u = (x - z) / Math.SQRT2;
      const v = y + 0.5 - 40;
      if (u * u + v * v < 9) setCell(g, x, y, z, K.spaghetti3d, false);
    }
    const [diag] = thinnestAxes(g, caveComponents(g, preCaveTops(g))).all;
    expect(Math.abs(diag! - 6)).toBeLessThanOrEqual(1);
    // Three 2 × 2 tubes crossing: every axis-aligned run through the crossing is long, but no wide ball fits there.
    const j = rock(40, 40, 100);
    carve(j, K.noodle, 0, 39, 50, 51, 20, 21);
    carve(j, K.noodle, 20, 21, 50, 51, 0, 39);
    carve(j, K.noodle, 20, 21, 30, 70, 20, 21);
    expect(thinnestAxes(j, caveComponents(j, preCaveTops(j))).all).toEqual([2]);
  });

  test('localThickness equals a brute force over every voxel centre and corner on random blobs (the transform and the skipping exact)', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 6; trial++) {
      const w = 11;
      const d = 9;
      const g = rock(w, d, -44);
      for (let b = 0; b < 4; b++) {
        const cx = rnd() * w;
        const cy = -56 + rnd() * 12;
        const cz = rnd() * d;
        const rr = 1 + rnd() * 3.5;
        const ky = 0.3 + rnd() * 1.5;
        for (let y = -56; y <= -44; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
          const q = (x + 0.5 - cx) ** 2 + ky * (y + 0.5 - cy) ** 2 + (z + 0.5 - cz) ** 2;
          if (q < rr * rr) setCell(g, x, y, z, K.cheese, false);
        }
      }
      const c = caveComponents(g, preCaveTops(g));
      const h = c.yMax - c.yMin + 1;
      const inside = (x: number, y: number, z: number): boolean =>
        x >= 0 && x < w && z >= 0 && z < d && y >= 0 && y < h && c.label[(y * d + z) * w + x]! !== 0;
      const want = new Uint8Array(w * d * h);
      for (let yy = 0; yy < 2 * h - 1; yy++) for (let zz = 0; zz < 2 * d - 1; zz++) for (let xx = 0; xx < 2 * w - 1; xx++) {
        // The centres: voxel centres and voxel corners.
        if ((xx & 1) !== (yy & 1) || (zz & 1) !== (yy & 1)) continue;
        // Half-block units: a voxel's centre at twice its index. The squared distance to the nearest outside centre.
        let f = Infinity;
        for (let y = -1; y <= h; y++) for (let z = -1; z <= d; z++) for (let x = -1; x <= w; x++) {
          if (inside(x, y, z)) continue;
          f = Math.min(f, (2 * x - xx) ** 2 + (2 * y - yy) ** 2 + (2 * z - zz) ** 2);
        }
        const ball: number[][] = [];
        for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
          if ((2 * x - xx) ** 2 + (2 * y - yy) ** 2 + (2 * z - zz) ** 2 < f) ball.push([x, y, z]);
        }
        if (ball.length === 0) continue;
        const ext = [0, 1, 2].map((a) => Math.max(...ball.map((v) => v[a]!)) - Math.min(...ball.map((v) => v[a]!)) + 1);
        const t = Math.min(...ext);
        for (const [x, y, z] of ball) want[(y! * d + z!) * w + x!] = Math.max(want[(y! * d + z!) * w + x!]!, t);
      }
      expect(Array.from(localThickness(c, w, d)), `trial ${trial}`).toEqual(Array.from(want));
    }
  });

  test('a lattice-aligned slab of carving at y ≡ 0 mod 8 has latticeBias 8; uniform carving 1; x ≡ 0 mod 4 carving 4', () => {
    const slab = rock(16, 16, 100);
    carve(slab, K.cheese, 0, 15, 0, 0, 0, 15);
    const b = bandCounts(slab, preCaveTops(slab));
    expect(latticeBias(b)).toBeCloseTo(8, 12);
    // Only the band −8 … 7 is carved: the others have no carving, so their minimum rate is 0.
    expect(bandsMin(b)).toBe(0);

    const uniform = rock(16, 16, 100);
    carve(uniform, K.cheese, 0, 15, -56, 39, 0, 15);
    const u = bandCounts(uniform, preCaveTops(uniform));
    expect(latticeBias(u)).toBeCloseTo(1, 12);
    expect(bandsMin(u)).toBe(1);

    const columns = rock(16, 16, 100);
    for (let x = 0; x < 16; x += 4) carve(columns, K.cheese, x, x, -56, 39, 0, 15);
    const cb = bandCounts(columns, preCaveTops(columns));
    expect(latticeBias(cb)).toBeCloseTo(4, 12);
    expect(bandsMin(cb)).toBeCloseTo(0.25, 12);
  });

  test('the bands count only underground voxels (y ≤ top − 8) and use world residues', () => {
    // Top 20: the band 24 … 39 holds no underground voxel, so C4.bands is NaN (an undefined population).
    const low = rock(8, 8, 20);
    expect(bandsMin(bandCounts(low, preCaveTops(low)))).toBeNaN();
    // x0 = 2: world x ≡ 0 mod 4 at local 2, 6.
    const g = rock(8, 8, 100, 2, 0);
    carve(g, K.cheese, 4, 4, -56, 39, 0, 7);
    carve(g, K.cheese, 8, 8, -56, 39, 0, 7);
    const b = bandCounts(g, preCaveTops(g));
    expect(b.xTagged[0]).toBe(2 * 16 * 8);
    expect(b.xTagged[1]).toBe(0);
  });

  test('a 1 × 1 vertical shaft to the sky is one sky component reaching 8 below the top; a sealed pocket is not', () => {
    const g = rock(16, 16, 60);
    carve(g, K.entrance, 5, 5, 20, 60, 5, 5);
    carve(g, K.cheese, 10, 12, 0, 2, 10, 12);
    const tops = preCaveTops(g);
    expect(tops[5 * 16 + 5]).toBe(60);
    const c = caveComponents(g, tops);
    expect(c.size.size).toBe(2);
    expect(c.sky.size).toBe(1);
    const s = skyCounts(g, tops, c);
    expect(s.deepSky).toBe(1);
    // Within 40 of the top 60: the shaft's y 20 … 60 (41 voxels), all sky-connected; the pocket is 58 below.
    expect(s.near).toBe(41);
    expect(s.nearSky).toBe(41);
    // A shaft only 5 deep reaches no voxel 8 below its top.
    const shallow = rock(16, 16, 60);
    carve(shallow, K.entrance, 5, 5, 56, 60, 5, 5);
    const st = preCaveTops(shallow);
    expect(skyCounts(shallow, st, caveComponents(shallow, st)).deepSky).toBe(0);
  });

  test('caveComponents crops the box above the highest top without changing the components or the sky', () => {
    const g = rock(12, 12, 40);
    carve(g, K.entrance, 3, 3, 10, 40, 3, 3);
    carve(g, K.cheese, 2, 8, 5, 12, 2, 8);
    carve(g, K.noodle, 9, 10, 20, 22, 9, 10);
    // Water over part of the surface: open air for the sky flood.
    for (let y = 41; y <= 45; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 12; x++) setCell(g, x, y, z, 0, false, true);
    const tops = preCaveTops(g);
    const c = caveComponents(g, tops);
    expect(c.yMax).toBe(41);
    const cell = (x: number, y: number, z: number) => g.cells[((y - GRID_Y0) * 12 + z) * 12 + x]!;
    const full = components3d((x, y, z) => (cell(x, y, z) & 15) !== 0, (x, y, z) => (cell(x, y, z) & 16) === 0, 12, 12, COMP_Y_MIN, 319);
    expect([...c.size]).toEqual([...full.size]);
    expect([...c.sky]).toEqual([...full.sky]);
    expect(Array.from(c.label)).toEqual(Array.from(full.label.subarray(0, c.label.length)));
  });

  test('C1 counts y −56 … top − 8; the kinds, the land and the largest component', () => {
    const g = rock(4, 4, 31);
    carve(g, K.cheese, 0, 3, 0, 1, 0, 3);
    carve(g, K.worm, 0, 0, 10, 10, 0, 0);
    carve(g, K.cheese, 0, 3, -60, -60, 0, 3);
    const tops = preCaveTops(g);
    // y −56 … 23: 80 voxels per position, 16 positions; tagged in range: 32 cheese + 1 worm (y −60 is below the range).
    expect(voidCounts(g, tops)).toEqual({ tagged: 33, voxels: 80 * 16 });
    const kinds = kindCounts(g);
    expect(kinds[K.cheese]).toBe(48);
    expect(kinds[K.worm]).toBe(1);
    expect(kinds[0]).toBe(0);
    // Water over one position: not land; the other 15 are land, all holding a tagged voxel (the y −60 layer).
    setCell(g, 3, 32, 3, 0, false, true);
    expect(landCounts(g)).toEqual({ land: 15, carved: 15 });
    const c = caveComponents(g, tops);
    expect(largestCounts(c)).toEqual({ largest: 32, void: 33 });
  });

  test('C4.floorPeak reads the floors of components ≥ 10,000 voxels only', () => {
    const g = rock(32, 32, 100);
    carve(g, K.cheese, 0, 29, 0, 15, 0, 29);
    carve(g, K.cheese, 0, 3, 40, 43, 0, 3);
    const c = caveComponents(g, preCaveTops(g));
    const floors = floorCounts(g, c);
    expect(floors.length).toBe(319 - COMP_Y_MIN + 1);
    expect(floors[0 - COMP_Y_MIN]).toBe(900);
    expect(floorPeak(floors)).toBe(1);
    // A stepped floor: half the floor at y 0, half at y 4 (the component 12,600 voxels).
    for (let y = 0; y <= 3; y++) for (let z = 0; z <= 29; z++) for (let x = 0; x <= 14; x++) setCell(g, x, y, z, 0, true);
    expect(floorPeak(floorCounts(g, caveComponents(g, preCaveTops(g))))).toBeCloseTo(0.5, 12);
    expect(floorPeak(floorCounts(rock(8, 8, 50), caveComponents(rock(8, 8, 50), preCaveTops(rock(8, 8, 50)))))).toBeNaN();
  });

  test('C3.pillars counts tiles holding a pillar voxel, asks only solid voxels and stops at a tile\'s first hit', () => {
    const g = rock(16, 16, 20);
    carve(g, K.cheese, 0, 15, 0, 5, 0, 15);
    let asked = 0;
    let airAsked = 0;
    const pillarAt = (x: number, y: number, z: number): boolean => {
      asked++;
      if ((g.cells[((y - GRID_Y0) * 16 + z) * 16 + x]! & 16) === 0) airAsked++;
      return x >= 9 && x <= 10 && z >= 1 && z <= 2 && y === 10;
    };
    expect(pillarTiles(g, pillarAt, 8)).toEqual({ tiles: 4, withPillar: 1 });
    expect(airAsked).toBe(0);
    // A column holds 78 solid voxels above y −64 (y −63 … 20, less the 6 carved). The three tiles without a pillar ask
    // every one; the tile (8, 0) asks its row z 0 (8 columns), (8, 1), and (9, 1) up to y 10 (68 voxels), then stops.
    expect(asked).toBe(3 * 64 * 78 + 9 * 78 + 68);
    expect(() => pillarTiles(g, pillarAt, 128)).toThrow(/not a multiple/);
  });

  test('C3.ravines: a source carves when it is the first path carving a ravine voxel; sky-exposed when one is sky', () => {
    const g = rock(32, 32, 60);
    // Ravine voxels: two overlapping balls, and a third ball inside the first; a ball of another kind.
    const a = path(8, 30, 8, 4, 4);
    const b = path(14, 30, 8, 4, 4);
    const inner = path(8, 30, 8, 2, 2);
    const worm = path(24, 30, 24, 3, 3);
    for (let y = 0; y < 60; y++) {
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) {
          if (inEllipsoid(a, 0, x, y, z) || inEllipsoid(b, 0, x, y, z)) setCell(g, x, y, z, K.ravine, false);
          if (inEllipsoid(worm, 0, x, y, z)) setCell(g, x, y, z, K.worm, false);
        }
      }
    }
    const notSky = () => false;
    expect(ravineCounts(g, [a, inner, b], inEllipsoid, notSky)).toMatchObject({ sources: 2, skySources: 0 });
    // The worm's ball holds no ravine voxel.
    expect(ravineCounts(g, [worm], inEllipsoid, notSky).sources).toBe(0);
    // Inner first: it owns its own voxels and a and b keep theirs outside it.
    expect(ravineCounts(g, [inner, a, b], inEllipsoid, notSky).sources).toBe(3);
    // Sky: the voxels with x ≥ 16 (b's far side).
    expect(ravineCounts(g, [a, b], inEllipsoid, (x) => x >= 16)).toMatchObject({ sources: 2, skySources: 1 });
  });

  test('median: odd and even counts, NaN when empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  test('the parts pool regions (C1 per profile, C5.largest the worst region); an empty population is NaN, never ±Infinity', () => {
    const noRavines = { paths: [], carves: () => false };
    const solid = rock(16, 16, 60);
    const carved = rock(16, 16, 60);
    carve(carved, K.cheese, 0, 15, 0, 9, 0, 15);
    carve(carved, K.spaghetti2d, 0, 15, 20, 21, 0, 7);
    carve(carved, K.entrance, 5, 5, 22, 60, 5, 5);
    const none = () => false;
    const rSolid = caveRegionCounts(solid, none, noRavines, 16);
    const rCarved = caveRegionCounts(carved, none, noRavines, 16);
    const empty = c1c6Parts([{ profile: 'default', counts: rSolid }]);
    expect(Object.keys(empty).sort()).toEqual([...C1_C6_PARTS].sort());
    for (const part of C1_C6_PARTS) expect(Number.isFinite(empty[part]) || Number.isNaN(empty[part]), part).toBe(true);
    expect(empty['C1.voidShareMin']).toBe(0);
    expect(empty['C3.cheeseShare']).toBeNaN();
    expect(empty['C5.thinnest']).toBeNaN();
    expect(empty['C5.largest']).toBeNaN();

    const parts = c1c6Parts([{ profile: 'default', counts: rCarved }, { profile: 'large_biomes', counts: rSolid }]);
    const underground = 256 * (60 - 8 + 56 + 1);
    // The entrance's y 22 … 52 lies in C1's range (31 voxels), the cheese 2,560, the spaghetti 256.
    expect(parts['C1.voidShareMax']).toBeCloseTo((2560 + 256 + 31) / underground, 12);
    expect(parts['C1.voidShareMin']).toBe(0);
    const tagged = 2560 + 256 + 39;
    expect(parts['C3.cheeseShare']).toBeCloseTo(2560 / tagged, 12);
    expect(parts['C3.spaghettiShare']).toBeCloseTo(256 / tagged, 12);
    expect(parts['C3.entranceShare']).toBeCloseTo(39 / tagged, 12);
    expect(parts['C3.maxShare']).toBeCloseTo(2560 / tagged, 12);
    expect(parts['C3.pillars']).toBe(0);
    // Area 2 × 256 m²: one deep sky component (the shaft, joined to the spaghetti below it) per 512 m².
    expect(parts['C2.skyComponents']).toBeCloseTo(1 / (512 / 1e6), 6);
    // Largest component: the cheese slab, 2,560 of the carved region's 2,855 (the spaghetti and the shaft apart).
    expect(parts['C5.largest']).toBeCloseTo(2560 / tagged, 12);
    expect(parts['C5.landCarved']).toBeCloseTo(256 / 512, 12);
    for (const part of C1_C6_PARTS) expect(Number.isFinite(parts[part]) || Number.isNaN(parts[part]), part).toBe(true);
  });

  test('the grid is the world: GRID_Y0 −64, 384 layers', () => {
    expect(GRID_Y0).toBe(-64);
    expect(GRID_H).toBe(384);
  });
});

describe('the caves instruments on fixtures (SP6a §10.1, C7-C9)', () => {
  /** A checkerboard of single cave voxels ((x + z) even) at y 10 over the grid: every residue has the same walls. */
  function checker(g: CaveGrid): void {
    for (let z = g.z0; z < g.z0 + g.d; z++) for (let x = g.x0; x < g.x0 + g.w; x++) if ((x + z) % 2 === 0) setCell(g, x, 10, z, K.cheese, false);
  }

  test('C7.borderPlaneRatio is 1 on a lattice-uniform fixture and > 1.1 on a cave cut at the planes x mod 16 = 0', () => {
    const g = rock(48, 32, 100);
    checker(g);
    const u = borderPlaneRatio(wallResidues(g));
    for (const k of ['x0', 'x15', 'z0', 'z15'] as const) expect(u[k], k).toBeCloseTo(1, 12);
    expect(u.value).toBeCloseTo(1, 12);
    // A cave filling the chunk x 16 … 31 (y 50 … 59, every z) ends on flat walls at the chunk's borders: the cave voxels
    // x 16 (x mod 16 = 0) and x 31 (x mod 16 = 15) hold 320 x-facing walls each, the residues 4, 8, 12 and 3, 7, 11 none.
    carve(g, K.worm, 16, 31, 50, 59, 0, 31);
    const r = wallResidues(g);
    // The checker's walls: x 0 (16, the box's face cuts the other), x 16 and x 32 (32 each); likewise x 15, 31, 47.
    expect(r.faces[0]! - 80).toBe(320);
    expect(r.faces[15]! - 80).toBe(320);
    const cut = borderPlaneRatio(r);
    expect(cut.x0).toBeGreaterThan(1.1);
    expect(cut.x15).toBeGreaterThan(1.1);
    expect(cut.z0).toBeCloseTo(1, 12);
    expect(cut.value).toBeGreaterThan(1.1);
    // The farthest ratio from 1 is the part, below 1 as well: walls only at the residues 4, 8, 12 read 0.
    const lean = rock(32, 32, 100);
    for (const x of [4, 8, 12, 20, 24, 28]) carve(lean, K.cheese, x, x, 20, 20, 3, 3);
    for (const x of [3, 7, 11, 15, 19, 23, 27]) carve(lean, K.cheese, x, x, 30, 30, 9, 9);
    const l = borderPlaneRatio(wallResidues(lean));
    expect(l.x0).toBe(0);
    expect(l.value).toBe(0);
    expect(borderPlaneRatio(wallResidues(rock(16, 16, 50))).value).toBeNaN();
  });

  test('C7.flatWallShare counts a 6 × 6 planar patch of walls and not a 5 × 6 one; a position mask keeps its positions', () => {
    const g = rock(16, 16, 100);
    carve(g, K.cheese, 2, 7, 20, 20, 2, 7);
    // A 6 × 1 × 6 slab: its floor and ceiling are 6 × 6 patches (72 faces), its four sides 6 × 1 (24 faces).
    expect(flatWallCounts(g)).toEqual({ faces: 96, flat: 72 });
    const h = rock(16, 16, 100);
    carve(h, K.cheese, 2, 6, 20, 20, 2, 7);
    expect(flatWallCounts(h)).toEqual({ faces: 2 * 30 + 2 * 5 + 2 * 6, flat: 0 });
    // A 6 × 6 wall face patch (an x-facing wall 6 high and 6 deep) beside a 5 × 6 one.
    const w = rock(16, 16, 100);
    carve(w, K.cheese, 3, 3, 30, 35, 2, 7);
    carve(w, K.cheese, 10, 10, 30, 34, 2, 7);
    const f = flatWallCounts(w);
    expect(f.flat).toBe(2 * 36);
    // An L of two 6 × 6 squares overlapping in 3 × 6 faces counts each face once (54 faces per side).
    const l = rock(16, 16, 100);
    carve(l, K.cheese, 2, 10, 20, 20, 2, 7);
    carve(l, K.cheese, 2, 7, 20, 20, 8, 10);
    expect(flatWallCounts(l).flat).toBe(2 * (9 * 6 + 6 * 3));
    // The mask: only the positions with z ≤ 4 (3 of the slab's 6 rows): no 6 × 6 patch left.
    const mask = new Uint8Array(256);
    for (let z = 0; z <= 4; z++) for (let x = 0; x < 16; x++) mask[z * 16 + x] = 1;
    expect(flatWallCounts(g, mask).flat).toBe(0);
    // The floor and ceiling's 18 faces each, the x sides' 3 each, the z = 2 side's 6.
    expect(flatWallCounts(g, mask).faces).toBe(2 * 18 + 2 * 3 + 6);
  });

  test('flatWallCounts equals a brute force over every 6 × 6 square on random blobs; the detail splits it per orientation', () => {
    let seed = 99;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 4; trial++) {
      const w = 20;
      const d = 18;
      const g = rock(w, d, 0);
      for (let b = 0; b < 5; b++) {
        // Boxes, so planar patches of every size occur.
        const x0 = Math.floor(rnd() * 14), z0 = Math.floor(rnd() * 12), y0 = -60 + Math.floor(rnd() * 40);
        carve(g, K.cheese, x0, x0 + 2 + Math.floor(rnd() * 8), y0, y0 + Math.floor(rnd() * 9), z0, z0 + 2 + Math.floor(rnd() * 8));
      }
      for (let k = 0; k < 300; k++) setCell(g, Math.floor(rnd() * w), -60 + Math.floor(rnd() * 50), Math.floor(rnd() * d), 0, true);
      const cell = (x: number, y: number, z: number): number =>
        x < 0 || x >= w || z < 0 || z >= d || y < GRID_Y0 || y >= GRID_Y0 + GRID_H ? -1 : g.cells[((y - GRID_Y0) * d + z) * w + x]!;
      const isWall = (x: number, y: number, z: number, o: number): boolean => {
        const c = cell(x, y, z);
        if (c < 0 || (c & 15) === 0 || (c & 16) !== 0) return false;
        const [dx, dy, dz] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]][o]!;
        const n = cell(x + dx!, y + dy!, z + dz!);
        return n >= 0 && (n & 16) !== 0;
      };
      let faces = 0;
      let flat = 0;
      for (let y = GRID_Y0; y < GRID_Y0 + GRID_H; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) for (let o = 0; o < 6; o++) {
        if (!isWall(x, y, z, o)) continue;
        faces++;
        // The plane's two axes: (y, z) for x walls, (x, z) for y walls, (x, y) for z walls.
        const at = (u: number, v: number): boolean =>
          o < 2 ? isWall(x, u, v, o) : o < 4 ? isWall(u, y, v, o) : isWall(u, v, z, o);
        const [u0, v0] = o < 2 ? [y, z] : o < 4 ? [x, z] : [x, y];
        let hit = false;
        for (let a = u0 - 5; a <= u0 && !hit; a++) for (let b = v0 - 5; b <= v0 && !hit; b++) {
          let all = true;
          for (let i = 0; i < 6 && all; i++) for (let j = 0; j < 6 && all; j++) if (!at(a + i, b + j)) all = false;
          if (all) hit = true;
        }
        if (hit) flat++;
      }
      expect(flatWallCounts(g), `trial ${trial}`).toEqual({ faces, flat });
      expect(flat, `trial ${trial} has flat walls`).toBeGreaterThan(0);
      const det = flatWallDetail(g);
      expect(det.flatBy.reduce((a, v) => a + v, 0)).toBe(flat);
      expect(det.flatFloorsByY.reduce((a, v) => a + v, 0)).toBe(det.flatBy[2]);
      expect(det.flatCeilingsByY.reduce((a, v) => a + v, 0)).toBe(det.flatBy[3]);
    }
  });

  test('C7.verticalStep: the largest ratio of 3-layer smoothed carve rates between neighbouring layers, rates ≥ 0.1 %', () => {
    // A uniform rate gives 1; a step from 1 in 16 to 1 in 4 positions at y 0 gives (2a + b)/3 over (a + b)… the smoothed
    // rates around the step.
    const g = rock(16, 16, 200);
    for (let y = -63; y < 0; y++) carve(g, K.cheese, 0, 3, y, y, 0, 3);
    for (let y = 0; y <= 150; y++) carve(g, K.cheese, 0, 7, y, y, 0, 7);
    const c = layerCounts(g, preCaveTops(g));
    expect(c.voxels[0 + 64]).toBe(256);
    expect(c.tagged[0 + 64]).toBe(64);
    const a = 16 / 256;
    const b = 64 / 256;
    // The smoothed rates: a at y ≤ −2, (2a + b)/3 at −1, (a + 2b)/3 at 0, b from 1: the largest step is b / ((a + 2b)/3).
    expect(verticalStep(c)).toBeCloseTo(Math.max(((a + 2 * b) / 3) / ((2 * a + b) / 3), b / ((a + 2 * b) / 3), ((2 * a + b) / 3) / a), 12);
    // The largest is (2a + b)/3 over a: y −1 against −2, over 3 · 256 voxels.
    expect(verticalStepDetail(c)).toMatchObject({ y: -1, n: -2, voxels: 768 });
    expect(verticalStepDetail(c).rate).toBeCloseTo((2 * a + b) / 3, 12);
    const uniform = rock(16, 16, 200);
    for (let y = -63; y <= 150; y++) carve(uniform, K.cheese, 0, 7, y, y, 0, 7);
    expect(verticalStep(layerCounts(uniform, preCaveTops(uniform)))).toBeCloseTo(1, 12);
    // Rates under 0.1 % are left out: nothing carved is NaN.
    const none = rock(16, 16, 200);
    expect(verticalStep(layerCounts(none, preCaveTops(none)))).toBeNaN();
  });

  test('C7.switchWall: walls in the shell |T − 8| < 1 over the shell\'s share of the pre-cave rock, on a known T', () => {
    const g = rock(16, 16, 100);
    // T = 100 − y: the shell is y 92 (T 8; y 91 and 93 have |T − 8| = 1).
    carve(g, K.cheese, 4, 11, 80, 92, 4, 11);
    const c = switchWallCounts(g, (_x, y) => 100 - y);
    // Walls: the ceiling (64) and the sides of y 92 (32) in the shell; the floor (64) and the sides of y 80 … 91 (384).
    expect(c).toEqual({ faces: 544, shellFaces: 96, voxels: 256 * (100 - COMP_Y_MIN + 1), shellVoxels: 256 });
    expect(switchWall(c)).toBeCloseTo((96 / 544) / (256 / (256 * 157)), 12);
    // A stride of 2 chunks reads the columns of every second chunk only (here the one chunk, cx 0).
    const big = rock(48, 16, 100);
    carve(big, K.cheese, 4, 11, 80, 92, 4, 11);
    carve(big, K.cheese, 20, 27, 80, 92, 4, 11);
    let asked = 0;
    const s = switchWallCounts(big, (x, y) => { asked++; expect(x >> 4).not.toBe(1); return 100 - y; }, 2);
    expect(s.shellFaces).toBe(96);
    expect(s.faces).toBe(544);
    expect(asked).toBeGreaterThan(0);
  });

  test('C7.waterWall counts the water voxels horizontally next to tagged air', () => {
    const g = rock(16, 16, 60);
    for (let y = 61; y <= 62; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) setCell(g, x, y, z, 0, false, true);
    expect(waterWallCount(g)).toBe(0);
    // An entrance opening at y 61 … 62 beside water: its 4 horizontal neighbours on each of 2 layers.
    carve(g, K.entrance, 8, 8, 40, 62, 8, 8);
    expect(waterWallCount(g)).toBe(8);
    // Tagged water is not tagged air.
    setCell(g, 8, 61, 8, K.entrance, false, true);
    setCell(g, 8, 62, 8, K.entrance, false, true);
    expect(waterWallCount(g)).toBe(0);
  });

  test('C8.aperiodicity is < 0.9 on a 16-periodic fixture, about 1 on a random one, and computed only for L ≤ width − 16', () => {
    expect(aperiodicLags(64)).toEqual([16, 32]);
    expect(aperiodicLags(256)).toEqual([16, 32, 64, 128]);
    expect(aperiodicLags(512)).toEqual([16, 32, 64, 128, 256]);
    expect(aperiodicLags(32)).toEqual([16]);
    expect(aperiodicLags(16)).toEqual([]);
    const g = rock(64, 48, 100);
    for (const y of [-40, 0, 40]) for (let z = 0; z < 48; z++) for (let x = 0; x < 64; x++) if (x % 16 < 4 && z % 5 !== 0) setCell(g, x, y, z, K.cheese, false);
    const counts = aperiodicCounts(g);
    expect(counts.filter((c) => c.axis === 'x').map((c) => c.lag)).toEqual([16, 32, 16, 32, 16, 32]);
    expect(counts.filter((c) => c.axis === 'z').map((c) => c.lag)).toEqual([16, 32, 16, 32, 16, 32]);
    const x16 = counts.find((c) => c.axis === 'x' && c.lag === 16 && c.y === 0)!;
    expect(x16.pairs).toBe((64 - 16) * 48);
    expect(x16.diff).toBe(0);
    expect(aperiodicity(counts)).toBeLessThan(0.9);
    expect(aperiodicity(counts)).toBe(0);
    let s = 7;
    const rnd = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
    const r = rock(128, 128, 100);
    for (const y of [-40, 0, 40]) for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) if (rnd() < 0.2) setCell(r, x, y, z, K.cheese, false);
    const v = aperiodicity(aperiodicCounts(r));
    expect(v).toBeGreaterThan(0.9);
    expect(v).toBeLessThan(1.1);
    // Nothing carved: every expected difference is 0, an undefined population.
    expect(aperiodicity(aperiodicCounts(rock(64, 64, 100)))).toBeNaN();
  });

  test('C8.typeMixVariation: Jensen-Shannon divergences (bits) of the kind shares between edge-adjacent tiles', () => {
    expect(jensenShannon([1, 0, 0, 0, 0], [0, 1, 0, 0, 0])).toBeCloseTo(1, 12);
    expect(jensenShannon([2, 2, 0, 0, 0], [1, 1, 0, 0, 0])).toBe(0);
    expect(jensenShannon([1, 1, 0, 0, 0], [1, 0, 0, 0, 0])).toBeCloseTo(1.5 - 0.75 * Math.log2(3), 12);
    const g = rock(32, 32, 100);
    // Tiles of 16: (0, 0) cheese, (1, 0) cheese, (0, 1) cheese and spaghetti 3D equally, (1, 1) nothing.
    carve(g, K.cheese, 2, 5, 10, 10, 2, 5);
    carve(g, K.cheese, 20, 23, 10, 10, 2, 5);
    carve(g, K.cheese, 2, 5, 10, 10, 20, 23);
    carve(g, K.spaghetti3d, 2, 5, 20, 20, 20, 23);
    const d = typeMixDivergences(g, 16);
    // Pairs with both tiles holding cave air: (0,0)-(1,0) 0 and (0,0)-(0,1) the half-split's divergence.
    expect(d.slice().sort((a, b) => a - b)).toEqual([0, jensenShannon([1, 0, 0, 0, 0], [1, 1, 0, 0, 0])]);
    // Spaghetti 3D and 2D are one share (C3's), as are the three carvers.
    const h = rock(32, 16, 100);
    carve(h, K.spaghetti3d, 2, 5, 10, 10, 2, 5);
    carve(h, K.spaghetti2d, 20, 23, 10, 10, 2, 5);
    expect(typeMixDivergences(h, 16)).toEqual([0]);
  });

  test('C8.sizeSpread\'s log-sd and percentile', () => {
    expect(logSd([Math.E, Math.E ** 3])).toBeCloseTo(Math.SQRT2, 12);
    expect(logSd([100])).toBeNaN();
    expect(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([3], 0.9)).toBe(3);
    expect(percentile([], 0.9)).toBeNaN();
    expect(percentile([1, Number.NaN, 2], 0.5)).toBe(1);
  });

  test('C9.nearestEntrance: the distances from land positions to a fixture\'s one opening; NaN without one', () => {
    const g = rock(32, 32, 60);
    // An entrance shaft at (5, 5) from y 40 to the top: one sky component reaching 8 below the top, opening at (5, 5).
    carve(g, K.entrance, 5, 5, 40, 60, 5, 5);
    // A sealed pocket is no opening.
    carve(g, K.cheese, 20, 22, 10, 12, 20, 22);
    const tops = preCaveTops(g);
    const c = caveComponents(g, tops);
    const open = openingMask(g, tops, c);
    expect(open.reduce((a, v) => a + v, 0)).toBe(1);
    expect(open[5 * 32 + 5]).toBe(1);
    const eligible = new Uint8Array(1024).fill(1);
    const { distances, positions } = nearestEntranceDistances(g, open, eligible);
    expect(distances.length).toBe(256);
    expect(new Set(positions).size).toBe(256);
    for (let i = 0; i < 256; i++) {
      const p = positions[i]!;
      expect(distances[i]).toBeCloseTo(Math.hypot((p % 32) - 5, Math.floor(p / 32) - 5), 12);
    }
    // Only eligible positions are drawn; fewer than 256 eligible gives all of them.
    const few = new Uint8Array(1024);
    few[3] = 1;
    few[1000] = 1;
    expect(Array.from(nearestEntranceDistances(g, open, few).positions).sort((a, b) => a - b)).toEqual([3, 1000]);
    // A shaft only 5 deep is not a C2 component: no opening, every distance NaN.
    const shallow = rock(32, 32, 60);
    carve(shallow, K.entrance, 5, 5, 56, 60, 5, 5);
    const st = preCaveTops(shallow);
    const none = openingMask(shallow, st, caveComponents(shallow, st));
    expect(none.reduce((a, v) => a + v, 0)).toBe(0);
    expect(Array.from(nearestEntranceDistances(shallow, none, eligible).distances).every(Number.isNaN)).toBe(true);
  });

  test('C9.holedSurface and C9.thinRoof: land positions holed at the pre-cave top, or with cave air 1 … 3 under the top', () => {
    const g = rock(8, 8, 60);
    carve(g, K.entrance, 1, 1, 40, 60, 1, 1);
    carve(g, K.cheese, 4, 5, 57, 58, 4, 4);
    carve(g, K.cheese, 6, 6, 50, 56, 6, 6);
    // Water over one position: not land.
    setCell(g, 7, 61, 7, 0, false, true);
    expect(surfaceCounts(g, preCaveTops(g))).toEqual({ land: 63, holed: 1, thinRoof: 2 });
  });

  test('the C7-C9 parts: one region\'s counts, the groups, NaN for an empty population, never ±Infinity', () => {
    const g = rock(16, 16, 60);
    carve(g, K.cheese, 0, 15, 0, 9, 0, 15);
    carve(g, K.entrance, 5, 5, 10, 60, 5, 5);
    const tops = preCaveTops(g);
    const c = caveComponents(g, tops);
    const all = new Uint8Array(256).fill(1);
    const counts = caveC7C9Counts(g, tops, c, { T: (_x, y) => 60 - y, stride: 1, eligible: all, seaFloor: null, tile: 16 });
    const solid = rock(16, 16, 60);
    const st = preCaveTops(solid);
    const empty = caveC7C9Counts(solid, st, caveComponents(solid, st), { T: (_x, y) => 60 - y, stride: 1, eligible: all, seaFloor: null, tile: 16 });
    const parts = c7c9Parts([{ group: 'default', full: false, counts }, { group: 'default', full: false, counts: empty }]);
    expect(Object.keys(parts).sort()).toEqual([...C7_C9_PARTS].sort());
    for (const part of C7_C9_PARTS) expect(Number.isFinite(parts[part]) || Number.isNaN(parts[part]), part).toBe(true);
    // Regions smaller than 32 × 32 chunks: C8's aperiodicity, sizeSpread and largeShare are NaN.
    expect(parts['C8.aperiodicity']).toBeNaN();
    expect(parts['C8.sizeSpread']).toBeNaN();
    expect(parts['C8.largeShare']).toBeNaN();
    // One C2 component (the shaft and the slab) over 2 × 256 m²; the shaft's top holed, 1 of 512 land positions.
    expect(parts['C9.entrancesMax']).toBeCloseTo(1 / (512 / 1e6), 6);
    expect(parts['C9.holedSurface']).toBeCloseTo(1 / 512, 12);
    expect(parts['C9.nearestEntrance']).toBeGreaterThan(0);
    // The same regions counted as full-size ones: the slab (2,560 voxels) is one component ≥ 64, its log-sd undefined.
    const full = c7c9Parts([{ group: 'default', full: true, counts }]);
    expect(full['C8.sizeSpread']).toBeNaN();
    expect(full['C8.largeShare']).toBe(0);
    // A preset group's part is the worse of the groups: holedSurface over the preset alone is 1 / 256.
    const both = c7c9Parts([{ group: 'default', full: false, counts: empty }, { group: 'amplified', full: false, counts }]);
    expect(both['C9.holedSurface']).toBeCloseTo(1 / 256, 12);
    // …but the default-only parts read the default group only.
    expect(both['C9.entrancesMax']).toBe(0);
  });

  test('the cave examples: per kind its largest component\'s voxel nearest the centre, the entrance at its top, a pillar, an interior', () => {
    const g = rock(32, 32, 60);
    carve(g, K.cheese, 2, 11, 10, 19, 2, 11);
    carve(g, K.cheese, 20, 21, 10, 11, 20, 21);
    carve(g, K.spaghetti3d, 0, 31, 30, 31, 16, 17);
    carve(g, K.entrance, 25, 25, 40, 60, 5, 5);
    const tops = preCaveTops(g);
    const c = caveComponents(g, tops);
    const thick = localThickness(c, 32, 32);
    // Pillar rock in the big cavern's wall (12, 15, 7): the wall's rock runs on, so it is no free-standing pillar.
    const ex = caveExamples(g, tops, c, thick, (x, y, z) => x === 12 && y === 15 && z === 7);
    // The cheese: the 10³ cavern (not the 2³ one), its voxel nearest the centre (16, 16): (11, ·, 11), lowest y first.
    expect(ex.cheese).toMatchObject({ voxel: [11, 10, 11] });
    expect(ex.spaghetti3d).toMatchObject({ voxel: [15, 30, 16] });
    expect(ex.entrance).toMatchObject({ voxel: [25, 60, 5], pitch: -60 });
    expect(ex.pillars).toBeNull();
    expect(ex.noodle).toBeNull();
    expect(ex.worm).toBeNull();
    // The largest interior: the cavern (1,000 voxels; the tube is 128), at a voxel of its thickest ball (10).
    expect(ex.interior).not.toBeNull();
    const [ix, iy, iz] = ex.interior!.voxel;
    expect(ix >= 2 && ix <= 11 && iy >= 10 && iy <= 19 && iz >= 2 && iz <= 11).toBe(true);
    // A pose stands at the voxel's centre and looks along its longest run of open voxels (yaw in degrees, 0 = −z).
    expect(ex.spaghetti3d).toMatchObject({ x: 15.5, y: 30.5, z: 16.5 });
    expect([90, 270]).toContain(ex.spaghetti3d!.yaw);
  });

  test('the cave examples\' pillars: a free-standing pillar of a cavern, the pose PILLAR_BACK … PILLAR_VIEW out looking back at it (D16)', () => {
    // A 20 × 10 × 20 cheese cavern holding a 2 × 2 rock column from its floor (y 10) to its ceiling (y 19).
    const g = rock(32, 32, 60);
    carve(g, K.cheese, 2, 21, 10, 19, 2, 21);
    for (let y = 10; y <= 19; y++) for (const [x, z] of [[6, 6], [7, 6], [6, 7], [7, 7]] as const) setCell(g, x, y, z, 0, true);
    const tops = preCaveTops(g);
    const c = caveComponents(g, tops);
    const thick = localThickness(c, 32, 32);
    const column = (x: number, y: number, z: number): boolean => x >= 6 && x <= 7 && z >= 6 && z <= 7 && y >= 10 && y <= 19;
    // Pillar rock in the wall at (22, 15, 15), nearer the centre, is passed over: the wall's rock in its row runs on.
    const wallToo = (x: number, y: number, z: number): boolean => column(x, y, z) || (x === 22 && y === 15 && z === 15);
    // The column's voxel nearest the centre, (7, ·, 7), lowest y first (its rock runs PILLAR_RISE above and below: the
    // floor's rock under it); the column's middle (6.5, 6.5) rounds to (7, 7); out of the rock, +x, +x+z and +z run 14
    // open voxels to the wall (−z, −x and the other diagonals 4 or 5, under PILLAR_BACK); the farthest, ties to the
    // smaller yaw: +x, the eye at the 14th, (21, 10, 7), looking back at the column (yaw 270, −x).
    const pose = { x: 21.5, y: 10.5, z: 7.5, yaw: 270, pitch: 0, voxel: [21, 10, 7], component: 4000 - 40 };
    expect([PILLAR_BACK, PILLAR_VIEW]).toEqual([8, 20]);
    expect(caveExamples(g, tops, c, thick, wallToo, 3000).pillars).toEqual(pose);
    // With no cavern that large (C4's 10,000 voxels by default), the second pass takes any cheese air: the same pose.
    expect(caveExamples(g, tops, c, thick, wallToo).pillars).toEqual(pose);
    // Not pillar rock (pillarAt false): no pose.
    expect(caveExamples(g, tops, c, thick, () => false).pillars).toBeNull();
    // A pillar whose row's rock holds more than PILLAR_AREA_MAX voxels is part of a wall: a 32 × 16 slab and one voxel.
    const big = rock(64, 64, 60);
    carve(big, K.cheese, 2, 61, 10, 19, 2, 61);
    for (let y = 10; y <= 19; y++) {
      for (let z = 20; z < 20 + 16; z++) for (let x = 20; x < 20 + 32; x++) setCell(big, x, y, z, 0, true);
      setCell(big, 52, y, 20, 0, true);
    }
    expect(16 * 32).toBe(PILLAR_AREA_MAX);
    const bt = preCaveTops(big);
    const bc = caveComponents(big, bt);
    const slab = (x: number, y: number, z: number): boolean => x >= 20 && x < 52 && z >= 20 && z < 36 && y >= 10 && y <= 19;
    expect(caveExamples(big, bt, bc, localThickness(bc, 64, 64), slab).pillars).toBeNull();
    // Without that voxel (512) it stands free.
    for (let y = 10; y <= 19; y++) setCell(big, 52, y, 20, K.cheese, false);
    const bt2 = preCaveTops(big);
    const bc2 = caveComponents(big, bt2);
    // Its middle (35.5, 27.5) rounds to (36, 28); +z runs 26 open voxels out of the slab, capped at PILLAR_VIEW: the eye
    // 20 out, at (36, 10, 55), looking back (yaw 0, −z); −x and −z run 18, +x 10.
    expect(caveExamples(big, bt2, bc2, localThickness(bc2, 64, 64), slab).pillars)
      .toEqual({ x: 36.5, y: 10.5, z: 55.5, yaw: 0, pitch: 0, voxel: [36, 10, 55], component: 36_000 - 5120 });
  });

  test('the cave examples\' pillars: a cavern\'s pillar wins over a nearer pocket\'s; with no cavern, the pocket\'s (Task 52, minors-8)', () => {
    // A 48 × 48 region, centre (24, 24). The cavern: 20 × 10 × 20 cheese with a 2 × 2 rock column at (6 … 7, 6 … 7),
    // 3,960 voxels. The pocket, apart from it: 22 × 6 × 4 cheese at x 24 … 45, y 10 … 15, z 24 … 27 with a 1 × 1 rock
    // pillar at (26, 25), 522 voxels; its pillar is nearer the centre.
    const g = rock(48, 48, 60);
    carve(g, K.cheese, 2, 21, 10, 19, 2, 21);
    for (let y = 10; y <= 19; y++) for (const [x, z] of [[6, 6], [7, 6], [6, 7], [7, 7]] as const) setCell(g, x, y, z, 0, true);
    carve(g, K.cheese, 24, 45, 10, 15, 24, 27);
    for (let y = 10; y <= 15; y++) setCell(g, 26, y, 25, 0, true);
    const tops = preCaveTops(g);
    const c = caveComponents(g, tops);
    expect([...c.size.values()].sort((a, b) => a - b)).toEqual([522, 3960]);
    const thick = localThickness(c, 48, 48);
    const pillars = (x: number, y: number, z: number): boolean =>
      (x >= 6 && x <= 7 && z >= 6 && z <= 7 && y >= 10 && y <= 19) || (x === 26 && z === 25 && y >= 10 && y <= 15);
    // A cavern from 3,000 voxels: the cavern's column, as in the test above (+x runs 14 open voxels to the wall: the eye
    // at (21, 10, 7), looking back, yaw 270), though the pocket's pillar is nearer the centre.
    expect(caveExamples(g, tops, c, thick, pillars, 3000).pillars)
      .toEqual({ x: 21.5, y: 10.5, z: 7.5, yaw: 270, pitch: 0, voxel: [21, 10, 7], component: 3960 });
    // No component reaches C4's 10,000 voxels: any cheese air, so the nearest pillar, the pocket's; +x runs 19 open voxels
    // (x 27 … 45; −x 2, ±z and the diagonals under PILLAR_BACK): the eye at (45, 10, 25), looking back (yaw 270).
    expect(caveExamples(g, tops, c, thick, pillars).pillars)
      .toEqual({ x: 45.5, y: 10.5, z: 25.5, yaw: 270, pitch: 0, voxel: [45, 10, 25], component: 522 });
  });
});


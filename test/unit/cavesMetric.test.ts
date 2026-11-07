import { describe, expect, test } from 'vitest';
import { CAVE_KIND } from '../../src/core/constants';
import type { CarverPath } from '../../src/gen/caves/carvers';
import {
  bandCounts, bandsMin, c1c6Parts, C1_C6_PARTS, caveComponents, caveRegionCounts, COMP_Y_MIN, emptyCaveGrid, floorCounts,
  floorPeak, GRID_H, GRID_Y0, kindCounts, landCounts, largestCounts, latticeBias, localThickness, median, pillarTiles, preCaveTops,
  ravineCounts, setCell, skyCounts, thinnestAxes, voidCounts, type CaveGrid,
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

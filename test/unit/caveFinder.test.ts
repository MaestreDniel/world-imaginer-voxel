/**
 * The Caves tab's finder (SP6a spec §7.3, D12, D16; Spec correction 21; Task 44): `nearestCave`, the search core of the
 * pool's `findCave` job, at seed 42 from L10's hover point (Task 45's L13 start), with its clock, its stop and its loaded
 * columns injected: every kind with a button found within 512 blocks; a carver kind found from its paths' centres with
 * density read only in the columns of the candidates it tried, skipping a centre in density air or above the ground;
 * the loaded columns read from their stored tags with no density; the deadline (`budget`), `stop` (`stopped`) and an
 * absent kind (`radius`), with no ring past the radius.
 */
import { describe, expect, test } from 'vitest';
import { CARVER_WINDOW_R, CAVE_BIOME, CAVE_KIND } from '../../src/core/constants';
import { carverCacheOf } from '../../src/gen/caves/carverCache';
import type { CarverKind } from '../../src/gen/caves/carvers';
import { caveTagAt, nearestCave, type FindOptions } from '../../src/gen/caves/tags';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { solidAt } from '../../src/gen/density/probe';
import type { ColumnView } from '../../src/world/store/api';
import { NIBBLE_REGION, nibbleRegion } from '../harness/caveNibbles';
import { ctxFor } from '../harness/gen';
import type { RegionView } from '../harness/regionView';

/**
 * L10's hover point at seed 42, where L13 starts (Task 45; Spec correction 20): the spawn (0, 0), L1's 400 blocks east,
 * L3's and L4's 4,800 north, L9's 20,000 east; the landing's y there, 198 + 24 (`landingY`).
 */
const L13_START = [20400, 222, -4800] as const;
const [X, Y, Z] = L13_START;
const ctx = ctxFor('42');
const dc = createDensityContext(ctx);
const NEVER = (): boolean => false;
const NONE = (): ColumnView | null => null;

/** The search's options: radius 512, a clock that never passes the deadline, no stop, nothing loaded; `o` overrides. */
const opts = (o: Partial<FindOptions> = {}): FindOptions => ({ radius: 512, deadline: 1, now: () => 0, stop: NEVER, loaded: NONE, ...o });
const key = (cx: number, cz: number): string => `${cx},${cz}`;

/** `d` wrapped so that every column it makes current (where density is evaluated) is recorded in `seen`. */
function counting(d: DensityContext, seen: Set<string>): DensityContext {
  return { ...d, column(cx, cz) { seen.add(key(cx, cz)); return d.column(cx, cz); } };
}

/** The columns of every ellipsoid centre of kind `kind`'s paths that can reach 512 blocks of (X, Z): the candidates' columns. */
function centreColumns(kind: CarverKind): Set<string> {
  const cache = carverCacheOf(ctx);
  const out = new Set<string>();
  const m = 32 + 1 + CARVER_WINDOW_R;
  for (let sz = (Z >> 4) - m; sz <= (Z >> 4) + m; sz++) {
    for (let sx = (X >> 4) - m; sx <= (X >> 4) + m; sx++) {
      const p = cache.path(kind, sx, sz);
      if (p === null) continue;
      for (let e = 0; e < p.count; e++) out.add(key(Math.floor(p.ell[6 * e]!) >> 4, Math.floor(p.ell[6 * e + 2]!) >> 4));
    }
  }
  return out;
}

/** The first ellipsoid centre (worm paths around (X, Z), sources in z then x order) whose voxel satisfies `pick`. */
function wormCentre(pick: (x: number, y: number, z: number) => boolean): [number, number, number] {
  const cache = carverCacheOf(ctx);
  for (let sz = (Z >> 4) - 12; sz <= (Z >> 4) + 12; sz++) {
    for (let sx = (X >> 4) - 12; sx <= (X >> 4) + 12; sx++) {
      const p = cache.path('worm', sx, sz);
      if (p === null) continue;
      for (let e = 0; e < p.count; e++) {
        const x = Math.floor(p.ell[6 * e]!), y = Math.floor(p.ell[6 * e + 1]!), z = Math.floor(p.ell[6 * e + 2]!);
        if (y > -64 && y <= 319 && pick(x, y, z)) return [x, y, z];
      }
    }
  }
  throw new Error('no such centre');
}

/** A stored column (cx, cz) whose cave bytes are `tags` (`lx,y,lz` → kind), 0 elsewhere, as the store's view reads them. */
function storedColumn(cx: number, cz: number, tags: ReadonlyMap<string, number>): ColumnView {
  const at = (lx: number, y: number, lz: number): number => tags.get(`${lx},${y},${lz}`) ?? 0;
  const section = (sy: number): Uint8Array | number => {
    const a = new Uint8Array(4096);
    let any = false;
    for (let i = 0; i < 4096; i++) {
      a[i] = at(i & 15, -64 + 16 * sy + (i >> 8), (i >> 4) & 15);
      any ||= a[i] !== 0;
    }
    return any ? a : 0;
  };
  const no = (): never => { throw new Error('the finder reads only the cave channel'); };
  return {
    cx, cz, block: no, fluid: no, light: no, sectionBlocks: no, sectionFluid: no, sectionLight: no, aux: no, auxB: no,
    sectionCave: section, cave: at,
  };
}

const horizontal = (h: { x: number; z: number }): number => Math.hypot(h.x - X, h.z - Z);

describe('nearestCave (SP6a spec §7.3, D12, D16)', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('kind %i is found from L13\'s start within 512 blocks: an air voxel of that kind, with a yaw along an axis', (kind) => {
    const r = nearestCave(dc, kind, X, Y, Z, opts());
    expect(r.reason).toBe('found');
    const h = r.hit!;
    expect(caveTagAt(dc, h.x, h.y, h.z)).toBe(kind);
    expect(solidAt(dc, h.x, h.y, h.z)).toBe(false);
    expect(horizontal(h)).toBeLessThan(512);
    expect([0, 90, 180, 270]).toContain(h.yaw);
    // Pure: the same search, the same hit.
    expect(nearestCave(dc, kind, X, Y, Z, opts())).toEqual(r);
  });

  test.each([[CAVE_KIND.worm, 'worm'], [CAVE_KIND.ravine, 'ravine'], [CAVE_KIND.undergroundWorm, 'undergroundWorm']] as const)(
    'carver kind %i (%s) is found with nothing loaded and density read only in the columns of the candidates it tried (no ring lattice)', (kind, name) => {
      const seen = new Set<string>();
      const r = nearestCave(counting(dc, seen), kind, X, Y, Z, opts());
      expect(r.reason).toBe('found');
      expect(caveTagAt(dc, r.hit!.x, r.hit!.y, r.hit!.z)).toBe(kind);
      const centres = centreColumns(name);
      expect(seen.size).toBeGreaterThan(0);
      for (const c of seen) expect(centres.has(c), c).toBe(true);
      expect(seen.has(key(r.hit!.x >> 4, r.hit!.z >> 4))).toBe(true);
      // A lattice over the ring would have read every column within the hit's distance.
      expect(seen.size).toBeLessThan(40);
    });

  test('a candidate centre in density air (a noise kind wins) or above the ground (nothing carved) is skipped for the next', () => {
    const inCheese = wormCentre((x, y, z) => caveTagAt(dc, x, y, z) === CAVE_KIND.cheese);
    const inSky = wormCentre((x, y, z) => caveTagAt(dc, x, y, z) === 0 && !solidAt(dc, x, y, z));
    for (const [x, y, z] of [inCheese, inSky]) {
      const seen = new Set<string>();
      const r = nearestCave(counting(dc, seen), CAVE_KIND.worm, x, y, z, opts());
      expect(r.reason).toBe('found');
      const h = r.hit!;
      // The start, the nearest candidate (at distance 0), was tried and failed.
      expect(seen.has(key(x >> 4, z >> 4))).toBe(true);
      expect([h.x, h.y, h.z]).not.toEqual([x, y, z]);
      expect(caveTagAt(dc, h.x, h.y, h.z)).toBe(CAVE_KIND.worm);
    }
  });

  test('the loaded columns are read from their stored tags with no density; a uniform section of the kind holds it at every voxel; the yaw follows the longer run', () => {
    // Column (1275, −300) holds the start at its (0, 0) corner: a cheese run along +z from (1, 222, 0) to (1, 222, 5).
    const tags = new Map<string, number>();
    for (let lz = 0; lz <= 5; lz++) tags.set(`1,222,${lz}`, CAVE_KIND.cheese);
    tags.set('2,222,0', CAVE_KIND.cheese);
    const view = storedColumn(1275, -300, tags);
    const asked: string[] = [];
    const seen = new Set<string>();
    const loaded = (cx: number, cz: number): ColumnView | null => {
      asked.push(key(cx, cz));
      return cx === 1275 && cz === -300 ? view : null;
    };
    const r = nearestCave(counting(dc, seen), CAVE_KIND.cheese, X, Y, Z, opts({ loaded }));
    expect(r).toEqual({ hit: { x: X + 1, y: 222, z: Z, yaw: 180 }, reason: 'found' });
    expect(seen.size).toBe(0);
    expect(asked[0]).toBe(key(1275, -300));
    // Uniform: a whole section of spaghetti 2D (y 32 … 47) in that column; the nearest voxel to (X, 40, Z) is (X, 40, Z).
    const uniform: ColumnView = { ...view, sectionCave: (sy) => (sy === 6 ? CAVE_KIND.spaghetti2d : 0), cave: (_lx, y) => (y >= 32 && y < 48 ? CAVE_KIND.spaghetti2d : 0) };
    const u = nearestCave(counting(dc, seen), CAVE_KIND.spaghetti2d, X, 40, Z, opts({ loaded: (cx, cz) => (cx === 1275 && cz === -300 ? uniform : null) }));
    expect(u).toEqual({ hit: { x: X, y: 40, z: Z, yaw: 90 }, reason: 'found' });
    expect(seen.size).toBe(0);
  });

  test('a noise kind beyond the loaded area stops at the deadline with `budget` on an advancing clock, polled every column', () => {
    let t = 0;
    const seen = new Set<string>();
    // Spaghetti 2D lies about 100 blocks away (ring 1): ten polls end the search first.
    const r = nearestCave(counting(dc, seen), CAVE_KIND.spaghetti2d, X, Y, Z, opts({ deadline: 10, now: () => t++ }));
    expect(r).toEqual({ hit: null, reason: 'budget' });
    expect(t).toBe(11);
    expect(seen.size).toBeLessThanOrEqual(10);
  });

  test('`stop` true ends the search with `stopped`: at once, or after some columns', () => {
    const seen = new Set<string>();
    expect(nearestCave(counting(dc, seen), CAVE_KIND.cheese, X, Y, Z, opts({ stop: () => true }))).toEqual({ hit: null, reason: 'stopped' });
    expect(seen.size).toBe(0);
    let polls = 0;
    expect(nearestCave(dc, CAVE_KIND.spaghetti2d, X, Y, Z, opts({ stop: () => ++polls > 5 }))).toEqual({ hit: null, reason: 'stopped' });
    expect(nearestCave(dc, CAVE_KIND.worm, X, Y, Z, opts({ stop: () => ++polls > 8 }))).toEqual({ hit: null, reason: 'stopped' });
  });

  test('a kind absent within 512 blocks (ravines.chance 0) returns `radius`, with no density read and no ring past 512', () => {
    const noRavines = createDensityContext(ctxFor('42', { caves: { ravines: { chance: 0 } } }));
    const seen = new Set<string>();
    const asked: Array<[number, number]> = [];
    const r = nearestCave(counting(noRavines, seen), CAVE_KIND.ravine, X, Y, Z, opts({ loaded: (cx, cz) => { asked.push([cx, cz]); return null; } }));
    expect(r).toEqual({ hit: null, reason: 'radius' });
    expect(seen.size).toBe(0);
    // The columns asked: each holds a voxel within 512 blocks, and the last ring (448 … 512) was searched.
    const near = ([cx, cz]: [number, number]): number => {
      const dx = Math.max(0, 16 * cx - X, X - (16 * cx + 15)), dz = Math.max(0, 16 * cz - Z, Z - (16 * cz + 15));
      return Math.sqrt(dx * dx + dz * dz);
    };
    expect(Math.max(...asked.map(near))).toBeLessThan(512);
    expect(Math.max(...asked.map(near))).toBeGreaterThanOrEqual(448);
  });

  test('a smaller radius bounds the noise lattice too: kind 9 (none in the default tree) searched within 100 blocks reads no column past it', () => {
    const seen = new Set<string>();
    expect(nearestCave(counting(dc, seen), CAVE_KIND.other, X, Y, Z, opts({ radius: 100 }))).toEqual({ hit: null, reason: 'radius' });
    for (const c of seen) {
      const [cx, cz] = c.split(',').map(Number) as [number, number];
      const dx = Math.max(0, 16 * cx - X, X - (16 * cx + 15)), dz = Math.max(0, 16 * cz - Z, Z - (16 * cz + 15));
      expect(dx * dx + dz * dz, c).toBeLessThan(100 * 100);
    }
    expect(seen.size).toBeGreaterThan(100);
  });

  test('arguments outside the rule throw a RangeError', () => {
    expect(() => nearestCave(dc, 0, X, Y, Z, opts())).toThrow(RangeError);
    expect(() => nearestCave(dc, 10, X, Y, Z, opts())).toThrow(RangeError);
    expect(() => nearestCave(dc, 1, X + 0.5, Y, Z, opts())).toThrow(RangeError);
    expect(() => nearestCave(dc, 1, 524288, Y, Z, opts())).toThrow(RangeError);
    expect(() => nearestCave(dc, 1, X, Y, Z, opts({ radius: 0 }))).toThrow(RangeError);
  });
});

describe('nearestCave over stored bytes with the cave biome in bits 4-7 (SP6b spec §2.1, Task 8)', () => {
  test('a column with every nibble set gives the same kind-level outputs as with them cleared: the finder\'s hit and yaw over loaded columns, a uniform section with a nibble included', () => {
    const { ctx: c, plain, nibbled } = nibbleRegion();
    const d = createDensityContext(c);
    const { cx0, cz0, size } = NIBBLE_REGION;
    const inRegion = (cx: number, cz: number): boolean => cx >= cx0 && cx < cx0 + size && cz >= cz0 && cz < cz0 + size;
    const loadedOf = (v: RegionView) => (cx: number, cz: number): ColumnView | null =>
      (inRegion(cx, cz) ? v.store.final(cx, cz) ?? v.store.proto(cx, cz) : null);
    // From the region's centre column, the caverns' column (546, 25857) one chunk away diagonally.
    const [sx, sy, sz] = [16 * (cx0 + 2) + 8, 0, 16 * (cz0 + 2) + 8];
    for (const kind of [CAVE_KIND.cheese, CAVE_KIND.spaghetti3d, CAVE_KIND.entrance, CAVE_KIND.worm, CAVE_KIND.ravine]) {
      const want = nearestCave(d, kind, sx, sy, sz, opts({ loaded: loadedOf(plain) }));
      expect(want.reason, `kind ${kind}`).toBe('found');
      expect(inRegion(want.hit!.x >> 4, want.hit!.z >> 4), `kind ${kind}: the hit lies in a loaded column`).toBe(true);
      expect(nearestCave(d, kind, sx, sy, sz, opts({ loaded: loadedOf(nibbled) })), `kind ${kind}`).toEqual(want);
    }
    // A uniform section (y 32 … 47) of spaghetti 2D, its byte with the abyss in bits 4-7: the hit and yaw of the plain one.
    const uniform = (b: number): ColumnView => ({
      ...storedColumn(1275, -300, new Map()), sectionCave: (s) => (s === 6 ? b : 0), cave: (_lx, y) => (y >= 32 && y < 48 ? b : 0),
    });
    const at = (v: ColumnView) => nearestCave(dc, CAVE_KIND.spaghetti2d, X, 40, Z, opts({ loaded: (cx, cz) => (cx === 1275 && cz === -300 ? v : null) }));
    const u = at(uniform(CAVE_KIND.spaghetti2d));
    expect(u).toEqual({ hit: { x: X, y: 40, z: Z, yaw: 90 }, reason: 'found' });
    expect(at(uniform(CAVE_KIND.spaghetti2d | (CAVE_BIOME.abyss << 4)))).toEqual(u);
  }, 120_000); // the nibble fixture (a 5 × 5 region, once per file) and its readers: about 1 s alone, more under load
});

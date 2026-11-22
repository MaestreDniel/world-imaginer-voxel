/**
 * Springs (SP7a spec §3.1-§3.2, D1, D21; Task 19): the tries' draws, §3.1's common rule and §3.2's water range on
 * hand-built columns with a probe stub (one world function read by the column's arrays and by the probes), then on real
 * columns of seed '42': border tries decided with the point probes against a full-knowledge oracle reading both columns'
 * T arrays, and T's writes (air plus `WATER_SOURCE`, cave byte 0, the seed section's bit). The rejection cases pass
 * `minFall` explicitly (rulings P30); the water range has no y floor (Task 19's Spec correction, ruling R17).
 */
import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import type { ParamsPatch } from '../../src/core/params/schema';
import { cavePickerOf, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample, readFieldHalo, type ColumnSample } from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { newSpringList, springProbesOf, springsColumn, springTries, type SpringList, type SpringProbes } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { fillColumnT } from '../../src/metrics/region';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, CARVABLE, DIRT, GRAVEL, RED_SAND, SAND, STONE } from '../../src/world/blocks/index';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
/** The directions in face order (N −z, E +x, S +z, W −x). */
const DX = [0, 1, 0, -1] as const;
const DZ = [-1, 0, 1, 0] as const;
/** T's column index of column voxel (lx, y, lz). */
const vi = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;
const listOf = (l: SpringList): Array<[number, number, number]> => Array.from({ length: l.n }, (_, k) => [l.pos[k]!, l.kind[k]!, l.dir[k]!]);
/** A context with seed '42' and `water` as its water leaves (every rejection case names minFall, P30). */
const waterCtx = (water: { tries: number; minFall: number }, patch: ParamsPatch = {}): GenContext => ctxFor('42', { ...patch, springs: { water } });
/** `ctx` with its seed replaced: `springsColumn` reads the seed for its tries only, so the terrain arrays stay seed '42''s. */
const withTrySeed = (ctx: GenContext, seed: Seed64): GenContext => ({ ...ctx, seed });

// ---------------------------------------------------------------- hand-built worlds

/** A world as T's arrays hold it before any spring, at world voxels. */
interface World {
  solid(x: number, y: number, z: number): boolean;
  state(x: number, y: number, z: number): number;
  cave(x: number, y: number, z: number): number;
  fluid(x: number, y: number, z: number): number;
}

/** T's arrays of column (cx, cz) of `w` (y −64 solid, `top` the highest solid y per position). */
function arraysOf(w: World, cx: number, cz: number): { solid: Uint8Array; state: Uint16Array; tags: Uint8Array; fluid: Uint8Array; top: Int32Array } {
  const solid = new Uint8Array(98304), state = new Uint16Array(98304), tags = new Uint8Array(98304), fluid = new Uint8Array(98304);
  const top = new Int32Array(256).fill(-64);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = 16 * cx + lx, z = 16 * cz + lz;
      for (let y = -64; y <= 319; y++) {
        const j = vi(lx, y, lz);
        const s = y === -64 || w.solid(x, y, z);
        solid[j] = s ? 1 : 0;
        if (s) {
          state[j] = w.state(x, y, z);
          if (y > -64) top[lz * 16 + lx] = y;
        } else {
          fluid[j] = w.fluid(x, y, z);
        }
        tags[j] = w.cave(x, y, z);
      }
    }
  }
  return { solid, state, tags, fluid, top };
}

/** The probes of a world: its own reads at world voxels (blind to springs, as the point functions). */
const probesOf = (w: World): SpringProbes => ({
  solid: (x, y, z) => w.solid(x, y, z),
  fluid: (x, y, z) => (w.solid(x, y, z) ? 0 : w.fluid(x, y, z)),
  tag: (x, y, z) => w.cave(x, y, z) & 15,
  nibble: (x, y, z) => w.cave(x, y, z) >> 4,
});

/** A sample of column (cx, cz) whose 2D `offset` is `off` everywhere (the water range's yLo reads it at the outlet). */
function flatSample(cx: number, cz: number, off: number): ColumnSample {
  const s = newColumnSample();
  s.cx = cx;
  s.cz = cz;
  s.f.offset.fill(off);
  return s;
}

/**
 * A rock face for the try (lx, lz, d) of column (cx, cz): stone up to `topY` everywhere but the outlet's position, open
 * from `floor` + 1 up (an open shaft to the sky; `floor` and below stone); `edit` overrides single voxels
 * (`[x, y, z, what]`: 'air', a state id, a cave byte with 'tag', or a fluid byte with 'fluid').
 */
function face(cx: number, cz: number, lx: number, lz: number, d: number, topY: number, floor: number, edits: ReadonlyArray<readonly [number, number, number, 'air' | 'tag' | 'fluid' | 'state', number]> = [], islandRun: readonly [number, number] | null = null): World {
  const ox = 16 * cx + lx + DX[d]!, oz = 16 * cz + lz + DZ[d]!;
  const at = (x: number, y: number, z: number, what: string): number | undefined => edits.find(([ex, ey, ez, w]) => ex === x && ey === y && ez === z && w === what)?.[4];
  return {
    solid: (x, y, z) => {
      if (at(x, y, z, 'air') !== undefined || at(x, y, z, 'fluid') !== undefined) return false;
      if (at(x, y, z, 'state') !== undefined) return true;
      if (islandRun !== null && y >= islandRun[0] && y <= islandRun[1]) return true;
      return y <= topY && !(x === ox && z === oz && y > floor);
    },
    state: (x, y, z) => at(x, y, z, 'state') ?? STONE,
    cave: (x, y, z) => at(x, y, z, 'tag') ?? 0,
    fluid: (x, y, z) => at(x, y, z, 'fluid') ?? 0,
  };
}

/** `springsColumn` on a hand-built world for column (cx, cz) with a flat offset `off`. */
function decide(ctx: GenContext, w: World, cx: number, cz: number, off: number): Array<[number, number, number]> {
  const a = arraysOf(w, cx, cz);
  const out = newSpringList();
  springsColumn(ctx, flatSample(cx, cz, off), newCaveColumnPass(), a.solid, a.state, a.tags, a.fluid, a.top, probesOf(w), out);
  return listOf(out);
}

/** The first chunk (cx, 0), cx ≥ 0, whose first water try of seed '42' lies at lx, lz in 1 … 14 (every neighbour inside). */
function innerTry(): { cx: number; lx: number; lz: number; d: number } {
  const t = new Float64Array(5);
  for (let cx = 0; ; cx++) {
    springTries(ctxFor('42').seed, 'water', cx, 0, 1, t);
    if (t[0]! >= 1 && t[0]! <= 14 && t[1]! >= 1 && t[1]! <= 14) return { cx, lx: t[0]!, lz: t[1]!, d: t[2]! };
  }
}

describe('springTries (SP7a §3.1)', () => {
  test('seed \'42\', chunk (0, 0), water, 3 tries: 15 values in the draw order x, z, direction, u, u2', () => {
    const out = new Float64Array(15);
    springTries(ctxFor('42').seed, 'water', 0, 0, 3, out);
    expect(Array.from(out)).toEqual(TRIES_42);
    // Each try draws exactly five values: the first two tries of a 3-try run equal a 2-try run's.
    const two = new Float64Array(10);
    springTries(ctxFor('42').seed, 'water', 0, 0, 2, two);
    expect(Array.from(two)).toEqual(TRIES_42.slice(0, 10));
    for (let t = 0; t < 3; t++) {
      const [x, z, d, u, u2] = TRIES_42.slice(5 * t, 5 * t + 5) as [number, number, number, number, number];
      expect([Number.isInteger(x) && x >= 0 && x < 16, Number.isInteger(z) && z >= 0 && z < 16, Number.isInteger(d) && d >= 0 && d < 4, u >= 0 && u < 1, u2 >= 0 && u2 < 1]).toEqual([true, true, true, true, true]);
    }
    // The kind names the stream: another kind's tries differ.
    const island = new Float64Array(15);
    springTries(ctxFor('42').seed, 'island', 0, 0, 3, island);
    expect(Array.from(island)).not.toEqual(TRIES_42);
    expect(() => springTries(ctxFor('42').seed, 'water', 0, 0, 4, out)).toThrow(RangeError);
  });
});

describe('the common rule and the water range on hand-built columns (SP7a §3.1-§3.2)', () => {
  const { cx, lx, lz, d } = innerTry();
  const x = 16 * cx + lx, z = lz;
  const ox = x + DX[d]!, oz = z + DZ[d]!;
  /** offset 70 and minFall 8 give yLo 78; the face's top 80 gives yHi 78: the try's y is 78 whatever its u. */
  const OFF = 70, TOP = 80, Y = 78;
  const ctx = waterCtx({ tries: 1, minFall: 8 });
  const ACCEPTED: Array<[number, number, number]> = [[vi(lx, Y, lz), 0, d]];
  /** The exposed face: the outlet open from y 68 up, a fall of 10 below the spring's y. */
  const fall10 = (edits: Parameters<typeof face>[7] = []): World => face(cx, 0, lx, lz, d, TOP, Y - 11, edits);

  test('an exposed rock face with a fall of 10 accepts the try whose y lands in range: one water spring at (lx, 78, lz) facing its direction', () => {
    expect(decide(ctx, fall10(), cx, 0, OFF)).toEqual(ACCEPTED);
    // Every CARVABLE terrain state but sand, red_sand and gravel is valid: dirt is.
    expect(CARVABLE[DIRT]).toBe(1);
    expect(decide(ctx, fall10([[x, Y, z, 'state', DIRT]]), cx, 0, OFF)).toEqual(ACCEPTED);
  });

  test('each rejection: sand, red_sand or gravel; tagged; a lateral or the back face open; the voxel above or below open', () => {
    for (const st of [SAND, RED_SAND, GRAVEL]) expect(decide(ctx, fall10([[x, Y, z, 'state', st]]), cx, 0, OFF), `state ${st}`).toEqual([]);
    expect(decide(ctx, fall10([[x, Y, z, 'tag', 1]]), cx, 0, OFF), 'tagged').toEqual([]);
    for (const e of [1, 2, 3]) {
      const f = (d + e) & 3;
      expect(decide(ctx, fall10([[x + DX[f]!, Y, z + DZ[f]!, 'air', 0]]), cx, 0, OFF), e === 2 ? 'back open' : 'lateral open').toEqual([]);
    }
    expect(decide(ctx, fall10([[x, Y + 1, z, 'air', 0]]), cx, 0, OFF), 'above open').toEqual([]);
    expect(decide(ctx, fall10([[x, Y - 1, z, 'air', 0]]), cx, 0, OFF), 'below open').toEqual([]);
  });

  test('each rejection: the outlet or a fall voxel holding fluid; a fall of 7 under minFall 8 (8 accepts); yHi < yLo; no y floor (y 63 accepts)', () => {
    expect(decide(ctx, fall10([[ox, Y, oz, 'fluid', WATER_SOURCE]]), cx, 0, OFF), 'outlet holds fluid').toEqual([]);
    expect(decide(ctx, fall10([[ox, Y - 5, oz, 'fluid', WATER_SOURCE]]), cx, 0, OFF), 'a fall voxel holds fluid').toEqual([]);
    expect(decide(ctx, face(cx, 0, lx, lz, d, TOP, Y - 8, []), cx, 0, OFF), 'fall of 7').toEqual([]);
    expect(decide(ctx, face(cx, 0, lx, lz, d, TOP, Y - 9, []), cx, 0, OFF), 'fall of 8').toEqual(ACCEPTED);
    // offset 55: yLo 63 = yHi (top 65): accepted, no y floor (the dropped springs.water.minY, Task 19).
    const low = face(cx, 0, lx, lz, d, 65, 63 - 11, []);
    expect(decide(ctx, low, cx, 0, 55), 'y 63, no floor').toEqual([[vi(lx, 63, lz), 0, d]]);
    // top 79: yHi 77 < yLo 78.
    expect(decide(ctx, face(cx, 0, lx, lz, d, 79, Y - 11, []), cx, 0, OFF), 'yHi < yLo').toEqual([]);
  });

  test('with islands.enabled, yHi is groundTop − 2: an island run above the face (bottom ≥ 181) leaves the decision unchanged; off, it is top − 2', () => {
    const island = face(cx, 0, lx, lz, d, TOP, Y - 11, [], [190, 205]);
    expect(decide(waterCtx({ tries: 1, minFall: 8 }, { islands: { enabled: true } }), island, cx, 0, OFF)).toEqual(ACCEPTED);
    // Without islands the range runs up to 203: the try's y lands elsewhere (u is not 0), in stone or the island.
    const t = new Float64Array(5);
    springTries(ctx.seed, 'water', cx, 0, 1, t);
    const y = 78 + Math.floor(t[3]! * (203 - 78 + 1));
    expect(y).not.toBe(Y);
    expect(decide(ctx, island, cx, 0, OFF)).toEqual([]);
  });

  test('two tries on one voxel accept it once', () => {
    // A try seed whose first two tries share (x, z, direction) inside the column.
    const t = new Float64Array(10);
    let seed: Seed64 = [0, 0];
    for (let k = 1; ; k++) {
      seed = [k, 19];
      springTries(seed, 'water', 0, 0, 2, t);
      if (t[0] === t[5] && t[1] === t[6] && t[2] === t[7] && t[0]! >= 1 && t[0]! <= 14 && t[1]! >= 1 && t[1]! <= 14) break;
    }
    const [lx2, lz2, d2] = [t[0]!, t[1]!, t[2]!];
    const w = face(0, 0, lx2, lz2, d2, TOP, Y - 11, []);
    const ctx2 = withTrySeed(waterCtx({ tries: 2, minFall: 8 }), seed);
    expect(decide(ctx2, w, 0, 0, OFF)).toEqual([[vi(lx2, Y, lz2), 0, d2]]);
  });
});

// ---------------------------------------------------------------- real columns of seed '42'

/** T's arrays of a real column before any spring, read back from its proto under `springs.water.tries` 0. */
interface TArrays { solid: Uint8Array; state: Uint16Array; tags: Uint8Array; fluid: Uint8Array; top: Int32Array; s: ColumnSample; pass: CaveColumnPass }

const NO_SPRINGS = ctxFor('42', { springs: { water: { tries: 0 } } });
let store: VoxelStore | null = null;
const ARRAYS = new Map<string, TArrays>();

function tArrays(cx: number, cz: number): TArrays {
  const key = `${cx},${cz}`;
  const hit = ARRAYS.get(key);
  if (hit !== undefined) return hit;
  store ??= createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
  expect(fillColumnT(store, NO_SPRINGS, cx, cz, () => false)).toBe(true);
  const v = store.proto(cx, cz)!;
  const a: TArrays = {
    solid: new Uint8Array(98304), state: new Uint16Array(98304), tags: new Uint8Array(98304), fluid: new Uint8Array(98304), top: new Int32Array(256),
    s: buildColumnSample(NO_SPRINGS, cx, cz, newColumnSample()), pass: newCaveColumnPass(),
  };
  fillCaveColumnPass(cavePickerOf(NO_SPRINGS), a.s, a.pass);
  for (let j = 0; j < 98304; j++) {
    const lx = j & 15, lz = (j >> 4) & 15, y = (j >> 8) - 64;
    const b = v.block(lx, y, lz);
    a.solid[j] = b !== AIR ? 1 : 0;
    a.state[j] = b;
    a.tags[j] = v.cave(lx, y, lz);
    a.fluid[j] = v.fluid(lx, y, lz);
  }
  const aux = v.aux()!;
  for (let p = 0; p < 256; p++) a.top[p] = aux.oceanFloorWG[p]! - 1;
  store.freeColumn(cx, cz);
  ARRAYS.set(key, a);
  return a;
}

/** The full-knowledge world: every voxel read from the T arrays of the column holding it. */
const oracleWorld: World = {
  solid: (x, y, z) => tArrays(x >> 4, z >> 4).solid[vi(x & 15, y, z & 15)] !== 0,
  state: (x, y, z) => tArrays(x >> 4, z >> 4).state[vi(x & 15, y, z & 15)]!,
  cave: (x, y, z) => tArrays(x >> 4, z >> 4).tags[vi(x & 15, y, z & 15)]!,
  fluid: (x, y, z) => tArrays(x >> 4, z >> 4).fluid[vi(x & 15, y, z & 15)]!,
};

/** §3.1's rule for a water spring at world (x, y, z) facing d, read from `w` alone (the oracle, written apart from springs.ts). */
function oracleAccepts(w: World, x: number, y: number, z: number, d: number, minFall: number): boolean {
  const st = w.state(x, y, z);
  if (!w.solid(x, y, z) || CARVABLE[st] === 0 || st === SAND || st === RED_SAND || st === GRAVEL || (w.cave(x, y, z) & 15) !== 0) return false;
  if (!w.solid(x, y + 1, z) || !w.solid(x, y - 1, z)) return false;
  for (const e of [1, 2, 3]) {
    const f = (d + e) & 3;
    if (!w.solid(x + DX[f]!, y, z + DZ[f]!)) return false;
  }
  const ox = x + DX[d]!, oz = z + DZ[d]!;
  for (let k = 0; k <= minFall; k++) if (w.solid(ox, y - k, oz) || w.fluid(ox, y - k, oz) !== 0) return false;
  return true;
}

/**
 * `springsColumn` on the real column (cx, cz)'s arrays under `ctx`, with `probes`. The 3 × 3's arrays are read first, so
 * the oracle's probes never generate a column inside the call (`springsColumn` is not reentrant).
 */
function realDecide(ctx: GenContext, cx: number, cz: number, probes: SpringProbes): Array<[number, number, number]> {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) tArrays(cx + dx, cz + dz);
  const a = tArrays(cx, cz);
  const out = newSpringList();
  springsColumn(ctx, a.s, a.pass, a.solid, a.state, a.tags, a.fluid, a.top, probes, out);
  return listOf(out);
}

/** Mountain columns of seed '42' (springs at the defaults, found by a scan of the sp7a.liveness.springs stream). */
const MOUNTAINS: ReadonlyArray<readonly [number, number]> = [[-3035, 11917], [17044, 25519], [13110, -22585], [8652, -18898], [1250, -30453]];

describe('real columns of seed \'42\' (SP7a §3.1, D21)', () => {
  const defaults = waterCtx({ tries: 1, minFall: 8 });
  const probes = springProbesOf(defaults);

  test('a try at x = 15 facing east decided with the probes equals the full-knowledge oracle reading both columns\' T arrays, on 32 border tries where the oracle accepts (no border ring excluded, D21)', () => {
    // Border sites: x = 15 of a mountain column, z in 1 … 14 (the laterals inside it), its outlet in the east neighbour,
    // y in the water range; each found by the oracle over both columns' arrays. Each is then given to springsColumn as
    // its column's one try, through a try seed whose first try lands there (the terrain, the arrays and the probes stay
    // seed '42''s): springsColumn reads the east column through the point probes only.
    const sites: Array<{ cx: number; cz: number; lz: number; y: number; yLo: number; yHi: number }> = [];
    for (const [mx, mz] of MOUNTAINS) {
      for (let dz = -3; dz <= 3 && sites.length < 32; dz++) {
        for (let dx = -3; dx <= 3 && sites.length < 32; dx++) {
          const cx = mx + dx, cz = mz + dz;
          const a = tArrays(cx, cz);
          let taken = 0;
          for (let lz = 1; lz <= 14 && taken < 2 && sites.length < 32; lz++) {
            const x = 16 * cx + 15, z = 16 * cz + lz;
            const yLo = Math.ceil(readFieldHalo(a.s, 'offset', x + 1, z)) + 8;
            const yHi = a.top[lz * 16 + 15]! - 2;
            for (let y = yLo; y <= yHi; y++) {
              if (!oracleAccepts(oracleWorld, x, y, z, 1, 8)) continue;
              sites.push({ cx, cz, lz, y, yLo, yHi });
              taken++;
              break;
            }
          }
        }
      }
    }
    expect(sites.length).toBe(32);
    const t = new Float64Array(5);
    for (const site of sites) {
      const r = site.yHi - site.yLo + 1;
      let seed: Seed64 = [0, 0];
      for (let k = 1; ; k++) {
        seed = [k, site.cx];
        springTries(seed, 'water', site.cx, site.cz, 1, t);
        if (t[0] === 15 && t[1] === site.lz && t[2] === 1 && Math.floor(t[3]! * r) === site.y - site.yLo) break;
      }
      const ctx = withTrySeed(defaults, seed);
      const want: Array<[number, number, number]> = [[vi(15, site.y, site.lz), 0, 1]];
      expect([site, realDecide(ctx, site.cx, site.cz, probes)]).toEqual([site, want]);
      // The same column decided with the oracle as its probes (the east column's arrays) agrees.
      expect(realDecide(ctx, site.cx, site.cz, probesOf(oracleWorld))).toEqual(want);
    }
  }, 120_000);

  test('every try of mountain columns (32 tries, minFall 2): springsColumn with the probes equals springsColumn with the oracle\'s reads, and terrainSpringsDebug (T\'s own arrays) agrees', () => {
    const many = waterCtx({ tries: 32, minFall: 2 });
    const p = springProbesOf(many);
    let accepted = 0, border = 0, borderTries = 0;
    const t = new Float64Array(5 * 32);
    const out = newSpringList();
    for (const [cx, cz] of MOUNTAINS) {
      const got = realDecide(many, cx, cz, p);
      expect([cx, cz, got]).toEqual([cx, cz, realDecide(many, cx, cz, probesOf(oracleWorld))]);
      terrainSpringsDebug(many, cx, cz, out);
      expect(listOf(out)).toEqual(got);
      // Each accepted spring holds by the oracle.
      for (const [j, , d] of got) expect(oracleAccepts(oracleWorld, 16 * cx + (j & 15), (j >> 8) - 64, 16 * cz + ((j >> 4) & 15), d, 2)).toBe(true);
      springTries(many.seed, 'water', cx, cz, 32, t);
      for (let k = 0; k < 32; k++) {
        const lx = t[5 * k]! + DX[t[5 * k + 2]!]!, lz = t[5 * k + 1]! + DZ[t[5 * k + 2]!]!;
        if (lx < 0 || lx > 15 || lz < 0 || lz > 15) borderTries++;
      }
      accepted += got.length;
      border += got.filter(([j, , d]) => { const lx = (j & 15) + DX[d]!, lz = ((j >> 4) & 15) + DZ[d]!; return lx < 0 || lx > 15 || lz < 0 || lz > 15; }).length;
    }
    console.log(`mountain columns: ${accepted} springs (${border} with their outlet across a border), ${borderTries} border tries`);
    expect(accepted).toBeGreaterThan(0);
    expect(borderTries).toBeGreaterThan(0);
  }, 120_000);

  test('T writes a spring as air plus WATER_SOURCE with cave byte 0 where the proto held rock, and aux B\'s seedSections holds its section\'s bit (its outlet inside the column)', () => {
    const [cx, cz] = SPRING_COLUMN;
    const out = newSpringList();
    terrainSpringsDebug(ctxFor('42'), cx, cz, out);
    expect(listOf(out)).toEqual([[vi(...SPRING_AT), 0, SPRING_DIR]]);
    const [lx, y, lz] = SPRING_AT;
    expect(lx + DX[SPRING_DIR]!).toBeGreaterThanOrEqual(0);
    expect(lx + DX[SPRING_DIR]!).toBeLessThanOrEqual(15);
    const a = tArrays(cx, cz);
    expect([a.solid[vi(lx, y, lz)], a.state[vi(lx, y, lz)] !== AIR]).toEqual([1, true]);
    const s = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
    expect(fillColumnT(s, ctxFor('42'), cx, cz, () => false)).toBe(true);
    const v = s.proto(cx, cz)!;
    expect([v.block(lx, y, lz), v.fluid(lx, y, lz), v.cave(lx, y, lz)]).toEqual([AIR, WATER_SOURCE, 0]);
    expect((v.auxB()!.seedSections[0]! >>> ((y + 64) >> 4)) & 1).toBe(1);
    // Every other voxel equals the spring-free proto's.
    let other = 0;
    for (let j = 0; j < 98304; j++) {
      if (j === vi(lx, y, lz)) continue;
      const jx = j & 15, jz = (j >> 4) & 15, jy = (j >> 8) - 64;
      if (v.block(jx, jy, jz) !== a.state[j] && a.solid[j] !== 0) other++;
      if (a.solid[j] === 0 && (v.block(jx, jy, jz) !== AIR || v.fluid(jx, jy, jz) !== a.fluid[j])) other++;
    }
    expect(other).toBe(0);
  }, 60_000);
});

/** `springTries(seed '42', 'water', 0, 0, 3)` (Task 19's pin). */
const TRIES_42: number[] = [
  0, 14, 2, 0.7641933120321482, 0.4116612796206027,
  4, 12, 3, 0.2096758137922734, 0.5976148415356874,
  13, 8, 0, 0.14460644801147282, 0.2377501269802451,
];
/** A column of seed '42' holding one water spring at the defaults whose outlet lies inside it (the relief scan's n916). */
const SPRING_COLUMN = [11344, 3591] as const;
const SPRING_AT = [7, 121, 3] as const;
const SPRING_DIR = 1;

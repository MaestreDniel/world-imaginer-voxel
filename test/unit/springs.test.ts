/**
 * Springs (SP7a spec §3.1-§3.2, D1, D21; Task 19): the tries' draws, §3.1's common rule and §3.2's water range on
 * hand-built columns with a probe stub (one world function read by the column's arrays and by the probes), then on real
 * columns of seed '42': border tries decided with the point probes against a full-knowledge oracle reading both columns'
 * T arrays, and T's writes (air plus `WATER_SOURCE`, cave byte 0, the seed section's bit). The rejection cases pass
 * `minFall` explicitly (rulings P30); the water range has no y floor (Task 19's Spec correction, ruling R17).
 * Island-edge springs (§3.3, D3; Task 20): the island range on hand-built island runs, with `islands.enabled` off, and
 * 8 island springs of seed '42' floating_islands written by T and falling into the sky's air.
 * Lava springs in the abyss (§3.4, D4; Task 21): the lava range (yLo = −55 + minFall, yHi clamped at the abyss's top
 * from the cave-biome pass's Y0), the abyss-nibble outlet and the lava valid set on hand-built columns, then a lava
 * spring of seed '42' beside SP6b's abyss column written by T as air plus `LAVA_SOURCE`.
 */
import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import type { ParamsPatch } from '../../src/core/params/schema';
import { cavePickerOf, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample, readFieldHalo, type ColumnSample } from '../../src/gen/column/columnStage';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { newSpringList, springProbesOf, springsColumn, springTries, type SpringList, type SpringProbes } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { fillColumnT } from '../../src/metrics/region';
import { LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, CARVABLE, DEEPSLATE, DIRT, GRAVEL, RED_SAND, REGISTRY, SAND, STONE } from '../../src/world/blocks/index';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
/** The directions in face order (N −z, E +x, S +z, W −x). */
const DX = [0, 1, 0, -1] as const;
const DZ = [-1, 0, 1, 0] as const;
/** T's column index of column voxel (lx, y, lz). */
const vi = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;
const listOf = (l: SpringList): Array<[number, number, number]> => Array.from({ length: l.n }, (_, k) => [l.pos[k]!, l.kind[k]!, l.dir[k]!]);
/**
 * A context with seed '42', `water` as its water leaves (every rejection case names minFall, P30) and no lava tries (the
 * water cases' lists hold water springs only; a substituted try seed would also move the lava tries, Task 21).
 */
const waterCtx = (water: { tries: number; minFall: number }, patch: ParamsPatch = {}): GenContext => ctxFor('42', { ...patch, springs: { water, lava: { tries: 0 } } });
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

/** `springsColumn` on a hand-built world for column (cx, cz) with a flat offset `off` (and a cave-biome pass, zeros by default). */
function decide(ctx: GenContext, w: World, cx: number, cz: number, off: number, pass: CaveColumnPass = newCaveColumnPass()): Array<[number, number, number]> {
  const a = arraysOf(w, cx, cz);
  const out = newSpringList();
  springsColumn(ctx, flatSample(cx, cz, off), pass, a.solid, a.state, a.tags, a.fluid, a.top, probesOf(w), out);
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

  test('a try at the world window\'s edge whose outlet lies outside the window is rejected without probing there (Task 21)', () => {
    // Chunk (32767, 0), the window's last column in x: a try seed whose first try is at lx 15 facing east, its outlet at
    // x = 524288, outside the window.
    const t = new Float64Array(5);
    let seed: Seed64 = [0, 0];
    for (let k = 1; ; k++) {
      seed = [k, 32767];
      springTries(seed, 'water', 32767, 0, 1, t);
      if (t[0] === 15 && t[1]! >= 1 && t[1]! <= 14 && t[2] === 1) break;
    }
    const w = face(32767, 0, 15, t[1]!, 1, TOP, Y - 11, []);
    const probes: SpringProbes = {
      solid: (px, py, pz) => { if (px >= 524288) throw new RangeError(`probe at x ${px}`); return w.solid(px, py, pz); },
      fluid: (px, py, pz) => { if (px >= 524288) throw new RangeError(`probe at x ${px}`); return w.fluid(px, py, pz); },
      tag: () => 0,
      nibble: () => 0,
    };
    const a = arraysOf(w, 32767, 0);
    const out = newSpringList();
    springsColumn(withTrySeed(waterCtx({ tries: 1, minFall: 8 }), seed), flatSample(32767, 0, OFF), newCaveColumnPass(), a.solid, a.state, a.tags, a.fluid, a.top, probes, out);
    expect(listOf(out)).toEqual([]);
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

const NO_SPRINGS = ctxFor('42', { springs: { water: { tries: 0 }, lava: { tries: 0 } } });
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

// ---------------------------------------------------------------- island-edge springs (Task 20)

/** A context with seed '42', islands on or off, no water tries and `island` as its island leaves. */
const islandCtx = (island: { tries: number }, enabled = true): GenContext =>
  ctxFor('42', { islands: { enabled }, springs: { water: { tries: 0 }, island } });

/**
 * Island runs over open air for the try (lx, lz, d) of column (cx, cz): stone up to `ground` everywhere, and each run
 * of `runs` ([bottom, top], world y) solid everywhere but the outlet's position, which is open from `ground` + 1 up
 * but at the outlet-column heights in `blocks` (solid there).
 */
function islandWorld(cx: number, cz: number, lx: number, lz: number, d: number, ground: number, runs: ReadonlyArray<readonly [number, number]>, blocks: readonly number[] = []): World {
  const ox = 16 * cx + lx + DX[d]!, oz = 16 * cz + lz + DZ[d]!;
  return {
    solid: (x, y, z) => y <= ground || (x === ox && z === oz ? blocks.includes(y) : runs.some(([b, t]) => y >= b && y <= t)),
    state: () => STONE,
    cave: () => 0,
    fluid: () => 0,
  };
}

/** The first chunk (cx, 0), cx ≥ 0, whose first island try of seed '42' lies at lx, lz in 1 … 14, with its draws. */
function innerIslandTry(): { cx: number; lx: number; lz: number; d: number; u: number; u2: number } {
  const t = new Float64Array(5);
  for (let cx = 0; ; cx++) {
    springTries(ctxFor('42').seed, 'island', cx, 0, 1, t);
    if (t[0]! >= 1 && t[0]! <= 14 && t[1]! >= 1 && t[1]! <= 14) return { cx, lx: t[0]!, lz: t[1]!, d: t[2]!, u: t[3]!, u2: t[4]! };
  }
}

/** The open voxels below world voxel (x, y, z) of `w` down to the first solid or wet one (the fall's length). */
function fallBelow(w: World, x: number, y: number, z: number): number {
  let k = 0;
  while (y - k - 1 > -64 && !w.solid(x, y - k - 1, z) && w.fluid(x, y - k - 1, z) === 0) k++;
  return k;
}

describe('island-edge springs on hand-built columns (SP7a §3.3, D3)', () => {
  const { cx, lx, lz, d, u, u2 } = innerIslandTry();
  const x = 16 * cx + lx, z = lz;
  const ox = x + DX[d]!, oz = z + DZ[d]!;
  const ctx = islandCtx({ tries: 1 });
  /** The run (bottom 190, top 205) over open air down to the ground at y 60. */
  const RUN = [190, 205] as const;
  const one = islandWorld(cx, 0, lx, lz, d, 60, [RUN]);
  /** y = bottom + 1 + ⌊u2·(top − bottom − 1)⌋: 191 … 204. */
  const Y = 191 + Math.floor(u2 * 14);

  test('an island run (bottom 190, top 205) over open air accepts the island try at y = bottom + 1 + ⌊u2·(top − bottom − 1)⌋, its fall reaching far below (to the ground)', () => {
    expect(decide(ctx, one, cx, 0, 55)).toEqual([[vi(lx, Y, lz), 1, d]]);
    expect(Y).toBeGreaterThanOrEqual(191);
    expect(Y).toBeLessThanOrEqual(204);
    // The fall below the outlet reaches the ground at y 60: 130 blocks or more, far beyond ISLAND_SPRING_MIN_FALL.
    expect(fallBelow(one, ox, Y, oz)).toBe(Y - 61);
    expect(Y - 61).toBeGreaterThanOrEqual(130);
    // The run is k = ⌊u·runs⌋ of the position's island runs, bottom to top: with a second run (230 … 245) the try takes it when u ≥ 0.5.
    const two = islandWorld(cx, 0, lx, lz, d, 60, [RUN, [230, 245]]);
    const y2 = (u < 0.5 ? 191 : 231) + Math.floor(u2 * 14);
    expect(decide(ctx, two, cx, 0, 55)).toEqual([[vi(lx, y2, lz), 1, d]]);
  });

  test('with islands.enabled false no island try runs', () => {
    expect(decide(islandCtx({ tries: 1 }, false), one, cx, 0, 55)).toEqual([]);
    // Nor at 32 tries: every try of the chunk is skipped.
    expect(decide(islandCtx({ tries: 32 }, false), one, cx, 0, 55)).toEqual([]);
  });

  test('a try whose column holds no island run is rejected: no run above the ground; a run reaching below 181 (bottom 175); a run under 3 high (190 … 191); and the fall under ISLAND_SPRING_MIN_FALL', () => {
    expect(decide(ctx, islandWorld(cx, 0, lx, lz, d, 60, []), cx, 0, 55), 'no run').toEqual([]);
    expect(decide(ctx, islandWorld(cx, 0, lx, lz, d, 60, [[175, 205]]), cx, 0, 55), 'bottom 175 < 181').toEqual([]);
    expect(decide(ctx, islandWorld(cx, 0, lx, lz, d, 60, [[190, 191]]), cx, 0, 55), 'under 3 high').toEqual([]);
    // A run whose bottom is 181 is an island run (SP3e's runs: bottom ≥ 181): 182 … 196.
    expect(decide(ctx, islandWorld(cx, 0, lx, lz, d, 60, [[181, 196]]), cx, 0, 55), 'bottom 181').toEqual([[vi(lx, 182 + Math.floor(u2 * 14), lz), 1, d]]);
    // A block in the outlet's column 8 below the spring leaves a fall of 7 under ISLAND_SPRING_MIN_FALL (8); 9 below, a fall of 8.
    expect(decide(ctx, islandWorld(cx, 0, lx, lz, d, 60, [RUN], [Y - 8]), cx, 0, 55), 'fall of 7').toEqual([]);
    expect(decide(ctx, islandWorld(cx, 0, lx, lz, d, 60, [RUN], [Y - 9]), cx, 0, 55), 'fall of 8').toEqual([[vi(lx, Y, lz), 1, d]]);
  });
});

/**
 * The first 8 island springs of seed '42' floating_islands at the defaults, [cx, cz, lx, y, lz, direction]: a ring scan
 * from chunk (0, 0) outward (ring r, then cz, then cx) over the columns whose 7 × 7 lattice holds an islandMask above 0
 * (1,584 such columns in rings 0-36 gave 12, about 1 per 130), each column's island-kind springs from
 * `terrainSpringsDebug`. (−30, 0)'s outlet lies across its east border.
 */
const ISLAND_SPRINGS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-14, 15, 15, 220, 6, 2], [-20, 5, 5, 209, 5, 0], [-21, 0, 9, 238, 7, 2], [-23, -16, 1, 233, 14, 3],
  [-26, -1, 4, 190, 6, 2], [-27, -3, 10, 199, 13, 0], [-30, 0, 15, 210, 15, 1], [-31, -4, 3, 230, 5, 3],
];

describe('island-edge springs at seed \'42\' floating_islands (SP7a §3.3, D3)', () => {
  test('8 accepted island springs found by a scan: each written by T as air plus WATER_SOURCE (cave 0), each falling ≥ 8 from its outlet into the sky\'s air (untagged, dry air)', () => {
    const fi = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    expect([fi.params.islands.enabled, fi.params.springs.island]).toEqual([true, { tries: 4 }]);
    const s = createStore({ shared: false, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
    const view = (cx: number, cz: number) => {
      if (s.proto(cx, cz) === null) expect(fillColumnT(s, fi, cx, cz, () => false)).toBe(true);
      return s.proto(cx, cz)!;
    };
    const out = newSpringList();
    const falls: number[] = [];
    for (const [cx, cz, lx, y, lz, d] of ISLAND_SPRINGS) {
      terrainSpringsDebug(fi, cx, cz, out);
      const islandList = listOf(out).filter(([, kind]) => kind === 1);
      expect([cx, cz, islandList[0]]).toEqual([cx, cz, [vi(lx, y, lz), 1, d]]);
      const v = view(cx, cz);
      expect([cx, cz, v.block(lx, y, lz), v.fluid(lx, y, lz), v.cave(lx, y, lz)]).toEqual([cx, cz, AIR, WATER_SOURCE, 0]);
      // The outlet's column, possibly the neighbour's: air, dry and untagged from the spring's y down by ≥ ISLAND_SPRING_MIN_FALL + 1.
      const ox = 16 * cx + lx + DX[d]!, oz = 16 * cz + lz + DZ[d]!;
      const ov = view(ox >> 4, oz >> 4);
      let fall = 0;
      while (ov.block(ox & 15, y - fall - 1, oz & 15) === AIR && ov.fluid(ox & 15, y - fall - 1, oz & 15) === 0 && ov.cave(ox & 15, y - fall - 1, oz & 15) === 0) fall++;
      expect([cx, cz, ov.block(ox & 15, y, oz & 15), ov.fluid(ox & 15, y, oz & 15), ov.cave(ox & 15, y, oz & 15)]).toEqual([cx, cz, AIR, 0, 0]);
      expect(fall, `(${cx}, ${cz}) fall`).toBeGreaterThanOrEqual(8);
      falls.push(fall);
    }
    console.log(`island springs' falls below the outlet: ${falls.join(', ')}`);
  }, 120_000);
});

// ---------------------------------------------------------------- lava springs in the abyss (Task 21)

/** A context with seed '42', no water tries and `lava` as its lava leaves (every case names minFall, as P30's). */
const lavaCtx = (lava: { tries: number; minFall: number }): GenContext => ctxFor('42', { springs: { water: { tries: 0 }, lava } });
/** The abyss's cave-biome nibble (3) on a tagged cave byte (kind 1). */
const ABYSS_AIR = 1 | (3 << 4);
/** The lava valid set (§3.4): deepslate and the five abyss rocks. */
const LAVA_ROCKS = [DEEPSLATE, ...['abyss_stone', 'abyss_shale', 'cracked_abyss_stone', 'abyss_stone_veined', 'abyss_ash'].map((k) => REGISTRY.parseStateKey(k))];
/** A cave-biome pass whose Y0 is `y0` at every position (the lava range's yHi reads ⌊Y0 − depthScale·abyss.depthMin⌋). */
function passAt(y0: number): CaveColumnPass {
  const pass = newCaveColumnPass();
  pass.y0.fill(y0);
  return pass;
}

/** The first chunk (cx, 0), cx ≥ 0, whose first lava try of seed '42' lies at lx, lz in 1 … 14 (every neighbour inside). */
function innerLavaTry(): { cx: number; lx: number; lz: number; d: number } {
  const t = new Float64Array(5);
  for (let cx = 0; ; cx++) {
    springTries(ctxFor('42').seed, 'lava', cx, 0, 1, t);
    if (t[0]! >= 1 && t[0]! <= 14 && t[1]! >= 1 && t[1]! <= 14) return { cx, lx: t[0]!, lz: t[1]!, d: t[2]! };
  }
}

describe('lava springs on hand-built columns (SP7a §3.4, D4)', () => {
  const { cx, lx, lz, d } = innerLavaTry();
  const x = 16 * cx + lx, z = lz;
  const ox = x + DX[d]!, oz = z + DZ[d]!;
  const ctx = lavaCtx({ tries: 1, minFall: 4 });
  const b = ctx.params.caves.biomes;
  /**
   * minFall 4 gives yLo −51; Y0 = 77 gives the abyss's top ⌊77 − 128·1⌋ = −51 (depthScale 128, abyss.depthMin 1), below
   * the face's top − 2 (78): the try's y is −51 whatever its u.
   */
  const Y = -51;
  const ABYSS_TOP_Y0 = Y + b.depthScale * b.abyss.depthMin;
  const ACCEPTED: Array<[number, number, number]> = [[vi(lx, Y, lz), 2, d]];
  /** A deepslate-or-`rock` wall at (x, Y, z) whose outlet is abyss air (cave byte `outlet`), open below down to y −57: a fall of 5. */
  const wall = (rock: number = DEEPSLATE, outlet: number = ABYSS_AIR, floor = Y - 6): World =>
    face(cx, 0, lx, lz, d, 80, floor, [[x, Y, z, 'state', rock], [ox, Y, oz, 'tag', outlet]]);

  test('a deepslate or abyss-rock wall with an abyss-nibble outlet and a fall ≥ 4 accepts the lava try: one lava spring at (lx, −51, lz) facing its direction', () => {
    expect([b.depthScale, b.abyss.depthMin]).toEqual([128, 1]);
    expect(decide(ctx, wall(), cx, 0, 70, passAt(ABYSS_TOP_Y0))).toEqual(ACCEPTED);
    for (const rock of LAVA_ROCKS) expect(decide(ctx, wall(rock), cx, 0, 70, passAt(ABYSS_TOP_Y0)), `state ${rock}`).toEqual(ACCEPTED);
    // A fall of exactly 4 (open down to y −55) accepts; a fall of 3 does not.
    expect(decide(ctx, wall(DEEPSLATE, ABYSS_AIR, Y - 5), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'fall of 4').toEqual(ACCEPTED);
    expect(decide(ctx, wall(DEEPSLATE, ABYSS_AIR, Y - 4), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'fall of 3').toEqual([]);
  });

  test('an outlet whose nibble is plain (or an untagged outlet) is rejected', () => {
    expect(decide(ctx, wall(DEEPSLATE, 1), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'plain nibble').toEqual([]);
    expect(decide(ctx, wall(DEEPSLATE, 1 | (1 << 4)), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'lush nibble').toEqual([]);
    expect(decide(ctx, wall(DEEPSLATE, 0), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'untagged').toEqual([]);
    // The outlet holding lava (or water) is rejected as the common rule's.
    expect(decide(ctx, face(cx, 0, lx, lz, d, 80, Y - 6, [[x, Y, z, 'state', DEEPSLATE], [ox, Y, oz, 'tag', ABYSS_AIR], [ox, Y, oz, 'fluid', LAVA_SOURCE]]), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'outlet holds lava').toEqual([]);
  });

  test('a spring voxel of stone, or of any other state outside the lava set, is rejected', () => {
    expect(decide(ctx, wall(STONE), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'stone').toEqual([]);
    for (const st of [DIRT, GRAVEL, REGISTRY.parseStateKey('dripstone_block')]) expect(decide(ctx, wall(st), cx, 0, 70, passAt(ABYSS_TOP_Y0)), `state ${st}`).toEqual([]);
  });

  test('yHi clamps at the abyss\'s top: ⌊Y0 − depthScale·abyss.depthMin⌋ one below yLo rejects although top − 2 is 78; top − 2 clamps it too', () => {
    // Y0 76.5: the abyss's top ⌊−51.5⌋ = −52 < yLo −51.
    expect(decide(ctx, wall(), cx, 0, 70, passAt(ABYSS_TOP_Y0 - 0.5)), 'abyss top −52').toEqual([]);
    // Y0 far above: the range runs from −51 to the face's top − 2 = 78, so the try's y lands elsewhere (u is not 0).
    const t = new Float64Array(5);
    springTries(ctx.seed, 'lava', cx, 0, 1, t);
    expect(Y + Math.floor(t[3]! * (78 - Y + 1))).not.toBe(Y);
    expect(decide(ctx, wall(), cx, 0, 70, passAt(ABYSS_TOP_Y0 + 200)), 'abyss top above the face').toEqual([]);
    // top − 2 clamps it: a face whose top is −49 gives yHi −51 under a high abyss top.
    expect(decide(ctx, face(cx, 0, lx, lz, d, -49, Y - 6, [[x, Y, z, 'state', DEEPSLATE], [ox, Y, oz, 'tag', ABYSS_AIR]]), cx, 0, 70, passAt(ABYSS_TOP_Y0 + 200)), 'top −49').toEqual(ACCEPTED);
    // minFall moves the range's floor: minFall 5 gives yLo −50 > −51 (rejected), minFall 3 yLo −52 (y −52 + ⌊u·2⌋).
    expect(decide(lavaCtx({ tries: 1, minFall: 5 }), wall(), cx, 0, 70, passAt(ABYSS_TOP_Y0)), 'minFall 5').toEqual([]);
  });
});

/**
 * SP6b's abyss column (−3000, −1182) of seed '42' holds no lava spring at the defaults; the first lava spring in its
 * 5 × 5 neighbourhood (a scan, cz then cx) is in (−3002, −1181) at (13, 21, 13) facing west, its outlet inside the column.
 */
const LAVA_COLUMN = [-3002, -1181] as const;
const LAVA_AT = [13, 21, 13] as const;
const LAVA_DIR = 3;

describe('lava springs at seed \'42\' beside SP6b\'s abyss column (SP7a §3.4, D4)', () => {
  test('a lava try accepts a deepslate or abyss-rock wall whose outlet is abyss air (tagged, nibble 3, dry) over a fall ≥ 4; T writes air plus LAVA_SOURCE with cave byte 0', () => {
    const [cx, cz] = LAVA_COLUMN;
    const [lx, y, lz] = LAVA_AT;
    const ctx = ctxFor('42');
    expect(ctx.params.springs.lava).toEqual({ tries: 16, minFall: 4 });
    const out = newSpringList();
    terrainSpringsDebug(ctx, cx, cz, out);
    expect(listOf(out).filter(([, kind]) => kind === 2)).toEqual([[vi(lx, y, lz), 2, LAVA_DIR]]);
    // The proto before any spring (T's arrays): the spring voxel in the lava set, its outlet abyss air, dry, over a fall ≥ 4.
    const a = tArrays(cx, cz);
    expect([a.solid[vi(lx, y, lz)], LAVA_ROCKS.includes(a.state[vi(lx, y, lz)]!), a.tags[vi(lx, y, lz)]]).toEqual([1, true, 0]);
    const olx = lx + DX[LAVA_DIR]!, olz = lz + DZ[LAVA_DIR]!;
    const outlet = a.tags[vi(olx, y, olz)]!;
    expect([a.solid[vi(olx, y, olz)], outlet & 15 ? 'tagged' : 'untagged', outlet >> 4, a.fluid[vi(olx, y, olz)]]).toEqual([0, 'tagged', 3, 0]);
    let fall = 0;
    while (a.solid[vi(olx, y - fall - 1, olz)] === 0 && a.fluid[vi(olx, y - fall - 1, olz)] === 0) fall++;
    expect(fall).toBeGreaterThanOrEqual(4);
    // The range: y lies in [−55 + 4, min(top − 2, the abyss's top)].
    const top = Math.floor(a.pass.y0[(lz + 4) * 24 + lx + 4]! - 128 * ctx.params.caves.biomes.abyss.depthMin);
    expect(y >= -51 && y <= Math.min(a.top[lz * 16 + lx]! - 2, top), `y ${y} in −51 … min(${a.top[lz * 16 + lx]! - 2}, ${top})`).toBe(true);
    const s = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
    expect(fillColumnT(s, ctx, cx, cz, () => false)).toBe(true);
    const v = s.proto(cx, cz)!;
    expect([v.block(lx, y, lz), v.fluid(lx, y, lz), v.cave(lx, y, lz)]).toEqual([AIR, LAVA_SOURCE, 0]);
    expect((v.auxB()!.seedSections[0]! >>> ((y + 64) >> 4)) & 1).toBe(1);
    console.log(`lava spring (${cx}, ${cz}) (${lx}, ${y}, ${lz}): fall ${fall}, abyss top ${top}`);
  }, 60_000);
});

/** `springTries(seed '42', 'water', 0, 0, 3)` (Task 19's pin). */
const TRIES_42: number[] = [
  0, 14, 2, 0.7641933120321482, 0.4116612796206027,
  4, 12, 3, 0.2096758137922734, 0.5976148415356874,
  13, 8, 0, 0.14460644801147282, 0.2377501269802451,
];
/**
 * A column of seed '42' holding one water spring at the defaults whose outlet lies inside it (first the relief scan's
 * n916, (11344, 3591); re-found at `minFall` 7 among `MOUNTAINS`, Task 28a).
 */
const SPRING_COLUMN = [-3035, 11917] as const;
const SPRING_AT = [12, 135, 1] as const;
const SPRING_DIR = 0;

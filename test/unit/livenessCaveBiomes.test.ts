/**
 * U2's liveness tests (`src/metrics/liveness.ts`), SP6b's cave-biome leaves. Split by leaf group in SP6b Task 58 (ruling U14) so CI's
 * unit shards run them in parallel; the pins and helpers they share are in `fixtures/liveness.ts`.
 */
import { describe, expect, test } from 'vitest';
import { SCHEMA } from '../../src/core/params/schema';
import { biomeWitness, CAVE_SLOTS, caveColumn, intendedClass, leafLiveness, u2Leaves } from '../../src/metrics/liveness';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import {
  CAVERNS_VIA, TUNNELS_VIA, BIOME_LEAVES, leaf, CTX, columns,
} from './fixtures/liveness';

describe('the cave-biome leaves (SP6b Task 17; spec §12.7, Spec correction 5)', () => {
  /**
   * Each cave-biome leaf's U2 verdict at seed 42: tried on the class columns, the cave columns first (the class it is
   * meant for), then on its bounded biome witness; lush's hMin and the abyss's cMin are dead on every class column (and
   * were, with the abyss's eMax and depthMin, the border warp and the border noise, from SP6b Task 19's rock floor, which
   * moved the caverns' column to (18487, −15384), until Task 22's rule 4, whose strata make the abyss's rock show in
   * every column under its climate: the eMax, border warp and border noise now act on the cliffY column, depthMin on
   * the caverns'). SP6b Task 20's σ_b closed the abyss's cMin witness (−24350, −30565) and every other column of the
   * first 8,192 draws: its witness lies at draw 21,291, so the search draws up to 32,768 (`BIOME_DRAWS`). Task 25's lever
   * 25c (`caves.floor.y` −60) moved the tunnels' column: lush's depthMax and dripstone's cMin, decided there before, now
   * act on a land and the cliffSteep column.
   */
  const BIOME_PINS: Readonly<Record<(typeof BIOME_LEAVES)[number], string>> = {
    'caves.biomes.lush.hMin': 'biome witness column (-18559, -12761)',
    'caves.biomes.lush.depthMin': 'land column (-25833, 16792)',
    'caves.biomes.lush.depthMax': 'land column (-15542, -30245)',
    'caves.biomes.dripstone.cMin': 'cliffSteep column (-24200, -4864)',
    'caves.biomes.dripstone.depthMin': CAVERNS_VIA,
    'caves.biomes.dripstone.depthMax': TUNNELS_VIA,
    'caves.biomes.abyss.eMax': 'cliffY column (17107, 13836)',
    'caves.biomes.abyss.cMin': 'biome witness column (-7705, 14078)',
    'caves.biomes.abyss.depthMin': CAVERNS_VIA,
    'caves.biomes.depthScale': CAVERNS_VIA,
    'caves.biomes.borderWarp': 'cliffY column (17107, 13836)',
    'caves.biomes.depthWarp': CAVERNS_VIA,
    'caves.biomes.edgeJitter': CAVERNS_VIA,
    'caves.biomes.noises.border': 'cliffY column (17107, 13836)',
    'caves.biomes.noises.depth': CAVERNS_VIA,
  };
  /**
   * The search's figures for the two leaves dead on every class column (SP6b Task 29's full-tier audit): draws of
   * 32,768, columns examined of 256, T columns hashed of 64. The abyss's cMin is the thinnest margin (229 of 256
   * examined, about 1 examined per 93 draws, so its budget ends near draw 23,800): a retune of the abyss box or the
   * floor that moves its witness re-pins it here.
   */
  const WITNESS_SCANS: Readonly<Partial<Record<(typeof BIOME_LEAVES)[number], { draws: number; examined: number; checks: number }>>> = {
    'caves.biomes.lush.hMin': { draws: 83, examined: 4, checks: 1 },
    'caves.biomes.abyss.cMin': { draws: 21291, examined: 229, checks: 1 },
  };
  /** The cave biomes each leaf reads: its box's own; any of lush, dripstone and abyss for the border leaves and noises. */
  const reads = (path: string): number[] => path.includes('.lush.') ? [1] : path.includes('.dripstone.') ? [2] : path.includes('.abyss.') ? [3] : [1, 2, 3];
  /** The cave biomes the tagged air of `ctx`'s T column (cx, cz) holds. */
  const biomesIn = (cx: number, cz: number): Set<number> => {
    const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
    expect(fillColumnT(store, CTX, cx, cz, () => false)).toBe(true);
    const v = store.proto(cx, cz)!;
    const out = new Set<number>();
    for (let y = -63; y <= 319; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const b = v.cave(lx, y, lz);
      if ((b & 15) !== 0) out.add(b >> 4);
    }
    return out;
  };

  test('the 15 caves.biomes.* leaves are U2 leaves of the T stage, meant for the cave class', () => {
    expect(SCHEMA.leaves.filter((l) => l.path.startsWith('caves.biomes.')).map((l) => l.path)).toEqual([...BIOME_LEAVES]);
    for (const p of BIOME_LEAVES) {
      expect(u2Leaves().map((l) => l.path)).toContain(p);
      expect([p, leaf(p).meta.stage, intendedClass(p)]).toEqual([p, 'terrain', 'cave']);
    }
  });

  test('each is decided: live on a class column (the cave columns first) or on its bounded biome witness, whose T column holds a biome it reads; its own witness search finds a column too', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    for (const p of BIOME_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      expect([p, r.live, r.via]).toEqual([p, true, BIOME_PINS[p]]);
      const w = biomeWitness(CTX, p, all);
      expect(w.via, p).toMatch(/^biome witness column \(-?\d+, -?\d+\)$/);
      if (r.cls === null) expect(w.via, p).toBe(r.via);
      if (r.cls === null) expect([p, { draws: w.draws, examined: w.examined, checks: w.checks }]).toEqual([p, WITNESS_SCANS[p]]);
      expect([p, r.cls === null]).toEqual([p, WITNESS_SCANS[p] !== undefined]);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(w.examined, p).toBeLessThanOrEqual(256);
      expect(w.draws, p).toBeLessThanOrEqual(32768);
      const [cx, cz] = w.via!.slice('biome witness column ('.length, -1).split(', ').map(Number) as [number, number];
      const held = biomesIn(cx, cz);
      expect(reads(p).some((b) => held.has(b)), `${p}: (${cx}, ${cz}) holds ${[...held]}`).toBe(true);
    }
    expect(() => biomeWitness(CTX, 'caves.noodles.regional')).toThrow('not a cave-biome leaf');
  }, 300_000);
});

/**
 * U2's liveness tests (`src/metrics/liveness.ts`), SP6b's rock-floor leaves, rule 4's noises and SP6b's leaves in U2 and U4. Split by leaf group in SP6b Task 58 (ruling U14) so CI's
 * unit shards run them in parallel; the pins and helpers they share are in `fixtures/liveness.ts`.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { getPath } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import {
  CAVE_SLOTS, caveColumn, caveRuleWitness, caveSlotLeaves, intendedClass, leafLiveness, perturbations, SURFACE_CLASSES, surfaceSlotLeaves, u2Leaves,
} from '../../src/metrics/liveness';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { checkRegistry, prefixCovers, STAGES } from '../../src/core/stage/registry';
import type { GenContext } from '../../src/gen/context';
import {
  CAVERNS_VIA, U2_LEAVES, BIOME_LEAVES, FLOOR_LEAVES, FLOOR_VIA, leaf, CTX, moved, RULE4_NOISES, columns,
} from './fixtures/liveness';

describe('the rock floor\'s leaves (SP6b Task 19; spec §5.2, §12.7, Spec correction 5)', () => {
  test('the 4 leaves are U2 leaves of the T stage, meant for the cave class, in no slot\'s acceptance', () => {
    expect(SCHEMA.leaves.filter((l) => l.path === 'caves.noises.floor' || l.path.startsWith('caves.floor.')).map((l) => l.path)).toEqual([...FLOOR_LEAVES]);
    const slotted = new Set([...caveSlotLeaves('caverns'), ...caveSlotLeaves('tunnels')].map((l) => l.path));
    for (const p of FLOOR_LEAVES) {
      expect(u2Leaves().map((l) => l.path)).toContain(p);
      expect([p, leaf(p).meta.stage, intendedClass(p), slotted.has(p)]).toEqual([p, 'terrain', 'cave', false]);
    }
  });

  /**
   * Each is live on one of the default base's cave columns, at its bottom: a U2 step of the leaf changes blocks of that
   * T column, the lowest of them within the floor's reach (y ≤ caves.floor.y + 3·amp + 8 + span of the base or the step:
   * floorY ≤ y + 3·amp, g_b is 0 above floorY + 8 + span); the highest is printed (a changed cave floor can move the
   * rules' runs and the water above it).
   */
  test('each is live on the tunnels\' cave column, where a step changes its T column from the bottom, within the floor\'s reach', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const blocksOf = (ctx: GenContext, cx: number, cz: number): Uint16Array => {
      const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
      expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
      const v = store.proto(cx, cz)!;
      const out = new Uint16Array(384 * 256);
      for (let y = -64; y < 320; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) out[((y + 64) * 16 + lz) * 16 + lx] = v.block(lx, y, lz);
      return out;
    };
    const reach = (ctx: GenContext): number => ctx.params.caves.floor.y + 3 * ctx.params.caves.floor.amp + 8 + ctx.params.caves.floor.span;
    const lines: string[] = [];
    for (const p of FLOOR_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      expect([p, r.live, r.via, r.cls]).toEqual([p, true, FLOOR_VIA, 'cave']);
      const [cx, cz] = r.via!.slice('cave column ('.length, -1).split(', ').map(Number) as [number, number];
      const base = blocksOf(CTX, cx, cz);
      for (const value of perturbations(leaf(p), getPath(DEFAULTS, p))) {
        const v = moved(p, value);
        const got = blocksOf(v, cx, cz);
        let changed = 0, low = Infinity, top = -Infinity;
        for (let i = 0; i < base.length; i++) {
          if (got[i] === base[i]) continue;
          changed++;
          low = Math.min(low, Math.floor(i / 256) - 64);
          top = Math.max(top, Math.floor(i / 256) - 64);
        }
        if (changed > 0) expect(low, `${p} ${JSON.stringify(value)}`).toBeLessThanOrEqual(Math.max(reach(CTX), reach(v)));
        lines.push(`${p} ${JSON.stringify(value)} on ${r.via}: ${changed} blocks changed, y ${low} … ${top}`);
      }
    }
    console.log(`the rock floor's leaves on the cave columns:\n${lines.join('\n')}`);
  }, 300_000);
});

describe('rule 4\'s noises (SP6b Task 22; spec §3.4, §12.7, Spec correction 5)', () => {
  /** The cave biomes rule 4 reads each noise in: cavePatch's floors and ceilings, strataOffset's abyss rock. */
  const READS: Readonly<Record<(typeof RULE4_NOISES)[number], readonly number[]>> = {
    'surface.noises.cavePatch': [1, 2, 3],
    'surface.noises.strataOffset': [3],
  };
  /**
   * Each noise's U2 verdict at seed 42 (the caverns' column, whose caves hold lush, dripstone and abyss) and its own
   * witness (the first columns of `sp6b.liveness.caveBiomes` whose tagged air holds a biome it is read in).
   */
  const WITNESS: Readonly<Record<(typeof RULE4_NOISES)[number], string>> = {
    'surface.noises.cavePatch': 'biome witness column (-3157, -27635)',
    'surface.noises.strataOffset': 'biome witness column (-1893, -974)',
  };

  test('both are U2 leaves of the T stage, meant for the cave class, served by no surface slot', () => {
    for (const p of RULE4_NOISES) {
      expect(u2Leaves().map((l) => l.path)).toContain(p);
      expect([p, leaf(p).meta.stage, intendedClass(p)]).toEqual([p, 'terrain', 'cave']);
      expect(SURFACE_CLASSES.flatMap((c) => surfaceSlotLeaves(c))).not.toContain(p);
    }
  });

  test('each is live on the caverns\' cave column; its bounded biome witness finds a column holding a biome it is read in', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    for (const p of RULE4_NOISES) {
      expect(leafLiveness(CTX, p, all)).toEqual({ path: p, live: true, via: CAVERNS_VIA, cls: 'cave' });
      const w = caveRuleWitness(CTX, p, all);
      expect([p, w.via]).toEqual([p, WITNESS[p]]);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(w.examined, p).toBeLessThanOrEqual(256);
      expect(w.draws, p).toBeLessThanOrEqual(32768);
      const [cx, cz] = w.via!.slice('biome witness column ('.length, -1).split(', ').map(Number) as [number, number];
      const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
      expect(fillColumnT(store, CTX, cx, cz, () => false)).toBe(true);
      const v = store.proto(cx, cz)!;
      const held = new Set<number>();
      for (let y = -63; y <= 319; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const b = v.cave(lx, y, lz);
        if ((b & 15) !== 0) held.add(b >> 4);
      }
      expect(READS[p].some((b) => held.has(b)), `${p}: (${cx}, ${cz}) holds ${[...held]}`).toBe(true);
    }
    expect(() => caveRuleWitness(CTX, 'surface.noises.patch')).toThrow('not a rule-4 noise');
  }, 300_000);
});

describe('SP6b\'s leaves in U2 and U4 (SP6b spec §12.7, D15; Task 29)', () => {
  const SP6B_LEAVES = [...BIOME_LEAVES, ...FLOOR_LEAVES, ...RULE4_NOISES];

  test('U2 covers SP6a\'s 172 leaves and SP6b\'s 21: the 15 cave-biome leaves, the rock floor\'s 4 and rule 4\'s 2 noises (193, SP6b\'s count; SP7a\'s leaves follow, livenessSp7a.test.ts)', () => {
    const covered = new Set(u2Leaves().map((l) => l.path));
    for (const p of SP6B_LEAVES) expect([p, covered.has(p)]).toEqual([p, true]);
    expect([SP6B_LEAVES.length, covered.size]).toEqual([21, U2_LEAVES]);
    // SP6b's count: 172 + 21 = 193; SP7a adds the 15 aquifer leaves (Task 13) and the springs' (Tasks 19-21).
    const sp7a = [...covered].filter((p) => p.startsWith('aquifer.') || p.startsWith('springs.')).length;
    expect([193 - SP6B_LEAVES.length, U2_LEAVES - sp7a]).toEqual([172, 193]);
  });

  test('U4\'s registry check accepts the unchanged stage list: every SP6b leaf is homed in, and first hashed by, the terrain stage (D15)', () => {
    // D15: the leaves live under caves.* and surface.*, which the terrain stage already hashes; no stage is added.
    expect(STAGES.map((s) => s.id)).toEqual(['climate', 'shape', 'surfaceEst', 'biome2d', 'terrain', 'decorate', 'light', 'mesh', 'lod', 'map']);
    // SP7a appends 'aquifer' (its spec §15.3, Task 13), which no SP6b leaf is under.
    expect(STAGES.find((s) => s.id === 'terrain')?.params).toEqual(['density', 'surface', 'caves', 'aquifer', 'springs']);
    for (const p of SP6B_LEAVES) {
      const first = STAGES.find((s) => s.params.some((q) => prefixCovers(q, p)));
      expect([p, leaf(p).meta.scope, leaf(p).meta.stage, first?.id]).toEqual([p, 'terrain', 'terrain', 'terrain']);
    }
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
  });
});

/**
 * The aquifer's point functions (SP7a spec D19, D20, §13.4; Spec correction 4): `fluidAt`, `barrierAt` and
 * `terrainSolidAt` against the column step T runs (`aquiferColumn`), voxel by voxel, on six real columns of seed '42'
 * (dry land, a coast, the open sea, a floating_islands column, SP6b's abyss column with its margin, and a column
 * holding a deep lava cell found by a scan); the same values in any query order (the per-column caches); and D19's
 * sky-open rule, which reads no `top`.
 */
import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, MIN_Y } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { caveBiomeAt, cavePickerOf, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs } from '../../src/gen/biomes/cavePicker';
import { caveTagAt } from '../../src/gen/caves/tags';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { buildColumnSample, newColumnSample, readLevel, type ColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { solidAt } from '../../src/gen/density/probe';
import {
  aquiferColumn, aquiferInputs, barrierAt, cellCentre, cellStatus, createAquiferScratch, fluidAt, inAbyssMargin,
  type AquiferInputs, type AquiferSettings,
} from '../../src/gen/fluids/aquifer';
import { terrainSolidAt } from '../../src/gen/fluids/solidAt';
import { FLUID_LAVA, LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AQUIFER_NOISES, AQUIFER_SETTINGS } from '../harness/aquiferDefaults';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const ST: AquiferSettings = AQUIFER_SETTINGS;
/** The settings with the abyss margin's box empty (no voxel lies in it), to tell the margin's barriers apart. */
const NO_MARGIN: AquiferSettings = { ...ST, abyssMargin: -10 };
const ABYSS = CAVE_BIOME.abyss;

/** One column as T sees it before the aquifer step: its sample, cave pass, solidity and tags (`kind | nibble << 4`). */
interface Column {
  readonly ctx: GenContext;
  readonly dc: DensityContext;
  readonly cx: number;
  readonly cz: number;
  readonly s: ColumnSample;
  readonly pick: CavePickerInputs;
  readonly pass: CaveColumnPass;
  readonly solid: Uint8Array;
  readonly tags: Uint8Array;
}
interface Stepped { solid: Uint8Array; fluid: Uint8Array }

const dcs = new Map<GenContext, DensityContext>();
const dcOf = (ctx: GenContext): DensityContext => {
  let dc = dcs.get(ctx);
  if (dc === undefined) dcs.set(ctx, (dc = createDensityContext(ctx)));
  return dc;
};

/** Column (cx, cz) built voxel by voxel from `solidAt`, `caveTagAt` and `caveBiomeAt` (T's arrays before the aquifer). */
function columnOf(ctx: GenContext, cx: number, cz: number): Column {
  const dc = dcOf(ctx);
  const solid = new Uint8Array(98304);
  const tags = new Uint8Array(98304);
  solid.fill(1, 0, 256);
  for (let v = 256; v < 98304; v++) {
    const x = 16 * cx + (v & 15);
    const z = 16 * cz + ((v >> 4) & 15);
    const y = (v >> 8) + MIN_Y;
    if (solidAt(dc, x, y, z)) {
      solid[v] = 1;
      continue;
    }
    const t = caveTagAt(dc, x, y, z);
    if (t !== 0) tags[v] = t | (caveBiomeAt(dc, x, y, z) << 4);
  }
  const s = buildColumnSample(ctx, cx, cz, newColumnSample());
  const pick = cavePickerOf(ctx);
  return { ctx, dc, cx, cz, s, pick, pass: fillCaveColumnPass(pick, s, newCaveColumnPass()), solid, tags };
}

/** T's aquifer step on copies of the column's solidity and tags. */
function step(inp: AquiferInputs, col: Column): Stepped {
  const solid = col.solid.slice();
  const fluid = new Uint8Array(98304);
  aquiferColumn(inp, col.s, col.pick, col.pass, solid, col.tags.slice(), new Uint8Array(98304), fluid, new Int32Array(256), createAquiferScratch());
  return { solid, fluid };
}

/** The point functions' three values at a voxel, packed: fluid byte | barrier << 8 | solid << 9. */
const pointValue = (inp: AquiferInputs, dc: DensityContext, x: number, y: number, z: number): number =>
  fluidAt(inp, dc, x, y, z) | (barrierAt(inp, dc, x, y, z) ? 256 : 0) | (terrainSolidAt(inp, dc, x, y, z) ? 512 : 0);

describe('the aquifer point functions (SP7a D19, D20; Spec correction 4)', () => {
  const ctx = ctxFor('42');
  const islands = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
  const inp = aquiferInputs(ctx, ST, AQUIFER_NOISES);
  const islandInp = aquiferInputs(islands, ST, AQUIFER_NOISES);

  /** The coast column: the first of the 25 × 25 grid cx, cz −96 … 96 step 8 whose centre's offset lies in 58 … 68. */
  const coastAt = ((): readonly [number, number] => {
    for (let cz = -96; cz <= 96; cz += 8) {
      for (let cx = -96; cx <= 96; cx += 8) {
        const q = columnPoint(ctx, 16 * cx + 8, 16 * cz + 8);
        if (q.offset >= 58 && q.offset <= 68) return [cx, cz];
      }
    }
    throw new Error('no coast column in the scan');
  })();

  /** The first column of R(−2, −1) (cx −32 … −2, cz −24 … 6 step 2) whose centre's islandMask is ≥ 0.9. */
  const islandAt = ((): readonly [number, number] => {
    for (let cz = -24; cz < 8; cz += 2) {
      for (let cx = -32; cx < 0; cx += 2) if (columnPoint(islands, 16 * cx + 8, 16 * cz + 8).islandMask >= 0.9) return [cx, cz];
    }
    throw new Error('no island column in the scan');
  })();

  /**
   * The deep lava column: the lava cells among i, k −20 … 20, j −6 … −1 (centres below y −10) in that order; the first
   * whose centre's column holds tagged lava at y ≥ −54 (the cell's, not the gullies' −55 rule) under T's step.
   */
  const lavaColumn = ((): Column => {
    const c = new Int32Array(3);
    let tries = 0;
    for (let i = -20; i <= 20; i++) {
      for (let k = -20; k <= 20; k++) {
        for (let j = -6; j <= -1; j++) {
          if (cellStatus(inp, i, j, k) >>> 16 !== FLUID_LAVA) continue;
          if (++tries > 12) throw new Error('no tagged cell lava in 12 lava cells');
          cellCentre(inp, i, j, k, c);
          const col = columnOf(ctx, c[0]! >> 4, c[2]! >> 4);
          const out = step(inp, col);
          for (let v = 256 * (-54 - MIN_Y); v < 98304; v++) if (col.tags[v] !== 0 && out.fluid[v] === LAVA_SOURCE) return col;
        }
      }
    }
    throw new Error('no lava cell in the scan');
  })();

  const columns: Array<{ name: string; inp: AquiferInputs; col: Column }> = [
    { name: 'land (0, 0)', inp, col: columnOf(ctx, 0, 0) },
    { name: `coast (${coastAt[0]}, ${coastAt[1]})`, inp, col: columnOf(ctx, ...coastAt) },
    { name: 'ocean (−96, −96)', inp, col: columnOf(ctx, -96, -96) },
    { name: `floating_islands (${islandAt[0]}, ${islandAt[1]})`, inp: islandInp, col: columnOf(islands, ...islandAt) },
    { name: 'abyss (−3000, −1182)', inp, col: columnOf(ctx, -3000, -1182) },
    { name: `deep lava (${lavaColumn.cx}, ${lavaColumn.cz})`, inp, col: lavaColumn },
  ];

  test('fluidAt, barrierAt and terrainSolidAt equal aquiferColumn at every voxel of six columns', () => {
    const counts = { water: 0, skyWater: 0, barrier: 0, marginBarrier: 0, cellLava: 0, abyss: 0, margin: 0 };
    for (const { name, inp: cInp, col } of columns) {
      const out = step(cInp, col);
      const noMargin = step(aquiferInputs(col.ctx, NO_MARGIN, AQUIFER_NOISES), col);
      let wrong = 0;
      let first = '';
      for (let v = 256; v < 98304; v++) {
        const x = 16 * col.cx + (v & 15);
        const z = 16 * col.cz + ((v >> 4) & 15);
        const y = (v >> 8) + MIN_Y;
        const tag = col.tags[v]!;
        const barrier = col.solid[v] === 0 && out.solid[v] === 1;
        const expected = out.fluid[v]! | (barrier ? 256 : 0) | (out.solid[v] === 1 ? 512 : 0);
        const got = pointValue(cInp, col.dc, x, y, z);
        if (got !== expected) {
          if (wrong++ === 0) first = `${name}: (${x}, ${y}, ${z}) tag ${tag} point ${got} column ${expected}`;
        }
        if (out.fluid[v] === WATER_SOURCE) {
          if (tag !== 0) counts.water++;
          else counts.skyWater++;
        }
        if (barrier) {
          counts.barrier++;
          if (noMargin.solid[v] === 0) counts.marginBarrier++;
        }
        if (tag !== 0 && out.fluid[v] === LAVA_SOURCE && y >= -54) counts.cellLava++;
        if (tag !== 0 && tag >> 4 === ABYSS) counts.abyss++;
        else if (tag !== 0 && inAbyssMargin(cInp, col.pick, col.pass, x, y, z)) counts.margin++;
      }
      expect(wrong, first).toBe(0);
    }
    // Every branch is seen: tagged and sky-open water, barriers (the margin's too), the cells' lava, the abyss and its margin.
    for (const [k, n] of Object.entries(counts)) expect(n, k).toBeGreaterThan(0);
  }, 300_000);

  test('the six columns and their neighbours queried in a shuffled order give the values of a column-by-column pass', () => {
    const rng = testRng(77);
    const pts: Array<{ inp: AquiferInputs; dc: DensityContext; x: number; y: number; z: number }> = [];
    for (const { inp: cInp, col } of columns) {
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (let n = 0; n < 300; n++) {
          const r = rng();
          pts.push({
            inp: cInp, dc: col.dc, x: 16 * (col.cx + dx) + (r & 15), z: 16 * (col.cz + dz) + ((r >>> 4) & 15), y: -63 + ((r >>> 8) % 224),
          });
        }
      }
    }
    const inOrder = pts.map((p) => pointValue(p.inp, p.dc, p.x, p.y, p.z));
    const order = pts.map((_, n) => n);
    for (let n = order.length - 1; n > 0; n--) {
      const m = rng() % (n + 1);
      [order[n], order[m]] = [order[m]!, order[n]!];
    }
    const shuffled = new Int32Array(pts.length);
    for (const n of order) {
      const p = pts[n]!;
      shuffled[n] = pointValue(p.inp, p.dc, p.x, p.y, p.z);
    }
    let wrong = 0;
    let tagged = 0;
    let fluid = 0;
    for (let n = 0; n < pts.length; n++) {
      if (shuffled[n] !== inOrder[n]) wrong++;
      const p = pts[n]!;
      if ((inOrder[n]! & 512) === 0 && caveTagAt(p.dc, p.x, p.y, p.z) !== 0) tagged++;
      if ((inOrder[n]! & 255) !== 0) fluid++;
    }
    expect(wrong).toBe(0);
    expect(tagged).toBeGreaterThan(0);
    expect(fluid).toBeGreaterThan(0);
  }, 300_000);

  test('an untagged voxel in the open sky above a coast takes water at y ≤ 63 and air above, whatever the column\'s top (D19)', () => {
    const [cx, cz] = coastAt;
    const dc = dcOf(ctx);
    const s = buildColumnSample(ctx, cx, cz, newColumnSample());
    const tops = new Set<number>();
    let checked = 0;
    let wet = 0;
    for (let p = 0; p < 256; p++) {
      const x = 16 * cx + (p & 15);
      const z = 16 * cz + (p >> 4);
      if (Math.floor(readLevel(s, 'surfaceWaterLevel', x, z)) !== 63) continue;
      // Downward from the build limit: no voxel below has been asked when the sky's voxels are.
      let top = MIN_Y;
      for (let y = 319; y > MIN_Y; y--) {
        if (solidAt(dc, x, y, z)) {
          top = y;
          break;
        }
        if (caveTagAt(dc, x, y, z) !== 0) continue;
        expect(fluidAt(inp, dc, x, y, z), `(${x}, ${y}, ${z})`).toBe(y <= 63 ? WATER_SOURCE : 0);
        expect(barrierAt(inp, dc, x, y, z)).toBe(false);
        expect(terrainSolidAt(inp, dc, x, y, z)).toBe(false);
        checked++;
        if (y <= 63) wet++;
      }
      tops.add(top);
    }
    expect(checked).toBeGreaterThan(0);
    expect(wet).toBeGreaterThan(0);
    // The coast's positions at level 63 hold ground at several heights, below and above the sea's surface.
    expect(tops.size).toBeGreaterThan(1);
    expect(Math.min(...tops)).toBeLessThan(63);
  });
});

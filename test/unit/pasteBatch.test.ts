/**
 * The selection tool's batches and their bounds (SP5c spec §2.2-§2.4, §2.7, §10.5's batch; D9, D12, D13): changed cells
 * only, each `expect` the read value; the clipboard's air and fluids written as copied; the order y ascending, then z,
 * then x (§2.3, ruling R5); a move's merge, each voxel once; every refusal of §2.7 with its text; the cap counted after
 * the skip; `boxChecks`' 25 `editState` calls at most; a cut's `set 0`s.
 */
import { describe, expect, test } from 'vitest';
import type { BodyBox } from '../../src/player/interaction';
import type { Edit } from '../../src/sim/edits';
import { MAX_STEP_EDITS } from '../../src/sim/edits';
import { turnClipboard, turnedCell, turnedSize, type Clipboard } from '../../src/ui/world/clipboard';
import {
  bodyHits, boxChecks, cutBatch, moveBatch, pasteBatch, refusalText, type Box, type Refusal,
} from '../../src/ui/world/pasteBatch';
import { FLUID_WATER, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, DIRT, GLASS, LADDER, OAK_LOG, STONE, TORCH, WALL_TORCH } from '../../src/world/blocks/index';
import { testRng } from '../harness/stats';

const dry = (s: number): number => (s << 8) >>> 0;
const isRefusal = (r: Edit[] | Refusal): r is Refusal => !Array.isArray(r);
const edits = (r: Edit[] | Refusal): Edit[] => {
  if (isRefusal(r)) throw new Error(`refused: ${r.why}`);
  return r;
};
const box = (x0: number, y0: number, z0: number, w: number, h: number, d: number): Box => ({ x0, y0, z0, w, h, d });
const idx = (b: Pick<Box, 'w' | 'd'>, x: number, y: number, z: number): number => (y * b.d + z) * b.w + x;
const allOk = (): 0 => 0;

/** The batch order (§2.3): y ascending, then z, then x. */
function inOrder(es: readonly Edit[]): boolean {
  for (let i = 1; i < es.length; i++) {
    const a = es[i - 1]!;
    const b = es[i]!;
    const c = a.y !== b.y ? a.y - b.y : a.z !== b.z ? a.z - b.z : a.x - b.x;
    if (c >= 0) return false;
  }
  return true;
}

/** A clipboard of random values drawn from `pool`. */
function randomClip(w: number, h: number, d: number, pool: readonly number[], seed: number): Clipboard {
  const rng = testRng(seed);
  const values = new Uint32Array(w * h * d);
  for (let i = 0; i < values.length; i++) values[i] = pool[rng() % pool.length]!;
  return { w, h, d, values };
}

describe('pasteBatch (§2.3, D9)', () => {
  test('changed cells only, each `expect` the read value; a paste at its copy\'s own place with q 0 is empty', () => {
    const c = randomClip(4, 3, 5, [0, dry(STONE), dry(DIRT), dry(GLASS)], 1);
    const at = box(100, 20, -37, 4, 3, 5);
    // The copy's own place: the target reads the clipboard's own values.
    expect(edits(pasteBatch(c, 0, at, c.values.slice()))).toEqual([]);
    // A target with every third cell different.
    const target = c.values.slice();
    const changed = new Set<number>();
    for (let i = 0; i < target.length; i += 3) {
      target[i] = target[i] === dry(STONE) ? dry(DIRT) : dry(STONE);
      changed.add(i);
    }
    const es = edits(pasteBatch(c, 0, at, target));
    expect(es.length).toBe(changed.size);
    for (const e of es) {
      const i = idx(at, e.x - at.x0, e.y - at.y0, e.z - at.z0);
      expect(changed.has(i)).toBe(true);
      expect(e).toEqual({ x: e.x, y: e.y, z: e.z, op: 'set', value: c.values[i], expect: target[i] });
    }
  });

  test('a turned paste writes the turned clipboard: every cell of the target ends at `turnedCell`', () => {
    const c = randomClip(5, 2, 3, [0, dry(STONE), dry(OAK_LOG), dry(WALL_TORCH), dry(LADDER)], 2);
    for (let q = 0; q < 4; q++) {
      const t = turnedSize(c, q);
      const at = box(-8, 0, 7, t.w, c.h, t.d);
      const target = new Uint32Array(t.w * c.h * t.d).fill(dry(DIRT));
      const after = target.slice();
      for (const e of edits(pasteBatch(c, q, at, target))) after[idx(at, e.x - at.x0, e.y - at.y0, e.z - at.z0)] = e.value;
      expect(after).toEqual(turnClipboard(c, q).values);
    }
  });

  test('the clipboard\'s air written over a terrain bump (D9)', () => {
    // A 3 × 2 × 3 room: a stone floor, air above it. The target has a dirt bump inside the room's air.
    const c: Clipboard = { w: 3, h: 2, d: 3, values: new Uint32Array(18) };
    for (let i = 0; i < 9; i++) c.values[i] = dry(STONE);
    const at = box(0, 64, 0, 3, 2, 3);
    const target = c.values.slice();
    target[idx(at, 1, 1, 1)] = dry(DIRT);
    expect(edits(pasteBatch(c, 0, at, target))).toEqual([{ x: 1, y: 65, z: 1, op: 'set', value: AIR, expect: dry(DIRT) }]);
  });

  test('fluids written as copied: a source stays a source, a level byte kept', () => {
    const level3 = packFluid(FLUID_WATER, 3);
    const c: Clipboard = { w: 3, h: 1, d: 1, values: Uint32Array.of(WATER_SOURCE, level3, (dry(LADDER) | WATER_SOURCE) >>> 0) };
    const at = box(10, 0, 10, 3, 1, 1);
    const target = new Uint32Array(3).fill(dry(STONE));
    expect(edits(pasteBatch(c, 0, at, target)).map((e) => e.value)).toEqual([WATER_SOURCE, level3, (dry(LADDER) | WATER_SOURCE) >>> 0]);
    // Turned, the ladder turns and keeps its water; the fluid cells keep their bytes.
    const turned = edits(pasteBatch(c, 1, box(10, 0, 10, 1, 1, 3), target));
    expect(turned.map((e) => e.value)).toEqual([WATER_SOURCE, level3, turnedCell(c, 1, 0, 0, 2)]);
    expect(turned[2]!.value & 0xFF).toBe(WATER_SOURCE);
  });

  test('the order is y ascending, then z, then x (§2.3, ruling R5)', () => {
    const c: Clipboard = { w: 4, h: 3, d: 2, values: new Uint32Array(24).fill(dry(STONE)) };
    for (let q = 0; q < 4; q++) {
      const t = turnedSize(c, q);
      const es = edits(pasteBatch(c, q, box(-3, 5, 9, t.w, 3, t.d), new Uint32Array(24)));
      expect(es.length).toBe(24);
      expect(inOrder(es)).toBe(true);
      expect(es[0]).toMatchObject({ x: -3, y: 5, z: 9 });
    }
  });

  test('a target box that is not the turned clipboard\'s size throws', () => {
    const c: Clipboard = { w: 4, h: 3, d: 2, values: new Uint32Array(24) };
    expect(() => pasteBatch(c, 1, box(0, 0, 0, 4, 3, 2), new Uint32Array(24))).toThrow(RangeError);
    expect(() => pasteBatch(c, 0, box(0, 0, 0, 4, 3, 2), new Uint32Array(23))).toThrow(RangeError);
  });
});

/** A sparse world: a background function, overwritten per voxel. */
function world(bg: (x: number, y: number, z: number) => number): {
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, v: number): void;
  read(b: Box): Uint32Array;
} {
  const cells = new Map<string, number>();
  const get = (x: number, y: number, z: number): number => cells.get(`${x},${y},${z}`) ?? bg(x, y, z);
  return {
    get,
    set(x, y, z, v) { cells.set(`${x},${y},${z}`, v); },
    read(b) {
      const out = new Uint32Array(b.w * b.h * b.d);
      let i = 0;
      for (let y = 0; y < b.h; y++) for (let z = 0; z < b.d; z++) for (let x = 0; x < b.w; x++) out[i++] = get(b.x0 + x, b.y0 + y, b.z0 + z);
      return out;
    },
  };
}

const inBox = (b: Box, x: number, y: number, z: number): boolean =>
  x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.h && z >= b.z0 && z < b.z0 + b.d;

/**
 * A move run as the sim would apply it: each edit's `expect` must equal the voxel's value, a `set` writes its value, a
 * `revert` the generated value. Checks each voxel once, no edit a no-op, the order, then every cell of both boxes.
 */
function runMove(q: number, src: Box, at: Box, now: (x: number, y: number, z: number) => number,
  gen: (x: number, y: number, z: number) => number): { es: Edit[]; reverts: number } {
  const w = world(now);
  const srcNow = w.read(src);
  const srcGen = world(gen).read(src);
  const target = w.read(at);
  const es = edits(moveBatch(q, src, srcNow, srcGen, at, target));
  expect(inOrder(es)).toBe(true);
  const seen = new Set<string>();
  let reverts = 0;
  for (const e of es) {
    const k = `${e.x},${e.y},${e.z}`;
    expect(seen.has(k), `voxel ${k} twice`).toBe(false);
    seen.add(k);
    expect(e.expect).toBe(w.get(e.x, e.y, e.z));
    const v = e.op === 'set' ? e.value : gen(e.x, e.y, e.z);
    expect(v, `edit at ${k} is a no-op`).not.toBe(e.expect);
    if (e.op === 'revert') {
      reverts++;
      expect(inBox(at, e.x, e.y, e.z)).toBe(false);
      expect(e.value).toBe(0);
    }
    w.set(e.x, e.y, e.z, v);
  }
  const turned = turnClipboard({ w: src.w, h: src.h, d: src.d, values: srcNow }, q);
  expect(w.read(at)).toEqual(turned.values);
  for (let y = src.y0; y < src.y0 + src.h; y++) {
    for (let z = src.z0; z < src.z0 + src.d; z++) {
      for (let x = src.x0; x < src.x0 + src.w; x++) if (!inBox(at, x, y, z)) expect(w.get(x, y, z)).toBe(gen(x, y, z));
    }
  }
  return { es, reverts };
}

describe('moveBatch (§2.4, D8)', () => {
  // A 6 × 5 × 4 house: planks-like stone walls with glass, air inside, at y 70 … 74.
  const src = box(30, 70, -6, 6, 5, 4);
  const house = (x: number, y: number, z: number): number => {
    if (!inBox(src, x, y, z)) return -1;
    const lx = x - src.x0;
    const lz = z - src.z0;
    const ly = y - src.y0;
    const wall = lx === 0 || lx === src.w - 1 || lz === 0 || lz === src.d - 1 || ly === 0 || ly === src.h - 1;
    return wall ? dry(ly === 2 ? GLASS : STONE) : 0;
  };

  test('a move overlapping its source 3 blocks down: each voxel once, the target its turned value, a source cell outside the target a `revert` only where its generated value differs from now', () => {
    const down = box(src.x0, src.y0 - 3, src.z0, src.w, src.h, src.d);
    // A floating house: everything around it is air, and so is its generated source.
    const floatNow = (x: number, y: number, z: number): number => Math.max(house(x, y, z), 0);
    const airGen = (): number => 0;
    const floating = runMove(0, src, down, floatNow, airGen);
    // Its source rows outside the target (y 72 … 74 above the moved house's top at 71) revert where now is not air.
    let solidAbove = 0;
    for (let y = down.y0 + down.h; y < src.y0 + src.h; y++) {
      for (let z = src.z0; z < src.z0 + src.d; z++) for (let x = src.x0; x < src.x0 + src.w; x++) if (floatNow(x, y, z) !== 0) solidAbove++;
    }
    expect(floating.reverts).toBe(solidAbove);
    // A buried house: the generated source is dirt everywhere, and the ground around reads dirt.
    const buriedNow = (x: number, y: number, z: number): number => { const h = house(x, y, z); return h < 0 ? dry(DIRT) : h; };
    const dirtGen = (): number => dry(DIRT);
    const buried = runMove(0, src, down, buriedNow, dirtGen);
    let notDirtAbove = 0;
    for (let y = down.y0 + down.h; y < src.y0 + src.h; y++) {
      for (let z = src.z0; z < src.z0 + src.d; z++) for (let x = src.x0; x < src.x0 + src.w; x++) if (buriedNow(x, y, z) !== dry(DIRT)) notDirtAbove++;
    }
    expect(buried.reverts).toBe(notDirtAbove);
    expect(buried.reverts).toBeGreaterThan(0);
  });

  test('turned moves over every overlap: sideways, apart and across a column border, each voxel once and both boxes right', () => {
    const now = (x: number, y: number, z: number): number => {
      const h = house(x, y, z);
      return h >= 0 ? h : y < 72 ? dry(DIRT) : 0;
    };
    const gen = (_x: number, y: number): number => (y < 72 ? dry(DIRT) : 0);
    for (let q = 0; q < 4; q++) {
      const t = turnedSize(src, q);
      for (const [dx, dy, dz] of [[0, 0, 0], [2, 1, -1], [-3, -2, 2], [5, 0, 0], [40, 0, 0], [-1, 4, -3], [0, 0, 20]] as const) {
        runMove(q, src, box(src.x0 + dx, src.y0 + dy, src.z0 + dz, t.w, src.h, t.d), now, gen);
      }
    }
  });

  test('the target takes `srcNow`\'s turned values: a source cell whose `srcNow` differs from an earlier copy of the source is moved with its `srcNow` value', () => {
    const w = world((x, y, z) => Math.max(house(x, y, z), 0));
    const atN = w.read(src); // the copy made at N (feeds the ghost only)
    w.set(src.x0 + 1, src.y0 + 1, src.z0 + 1, dry(TORCH)); // a block placed while placing (D1, D4)
    const srcNow = w.read(src);
    expect(srcNow).not.toEqual(atN);
    const at = box(src.x0 + 20, src.y0, src.z0, 4, 5, 6);
    const es = edits(moveBatch(1, src, srcNow, new Uint32Array(srcNow.length), at, w.read(at)));
    const nowClip: Clipboard = { w: src.w, h: src.h, d: src.d, values: srcNow };
    const sets = es.filter((e) => e.op === 'set');
    for (const e of sets) expect(e.value).toBe(turnedCell(nowClip, 1, e.x - at.x0, e.y - at.y0, e.z - at.z0));
    expect(sets.some((e) => e.value === dry(TORCH))).toBe(true);
  });
});

describe('the bounds and refusals of §2.7 (D12, D13)', () => {
  test('every refusal of §2.7 with its text', () => {
    // A cell at y 320; a cell at y −65.
    expect(boxChecks(box(0, 310, 0, 4, 11, 4), allOk)).toEqual({ why: 'outsideY' });
    expect(boxChecks(box(0, 309, 0, 4, 11, 4), allOk)).toBeNull();
    expect(boxChecks(box(0, -65, 0, 4, 2, 4), allOk)).toEqual({ why: 'outsideY' });
    expect(boxChecks(box(0, -64, 0, 4, 2, 4), allOk)).toBeNull();
    // A cell at x 524,288 (or z); a cell at x −524,289.
    expect(boxChecks(box(524_285, 0, 0, 4, 1, 1), allOk)).toEqual({ why: 'edge' });
    expect(boxChecks(box(524_284, 0, 0, 4, 1, 1), allOk)).toBeNull();
    expect(boxChecks(box(0, 0, 524_285, 1, 1, 4), allOk)).toEqual({ why: 'edge' });
    expect(boxChecks(box(-524_289, 0, 0, 4, 1, 1), allOk)).toEqual({ why: 'edge' });
    expect(boxChecks(box(-524_288, 0, 0, 4, 1, 1), allOk)).toBeNull();
    // One editState-1 column; one editState-2 column; both (any 1 wins over a 2 met first).
    const b = box(-20, 0, -20, 40, 1, 40);
    expect(boxChecks(b, (cx, cz) => (cx === 1 && cz === 0 ? 1 : 0))).toEqual({ why: 'unloaded' });
    expect(boxChecks(b, (cx, cz) => (cx === 0 && cz === -1 ? 2 : 0))).toEqual({ why: 'regenerating' });
    expect(boxChecks(b, (cx, cz) => (cz === -2 ? 2 : cx === 1 && cz === 1 ? 1 : 0))).toEqual({ why: 'unloaded' });
    // The body: a stone cell of the turned clipboard over the body; a torch (no collision) there is not.
    const body: BodyBox = { minX: 2.2, minY: 65, minZ: 3.4, maxX: 2.8, maxY: 66.8, maxZ: 4.0 };
    const c: Clipboard = { w: 2, h: 1, d: 3, values: new Uint32Array(6) };
    c.values[idx(c, 1, 0, 2)] = dry(STONE);
    const at1 = box(2, 65, 3, 3, 1, 2); // turned once: cell (1, 0, 2) goes to (3 − 1 − 2, 0, 1) = (0, 0, 1) → world (2, 65, 4)
    expect(bodyHits(c, 1, at1, body)).toBe(false); // (2, 65, 4) only touches the body's maxZ face
    expect(bodyHits(c, 1, box(2, 65, 2, 3, 1, 2), body)).toBe(true); // world (2, 65, 3): overlaps
    expect(bodyHits(c, 0, box(1, 65, 1, 2, 1, 3), body)).toBe(true); // q 0: cell (1, 0, 2) at world (2, 65, 3)
    expect(bodyHits(c, 0, box(1, 67, 1, 2, 1, 3), body)).toBe(false); // above the body's top
    c.values[idx(c, 1, 0, 2)] = dry(TORCH);
    expect(bodyHits(c, 0, box(1, 65, 1, 2, 1, 3), body)).toBe(false);
    // 32,769 changed.
    const big: Clipboard = { w: 64, h: 9, d: 64, values: new Uint32Array(64 * 9 * 64) };
    const target = new Uint32Array(big.values.length);
    target.fill(dry(STONE), 0, 32_769);
    const r = pasteBatch(big, 0, box(0, 0, 0, 64, 9, 64), target);
    expect(r).toEqual({ why: 'tooMany', n: 32_769 });
    // The texts.
    const texts: Array<[Refusal, string]> = [
      [{ why: 'outsideY' }, 'it would leave the world (y −64 … 319)'],
      [{ why: 'edge' }, 'it would cross the world\'s edge'],
      [{ why: 'unloaded' }, 'part of it is not loaded'],
      [{ why: 'regenerating' }, 'the world is regenerating'],
      [{ why: 'body' }, 'you are inside it'],
      [r as Refusal, 'it would change 32,769 blocks; at most 32,768 at once'],
      [{ why: 'tooMany', n: 262_144 }, 'it would change 262,144 blocks; at most 32,768 at once'],
      [{ why: 'changed' }, 'the blocks changed; try again'],
    ];
    for (const [refusal, text] of texts) expect(refusalText(refusal)).toBe(text);
  });

  test('the cap is counted after the skip: a 64³ paste of which 32,768 cells change is accepted', () => {
    const c: Clipboard = { w: 64, h: 64, d: 64, values: new Uint32Array(64 ** 3).fill(dry(STONE)) };
    const target = c.values.slice();
    for (let i = 0; i < MAX_STEP_EDITS; i++) target[i * 8] = 0;
    const es = edits(pasteBatch(c, 0, box(0, 0, 0, 64, 64, 64), target));
    expect(es.length).toBe(MAX_STEP_EDITS);
    expect(inOrder(es)).toBe(true);
  });

  test('a move and a cut are capped over all their changes', () => {
    // A move of a 64 × 9 × 64 solid block 40 blocks east, into air over air: 36,864 sets and as many reverts.
    const src = box(0, 0, 0, 64, 9, 64);
    const solid = new Uint32Array(64 * 9 * 64).fill(dry(STONE));
    const r = moveBatch(0, src, solid, new Uint32Array(solid.length), box(40, 0, 0, 64, 9, 64), new Uint32Array(solid.length));
    // 64 × 9 × 64 target sets plus the 40 × 9 × 64 source cells left behind.
    expect(r).toEqual({ why: 'tooMany', n: 64 * 9 * 64 + 40 * 9 * 64 });
    expect(cutBatch(src, solid)).toEqual({ why: 'tooMany', n: 64 * 9 * 64 });
    // Exactly the cap is accepted.
    const capped = new Uint32Array(solid.length);
    capped.fill(dry(STONE), 0, MAX_STEP_EDITS);
    expect(edits(cutBatch(src, capped)).length).toBe(MAX_STEP_EDITS);
  });

  test('`boxChecks` calls `editState` at most 25 times for a 64 × 64 box (a counting stub)', () => {
    for (const [x0, z0] of [[0, 0], [1, 1], [15, -1], [-17, 8], [-524_288, 524_224]] as const) {
      let calls = 0;
      const seen = new Set<string>();
      const r = boxChecks(box(x0, 0, z0, 64, 64, 64), (cx, cz) => { calls++; seen.add(`${cx},${cz}`); return 0; });
      expect(r).toBeNull();
      expect(calls).toBeLessThanOrEqual(25);
      // Every covered column is asked once.
      const nx = ((x0 + 63) >> 4) - (x0 >> 4) + 1;
      const nz = ((z0 + 63) >> 4) - (z0 >> 4) + 1;
      expect(seen.size).toBe(nx * nz);
      expect(calls).toBe(nx * nz);
    }
    // A box failing y or the window asks no column.
    let calls = 0;
    boxChecks(box(0, 300, 0, 64, 64, 64), () => { calls++; return 0; });
    boxChecks(box(524_280, 0, 0, 64, 1, 1), () => { calls++; return 0; });
    expect(calls).toBe(0);
  });

  test('`boxChecks` allocates nothing: its refusals are shared', () => {
    const b = box(0, 0, 0, 4, 1, 4);
    expect(boxChecks(b, () => 1)).toBe(boxChecks(b, () => 1));
    expect(boxChecks(b, () => 2)).toBe(boxChecks(b, () => 2));
    expect(boxChecks(box(0, 400, 0, 1, 1, 1), allOk)).toBe(boxChecks(box(0, -70, 0, 1, 1, 1), allOk));
  });
});

describe('cutBatch (§2.2)', () => {
  test('a cut of a box holding 100 non-air cells is 100 `set 0`s', () => {
    const b = box(-5, 12, 33, 10, 4, 8);
    const values = new Uint32Array(320);
    const rng = testRng(7);
    const filled = new Set<number>();
    while (filled.size < 100) filled.add(rng() % 320);
    const pool = [dry(STONE), dry(GLASS), WATER_SOURCE, (dry(LADDER) | WATER_SOURCE) >>> 0];
    for (const i of filled) values[i] = pool[i % pool.length]!;
    const es = edits(cutBatch(b, values));
    expect(es.length).toBe(100);
    expect(inOrder(es)).toBe(true);
    for (const e of es) {
      const i = idx(b, e.x - b.x0, e.y - b.y0, e.z - b.z0);
      expect(filled.has(i)).toBe(true);
      expect(e).toEqual({ x: e.x, y: e.y, z: e.z, op: 'set', value: 0, expect: values[i] });
    }
  });
});

/**
 * The clipboard model and its turns (SP5c spec §2.6, §10.5's Rotation; D10): one turn is clockwise seen from +y, a cell
 * (x, y, z) of a W × D box goes to (D − 1 − z, y, x) of the D × W box, and a value's state turns by
 * `REGISTRY.rotateState` while its fluid byte is kept.
 */
import { describe, expect, test } from 'vitest';
import {
  sourceIndex,
  turnClipboard,
  turnedCell,
  turnedSize,
  turnValue,
  type Clipboard,
} from '../../src/ui/world/clipboard';
import { parseToSim } from '../../src/workers/protocol';
import { AIR, LADDER, REGISTRY, STONE, WALL_TORCH } from '../../src/world/blocks/index';
import { packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { boxOf } from '../../src/world/blocks/provisionalBoxes';
import { testRng } from '../harness/stats';

const mod4 = (q: number): number => ((q % 4) + 4) % 4;

/** Every state of a type with a `facing` or `axis` property (today: `oak_log`, `wall_torch`, `ladder`). */
const ORIENTED: readonly number[] = Array.from({ length: REGISTRY.stateCount }, (_, s) => s).filter((s) => {
  const p = REGISTRY.propsOf(s);
  return p['facing'] !== undefined || p['axis'] !== undefined;
});

/** The ladder's four facings. */
const LADDERS: readonly number[] = [0, 1, 2, 3].map((q) => REGISTRY.rotateState(LADDER, q));

/**
 * The value pool of the random clipboards: every registry state dry (so every oriented state in every orientation),
 * air with a water source and with a flowing level, and each ladder waterlogged.
 */
const POOL: readonly number[] = [
  ...Array.from({ length: REGISTRY.stateCount }, (_, s) => s << 8),
  (AIR << 8) | WATER_SOURCE,
  (AIR << 8) | packFluid(1, 3),
  ...LADDERS.map((s) => (s << 8) | WATER_SOURCE),
];

/** A random clipboard of sides 1-8 holding values of `POOL`. */
function randomClipboard(next: () => number): Clipboard {
  const w = 1 + (next() % 8);
  const h = 1 + (next() % 8);
  const d = 1 + (next() % 8);
  const values = new Uint32Array(w * h * d);
  for (let i = 0; i < values.length; i++) values[i] = POOL[next() % POOL.length]!;
  return { w, h, d, values };
}

/** The first index where two clipboards differ, or −1 when sizes and every cell agree. */
function firstDiff(a: Clipboard, b: Clipboard): number {
  if (a.w !== b.w || a.h !== b.h || a.d !== b.d || a.values.length !== b.values.length) return -2;
  for (let i = 0; i < a.values.length; i++) if (a.values[i] !== b.values[i]) return i;
  return -1;
}

/** The forward position map of q turns applied one at a time, as §2.6 states it: (x, z) in W × D → (D − 1 − z, x). */
function forward(c: Pick<Clipboard, 'w' | 'd'>, q: number, x: number, z: number): [x: number, z: number] {
  let w = c.w;
  let d = c.d;
  for (let i = 0; i < mod4(q); i++) {
    [x, z] = [d - 1 - z, x];
    [w, d] = [d, w];
  }
  return [x, z];
}

describe('rotation (SP5c spec §2.6, D10)', () => {
  test('for every registry state and q in −5 … 5, rotateState(s, q) === rotateState(s, q mod 4), its type kept, only `facing` and `axis` changed', () => {
    for (let s = 0; s < REGISTRY.stateCount; s++) {
      const from = REGISTRY.propsOf(s);
      for (let q = -5; q <= 5; q++) {
        const case_ = `state ${REGISTRY.stateKey(s)} q ${q}`;
        const t = REGISTRY.rotateState(s, q);
        expect(t, case_).toBe(REGISTRY.rotateState(s, mod4(q)));
        expect(REGISTRY.STATE_TYPE[t], case_).toBe(REGISTRY.STATE_TYPE[s]);
        const to = REGISTRY.propsOf(t);
        expect(Object.keys(to), case_).toEqual(Object.keys(from));
        for (const k of Object.keys(from)) if (k !== 'facing' && k !== 'axis') expect(to[k], `${case_} prop ${k}`).toBe(from[k]);
        for (const f of [0, WATER_SOURCE, packFluid(1, 3)]) {
          expect(turnValue((s << 8) | f, q), `${case_} fluid ${f}`).toBe(turnValue((s << 8) | f, mod4(q)));
        }
      }
    }
  });

  test('for 200 random clipboards: four turns are the identity cell for cell; a turn then three turns is the identity; two single turns equal one double; sizes swap on odd turns', () => {
    const seed = 0x5c09;
    const next = testRng(seed);
    for (let n = 0; n < 200; n++) {
      const c = randomClipboard(next);
      const case_ = `seed ${seed} case ${n} (${c.w} × ${c.h} × ${c.d})`;
      expect(firstDiff(turnClipboard(c, 4), c), `${case_}: four turns`).toBe(-1);
      expect(firstDiff(turnClipboard(turnClipboard(turnClipboard(turnClipboard(c, 1), 1), 1), 1), c), `${case_}: four single turns`).toBe(-1);
      expect(firstDiff(turnClipboard(turnClipboard(c, 1), 3), c), `${case_}: a turn then three`).toBe(-1);
      expect(firstDiff(turnClipboard(turnClipboard(c, 1), 1), turnClipboard(c, 2)), `${case_}: two singles vs one double`).toBe(-1);
      expect(firstDiff(turnClipboard(c, -1), turnClipboard(c, 3)), `${case_}: −1 vs 3`).toBe(-1);
      for (let q = -5; q <= 5; q++) {
        const odd = mod4(q) % 2 === 1;
        const size = turnedSize(c, q);
        const t = turnClipboard(c, q);
        expect(size, `${case_} q ${q}: turnedSize`).toEqual(odd ? { w: c.d, d: c.w } : { w: c.w, d: c.d });
        expect([t.w, t.h, t.d], `${case_} q ${q}: turned sizes`).toEqual([size.w, c.h, size.d]);
        // Each source cell lands where §2.6's forward map sends it, its value turned; sourceIndex is that map's inverse.
        for (let y = 0; y < c.h; y++) {
          for (let z = 0; z < c.d; z++) {
            for (let x = 0; x < c.w; x++) {
              const [tx, tz] = forward(c, q, x, z);
              const from = (y * c.d + z) * c.w + x;
              expect(sourceIndex(c, q, tx, y, tz), `${case_} q ${q} cell (${x}, ${y}, ${z})`).toBe(from);
              expect(turnedCell(c, q, tx, y, tz), `${case_} q ${q} cell (${x}, ${y}, ${z})`).toBe(turnValue(c.values[from]!, q));
              expect(t.values[(y * t.d + tz) * t.w + tx], `${case_} q ${q} cell (${x}, ${y}, ${z})`).toBe(turnValue(c.values[from]!, q));
            }
          }
        }
      }
    }
  });

  test('every turned value passes the sim\'s guard, through `parseToSim` of an `edits` message holding it as `value` and `expect`, and keeps its fluid byte', () => {
    for (let q = -5; q <= 5; q++) {
      const turned = POOL.map((v) => turnValue(v, q));
      turned.forEach((t, i) => expect(t & 0xFF, `value ${POOL[i]} q ${q}: fluid byte`).toBe(POOL[i]! & 0xFF));
      for (let i = 0; i < turned.length; i++) {
        const t = turned[i]!;
        const msg = { type: 'edits', id: 1, edits: [{ x: 0, y: 0, z: 0, op: 'set', value: t, expect: t }] };
        expect(parseToSim(msg), `value ${POOL[i]} q ${q} → ${t}: refused by the guard`).not.toBeNull();
      }
    }
  });

  test('each oriented state\'s direction turned by the position map (x, z) → (−z, x) equals the turned state\'s direction; each provisional box turned by the same map equals the turned state\'s box', () => {
    expect(ORIENTED.length, 'no oriented states').toBeGreaterThan(0);
    const unit: Record<string, readonly [number, number, number]> = {
      north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
      x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
    };
    /** The state's direction: its facing's unit vector, or its axis (as an unsigned vector). */
    const dir = (s: number): [number, number, number] => {
      const p = REGISTRY.propsOf(s);
      const v = unit[(p['facing'] ?? p['axis'])!]!;
      return [v[0], v[1], v[2]];
    };
    const abs = (v: readonly number[]): number[] => v.map((c) => Math.abs(c));
    for (const s of ORIENTED) {
      const isAxis = REGISTRY.propsOf(s)['axis'] !== undefined;
      let v = dir(s);
      for (let q = 1; q <= 4; q++) {
        v = [0 - v[2] || 0, v[1], v[0]]; // `|| 0` keeps −0 out of toEqual
        const t = turnValue(s << 8, q) >>> 8;
        const case_ = `${REGISTRY.stateKey(s)} q ${q} → ${REGISTRY.stateKey(t)}`;
        if (isAxis) expect(abs(dir(t)), case_).toEqual(abs(v));
        else expect(dir(t), case_).toEqual(v);
      }
    }
    // The boxes in eighths: (x, z) → (8 − z, x) is the block-centred form of (x, z) → (−z, x).
    const a = new Uint8Array(6);
    const b = new Uint8Array(6);
    let boxes = 0;
    for (let s = 0; s < REGISTRY.stateCount; s++) {
      if (!boxOf(s, a)) continue;
      boxes++;
      for (let q = 1; q <= 4; q++) {
        let box = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
        for (let i = 0; i < q; i++) box = [8 - box[5]!, box[1]!, box[0]!, 8 - box[2]!, box[4]!, box[3]!];
        const t = turnValue(s << 8, q) >>> 8;
        expect(boxOf(t, b), `${REGISTRY.stateKey(t)} has no box`).toBe(true);
        expect(Array.from(b), `${REGISTRY.stateKey(s)} q ${q} → ${REGISTRY.stateKey(t)}`).toEqual(box);
      }
    }
    expect(boxes, 'no provisional boxes').toBeGreaterThan(0);
  });

  test('named: a north `wall_torch` at (1, 0, 0) with its support block at (1, 0, 1) (to its south) in a 3 × 1 × 2 clipboard: after one turn an east wall torch with its support to its west, both inside the turned 2 × 1 × 3 clipboard', () => {
    const values = new Uint32Array(3 * 1 * 2).fill(AIR << 8);
    const c: Clipboard = { w: 3, h: 1, d: 2, values };
    const at = (k: Clipboard, x: number, y: number, z: number): number => k.values[(y * k.d + z) * k.w + x]!;
    values[(0 * 2 + 0) * 3 + 1] = WALL_TORCH << 8;
    values[(0 * 2 + 1) * 3 + 1] = STONE << 8;
    expect(REGISTRY.propsOf(WALL_TORCH)['facing']).toBe('north');

    const t = turnClipboard(c, 1);
    expect([t.w, t.h, t.d]).toEqual([2, 1, 3]);
    let torch: [number, number, number] | null = null;
    let support: [number, number, number] | null = null;
    for (let z = 0; z < t.d; z++) {
      for (let x = 0; x < t.w; x++) {
        const v = at(t, x, 0, z);
        if (REGISTRY.STATE_TYPE[v >>> 8] === REGISTRY.STATE_TYPE[WALL_TORCH]) torch = [x, 0, z];
        if (v >>> 8 === STONE) support = [x, 0, z];
      }
    }
    expect(torch, 'no wall torch in the turned clipboard').not.toBeNull();
    expect(support, 'no support block in the turned clipboard').not.toBeNull();
    expect(REGISTRY.stateKey(at(t, torch![0], 0, torch![2]) >>> 8)).toBe('wall_torch[facing=east]');
    expect(support, 'the support is not to the torch\'s west').toEqual([torch![0] - 1, 0, torch![2]]);
    expect(torch).toEqual([1, 0, 1]);
    expect(turnedCell(c, 1, 1, 0, 1)).toBe(REGISTRY.parseStateKey('wall_torch[facing=east]') << 8);
    expect(turnedCell(c, 1, 0, 0, 1)).toBe(STONE << 8);
  });
});

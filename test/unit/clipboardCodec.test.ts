/**
 * `ClipboardV1` (SP5c spec §4.1, §10.5's clipboard codec; D24): the stored clipboard holds a table of the state keys it
 * uses and, per cell, an index into it and the fluid byte, so it reads under any later registry by key. Seeded round
 * trips; a permuted and a shorter key table remap by key, an unknown key becomes air and is counted; each malformed field
 * of §4.1 reads as unreadable, never a throw; the 3 B per cell; the one `put` of `meta['clipboard']`.
 */
import { describe, expect, test } from 'vitest';
import {
  CLIPBOARD_KEY,
  clipboardOps,
  decodeClipboard,
  encodeClipboard,
  MAX_CLIPBOARD_KEYS,
  type ClipboardV1,
} from '../../src/persist/clipboard';
import { AIR, LADDER, REGISTRY, STONE } from '../../src/world/blocks/index';
import { MAX_STATES } from '../../src/world/blocks/registry';
import { packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { testRng } from '../harness/stats';

/**
 * The value pool: every registry state dry (every placeable state among them, and every orientation of the oriented
 * ones), air with a water source and with a flowing level, and a waterlogged ladder.
 */
const POOL: readonly number[] = [
  ...Array.from({ length: REGISTRY.stateCount }, (_, s) => s << 8),
  (AIR << 8) | WATER_SOURCE,
  (AIR << 8) | packFluid(1, 3, true, true),
  ((LADDER << 8) | WATER_SOURCE) >>> 0,
];

interface Box {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly values: Uint32Array;
}

/** A random clipboard of sides 1-16 holding values of `POOL`. */
function randomBox(next: () => number): Box {
  const w = 1 + (next() % 16);
  const h = 1 + (next() % 16);
  const d = 1 + (next() % 16);
  const values = new Uint32Array(w * h * d);
  for (let i = 0; i < values.length; i++) values[i] = POOL[next() % POOL.length]!;
  return { w, h, d, values };
}

/** A well-formed raw clipboard to break one field of: 2 × 1 × 2 of stone, air with water, stone, air. */
function goodRaw(): Record<string, unknown> {
  return {
    v: 1, w: 2, h: 1, d: 2,
    keys: [REGISTRY.stateKey(STONE), REGISTRY.stateKey(AIR)],
    states: Uint16Array.of(0, 1, 0, 1),
    fluids: Uint8Array.of(0, WATER_SOURCE, 0, 0),
  };
}

describe('ClipboardV1 (SP5c §4.1, D24)', () => {
  test('round trip: 200 random clipboards (seeded, sides 1-16, every placeable state) decode to their values', () => {
    const next = testRng(0x5c10);
    const seen = new Set<number>();
    for (let k = 0; k < 200; k++) {
      const b = randomBox(next);
      const c = encodeClipboard(b.w, b.h, b.d, b.values);
      expect(c.v).toBe(1);
      expect([c.w, c.h, c.d]).toEqual([b.w, b.h, b.d]);
      expect(c.states).toBeInstanceOf(Uint16Array);
      expect(c.fluids).toBeInstanceOf(Uint8Array);
      expect(c.states.length).toBe(b.values.length);
      expect(c.fluids.length).toBe(b.values.length);
      // `keys` the distinct state keys in first-use order.
      const order: string[] = [];
      for (const v of b.values) {
        const key = REGISTRY.stateKey(v >>> 8);
        if (!order.includes(key)) order.push(key);
      }
      expect(c.keys).toEqual(order);
      for (let i = 0; i < b.values.length; i++) {
        expect(c.keys[c.states[i]!]).toBe(REGISTRY.stateKey(b.values[i]! >>> 8));
        expect(c.fluids[i]).toBe(b.values[i]! & 0xFF);
      }
      const out = decodeClipboard(c);
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect([out.w, out.h, out.d, out.unknown]).toEqual([b.w, b.h, b.d, 0]);
      expect(out.values).toEqual(b.values);
      for (const v of b.values) seen.add(v);
    }
    // Every state of the pool was round-tripped at least once.
    for (const v of POOL) expect(seen.has(v), `value ${v} never drawn`).toBe(true);
  });

  test('a key table permuted, and one cut to its first keys with the rest renamed `nope[x=1]`: every cell equal by state key, the unknown ones air, `unknown` their cell count', () => {
    const next = testRng(0x5c11);
    for (let k = 0; k < 50; k++) {
      const b = randomBox(next);
      const c = encodeClipboard(b.w, b.h, b.d, b.values);
      const n = c.keys.length;

      // Permuted: key j moves to perm[j], and each cell's index follows it.
      const perm = Array.from({ length: n }, (_, j) => j);
      for (let j = n - 1; j > 0; j--) {
        const r = next() % (j + 1);
        [perm[j], perm[r]] = [perm[r]!, perm[j]!];
      }
      const keys = new Array<string>(n);
      for (let j = 0; j < n; j++) keys[perm[j]!] = c.keys[j]!;
      const states = c.states.map((s) => perm[s]!);
      const permuted = decodeClipboard({ ...c, keys, states });
      expect(permuted.ok).toBe(true);
      if (permuted.ok) {
        expect(permuted.unknown).toBe(0);
        expect(permuted.values).toEqual(b.values);
      }

      // Cut: the first `keep` keys stay, the rest are renamed to a key no registry parses.
      const keep = next() % (n + 1);
      const cut = c.keys.map((key, j) => (j < keep ? key : 'nope[x=1]'));
      const shorter = decodeClipboard({ ...c, keys: cut });
      expect(shorter.ok).toBe(true);
      if (!shorter.ok) continue;
      let unknown = 0;
      for (let i = 0; i < b.values.length; i++) {
        if (c.states[i]! < keep) {
          expect(shorter.values[i]).toBe(b.values[i]);
        } else {
          expect(shorter.values[i], 'an unknown key is air with fluid 0').toBe(0);
          unknown++;
        }
      }
      expect(shorter.unknown).toBe(unknown);
    }
  });

  test('each malformed field of §4.1 reads `{ ok: false }` and never throws', () => {
    expect(decodeClipboard(goodRaw()).ok, 'the unbroken clipboard reads').toBe(true);
    const tooManyKeys = goodRaw();
    tooManyKeys['keys'] = Array.from({ length: MAX_CLIPBOARD_KEYS + 1 }, (_, j) => (j === 0 ? REGISTRY.stateKey(STONE) : j === 1 ? REGISTRY.stateKey(AIR) : `k${j}`));
    expect((tooManyKeys['keys'] as string[]).length).toBe(4097);
    const cases: Array<[string, unknown]> = [
      ['v 2', { ...goodRaw(), v: 2 }],
      ['w 0', { ...goodRaw(), w: 0, states: new Uint16Array(0), fluids: new Uint8Array(0) }],
      ['w 65', { ...goodRaw(), w: 65, states: new Uint16Array(65 * 2), fluids: new Uint8Array(65 * 2) }],
      // 2 × 1.5 × 2 = 6 cells: the arrays fit the product, so only the side's integer check refuses it.
      ['h 1.5', { ...goodRaw(), h: 1.5, states: new Uint16Array(6), fluids: new Uint8Array(6) }],
      ['states a Uint8Array', { ...goodRaw(), states: Uint8Array.of(0, 1, 0, 1) }],
      ['fluids one short', { ...goodRaw(), fluids: Uint8Array.of(0, WATER_SOURCE, 0) }],
      ['an index equal to keys.length', { ...goodRaw(), states: Uint16Array.of(0, 1, 2, 1) }],
      ['a fluid byte 0x80', { ...goodRaw(), fluids: Uint8Array.of(0, 0x80, 0, 0) }],
      ['4,097 keys', tooManyKeys],
      ['a key 7', { ...goodRaw(), keys: [REGISTRY.stateKey(STONE), 7] }],
      ['raw null', null],
      ['raw a string', 'clipboard'],
    ];
    for (const [name, raw] of cases) {
      let out: ReturnType<typeof decodeClipboard> | undefined;
      expect(() => { out = decodeClipboard(raw); }, name).not.toThrow();
      expect(out, name).toEqual({ ok: false });
    }
  });

  test('a 64³ clipboard\'s arrays are 3 B per cell (768 KiB)', () => {
    const values = new Uint32Array(64 ** 3).fill(((STONE << 8) | 0) >>> 0);
    const c = encodeClipboard(64, 64, 64, values);
    expect(c.states.byteLength + c.fluids.byteLength).toBe(3 * 64 ** 3);
    expect(c.states.byteLength + c.fluids.byteLength).toBe(768 * 1024);
    expect(MAX_CLIPBOARD_KEYS).toBe(MAX_STATES);
  });

  test('`clipboardOps` is one `put` of `meta[\'clipboard\']`', () => {
    const c: ClipboardV1 = encodeClipboard(1, 1, 1, Uint32Array.of(STONE << 8));
    expect(CLIPBOARD_KEY).toBe('clipboard');
    const ops = clipboardOps(c);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: 'put', store: 'meta', key: 'clipboard', value: c });
    expect(ops[0]!.op === 'put' && ops[0]!.value).toBe(c);
  });
});

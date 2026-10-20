import { describe, expect, test } from 'vitest';
import {
  PACK_LAYOUT,
  packFluid,
  packSolid,
  unpackFluid,
  unpackSolid,
  type FluidFields,
  type PackField,
  type SolidFields,
} from '../../src/mesh/packing';
import { packingGlsl } from '../../src/render/materials/glsl/packing.glsl';
import { testRng } from '../harness/stats';

type Variant = 'solid' | 'fluid';
type Fields = Record<string, number>;

const VARIANTS = {
  solid: { pack: (f: Fields) => packSolid(f as unknown as SolidFields), unpack: (w: number): Fields => ({ ...unpackSolid(w) }), top: 29 },
  fluid: { pack: (f: Fields) => packFluid(f as unknown as FluidFields), unpack: (w: number): Fields => ({ ...unpackFluid(w) }), top: 31 },
} as const;

const fieldsOf = (v: Variant): [string, PackField][] => Object.entries(PACK_LAYOUT[v]);
const zeros = (v: Variant): Fields => Object.fromEntries(fieldsOf(v).map(([n]) => [n, 0]));
const max = (bits: number): number => 2 ** bits - 1;
/** The define name of a field: camelCase to UPPER_SNAKE (cornerDrop → CORNER_DROP). */
const defineName = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

test('PACK_LAYOUT is the spec §5.5 bit order (SP4a spec §5.5, D11)', () => {
  expect(PACK_LAYOUT).toEqual({
    solid: {
      layer: { offset: 0, bits: 10 }, face: { offset: 10, bits: 3 }, ao: { offset: 13, bits: 2 }, sky: { offset: 15, bits: 4 },
      block: { offset: 19, bits: 4 }, tint: { offset: 23, bits: 3 }, flags: { offset: 26, bits: 4 },
    },
    fluid: {
      layer: { offset: 0, bits: 10 }, face: { offset: 10, bits: 3 }, sky: { offset: 13, bits: 4 }, block: { offset: 17, bits: 4 },
      depth: { offset: 21, bits: 4 }, tint: { offset: 25, bits: 3 }, cornerDrop: { offset: 28, bits: 4 },
    },
  });
});

test('PACK_LAYOUT is deep-frozen', () => {
  expect(Object.isFrozen(PACK_LAYOUT)).toBe(true);
  for (const v of ['solid', 'fluid'] as const) {
    expect(Object.isFrozen(PACK_LAYOUT[v])).toBe(true);
    for (const [, f] of fieldsOf(v)) expect(Object.isFrozen(f)).toBe(true);
  }
});

describe.each(['solid', 'fluid'] as const)('%s', (v) => {
  const { pack, unpack, top } = VARIANTS[v];

  test('every field round-trips at 0 and at its maximum', () => {
    expect(pack(zeros(v))).toBe(0);
    expect(unpack(0)).toEqual(zeros(v));
    for (const [name, f] of fieldsOf(v)) {
      const fields = { ...zeros(v), [name]: max(f.bits) };
      const word = pack(fields);
      expect(word).toBe((max(f.bits) * 2 ** f.offset) >>> 0);
      expect(unpack(word)).toEqual(fields);
    }
    const all = Object.fromEntries(fieldsOf(v).map(([n, f]) => [n, max(f.bits)]));
    const word = pack(all);
    expect(word).toBe(max(top + 1));
    expect(word).toBeGreaterThanOrEqual(0);
    expect(unpack(word)).toEqual(all);
  });

  test('a RangeError naming the field at maximum + 1, at −1 and at 0.5', () => {
    for (const [name, f] of fieldsOf(v)) {
      for (const bad of [max(f.bits) + 1, -1, 0.5]) {
        expect(() => pack({ ...zeros(v), [name]: bad })).toThrow(RangeError);
        expect(() => pack({ ...zeros(v), [name]: bad })).toThrow(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  test(`the fields tile bits 0-${top} without overlap`, () => {
    let covered = 0;
    let bitCount = 0;
    for (const [, f] of fieldsOf(v)) {
      const mask = (max(f.bits) * 2 ** f.offset) >>> 0;
      expect((covered & mask) >>> 0).toBe(0);
      covered = (covered | mask) >>> 0;
      bitCount += f.bits;
    }
    expect(bitCount).toBe(top + 1);
    expect(covered).toBe(max(top + 1));
  });
});

describe('packingGlsl', () => {
  const glsl = packingGlsl();
  const defines = new Map<string, number>();
  for (const m of glsl.matchAll(/^#define (PK_[SF]_\w+_(?:OFFSET|MASK)) (\d+)u$/gm)) defines.set(m[1]!, Number(m[2]));

  test('the #defines equal PACK_LAYOUT (14 fields × 2 defines)', () => {
    expect(defines.size).toBe(28);
    for (const v of ['solid', 'fluid'] as const) {
      const V = v === 'solid' ? 'S' : 'F';
      for (const [name, f] of fieldsOf(v)) {
        expect(defines.get(`PK_${V}_${defineName(name)}_OFFSET`)).toBe(f.offset);
        expect(defines.get(`PK_${V}_${defineName(name)}_MASK`)).toBe(max(f.bits));
      }
    }
  });

  test('one unpack function per field, built from its defines', () => {
    for (const v of ['solid', 'fluid'] as const) {
      const V = v === 'solid' ? 'S' : 'F';
      for (const [name] of fieldsOf(v)) {
        const N = `PK_${V}_${defineName(name)}`;
        expect(glsl).toContain(`uint pk${V}_${name}(uint d) { return (d >> ${N}_OFFSET) & ${N}_MASK; }`);
      }
    }
    expect(glsl.match(/^uint pk[SF]_\w+\(uint d\)/gm)).toHaveLength(14);
  });

  test('the JS port of each define equals unpackSolid and unpackFluid on 1,000 words', () => {
    const next = testRng(4001);
    for (let i = 0; i < 1000; i++) {
      const w = next();
      for (const v of ['solid', 'fluid'] as const) {
        const V = v === 'solid' ? 'S' : 'F';
        const expected = VARIANTS[v].unpack(w);
        for (const [name] of fieldsOf(v)) {
          const off = defines.get(`PK_${V}_${defineName(name)}_OFFSET`)!;
          const mask = defines.get(`PK_${V}_${defineName(name)}_MASK`)!;
          expect((w >>> off) & mask).toBe(expected[name]);
        }
      }
    }
  });
});

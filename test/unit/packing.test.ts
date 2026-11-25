import { describe, expect, test } from 'vitest';
import {
  PACK_LAYOUT,
  packFluid,
  packSolid,
  packXray,
  unpackFluid,
  unpackSolid,
  unpackXray,
  type FluidFields,
  type PackField,
  type SolidFields,
  type XrayFields,
} from '../../src/mesh/packing';
import { LAVA_LAYER } from '../../src/mesh/greedy';
import { packingGlsl } from '../../src/render/materials/glsl/packing.glsl';
import { testRng } from '../harness/stats';

type Variant = 'solid' | 'fluid' | 'xray';
type Fields = Record<string, number>;

const VARIANTS = {
  solid: { pack: (f: Fields) => packSolid(f as unknown as SolidFields), unpack: (w: number): Fields => ({ ...unpackSolid(w) }), top: 30 },
  fluid: { pack: (f: Fields) => packFluid(f as unknown as FluidFields), unpack: (w: number): Fields => ({ ...unpackFluid(w) }), top: 31 },
  xray: { pack: (f: Fields) => packXray(f as unknown as XrayFields), unpack: (w: number): Fields => ({ ...unpackXray(w) }), top: 12 },
} as const;
/** The GLSL variant letter of each layout (`packing.glsl.ts`). */
const LETTER = { solid: 'S', fluid: 'F', xray: 'X' } as const;
const ALL_VARIANTS = ['solid', 'fluid', 'xray'] as const;

const fieldsOf = (v: Variant): [string, PackField][] => Object.entries(PACK_LAYOUT[v]);
const zeros = (v: Variant): Fields => Object.fromEntries(fieldsOf(v).map(([n]) => [n, 0]));
const max = (bits: number): number => 2 ** bits - 1;
/** The define name of a field: camelCase to UPPER_SNAKE (cornerDrop → CORNER_DROP). */
const defineName = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

test('PACK_LAYOUT is the spec §5.5 bit order (SP4a spec §5.5, D11), with the glass frame at bit 30 (SP5a spec §1.3) and the X-ray word (SP6a spec §5.1) with its fluid bits (SP7a spec §10.1)', () => {
  expect(PACK_LAYOUT).toEqual({
    solid: {
      layer: { offset: 0, bits: 10 }, face: { offset: 10, bits: 3 }, ao: { offset: 13, bits: 2 }, sky: { offset: 15, bits: 4 },
      block: { offset: 19, bits: 4 }, tint: { offset: 23, bits: 3 }, flags: { offset: 26, bits: 4 }, frame: { offset: 30, bits: 1 },
    },
    fluid: {
      layer: { offset: 0, bits: 10 }, face: { offset: 10, bits: 3 }, sky: { offset: 13, bits: 4 }, block: { offset: 17, bits: 4 },
      depth: { offset: 21, bits: 4 }, tint: { offset: 25, bits: 3 }, cornerDrop: { offset: 28, bits: 4 },
    },
    xray: { face: { offset: 0, bits: 3 }, kind: { offset: 3, bits: 4 }, biome: { offset: 7, bits: 4 }, fluid: { offset: 11, bits: 2 } },
  });
});

test('PACK_LAYOUT is deep-frozen', () => {
  expect(Object.isFrozen(PACK_LAYOUT)).toBe(true);
  for (const v of ALL_VARIANTS) {
    expect(Object.isFrozen(PACK_LAYOUT[v])).toBe(true);
    for (const [, f] of fieldsOf(v)) expect(Object.isFrozen(f)).toBe(true);
  }
});

describe.each(ALL_VARIANTS)('%s', (v) => {
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

test('a LAVA_LAYER vertex\'s flags (its corner drop in ninths, SP7a spec §6.3) round-trip at 0 … 8, beside every other field', () => {
  for (let drop = 0; drop <= 8; drop++) {
    for (const face of [0, 4, 5]) {
      const fields: SolidFields = { layer: LAVA_LAYER, face, ao: 0, sky: 15, block: 15, tint: 0, flags: drop, frame: 0 };
      const word = packSolid(fields);
      expect(unpackSolid(word)).toEqual(fields);
      expect((word >>> PACK_LAYOUT.solid.flags.offset) & 15).toBe(drop);
      expect(word & 1023).toBe(LAVA_LAYER);
    }
  }
});

test('the X-ray word: face 0-2, kind 3-6, biome 7-10 (SP6b\'s cave biome), fluid 11-12 (0 dry, 1 water, 2 lava; SP7a spec §10.1), bits 13-31 spare (SP6a spec §5.1)', () => {
  const word = packXray({ face: 4, kind: 15, biome: 0, fluid: 0 });
  expect(word).toBe(4 | 15 << 3);
  expect(unpackXray(word)).toEqual({ face: 4, kind: 15, biome: 0, fluid: 0 });
  expect(unpackXray(packXray({ face: 5, kind: 8, biome: 11, fluid: 2 }))).toEqual({ face: 5, kind: 8, biome: 11, fluid: 2 });
  // A flooded wall: fluid 1 in bits 11-12, beside its kind and biome.
  const flooded = packXray({ face: 1, kind: 1, biome: 3, fluid: 1 });
  expect(flooded).toBe(1 | 1 << 3 | 3 << 7 | 1 << 11);
  expect((flooded >>> PACK_LAYOUT.xray.fluid.offset) & 3).toBe(1);
  // Bits 13-31 are spare: the unpack ignores them.
  expect(unpackXray((word | 0xFFFFE000) >>> 0)).toEqual({ face: 4, kind: 15, biome: 0, fluid: 0 });
});

describe('packingGlsl', () => {
  const glsl = packingGlsl();
  const defines = new Map<string, number>();
  for (const m of glsl.matchAll(/^#define (PK_[SFX]_\w+_(?:OFFSET|MASK)) (\d+)u$/gm)) defines.set(m[1]!, Number(m[2]));

  test('the #defines equal PACK_LAYOUT (19 fields × 2 defines)', () => {
    expect(defines.size).toBe(38);
    for (const v of ALL_VARIANTS) {
      const V = LETTER[v];
      for (const [name, f] of fieldsOf(v)) {
        expect(defines.get(`PK_${V}_${defineName(name)}_OFFSET`)).toBe(f.offset);
        expect(defines.get(`PK_${V}_${defineName(name)}_MASK`)).toBe(max(f.bits));
      }
    }
  });

  test('one unpack function per field, built from its defines; the X-ray\'s are pkX_face, pkX_kind, pkX_biome and pkX_fluid', () => {
    for (const v of ALL_VARIANTS) {
      const V = LETTER[v];
      for (const [name] of fieldsOf(v)) {
        const N = `PK_${V}_${defineName(name)}`;
        expect(glsl).toContain(`uint pk${V}_${name}(uint d) { return (d >> ${N}_OFFSET) & ${N}_MASK; }`);
      }
    }
    expect(glsl.match(/^uint pk[SFX]_\w+\(uint d\)/gm)).toHaveLength(19);
    for (const name of ['face', 'kind', 'biome', 'fluid']) expect(glsl).toMatch(new RegExp(`^uint pkX_${name}\\(uint d\\)`, 'm'));
  });

  test('the JS port of each define equals unpackSolid, unpackFluid and unpackXray on 1,000 words', () => {
    const next = testRng(4001);
    for (let i = 0; i < 1000; i++) {
      const w = next();
      for (const v of ALL_VARIANTS) {
        const V = LETTER[v];
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

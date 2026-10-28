/**
 * The vertex `data` word (SP4a spec §5.5, D11; master §4.4): one uint32 per vertex, its fields pinned bit by bit, bit 0
 * first. `render/materials/glsl/packing.glsl.ts` generates the shaders' `#define`s and unpack functions from
 * `PACK_LAYOUT`, so the mesher and the shaders cannot drift apart.
 *
 * - solid (opaque and cutout): `layer` 0-9, `face` 10-12, `ao` 13-14, `sky` 15-18, `block` 19-22, `tint` 23-25,
 *   `flags` 26-29 (emissive, waving, randomRotate, upper), `frame` 30 (glass's thin frame, discarded inside by the
 *   cutout shader; SP5a spec §1.3, provisional until SP8a), spare 31;
 * - fluid: `layer` 0-9, `face` 10-12, `sky` 13-16, `block` 17-20, `depth` 21-24, `tint` 25-27, `cornerDrop` 28-31
 *   (ninths of a block below the voxel's top).
 */

/** One field: its lowest bit and its width. */
export interface PackField {
  readonly offset: number;
  readonly bits: number;
}

export interface SolidFields {
  layer: number;
  face: number;
  ao: number;
  sky: number;
  block: number;
  tint: number;
  flags: number;
  frame: number;
}

export interface FluidFields {
  layer: number;
  face: number;
  sky: number;
  block: number;
  depth: number;
  tint: number;
  cornerDrop: number;
}

const field = (offset: number, bits: number): PackField => Object.freeze({ offset, bits });

const SOLID: Readonly<Record<keyof SolidFields, PackField>> = Object.freeze({
  layer: field(0, 10),
  face: field(10, 3),
  ao: field(13, 2),
  sky: field(15, 4),
  block: field(19, 4),
  tint: field(23, 3),
  flags: field(26, 4),
  frame: field(30, 1),
});

const FLUID: Readonly<Record<keyof FluidFields, PackField>> = Object.freeze({
  layer: field(0, 10),
  face: field(10, 3),
  sky: field(13, 4),
  block: field(17, 4),
  depth: field(21, 4),
  tint: field(25, 3),
  cornerDrop: field(28, 4),
});

/** Offset and width of every field of both variants (SP4a spec §5.5), deep-frozen. */
export const PACK_LAYOUT = Object.freeze({ solid: SOLID, fluid: FLUID });

/** `[name, offset, mask]` per field, for the pack and unpack loops. */
type Entry<K> = readonly [K, number, number];
const entries = <K extends string>(layout: Readonly<Record<K, PackField>>): readonly Entry<K>[] =>
  (Object.keys(layout) as K[]).map((k) => [k, layout[k].offset, 2 ** layout[k].bits - 1] as const);

const SOLID_ENTRIES = entries(SOLID);
const FLUID_ENTRIES = entries(FLUID);

function pack<K extends string>(variant: string, list: readonly Entry<K>[], f: Readonly<Record<K, number>>): number {
  let word = 0;
  for (const [name, offset, mask] of list) {
    const v = f[name];
    if (!Number.isInteger(v) || v < 0 || v > mask) throw new RangeError(`pack ${variant}: ${name} ${v} is outside 0…${mask}`);
    word |= v << offset;
  }
  return word >>> 0;
}

function unpack<K extends string>(list: readonly Entry<K>[], word: number): Record<K, number> {
  const w = word >>> 0;
  const out = {} as Record<K, number>;
  for (const [name, offset, mask] of list) out[name] = (w >>> offset) & mask;
  return out;
}

/** The u32 data word of an opaque or cutout vertex; a RangeError names a field outside `[0, 2^bits)` or not an integer. */
export function packSolid(f: SolidFields): number {
  return pack('solid', SOLID_ENTRIES, f);
}

/** The u32 data word of a fluid vertex; a RangeError names a field outside `[0, 2^bits)` or not an integer. */
export function packFluid(f: FluidFields): number {
  return pack('fluid', FLUID_ENTRIES, f);
}

export function unpackSolid(word: number): SolidFields {
  return unpack(SOLID_ENTRIES, word);
}

export function unpackFluid(word: number): FluidFields {
  return unpack(FLUID_ENTRIES, word);
}

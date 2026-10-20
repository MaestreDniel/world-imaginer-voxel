/**
 * The shaders' decode of the vertex `data` word, generated from `PACK_LAYOUT` (SP4a spec §5.5, D11). For each variant
 * V (`S` solid, `F` fluid) and field: `#define PK_<V>_<NAME>_OFFSET <offset>u`, `#define PK_<V>_<NAME>_MASK
 * <2^bits − 1>u` and `uint pk<V>_<name>(uint d)`. NAME is the field's name in UPPER_SNAKE (cornerDrop → CORNER_DROP).
 */
import { PACK_LAYOUT, type PackField } from '../../../mesh/packing';

const upperSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

function variantGlsl(v: 'S' | 'F', layout: Readonly<Record<string, PackField>>): string[] {
  const lines: string[] = [];
  for (const [name, f] of Object.entries(layout)) {
    const n = `PK_${v}_${upperSnake(name)}`;
    lines.push(
      `#define ${n}_OFFSET ${f.offset}u`,
      `#define ${n}_MASK ${2 ** f.bits - 1}u`,
      `uint pk${v}_${name}(uint d) { return (d >> ${n}_OFFSET) & ${n}_MASK; }`,
    );
  }
  return lines;
}

/** The `#define`s and unpack functions of both variants, one per line. */
export function packingGlsl(): string {
  return [
    '// The vertex data word (PACK_LAYOUT, SP4a spec §5.5).',
    ...variantGlsl('S', PACK_LAYOUT.solid),
    ...variantGlsl('F', PACK_LAYOUT.fluid),
    '',
  ].join('\n');
}

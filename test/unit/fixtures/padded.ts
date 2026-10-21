import { AIR } from '../../../src/world/blocks/index';
import type { MeshView } from '../../../src/mesh/builder';
import { createPaddedSection, PAD, padIndex, type PaddedSection } from '../../../src/world/store/padded';

/** A per-voxel value at section-local (x, y, z), each −1 … 16 (the padded view's border included). */
export type VoxelFn = (x: number, y: number, z: number) => number;

const LO = -1;
const HI = PAD - 1;

/**
 * A padded section (SP4a spec §5.1) filled voxel by voxel over its whole 18³, border included: `block` gives the
 * state, `light` the light byte (`sky << 4 | block`; default 0xF0, open sky) and `fluid` the fluid byte (default 0).
 */
export function paddedFrom(block: VoxelFn, light: VoxelFn = () => 0xF0, fluid: VoxelFn = () => 0): PaddedSection {
  const p = createPaddedSection();
  for (let y = LO; y < HI; y++) {
    for (let z = LO; z < HI; z++) {
      for (let x = LO; x < HI; x++) {
        const i = padIndex(x, y, z);
        p.blocks[i] = block(x, y, z);
        p.light[i] = light(x, y, z);
        p.fluid[i] = fluid(x, y, z);
      }
    }
  }
  return p;
}

/**
 * A padded section from a small text map. The map is a list of blocks, each a header line `@ x0 y z0` followed by
 * rows: row r is z = z0 + r and its character c is x = x0 + c, at that y. A character found in `legend` places that
 * state; any other character ('.' by convention) leaves the voxel at `fill` (default `AIR`). `light` and `fluid` are
 * per-voxel functions as in `paddedFrom`.
 */
export function paddedFromMap(
  map: string, legend: Readonly<Record<string, number>>, o: { fill?: number; light?: VoxelFn; fluid?: VoxelFn } = {},
): PaddedSection {
  const placed = new Map<number, number>();
  let x0 = 0;
  let y = 0;
  let z = 0;
  let open = false;
  for (const raw of map.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('@')) {
      const parts = line.slice(1).trim().split(/\s+/).map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) throw new Error(`paddedFromMap: bad header '${line}'`);
      [x0, y, z] = parts as [number, number, number];
      open = true;
      continue;
    }
    if (!open) throw new Error(`paddedFromMap: row '${line}' before any '@ x0 y z0' header`);
    for (let c = 0; c < line.length; c++) {
      const s = legend[line[c]!];
      if (s === undefined) continue;
      const x = x0 + c;
      if (x < LO || x >= HI || y < LO || y >= HI || z < LO || z >= HI) throw new RangeError(`paddedFromMap: (${x}, ${y}, ${z}) is outside the padded view`);
      placed.set(padIndex(x, y, z), s);
    }
    z++;
  }
  const fill = o.fill ?? AIR;
  return paddedFrom((x, yy, zz) => placed.get(padIndex(x, yy, zz)) ?? fill, o.light, o.fluid);
}

/** One emitted quad, read back from a builder view: corners in 1/8-block units, the four data words, its six indices. */
export interface ReadQuad {
  readonly corners: ReadonlyArray<readonly [number, number, number]>;
  readonly words: readonly number[];
  /** The quad's six indices relative to its own first vertex (0-3). */
  readonly index: readonly number[];
  /** The fourth position byte of each vertex (always 0). */
  readonly w: readonly number[];
}

/** The quads of one pass of a builder view, in emission order (four vertices and six indices each). */
export function quadsOf(v: MeshView): ReadQuad[] {
  const out: ReadQuad[] = [];
  for (let q = 0; q < v.vertices / 4; q++) {
    const corners: Array<[number, number, number]> = [];
    const words: number[] = [];
    const w: number[] = [];
    for (let k = 0; k < 4; k++) {
      const o = 4 * (4 * q + k);
      corners.push([v.position[o]!, v.position[o + 1]!, v.position[o + 2]!]);
      w.push(v.position[o + 3]!);
      words.push(v.data[4 * q + k]!);
    }
    const index = Array.from(v.index.subarray(6 * q, 6 * q + 6), (i) => i - 4 * q);
    out.push({ corners, words, index, w });
  }
  return out;
}

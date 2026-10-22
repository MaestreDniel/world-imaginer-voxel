/**
 * Section connectivity (SP4a spec §5.7, D10; master §4.4): for each of the 15 unordered pairs of distinct faces,
 * whether a 6-connected path through the section's non-opaque voxels joins them, "opaque" meaning PASS opaque with
 * `fullFaces` 63 (so partial states count as open). A flood over the 16³ per component records the faces it touches
 * (north z 0, east x 15, south z 15, west x 0, up y 15, down y 0) and sets every pair among them. The padding is not
 * read. Bit k is the k-th pair in lexicographic order (plan): (0,1), (0,2) … (0,5), (1,2) … (4,5), so bit 0 is
 * (north, east) and bit 14 (up, down). All non-opaque gives 0x7FFF, all opaque 0.
 */
import { ALL_FACES, PASS_OPAQUE } from '../world/blocks/kinds';
import { PAD, padIndex, type PaddedSection } from '../world/store/padded';
import { DEFAULT_MESH_TABLES, type MeshTables } from './greedy';

// Imported values are read through top-level aliases (vitest's bench mode turns import reads into getters; SP4a Task P1).
const OPAQUE = PASS_OPAQUE;
const FULL = ALL_FACES;
const SIDE = PAD;
const PAD_INDEX = padIndex;
const TABLES = DEFAULT_MESH_TABLES;

/** Every pair's bit set. */
const ALL_PAIRS = 0x7FFF;

/** The bit of the unordered pair of distinct faces a, b (0 … 5) in lexicographic order: 0 … 14. */
export function connectivityBit(a: number, b: number): number {
  if (a === b || a < 0 || b < 0 || a > 5 || b > 5) throw new RangeError(`connectivityBit: (${a}, ${b}) is not a pair of distinct faces`);
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  // Pairs before (lo, ·): 5 + 4 + … over the rows above lo, i.e. lo·(11 − lo)/2; then hi − lo − 1 within the row.
  return (lo * (11 - lo)) / 2 + hi - lo - 1;
}

/** Per 6-bit set of touched faces, the pair bits it sets. */
const PAIRS_OF = new Uint16Array(64);
for (let set = 0; set < 64; set++) {
  let bits = 0;
  for (let a = 0; a < 6; a++) {
    if ((set & (1 << a)) === 0) continue;
    for (let b = a + 1; b < 6; b++) if ((set & (1 << b)) !== 0) bits |= 1 << connectivityBit(a, b);
  }
  PAIRS_OF[set] = bits;
}

/** 1 for a non-opaque voxel not yet flooded (section-local `y·256 + z·16 + x`), and the flood's stack. */
const OPEN = new Uint8Array(4096);
const STACK = new Uint16Array(4096);
const ORIGIN = PAD_INDEX(0, 0, 0);
const LAYER = SIDE * SIDE;

/** The faces a section-local voxel lies on, as a 6-bit set (bit = face index). */
function facesOf(i: number): number {
  const x = i & 15;
  const z = (i >> 4) & 15;
  const y = i >> 8;
  return (z === 0 ? 1 : 0) | (x === 15 ? 2 : 0) | (z === 15 ? 4 : 0) | (x === 0 ? 8 : 0) | (y === 15 ? 16 : 0) | (y === 0 ? 32 : 0);
}

/** The 15 face-to-face bits of the padded section `p` (SP4a spec §5.7). */
export function connectivity15(p: PaddedSection, t: MeshTables = TABLES): number {
  const blocks = p.blocks;
  const pass = t.pass;
  const full = t.fullFaces;
  let open = 0;
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      const row = ORIGIN + y * LAYER + z * SIDE;
      const o = (y << 8) | (z << 4);
      for (let x = 0; x < 16; x++) {
        const s = blocks[row + x]!;
        const v = pass[s] === OPAQUE && full[s] === FULL ? 0 : 1;
        OPEN[o | x] = v;
        open += v;
      }
    }
  }
  if (open === 0) return 0;
  if (open === 4096) return ALL_PAIRS;
  let bits = 0;
  for (let start = 0; start < 4096 && bits !== ALL_PAIRS; start++) {
    if (OPEN[start] === 0) continue;
    OPEN[start] = 0;
    STACK[0] = start;
    let top = 1;
    let faces = 0;
    while (top > 0) {
      const i = STACK[--top]!;
      const x = i & 15;
      const z = (i >> 4) & 15;
      const y = i >> 8;
      faces |= facesOf(i);
      if (x > 0 && OPEN[i - 1] === 1) { OPEN[i - 1] = 0; STACK[top++] = i - 1; }
      if (x < 15 && OPEN[i + 1] === 1) { OPEN[i + 1] = 0; STACK[top++] = i + 1; }
      if (z > 0 && OPEN[i - 16] === 1) { OPEN[i - 16] = 0; STACK[top++] = i - 16; }
      if (z < 15 && OPEN[i + 16] === 1) { OPEN[i + 16] = 0; STACK[top++] = i + 16; }
      if (y > 0 && OPEN[i - 256] === 1) { OPEN[i - 256] = 0; STACK[top++] = i - 256; }
      if (y < 15 && OPEN[i + 256] === 1) { OPEN[i + 256] = 0; STACK[top++] = i + 256; }
    }
    bits |= PAIRS_OF[faces]!;
  }
  return bits;
}

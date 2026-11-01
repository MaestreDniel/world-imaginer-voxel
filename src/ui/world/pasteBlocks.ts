/**
 * The two maximum paste blocks (SP5c spec §10.3, D31): `paste.max`'s solid block and `paste.maxLit`'s relight-heavy
 * shells, built once here so the Node bench (`test/bench/noise.bench.ts`) and the page's bench leg L12c paste the same
 * cells (`src/` cannot import `test/`). Pure: no DOM, no clock; it value-imports the block registry only.
 *
 * A block is the clipboard's shape (§2.6): `w × h × d` cells, cell (x, y, z) at index `(y · d + z) · w + x`, each value
 * `state << 8 | fluid` (every cell here is dry: `NO_FLUID` is 0), air (0) where nothing is pasted. Pasted into air,
 * every non-air cell is one change; each builder keeps the first `changes` of its cells in a fixed order and leaves the
 * rest air, so a cut of 16,384 is the first half of the 32,768 cut.
 */
import { GLASS, OAK_LOG, OAK_PLANKS, STONE, WALL_TORCH } from '../../world/blocks/index';

/** A block of cells to paste: the clipboard's shape (`Clipboard`, SP5c spec §2.6). */
export interface PasteBlock {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** `w · h · d` values, index `(y · d + z) · w + x`, each `state << 8 | fluid`. */
  readonly values: Uint32Array;
}

/** A dry voxel value of a state. */
const dry = (state: number): number => state << 8;

/** The cell count of one 32 × 12 × 32 house shell: its walls, floor and roof (3,288) and its 8 wall torches. */
const SHELL_CHANGES = 3_296;

function checkChanges(changes: number, most: number, what: string): void {
  if (!Number.isInteger(changes) || changes < 0 || changes > most) throw new RangeError(`${what}: changes ${changes} outside 0 … ${most}`);
}

/**
 * `paste.max`'s block (§10.3): 32 × 32 × 32 stone with an `oak_log` (axis y) at every cell whose index is a multiple
 * of 7, its first `changes` cells in index order (y ascending, then z, then x: the paste's order, §2.3) kept and the
 * rest air.
 */
export function pasteMaxBlock(changes = 32_768): PasteBlock {
  const w = 32;
  const h = 32;
  const d = 32;
  checkChanges(changes, w * h * d, 'pasteMaxBlock');
  const values = new Uint32Array(w * h * d);
  for (let i = 0; i < changes; i++) values[i] = dry(i % 7 === 0 ? OAK_LOG : STONE);
  return { w, h, d, values };
}

/**
 * `paste.maxLit`'s block (§10.3): 32 × 12 × 32 house shells of oak planks, each with a glass band on its 5th row (row 4;
 * the corner columns stay planks) and 8 interior wall torches on row 6 against its z = 31 wall, facing in (north),
 * stacked 2 across x by 5 high: 64 × 60 × 32. Shell i (0 … 9) sits at x `i ≥ 5 ? 32 : 0`, y `(i mod 5) · 12`. Its first
 * `changes` cells in shell-major order (shell 0 first; within a shell y, then z, then x) are kept and the rest left
 * air: 9 whole shells (29,664) and 3,104 of the 10th's cells at 32,768.
 */
export function pasteLitBlock(changes = 32_768): PasteBlock {
  const w = 64;
  const h = 60;
  const d = 32;
  checkChanges(changes, 10 * SHELL_CHANGES, 'pasteLitBlock');
  const values = new Uint32Array(w * h * d);
  let n = 0;
  for (let i = 0; i < 10 && n < changes; i++) {
    const sx = i >= 5 ? 32 : 0;
    const sy = (i % 5) * 12;
    for (let y = 0; y < 12 && n < changes; y++) {
      for (let z = 0; z < 32 && n < changes; z++) {
        for (let x = 0; x < 32 && n < changes; x++) {
          const wallX = x === 0 || x === 31;
          const wallZ = z === 0 || z === 31;
          let state = -1;
          if (wallX || wallZ || y === 0 || y === 11) state = y === 4 && wallX !== wallZ ? GLASS : OAK_PLANKS;
          else if (z === 30 && y === 6 && x % 4 === 2) state = WALL_TORCH;
          if (state < 0) continue;
          values[((sy + y) * d + z) * w + sx + x] = dry(state);
          n++;
        }
      }
    }
  }
  return { w, h, d, values };
}

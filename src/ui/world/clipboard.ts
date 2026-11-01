/**
 * The selection tool's clipboard model and its turns (SP5c spec §2.6, D10). Pure: no DOM, no clock.
 *
 * A clipboard is a box of W (x) × H (y) × D (z) voxel values `state << 8 | fluid`, indexed `(y · d + z) · w + x`, sides
 * 1-64, in the copy's own orientation. One turn is clockwise seen from +y (north (0, −1) → east (1, 0)), the sense of
 * `REGISTRY.rotateState`: a cell (x, y, z) of the W × D box goes to (D − 1 − z, y, x) of the D × W box, and a value's
 * state turns by the registry's table while its fluid byte (which has no direction, `world/blocks/fluid.ts`) is kept.
 * q is any integer, taken mod 4. Nothing is precomputed and nothing here runs in the frame step: the paste batch's
 * builder turns positions arithmetically with `sourceIndex` and states with `turnValue`.
 */
import { REGISTRY } from '../../world/blocks/index';

export interface Clipboard {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** `state << 8 | fluid` per cell, index `(y · d + z) · w + x`, unturned. */
  readonly values: Uint32Array;
}

const mod4 = (q: number): number => ((q % 4) + 4) % 4;

/** The x and z sizes after q turns: swapped on odd q. */
export function turnedSize(c: Pick<Clipboard, 'w' | 'd'>, q: number): { w: number; d: number } {
  return (mod4(q) & 1) === 1 ? { w: c.d, d: c.w } : { w: c.w, d: c.d };
}

/** A voxel value turned by q quarter turns: its state by `REGISTRY.rotateState`, its fluid byte kept. */
export function turnValue(v: number, q: number): number {
  return ((REGISTRY.rotateState(v >>> 8, q) << 8) | (v & 0xFF)) >>> 0;
}

/**
 * The index in `c.values` of the cell that the turned clipboard's cell (x, y, z) comes from. One turn maps (x, z) in
 * W × D to (D − 1 − z, x) in D × W, so its inverse maps (x′, z′) to (z′, D − 1 − x′); the inverses of q = 0 … 3 turns,
 * composed, are the four cases below (W, D the unturned sizes).
 */
export function sourceIndex(c: Clipboard, q: number, x: number, y: number, z: number): number {
  const w = c.w;
  const d = c.d;
  let sx: number;
  let sz: number;
  switch (mod4(q)) {
    case 0: sx = x; sz = z; break;
    case 1: sx = z; sz = d - 1 - x; break;
    case 2: sx = w - 1 - x; sz = d - 1 - z; break;
    default: sx = w - 1 - z; sz = x; break;
  }
  return (y * d + sz) * w + sx;
}

/** The value of the turned clipboard's cell (x, y, z): its source cell's value turned. */
export function turnedCell(c: Clipboard, q: number, x: number, y: number, z: number): number {
  return turnValue(c.values[sourceIndex(c, q, x, y, z)]!, q);
}

/** The whole clipboard turned by q quarter turns (tests and round trips; the batch builder uses `turnedCell`). */
export function turnClipboard(c: Clipboard, q: number): Clipboard {
  const { w, d } = turnedSize(c, q);
  const h = c.h;
  const values = new Uint32Array(w * h * d);
  let i = 0;
  for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) values[i++] = turnedCell(c, q, x, y, z);
  return { w, h, d, values };
}

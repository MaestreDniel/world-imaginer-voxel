/**
 * The selection tool's model (SP5c spec §1.2, §1.3; D1-D3). Pure: no DOM, no clock.
 *
 * - **Modes** (§1.2, D1): `off`, `select` (the mouse marks corners) and `place` (a paste's or a move's ghost follows the
 *   aim). Q (`toggle`): off → select, select → off, place → off (the paste or move cancelled). Ctrl+V (`place('paste')`):
 *   off or select → place. N (`place('move')`): select with both corners → place. In place: `turn` ±1 mod 4, `raise` ±1
 *   on `offset` (y), LMB `cancel` → select, RMB the page's paste or move, then `placed(b)` → select with the corners set
 *   to the target box. In select: LMB `mark(0, hit)` → corner 1, RMB `mark(2, hit)` → corner 2; a null hit (the sky, or
 *   past `SELECT_REACH`) changes nothing.
 * - **Corners** (D2) are kept for the page's life: turning the tool off and on shows them again. They are not saved.
 * - **`version`** moves on every change and only then, so the page redraws the box and the label only when it moves
 *   (§1.3: never per frame).
 * - **`selection()`** (D3): with both corners, their box; with one, the 1 × 1 × 1 box at it; with none, null. The
 *   callers' "fewer than two corners" check reads `corner1` and `corner2`, never `selection()`. The box is built once
 *   per corner change and answered as the same object until then, so a frame that reads it allocates nothing.
 * - **`selectLabel`** (§1.3, D3): the label's text in `select`, with the key names from the key map (SP10's remapping
 *   renames them) and counts with a thousands separator; null with the tool off. While placing the label is the
 *   ghost's placing label (§2.5, D11), not this one, so `selectLabel` answers null there too.
 */
import type { Action } from '../../player/keymap';
import { formatCount } from './editPath';
import type { Box } from './pasteBatch';

/** The tool's ray reach in blocks, walking or flying (D2; the editing reach stays 6 and 10 with the tool off). */
export const SELECT_REACH = 32;
/** The largest selection side copy, cut and move accept (D3, D5): `MAX_COPY_SIDE`, the `copy` message's. */
export const MAX_SELECTION_SIDE = 64;

export type ToolMode = 'off' | 'select' | 'place';

/** A block position. */
export interface Corner {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SelectTool {
  readonly mode: ToolMode;
  readonly corner1: Corner | null;
  readonly corner2: Corner | null;
  /** While placing, what RMB does; null otherwise. */
  readonly kind: 'paste' | 'move' | null;
  /** While placing, the quarter turns 0-3; 0 otherwise. */
  readonly turns: number;
  /** While placing, the raise in blocks along y; 0 otherwise. */
  readonly offset: number;
  /** Moves on every change of the fields above, and only then. */
  readonly version: number;
  /** Q: off → select, select → off, place → off (cancel; the corners kept). */
  toggle(): void;
  /** In select: LMB (0) marks corner 1, RMB (2) corner 2 at the hit voxel; a null hit, or another mode, changes nothing. */
  mark(button: 0 | 2, hit: Corner | null): void;
  /**
   * Ctrl+V (`'paste'`, from off or select) or N (`'move'`, from select with both corners) → place, turns 0, offset 0.
   * False, and nothing changed, otherwise (placing already included).
   */
  place(kind: 'paste' | 'move'): boolean;
  /** In place: `turns` + dir mod 4 (`turn` 1, `turnBack` −1). */
  turn(dir: 1 | -1): void;
  /** In place: `offset` + dir (↑ 1, ↓ −1). */
  raise(dir: 1 | -1): void;
  /** In place: LMB → select, the paste or move cancelled. */
  cancel(): void;
  /** An accepted paste or move (or a harness re-marking a box): select with the corners at b's min and max. */
  placed(b: Box): void;
  /** Both corners' box, the 1 × 1 × 1 box at the one corner set, or null (D3). */
  selection(): Box | null;
}

const same = (a: Corner | null, b: Corner): boolean => a !== null && a.x === b.x && a.y === b.y && a.z === b.z;
const corner = (x: number, y: number, z: number): Corner => Object.freeze({ x, y, z });

export function createSelectTool(): SelectTool {
  let mode: ToolMode = 'off';
  let corner1: Corner | null = null;
  let corner2: Corner | null = null;
  let kind: 'paste' | 'move' | null = null;
  let turns = 0;
  let offset = 0;
  let version = 0;
  // The selection's box, rebuilt only when a corner changes.
  let box: Box | null = null;
  let boxStale = false;

  const toSelect = (): void => {
    mode = 'select';
    kind = null;
    turns = 0;
    offset = 0;
  };

  return {
    get mode() { return mode; },
    get corner1() { return corner1; },
    get corner2() { return corner2; },
    get kind() { return kind; },
    get turns() { return turns; },
    get offset() { return offset; },
    get version() { return version; },

    toggle() {
      if (mode === 'off') {
        mode = 'select';
      } else {
        mode = 'off';
        kind = null;
        turns = 0;
        offset = 0;
      }
      version++;
    },

    mark(button, hit) {
      if (mode !== 'select' || hit === null) return;
      if (same(button === 0 ? corner1 : corner2, hit)) return;
      const c = corner(hit.x, hit.y, hit.z);
      if (button === 0) corner1 = c;
      else corner2 = c;
      boxStale = true;
      version++;
    },

    place(k) {
      if (mode === 'place') return false;
      if (k === 'move' && (mode !== 'select' || corner1 === null || corner2 === null)) return false;
      mode = 'place';
      kind = k;
      turns = 0;
      offset = 0;
      version++;
      return true;
    },

    turn(dir) {
      if (mode !== 'place') return;
      turns = (turns + dir + 4) % 4;
      version++;
    },

    raise(dir) {
      if (mode !== 'place') return;
      offset += dir;
      version++;
    },

    cancel() {
      if (mode !== 'place') return;
      toSelect();
      version++;
    },

    placed(b) {
      const lo = corner(b.x0, b.y0, b.z0);
      const hi = corner(b.x0 + b.w - 1, b.y0 + b.h - 1, b.z0 + b.d - 1);
      if (mode === 'select' && same(corner1, lo) && same(corner2, hi)) return;
      toSelect();
      corner1 = lo;
      corner2 = hi;
      boxStale = true;
      version++;
    },

    selection() {
      if (boxStale) {
        boxStale = false;
        const a = corner1 ?? corner2;
        const b = corner2 ?? corner1;
        box = a === null || b === null ? null : Object.freeze({
          x0: Math.min(a.x, b.x),
          y0: Math.min(a.y, b.y),
          z0: Math.min(a.z, b.z),
          w: Math.abs(a.x - b.x) + 1,
          h: Math.abs(a.y - b.y) + 1,
          d: Math.abs(a.z - b.z) + 1,
        });
      }
      return box;
    },
  };
}

/**
 * The label's text in `select` (§1.3, D3), or null with the tool off and while placing (the placing label is the
 * ghost's). `keyName` gives an action's key name from the key map (`bindingLabel`), so a remapped key is renamed.
 */
export function selectLabel(t: SelectTool, keyName: (a: Action) => string): string | null {
  if (t.mode !== 'select') return null;
  const c1 = t.corner1;
  const c2 = t.corner2;
  if (c1 === null && c2 === null) return 'Selection tool: LMB marks corner 1, RMB corner 2';
  if (c2 === null) return `Corner 1 at ${c1!.x}, ${c1!.y}, ${c1!.z}: RMB marks corner 2`;
  if (c1 === null) return `Corner 2 at ${c2.x}, ${c2.y}, ${c2.z}: LMB marks corner 1`;
  const b = t.selection()!;
  const size = `${b.w} × ${b.h} × ${b.d}`;
  if (b.w > MAX_SELECTION_SIDE || b.h > MAX_SELECTION_SIDE || b.d > MAX_SELECTION_SIDE) {
    return `Selection ${size}: at most ${MAX_SELECTION_SIDE} blocks on a side`;
  }
  return `Selection ${size} (${formatCount(b.w * b.h * b.d)} blocks) · ${keyName('copy')} copy · ${keyName('cut')} cut · ${keyName('move')} move · ${keyName('paste')} paste`;
}

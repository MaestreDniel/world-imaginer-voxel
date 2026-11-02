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
 * - **The anchor** (§2.5, D7): `anchorBox` gives the ghost's min corner from the aim's hit voxel, its face and the turned
 *   sizes, then y + `offset`: it rests on a top face, hangs under a bottom face and stands against a side face, centred
 *   on the aimed spot. With offset 0 it never covers the aimed block, and on a side face it never does at any offset.
 *   It allocates nothing (the page runs it, and `boxChecks`, only when the hit voxel, its face, the turns or the offset
 *   change).
 * - **The target read** (§2.5): `createTargetReader` posts one `copy` of the ghost's box once it has stayed the same for
 *   `TARGET_READ_SETTLE_MS` (injected timers), one in flight with at most one box queued behind it; a reply for a box
 *   that is no longer the last one moved to is dropped, as is every reply in flight at a `moved(null)` (a refused or
 *   hidden ghost) and one rejected with `SimFailed` (the sim's own failure notice shows; ruling P2).
 * - **`placingLabel`** (§2.5, D11): the label while placing, written when the tool's state, the counts or the refusal
 *   change.
 */
import { SimFailed } from '../../engine/simClient';
import { acrossInto } from '../../player/interaction';
import type { Action } from '../../player/keymap';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../world/blocks/kinds';
import type { CopiedMsg } from '../../workers/protocol';
import { formatCount } from './editPath';
import { refusalText, type Box, type Refusal } from './pasteBatch';

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

const anchorScratch = new Int32Array(3);

/**
 * The ghost's min corner (§2.5) written into `out[0..2]` as x0, y0, z0: `a` the voxel across the hit face, `size` the
 * turned sizes (W′, H, D′); on a top face (a.x − ⌊W′/2⌋, a.y, a.z − ⌊D′/2⌋), on a bottom face its top at a.y, on a side
 * face its near side at a and centred along the face; then y + `offset`. Allocates nothing.
 */
export function anchorBox(hit: { x: number; y: number; z: number; face: number }, size: { w: number; h: number; d: number },
  offset: number, out: Int32Array): void {
  acrossInto(hit, anchorScratch);
  const ax = anchorScratch[0]!;
  const ay = anchorScratch[1]!;
  const az = anchorScratch[2]!;
  const cx = ax - (size.w >> 1);
  const cz = az - (size.d >> 1);
  let x0 = cx;
  let y0 = ay;
  let z0 = cz;
  switch (hit.face) {
    case FACE_DOWN: y0 = ay - size.h + 1; break;
    case FACE_EAST: x0 = ax; break;
    case FACE_WEST: x0 = ax - size.w + 1; break;
    case FACE_SOUTH: z0 = az; break;
    case FACE_NORTH: z0 = az - size.d + 1; break;
    case FACE_UP:
    default: break;
  }
  out[0] = x0;
  out[1] = y0 + offset;
  out[2] = z0;
}

/** How long the ghost's box must stay the same before its target is read (§2.5, D7). */
export const TARGET_READ_SETTLE_MS = 100;

/** The ghost as the label and the overlay see it: its box, its refusal, and the counts once its target is read. */
export interface GhostState {
  readonly box: Box | null;
  readonly refusal: Refusal | null;
  readonly counts: { readonly n: number; readonly m: number } | null;
}

const UNLOADED_READ: Refusal = Object.freeze({ why: 'unloaded' });

/**
 * A target reply's refusal: `why` `'unloaded'` → "part of it is not loaded"; otherwise null (the page never posts a
 * box outside the world, §2.7, so an `outside` never reaches it).
 */
export function readRefusal(r: CopiedMsg): Refusal | null {
  return r.why === 'unloaded' ? UNLOADED_READ : null;
}

const sameBox = (a: Box | null, b: Box | null): boolean => a !== null && b !== null
  && a.x0 === b.x0 && a.y0 === b.y0 && a.z0 === b.z0 && a.w === b.w && a.h === b.h && a.d === b.d;

/**
 * The throttled target read (§2.5). `moved(b)` restarts the settle (one timer) with b as the last box; at the settle
 * the box's `copy` is posted, or, with one in flight, b waits as the one queued (a box moved to later drops it until
 * its own settle). A reply reaches `onRead` only when its box equals the last box moved to and no `moved(null)` came
 * since it was posted; then the queued box, if any, is posted. `moved(null)` (a refused or hidden ghost) cancels the
 * settle and the queued box and drops the reply in flight. A `copy` rejected with `SimFailed` is dropped with the
 * queued box (any other rejection is rethrown). `dispose` does what `moved(null)` does, for good.
 */
export function createTargetReader(o: {
  timers: { set(f: () => void, ms: number): number; clear(id: number): void };
  copy(b: Box): Promise<CopiedMsg>;
  onRead(b: Box, r: CopiedMsg): void;
}): { moved(b: Box | null): void; dispose(): void } {
  let last: Box | null = null;
  let timer = -1;
  let queued: Box | null = null;
  // The box in flight and whether its reply may still be delivered (false after a `moved(null)`).
  let inFlight: Box | null = null;
  let live = false;
  let disposed = false;

  const cancelSettle = (): void => {
    if (timer >= 0) o.timers.clear(timer);
    timer = -1;
  };

  const post = (b: Box): void => {
    inFlight = b;
    live = true;
    o.copy(b).then((r) => {
      const deliver = live && !disposed && sameBox(b, last);
      inFlight = null;
      live = false;
      if (deliver) o.onRead(b, r);
      const next = queued;
      queued = null;
      if (next !== null && !disposed) post(next);
    }, (e: unknown) => {
      inFlight = null;
      live = false;
      queued = null;
      if (!(e instanceof SimFailed)) throw e;
    });
  };

  const settle = (): void => {
    timer = -1;
    const b = last;
    if (b === null || disposed) return;
    if (inFlight !== null) queued = b;
    else post(b);
  };

  return {
    moved(b) {
      if (disposed) return;
      cancelSettle();
      queued = null;
      last = b;
      if (b === null) {
        live = false;
        return;
      }
      timer = o.timers.set(settle, TARGET_READ_SETTLE_MS);
    },
    dispose() {
      disposed = true;
      cancelSettle();
      queued = null;
      last = null;
      live = false;
    },
  };
}

/**
 * The turn keys' hint: "Wheel turns" when `turn` and `turnBack` are the plain wheel's two directions (the default map;
 * a wheel binding's label reads "Wheel down" or "Wheel up"), else their names.
 */
function turnHint(keyName: (a: Action) => string): string {
  const t = keyName('turn');
  const b = keyName('turnBack');
  const wheel = (t === 'Wheel down' && b === 'Wheel up') || (t === 'Wheel up' && b === 'Wheel down');
  return wheel ? 'Wheel turns' : `${t} / ${b} turn`;
}

/**
 * The label while placing (§2.5, D11): "Paste W × H × D · turned 90° · n blocks change, m replaced · RMB pastes, LMB
 * cancels · Wheel turns · ↑ ↓ raise or lower", `size` the clipboard's (or the moved selection's) as copied; "turned …"
 * only once turned; "counting…" until the target is read; a refusal's text in place of the counts; "Move …" and "RMB
 * moves" for a move; " · no preview: too many faces" appended when the ghost's mesh has too many faces (D11). Every key
 * name is `keyName`'s (the turn keys through `turnHint`, "↑ ↓" the default map's `raise` and `lower`), so SP10's
 * remapping renames them (spec §1.3).
 */
export function placingLabel(t: SelectTool, size: { w: number; h: number; d: number }, g: GhostState,
  keyName: (a: Action) => string, tooMany: boolean): string {
  const move = t.kind === 'move';
  const turned = t.turns >= 1 ? ` · turned ${90 * t.turns}°` : '';
  const counts = g.refusal !== null ? refusalText(g.refusal)
    : g.counts === null ? 'counting…'
      : `${formatCount(g.counts.n)} blocks change, ${formatCount(g.counts.m)} replaced`;
  const label = `${move ? 'Move' : 'Paste'} ${size.w} × ${size.h} × ${size.d}${turned} · ${counts} · RMB ${move ? 'moves' : 'pastes'}, `
    + `LMB cancels · ${turnHint(keyName)} · ${keyName('raise')} ${keyName('lower')} raise or lower`;
  return tooMany ? `${label} · no preview: too many faces` : label;
}

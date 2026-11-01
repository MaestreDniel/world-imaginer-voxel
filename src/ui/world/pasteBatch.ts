/**
 * The selection tool's batches and their bounds (SP5c spec §2.2-§2.4, §2.7; D9, D12, D13). Pure: no DOM, no clock.
 *
 * - **Paste** (§2.3): every cell of the turned clipboard whose value differs from the target's read value becomes
 *   `{op: 'set', value, expect: read}`; the clipboard's air is a value like any other (D9) and fluid bytes are written
 *   as copied.
 * - **Move** (§2.4): one pass over the union of the source and target boxes, one edit per voxel: a target cell takes the
 *   turned source value read at RMB (`srcNow`) where it differs, a source cell outside the target is `revert`ed where
 *   its generated value differs from its read value. A voxel appears once, so the sim's in-batch rule is never needed.
 * - **Cut** (§2.2): every cell of the box whose value is not 0 becomes `{op: 'set', value: 0, expect: v}`.
 *
 * Every batch is written y ascending, then z, then x (§2.3: the room before the roof over it; the order that keeps §3.2's
 * limbo bound, ruling R5) and refused as `tooMany` over `MAX_STEP_EDITS`, counted after the unchanged cells are left
 * out. `boxChecks` is the main thread's check of a box before any `copy` (§2.5, §2.7): y, the window, then one
 * `editState` per covered column (each already covers its column's 3 × 3), allocating nothing; `bodyHits` is
 * `placeAt`'s body rule over the turned clipboard's colliding cells.
 *
 * A box's values (`target`, `srcNow`, `srcGen`, a cut's `values`) are laid out as the `copy` reply's: index
 * `(y · d + z) · w + x` over the box's own sizes.
 */
import { MAX_Y, WINDOW_HALF } from '../../core/coords';
import { MIN_Y } from '../../core/constants';
import { cellIntersects, type BodyBox } from '../../player/interaction';
import { MAX_STEP_EDITS, type Edit } from '../../sim/edits';
import { COLLIDE } from '../../world/blocks/index';
import { COLLIDE_NONE } from '../../world/blocks/kinds';
import { turnedCell, turnedSize, type Clipboard } from './clipboard';
import { formatCount } from './editPath';

/** A box of world blocks: its minimum corner and its sizes (each ≥ 1). */
export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/** Why a cut, paste or move is refused (§2.7, D13); `n` the changed count of a `tooMany`. */
export type Refusal = {
  readonly why: 'outsideY' | 'edge' | 'unloaded' | 'regenerating' | 'body' | 'tooMany' | 'changed';
  readonly n?: number;
};

/** A refusal's reason as the notices and the label write it (§2.7's table, D13). */
export function refusalText(r: Refusal): string {
  switch (r.why) {
    case 'outsideY': return 'it would leave the world (y −64 … 319)';
    case 'edge': return 'it would cross the world\'s edge';
    case 'unloaded': return 'part of it is not loaded';
    case 'regenerating': return 'the world is regenerating';
    case 'body': return 'you are inside it';
    case 'tooMany': return `it would change ${formatCount(r.n ?? 0)} blocks; at most ${formatCount(MAX_STEP_EDITS)} at once`;
    case 'changed': return 'the blocks changed; try again';
  }
}

// `boxChecks` runs at each anchor, turn or offset change: its refusals are shared and frozen, so it allocates nothing.
const OUTSIDE_Y: Refusal = Object.freeze({ why: 'outsideY' });
const EDGE: Refusal = Object.freeze({ why: 'edge' });
const UNLOADED: Refusal = Object.freeze({ why: 'unloaded' });
const REGENERATING: Refusal = Object.freeze({ why: 'regenerating' });

/**
 * The checks of §2.7 a box takes with no read (§2.5): every cell's y in −64 … 319, then x and z in the window
 * [−524,288, 524,288), then one `editState(cx, cz)` per column the box covers (at most 5 × 5 = 25 for 64 a side; each
 * covers its column's 3 × 3): any 1 → `unloaded`, else any 2 → `regenerating`. Null when the box passes.
 */
export function boxChecks(b: Box, editState: (cx: number, cz: number) => 0 | 1 | 2): Refusal | null {
  if (b.y0 < MIN_Y || b.y0 + b.h - 1 > MAX_Y) return OUTSIDE_Y;
  if (b.x0 < -WINDOW_HALF || b.x0 + b.w > WINDOW_HALF || b.z0 < -WINDOW_HALF || b.z0 + b.d > WINDOW_HALF) return EDGE;
  const cx1 = (b.x0 + b.w - 1) >> 4;
  const cz1 = (b.z0 + b.d - 1) >> 4;
  let stale = false;
  for (let cz = b.z0 >> 4; cz <= cz1; cz++) {
    for (let cx = b.x0 >> 4; cx <= cx1; cx++) {
      const s = editState(cx, cz);
      if (s === 1) return UNLOADED;
      if (s === 2) stale = true;
    }
  }
  return stale ? REGENERATING : null;
}

const tooMany = (n: number): Refusal => ({ why: 'tooMany', n });

function checkValues(what: string, b: Box, values: Uint32Array): void {
  if (values.length !== b.w * b.h * b.d) {
    throw new RangeError(`${what}: ${values.length} values for a ${b.w} × ${b.h} × ${b.d} box`);
  }
}

function checkTurned(what: string, src: Pick<Box, 'w' | 'h' | 'd'>, q: number, at: Box): void {
  const t = turnedSize(src, q);
  if (at.w !== t.w || at.h !== src.h || at.d !== t.d) {
    throw new RangeError(`${what}: the target box ${at.w} × ${at.h} × ${at.d} is not the turned ${t.w} × ${src.h} × ${t.d}`);
  }
}

/**
 * The paste's batch (§2.3): for every cell of the clipboard turned q times and placed at `at` (its turned sizes), a
 * `set` of the turned value where it differs from `target`'s read value, y ascending, then z, then x. More than
 * `MAX_STEP_EDITS` changed cells → `tooMany` with their count.
 */
export function pasteBatch(c: Clipboard, q: number, at: Box, target: Uint32Array): Edit[] | Refusal {
  checkTurned('pasteBatch', c, q, at);
  checkValues('pasteBatch', at, target);
  const edits: Edit[] = [];
  let n = 0;
  let i = 0;
  for (let y = 0; y < at.h; y++) {
    for (let z = 0; z < at.d; z++) {
      for (let x = 0; x < at.w; x++, i++) {
        const value = turnedCell(c, q, x, y, z);
        const expect = target[i]!;
        if (value === expect) continue;
        if (++n <= MAX_STEP_EDITS) edits.push({ x: at.x0 + x, y: at.y0 + y, z: at.z0 + z, op: 'set', value, expect });
      }
    }
  }
  return n > MAX_STEP_EDITS ? tooMany(n) : edits;
}

/**
 * The move's batch (§2.4) over the union of `src` and `at` (the source's sizes turned q times), one edit per voxel in
 * the batch order: a target cell a `set` of the turned `srcNow` value (the source as read at RMB) where it differs from
 * `target`'s read value; a source cell outside the target `{op: 'revert', value: 0, expect: srcNow}` where `srcGen`
 * (its generated value) differs from `srcNow`. More than `MAX_STEP_EDITS` over both → `tooMany`.
 */
export function moveBatch(q: number, src: Box, srcNow: Uint32Array, srcGen: Uint32Array, at: Box,
  target: Uint32Array): Edit[] | Refusal {
  checkTurned('moveBatch', src, q, at);
  checkValues('moveBatch srcNow', src, srcNow);
  checkValues('moveBatch srcGen', src, srcGen);
  checkValues('moveBatch', at, target);
  const clip: Clipboard = { w: src.w, h: src.h, d: src.d, values: srcNow };
  const ax1 = at.x0 + at.w;
  const sx1 = src.x0 + src.w;
  const edits: Edit[] = [];
  let n = 0;
  const visit = (x: number, y: number, z: number, inAt: boolean): void => {
    let edit: Edit | null = null;
    if (inAt) {
      const value = turnedCell(clip, q, x - at.x0, y - at.y0, z - at.z0);
      const expect = target[((y - at.y0) * at.d + (z - at.z0)) * at.w + (x - at.x0)]!;
      if (value !== expect) edit = { x, y, z, op: 'set', value, expect };
    } else {
      const k = ((y - src.y0) * src.d + (z - src.z0)) * src.w + (x - src.x0);
      const expect = srcNow[k]!;
      if (srcGen[k] !== expect) edit = { x, y, z, op: 'revert', value: 0, expect };
    }
    if (edit !== null && ++n <= MAX_STEP_EDITS) edits.push(edit);
  };
  const y0 = Math.min(at.y0, src.y0);
  const y1 = Math.max(at.y0 + at.h, src.y0 + src.h);
  const z0 = Math.min(at.z0, src.z0);
  const z1 = Math.max(at.z0 + at.d, src.z0 + src.d);
  for (let y = y0; y < y1; y++) {
    const yA = y >= at.y0 && y < at.y0 + at.h;
    const yS = y >= src.y0 && y < src.y0 + src.h;
    if (!yA && !yS) continue;
    for (let z = z0; z < z1; z++) {
      const rowA = yA && z >= at.z0 && z < at.z0 + at.d;
      const rowS = yS && z >= src.z0 && z < src.z0 + src.d;
      if (!rowA && !rowS) continue;
      if (!rowS) {
        for (let x = at.x0; x < ax1; x++) visit(x, y, z, true);
      } else if (!rowA) {
        for (let x = src.x0; x < sx1; x++) visit(x, y, z, false);
      } else {
        // Both rows: the interval that starts first, then what of the other lies past it, x ascending throughout.
        const lo1 = Math.min(at.x0, src.x0);
        const hi1 = at.x0 <= src.x0 ? ax1 : sx1;
        const hi2 = at.x0 <= src.x0 ? sx1 : ax1;
        for (let x = lo1; x < hi1; x++) visit(x, y, z, x >= at.x0 && x < ax1);
        for (let x = Math.max(hi1, Math.max(at.x0, src.x0)); x < hi2; x++) visit(x, y, z, x >= at.x0 && x < ax1);
      }
    }
  }
  return n > MAX_STEP_EDITS ? tooMany(n) : edits;
}

/**
 * The cut's batch (§2.2 step 2): `{op: 'set', value: 0, expect: v}` for each cell of `b` whose read value v is not 0,
 * in the batch order. More than `MAX_STEP_EDITS` → `tooMany`.
 */
export function cutBatch(b: Box, values: Uint32Array): Edit[] | Refusal {
  checkValues('cutBatch', b, values);
  const edits: Edit[] = [];
  let n = 0;
  let i = 0;
  for (let y = 0; y < b.h; y++) {
    for (let z = 0; z < b.d; z++) {
      for (let x = 0; x < b.w; x++, i++) {
        const expect = values[i]!;
        if (expect === 0) continue;
        if (++n <= MAX_STEP_EDITS) edits.push({ x: b.x0 + x, y: b.y0 + y, z: b.z0 + z, op: 'set', value: 0, expect });
      }
    }
  }
  return n > MAX_STEP_EDITS ? tooMany(n) : edits;
}

/**
 * True when a cell of the clipboard turned q times at `at` whose state collides (`COLLIDE` not none) intersects the
 * body (`placeAt`'s rule, `interaction.ts`: positive volume; a shared face is not an overlap). Only the cells under the
 * body's extent are looked at.
 */
export function bodyHits(c: Clipboard, q: number, at: Box, body: BodyBox): boolean {
  const { w, d } = turnedSize(c, q);
  const x0 = Math.max(0, Math.floor(body.minX) - at.x0);
  const x1 = Math.min(w - 1, Math.ceil(body.maxX) - 1 - at.x0);
  const y0 = Math.max(0, Math.floor(body.minY) - at.y0);
  const y1 = Math.min(c.h - 1, Math.ceil(body.maxY) - 1 - at.y0);
  const z0 = Math.max(0, Math.floor(body.minZ) - at.z0);
  const z1 = Math.min(d - 1, Math.ceil(body.maxZ) - 1 - at.z0);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (COLLIDE[turnedCell(c, q, x, y, z) >>> 8] === COLLIDE_NONE) continue;
        if (cellIntersects(at.x0 + x, at.y0 + y, at.z0 + z, body)) return true;
      }
    }
  }
  return false;
}

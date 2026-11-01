/**
 * The selection tool's model (SP5c spec §1.2, §1.3; D1-D3): every mode transition of §1.2 (Q, Ctrl+V, N, RMB, LMB,
 * turn, raise), the corners kept for the page's life, `placed(b)`, `version` moving only on a change, `selection()`
 * with zero, one and two corners, and the labels' texts with the key map's names and a thousands separator.
 */
import { describe, expect, test } from 'vitest';
import { bindingLabel, DEFAULT_KEYMAP, type Action } from '../../src/player/keymap';
import { MAX_COPY_SIDE } from '../../src/sim/edits';
import {
  createSelectTool, MAX_SELECTION_SIDE, SELECT_REACH, selectLabel, type SelectTool,
} from '../../src/ui/world/selectTool';

/** The key names as the page writes them: the action's first binding in the default map (`bindingLabel`). */
const keyName = (a: Action): string => bindingLabel(DEFAULT_KEYMAP.find((e) => e.action === a)!.bindings[0]!);

const c = (x: number, y: number, z: number) => ({ x, y, z });

/** A tool in `select` with both corners marked. */
function withCorners(a = c(0, 0, 0), b = c(2, 1, 3)): SelectTool {
  const t = createSelectTool();
  t.toggle();
  t.mark(0, a);
  t.mark(2, b);
  return t;
}

describe('the selection tool (SP5c spec §1.2, D1, D2)', () => {
  test('the constants: reach 32, at most 64 a side, equal to the copy\'s side', () => {
    expect(SELECT_REACH).toBe(32);
    expect(MAX_SELECTION_SIDE).toBe(64);
    expect(MAX_SELECTION_SIDE).toBe(MAX_COPY_SIDE);
  });

  test('a new tool is off with no corners, nothing placing', () => {
    const t = createSelectTool();
    expect(t.mode).toBe('off');
    expect(t.corner1).toBeNull();
    expect(t.corner2).toBeNull();
    expect(t.kind).toBeNull();
    expect(t.turns).toBe(0);
    expect(t.offset).toBe(0);
    expect(t.selection()).toBeNull();
  });

  test('Q: off → select, select → off, place → off (the paste cancelled)', () => {
    const t = createSelectTool();
    t.toggle();
    expect(t.mode).toBe('select');
    t.toggle();
    expect(t.mode).toBe('off');
    t.toggle();
    expect(t.place('paste')).toBe(true);
    t.turn(1);
    t.raise(1);
    t.toggle();
    expect(t.mode).toBe('off');
    expect(t.kind).toBeNull();
    expect(t.turns).toBe(0);
    expect(t.offset).toBe(0);
  });

  test('Q while moving: place → off, the move cancelled and the corners kept', () => {
    const t = withCorners();
    expect(t.place('move')).toBe(true);
    t.toggle();
    expect(t.mode).toBe('off');
    expect(t.kind).toBeNull();
    expect(t.corner1).toEqual(c(0, 0, 0));
    expect(t.corner2).toEqual(c(2, 1, 3));
  });

  test('Ctrl+V from off: place (paste), turns 0 and offset 0', () => {
    const t = createSelectTool();
    expect(t.place('paste')).toBe(true);
    expect(t.mode).toBe('place');
    expect(t.kind).toBe('paste');
    expect(t.turns).toBe(0);
    expect(t.offset).toBe(0);
  });

  test('Ctrl+V from select: place (paste), the corners kept', () => {
    const t = withCorners();
    expect(t.place('paste')).toBe(true);
    expect(t.mode).toBe('place');
    expect(t.kind).toBe('paste');
    expect(t.corner1).toEqual(c(0, 0, 0));
    expect(t.corner2).toEqual(c(2, 1, 3));
  });

  test('Ctrl+V while placing changes nothing', () => {
    const t = createSelectTool();
    t.place('paste');
    t.turn(1);
    t.raise(-1);
    const v = t.version;
    expect(t.place('paste')).toBe(false);
    expect(t.place('move')).toBe(false);
    expect(t.version).toBe(v);
    expect(t.kind).toBe('paste');
    expect(t.turns).toBe(1);
    expect(t.offset).toBe(-1);
  });

  test('N only from select with both corners: place (move)', () => {
    const off = createSelectTool();
    expect(off.place('move')).toBe(false);
    expect(off.mode).toBe('off');

    const none = createSelectTool();
    none.toggle();
    expect(none.place('move')).toBe(false);
    expect(none.mode).toBe('select');

    const one = createSelectTool();
    one.toggle();
    one.mark(0, c(1, 2, 3));
    expect(one.place('move')).toBe(false);
    expect(one.mode).toBe('select');

    const two = createSelectTool();
    two.toggle();
    two.mark(2, c(1, 2, 3));
    expect(two.place('move')).toBe(false);

    const both = withCorners();
    expect(both.place('move')).toBe(true);
    expect(both.mode).toBe('place');
    expect(both.kind).toBe('move');
    expect(both.turns).toBe(0);
    expect(both.offset).toBe(0);

    const offWithCorners = withCorners();
    offWithCorners.toggle();
    expect(offWithCorners.place('move')).toBe(false);
    expect(offWithCorners.mode).toBe('off');
  });

  test('in place: turn ±1 mod 4 (four turns back to 0; turnBack from 0 to 3)', () => {
    const t = createSelectTool();
    t.place('paste');
    t.turn(-1);
    expect(t.turns).toBe(3);
    t.turn(1);
    expect(t.turns).toBe(0);
    for (let i = 1; i <= 4; i++) {
      t.turn(1);
      expect(t.turns).toBe(i % 4);
    }
    expect(t.turns).toBe(0);
  });

  test('in place: raise ±1 on the offset, without a bound', () => {
    const t = createSelectTool();
    t.place('paste');
    t.raise(1);
    t.raise(1);
    expect(t.offset).toBe(2);
    for (let i = 0; i < 5; i++) t.raise(-1);
    expect(t.offset).toBe(-3);
  });

  test('turn and raise outside place change nothing', () => {
    const t = withCorners();
    const v = t.version;
    t.turn(1);
    t.raise(1);
    expect(t.turns).toBe(0);
    expect(t.offset).toBe(0);
    expect(t.version).toBe(v);
    t.toggle();
    const w = t.version;
    t.turn(-1);
    t.raise(-1);
    expect(t.version).toBe(w);
  });

  test('in place: LMB cancels → select (the paste\'s turns and offset gone, the corners kept)', () => {
    const t = withCorners();
    t.place('paste');
    t.turn(1);
    t.raise(1);
    t.raise(1);
    t.cancel();
    expect(t.mode).toBe('select');
    expect(t.kind).toBeNull();
    expect(t.turns).toBe(0);
    expect(t.offset).toBe(0);
    expect(t.corner1).toEqual(c(0, 0, 0));
    expect(t.corner2).toEqual(c(2, 1, 3));
  });

  test('in place: RMB pastes, then `placed(b)` → select with the corners at the target box', () => {
    const t = withCorners();
    t.place('paste');
    t.turn(1);
    t.raise(1);
    t.placed({ x0: 10, y0: 64, z0: -3, w: 4, h: 2, d: 5 });
    expect(t.mode).toBe('select');
    expect(t.kind).toBeNull();
    expect(t.turns).toBe(0);
    expect(t.offset).toBe(0);
  });

  test('`placed(b)` sets the corners to b\'s min and max', () => {
    const t = createSelectTool();
    t.place('move');
    t.place('paste');
    t.placed({ x0: 10, y0: 64, z0: -3, w: 4, h: 2, d: 5 });
    expect(t.corner1).toEqual(c(10, 64, -3));
    expect(t.corner2).toEqual(c(13, 65, 1));
    expect(t.selection()).toEqual({ x0: 10, y0: 64, z0: -3, w: 4, h: 2, d: 5 });
  });

  test('`placed(b)` from select re-marks the corners (L12b\'s house box, ruling P13)', () => {
    const t = withCorners();
    t.placed({ x0: -5, y0: 70, z0: 8, w: 1, h: 1, d: 1 });
    expect(t.mode).toBe('select');
    expect(t.corner1).toEqual(c(-5, 70, 8));
    expect(t.corner2).toEqual(c(-5, 70, 8));
  });

  test('in place: LMB and RMB do not mark corners (the page confirms or cancels)', () => {
    const t = withCorners();
    t.place('paste');
    const v = t.version;
    t.mark(0, c(9, 9, 9));
    t.mark(2, c(8, 8, 8));
    expect(t.corner1).toEqual(c(0, 0, 0));
    expect(t.corner2).toEqual(c(2, 1, 3));
    expect(t.mode).toBe('place');
    expect(t.version).toBe(v);
  });

  test('in select: LMB marks corner 1 and RMB corner 2 at the aimed voxel', () => {
    const t = createSelectTool();
    t.toggle();
    t.mark(0, c(10, 64, -3));
    expect(t.corner1).toEqual(c(10, 64, -3));
    expect(t.corner2).toBeNull();
    t.mark(2, c(12, 60, 0));
    expect(t.corner2).toEqual(c(12, 60, 0));
    t.mark(0, c(1, 2, 3));
    expect(t.corner1).toEqual(c(1, 2, 3));
    expect(t.corner2).toEqual(c(12, 60, 0));
  });

  test('a mark keeps its own copy of the hit (the caller may reuse its object)', () => {
    const t = createSelectTool();
    t.toggle();
    const hit = { x: 1, y: 2, z: 3 };
    t.mark(0, hit);
    hit.x = 99;
    expect(t.corner1).toEqual(c(1, 2, 3));
  });

  test('in select: a null hit (the sky, past 32 blocks) changes nothing', () => {
    const t = withCorners();
    const v = t.version;
    t.mark(0, null);
    t.mark(2, null);
    expect(t.corner1).toEqual(c(0, 0, 0));
    expect(t.corner2).toEqual(c(2, 1, 3));
    expect(t.version).toBe(v);
  });

  test('with the tool off, a mark changes nothing', () => {
    const t = createSelectTool();
    t.mark(0, c(1, 2, 3));
    expect(t.corner1).toBeNull();
    expect(t.version).toBe(0);
  });

  test('cancel outside place changes nothing', () => {
    const t = withCorners();
    const v = t.version;
    t.cancel();
    expect(t.mode).toBe('select');
    expect(t.version).toBe(v);
    t.toggle();
    const w = t.version;
    t.cancel();
    expect(t.mode).toBe('off');
    expect(t.version).toBe(w);
  });

  test('the corners survive off → select', () => {
    const t = withCorners(c(4, 5, 6), c(-1, -2, -3));
    t.toggle();
    expect(t.mode).toBe('off');
    expect(t.corner1).toEqual(c(4, 5, 6));
    expect(t.corner2).toEqual(c(-1, -2, -3));
    t.toggle();
    expect(t.mode).toBe('select');
    expect(t.corner1).toEqual(c(4, 5, 6));
    expect(t.corner2).toEqual(c(-1, -2, -3));
    expect(t.selection()).toEqual({ x0: -1, y0: -2, z0: -3, w: 6, h: 8, d: 10 });
  });

  test('`version` moves only on a change', () => {
    const t = createSelectTool();
    const seen: number[] = [t.version];
    const changed = (): void => {
      expect(t.version).toBeGreaterThan(seen[seen.length - 1]!);
      seen.push(t.version);
    };
    const same = (): void => expect(t.version).toBe(seen[seen.length - 1]);

    t.toggle(); changed();
    t.mark(0, c(1, 2, 3)); changed();
    t.mark(0, c(1, 2, 3)); same(); // the same corner again
    t.mark(0, null); same();
    t.mark(2, c(4, 5, 6)); changed();
    t.mark(2, c(4, 5, 6)); same();
    t.cancel(); same();
    t.turn(1); same();
    t.raise(1); same();
    expect(t.place('move')).toBe(true); changed();
    expect(t.place('paste')).toBe(false); same();
    t.turn(1); changed();
    t.turn(-1); changed();
    t.raise(-1); changed();
    t.mark(0, c(7, 7, 7)); same();
    t.cancel(); changed();
    t.place('paste'); changed();
    t.placed({ x0: 1, y0: 2, z0: 3, w: 4, h: 4, d: 4 }); changed();
    t.placed({ x0: 1, y0: 2, z0: 3, w: 4, h: 4, d: 4 }); same(); // already select with those corners
    t.toggle(); changed();
    t.cancel(); same();
    t.mark(0, c(0, 0, 0)); same();
  });

  test('`selection()` with corner 1 only (or corner 2 only) is the 1 × 1 × 1 box at it; with none, null', () => {
    const none = createSelectTool();
    none.toggle();
    expect(none.selection()).toBeNull();

    const one = createSelectTool();
    one.toggle();
    one.mark(0, c(10, 64, -3));
    expect(one.selection()).toEqual({ x0: 10, y0: 64, z0: -3, w: 1, h: 1, d: 1 });

    const two = createSelectTool();
    two.toggle();
    two.mark(2, c(-7, 0, 5));
    expect(two.selection()).toEqual({ x0: -7, y0: 0, z0: 5, w: 1, h: 1, d: 1 });
  });

  test('`selection()` with both corners is their box, whichever corner is the smaller', () => {
    const t = withCorners(c(5, 70, -2), c(3, 64, 1));
    expect(t.selection()).toEqual({ x0: 3, y0: 64, z0: -2, w: 3, h: 7, d: 4 });
  });

  test('`selection()` answers the same box until the corners change', () => {
    const t = withCorners();
    const a = t.selection();
    expect(t.selection()).toBe(a);
    t.mark(0, c(-1, 0, 0));
    expect(t.selection()).not.toBe(a);
    expect(t.selection()).toEqual({ x0: -1, y0: 0, z0: 0, w: 4, h: 2, d: 4 });
  });
});

describe('the label (SP5c spec §1.3, D3)', () => {
  test('the key names are the map\'s: Ctrl+C, Ctrl+X, N, Ctrl+V', () => {
    expect([keyName('copy'), keyName('cut'), keyName('move'), keyName('paste')]).toEqual(['Ctrl+C', 'Ctrl+X', 'N', 'Ctrl+V']);
  });

  test('the tool off: no label', () => {
    expect(selectLabel(createSelectTool(), keyName)).toBeNull();
    const t = withCorners();
    t.toggle();
    expect(selectLabel(t, keyName)).toBeNull();
  });

  test('no corner: the marking hint', () => {
    const t = createSelectTool();
    t.toggle();
    expect(selectLabel(t, keyName)).toBe('Selection tool: LMB marks corner 1, RMB corner 2');
  });

  test('one corner: `Corner 1 at 10, 64, -3: RMB marks corner 2`', () => {
    const t = createSelectTool();
    t.toggle();
    t.mark(0, c(10, 64, -3));
    expect(selectLabel(t, keyName)).toBe('Corner 1 at 10, 64, -3: RMB marks corner 2');
  });

  test('corner 2 only: `Corner 2 at x, y, z: LMB marks corner 1`', () => {
    const t = createSelectTool();
    t.toggle();
    t.mark(2, c(-4, 100, 7));
    expect(selectLabel(t, keyName)).toBe('Corner 2 at -4, 100, 7: LMB marks corner 1');
  });

  test('both corners: the sizes along x, y and z, the count and the keys', () => {
    const t = withCorners(c(0, 0, 0), c(2, 1, 3));
    expect(selectLabel(t, keyName)).toBe('Selection 3 × 2 × 4 (24 blocks) · Ctrl+C copy · Ctrl+X cut · N move · Ctrl+V paste');
  });

  test('64 a side: the count with a thousands separator', () => {
    const t = withCorners(c(0, 0, 0), c(63, 63, 63));
    expect(selectLabel(t, keyName)).toBe('Selection 64 × 64 × 64 (262,144 blocks) · Ctrl+C copy · Ctrl+X cut · N move · Ctrl+V paste');
  });

  test('65 on a side: the over-64 text', () => {
    expect(selectLabel(withCorners(c(0, 0, 0), c(64, 1, 1)), keyName)).toBe('Selection 65 × 2 × 2: at most 64 blocks on a side');
    expect(selectLabel(withCorners(c(0, 0, 0), c(0, 64, 0)), keyName)).toBe('Selection 1 × 65 × 1: at most 64 blocks on a side');
    expect(selectLabel(withCorners(c(0, 0, 0), c(9, 9, -64)), keyName)).toBe('Selection 10 × 10 × 65: at most 64 blocks on a side');
  });

  test('the key names come from the map given (SP10\'s remapping renames them)', () => {
    const remapped = (a: Action): string => (a === 'copy' ? 'K' : keyName(a));
    expect(selectLabel(withCorners(), remapped)).toBe('Selection 3 × 2 × 4 (24 blocks) · K copy · Ctrl+X cut · N move · Ctrl+V paste');
  });

  test('placing: no selection label (the placing label is the ghost\'s)', () => {
    const t = withCorners();
    t.place('paste');
    expect(selectLabel(t, keyName)).toBeNull();
  });
});

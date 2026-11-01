/**
 * The selection tool's model (SP5c spec §1.2, §1.3; D1-D3): every mode transition of §1.2 (Q, Ctrl+V, N, RMB, LMB,
 * turn, raise), the corners kept for the page's life, `placed(b)`, `version` moving only on a change, `selection()`
 * with zero, one and two corners, and the labels' texts with the key map's names and a thousands separator. The
 * ghost's anchor, its main-thread checks, the throttled target read and the placing labels (§2.5, D7, D11, D13).
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { SimFailed } from '../../src/engine/simClient';
import { bindingLabel, DEFAULT_KEYMAP, type Action } from '../../src/player/keymap';
import { MAX_COPY_SIDE } from '../../src/sim/edits';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';
import type { CopiedMsg } from '../../src/workers/protocol';
import { turnedSize } from '../../src/ui/world/clipboard';
import { boxChecks, refusalText, type Box } from '../../src/ui/world/pasteBatch';
import {
  anchorBox, createSelectTool, createTargetReader, MAX_SELECTION_SIDE, placingLabel, readRefusal, SELECT_REACH,
  selectLabel, TARGET_READ_SETTLE_MS, type GhostState, type SelectTool,
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

const FACES = [FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST, FACE_UP, FACE_DOWN] as const;
/** Each face's normal (`kinds.ts`: north −z, east +x, south +z, west −x, up +y, down −y). */
const NORMAL: Readonly<Record<number, readonly [number, number, number]>> = {
  [FACE_NORTH]: [0, 0, -1], [FACE_EAST]: [1, 0, 0], [FACE_SOUTH]: [0, 0, 1],
  [FACE_WEST]: [-1, 0, 0], [FACE_UP]: [0, 1, 0], [FACE_DOWN]: [0, -1, 0],
};
const SIDE = new Set<number>([FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST]);

/** §2.5's table, written out from the normal: the min corner for the turned sizes (W′, H, D′), then y + offset. */
function expectedMin(h: { x: number; y: number; z: number }, face: number, w: number, hh: number, d: number,
  offset: number): [number, number, number] {
  const [nx, ny, nz] = NORMAL[face]!;
  const a = [h.x + nx, h.y + ny, h.z + nz] as const;
  const fw = Math.floor(w / 2);
  const fd = Math.floor(d / 2);
  switch (face) {
    case FACE_UP: return [a[0] - fw, a[1] + offset, a[2] - fd];
    case FACE_DOWN: return [a[0] - fw, a[1] - hh + 1 + offset, a[2] - fd];
    case FACE_EAST: return [a[0], a[1] + offset, a[2] - fd];
    case FACE_WEST: return [a[0] - w + 1, a[1] + offset, a[2] - fd];
    case FACE_SOUTH: return [a[0] - fw, a[1] + offset, a[2]];
    default: return [a[0] - fw, a[1] + offset, a[2] - d + 1]; // north, −z
  }
}

describe('the ghost\'s anchor (SP5c spec §2.5, D7)', () => {
  const clip = { w: 5, h: 3, d: 7 };

  test('the anchor for each of the six faces, a 5 × 3 × 7 clipboard, turns 0-3 and offsets −2, 0, 3: the min corners of §2.5, and with offset 0 the box never covers the hit voxel (a side face\'s box never does at any offset)', () => {
    const out = new Int32Array(3);
    for (const h of [{ x: 10, y: 70, z: -20 }, { x: -1, y: -60, z: 0 }, { x: 524_000, y: 300, z: -524_000 }]) {
      for (const face of FACES) {
        for (let q = 0; q < 4; q++) {
          const t = turnedSize(clip, q);
          for (const offset of [-2, 0, 3]) {
            anchorBox({ ...h, face }, { w: t.w, h: clip.h, d: t.d }, offset, out);
            const want = expectedMin(h, face, t.w, clip.h, t.d, offset);
            expect([...out], `hit ${h.x},${h.y},${h.z} face ${face} q ${q} offset ${offset}`).toEqual(want);
            const covers = h.x >= out[0]! && h.x < out[0]! + t.w && h.y >= out[1]! && h.y < out[1]! + clip.h
              && h.z >= out[2]! && h.z < out[2]! + t.d;
            if (offset === 0 || SIDE.has(face)) expect(covers, `face ${face} q ${q} offset ${offset} covers the hit`).toBe(false);
          }
        }
      }
    }
  });

  test('a few corners written out: on top centred, hung under, against each side', () => {
    const out = new Int32Array(3);
    const at = (face: number, offset = 0, size = { w: 5, h: 3, d: 7 }): number[] => {
      anchorBox({ x: 10, y: 70, z: -20, face }, size, offset, out);
      return [...out];
    };
    expect(at(FACE_UP)).toEqual([8, 71, -23]);
    expect(at(FACE_DOWN)).toEqual([8, 67, -23]);
    expect(at(FACE_EAST)).toEqual([11, 70, -23]);
    expect(at(FACE_WEST)).toEqual([5, 70, -23]);
    expect(at(FACE_SOUTH)).toEqual([8, 70, -19]);
    expect(at(FACE_NORTH)).toEqual([8, 70, -27]);
    // Turned once: 7 × 3 × 5.
    expect(at(FACE_UP, 0, { w: 7, h: 3, d: 5 })).toEqual([7, 71, -22]);
    // Raised and lowered on a top face: +y with offset −2 starts at h.y − 1, so it covers the aimed block.
    expect(at(FACE_UP, -2)).toEqual([8, 69, -23]);
    expect(at(FACE_DOWN, 3)).toEqual([8, 70, -23]);
  });

  test('10,000 `anchorBox` calls grow the heap by less than 256 KB', () => {
    const out = new Int32Array(3);
    const hit = { x: 1234, y: 70, z: -987, face: FACE_UP };
    const size = { w: 64, h: 64, d: 64 };
    let i = 0;
    const call = (): void => {
      hit.face = FACES[i++ % 6]!;
      anchorBox(hit, size, 1, out);
    };
    for (let k = 0; k < 100_000; k++) call();
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
    const heapUsed = (): number => {
      let b = 0;
      for (const sp of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(sp.space_name)) b += sp.space_used_size;
      return b;
    };
    const readings: number[] = [];
    for (let t = 0; t < 3; t++) {
      gc();
      gc();
      const before = heapUsed();
      const profiler = new v8.GCProfiler();
      profiler.start();
      for (let k = 0; k < 10_000; k++) call();
      const after = heapUsed();
      const gcs = profiler.stop()?.statistics.length ?? 0;
      if (gcs > 0) continue;
      readings.push(after - before);
      if (after - before < 256 * 1024) break;
    }
    expect(readings.length, 'every attempt saw a GC').toBeGreaterThan(0);
    expect(readings[readings.length - 1]!, `heap growth over 10,000 calls (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
  });
});

/** Timers run by hand: `advance(ms)` runs every timer due, in order of their time. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; f: () => void }>();
  return {
    set(f: () => void, ms: number): number {
      const id = next++;
      due.set(id, { at: now + ms, f });
      return id;
    },
    clear(id: number): void { due.delete(id); },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let id = -1;
        let at = Infinity;
        for (const [k, t] of due) if (t.at <= end && t.at < at) { id = k; at = t.at; }
        if (id < 0) break;
        const t = due.get(id)!;
        due.delete(id);
        now = t.at;
        t.f();
      }
      now = end;
    },
    get pending(): number { return due.size; },
  };
}

const box = (x0: number, y0 = 70, z0 = 0, w = 5, h = 3, d = 7): Box => ({ x0, y0, z0, w, h, d });
const copied = (values: Uint32Array | null, why: CopiedMsg['why'] = null): CopiedMsg =>
  ({ type: 'copied', id: 1, values, generated: null, why });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A target reader over manual timers and a `copy` whose replies the test resolves by hand. */
function readerHarness() {
  const timers = manualTimers();
  const posted: Box[] = [];
  const replies: { resolve(m: CopiedMsg): void; reject(e: unknown): void }[] = [];
  const reads: Box[] = [];
  const reader = createTargetReader({
    timers,
    copy(b) {
      posted.push(b);
      return new Promise<CopiedMsg>((resolve, reject) => { replies.push({ resolve, reject }); });
    },
    onRead(b) { reads.push(b); },
  });
  return { timers, posted, replies, reads, reader };
}

describe('the main-thread checks before any `copy` (SP5c spec §2.5, §2.7, D13)', () => {
  /** The page's step at an anchor change: `boxChecks`, then the reader moved to the box or to null when refused. */
  function step(h: ReturnType<typeof readerHarness>, b: Box, editState: (cx: number, cz: number) => 0 | 1 | 2 = () => 0): string | null {
    const r = boxChecks(b, editState);
    h.reader.moved(r === null ? b : null);
    return r === null ? null : refusalText(r);
  }

  test('a ghost whose top is at y 319 raised once: `it would leave the world (y −64 … 319)`, `moved(null)`, no `copy`', () => {
    const h = readerHarness();
    const t = createSelectTool();
    t.place('paste');
    const out = new Int32Array(3);
    const at = (): Box => {
      anchorBox({ x: 0, y: 316, z: 0, face: FACE_UP }, { w: 5, h: 3, d: 7 }, t.offset, out);
      return box(out[0]!, out[1]!, out[2]!);
    };
    const first = at();
    expect(first.y0 + first.h - 1).toBe(319);
    expect(step(h, first)).toBeNull();
    h.timers.advance(50);
    t.raise(1);
    expect(step(h, at())).toBe('it would leave the world (y −64 … 319)');
    h.timers.advance(200);
    expect(h.posted).toEqual([]);
    expect(h.timers.pending).toBe(0);
  });

  test('a box reaching x = 524,288: `it would cross the world\'s edge`, no `copy`', () => {
    const h = readerHarness();
    const out = new Int32Array(3);
    anchorBox({ x: 524_287, y: 70, z: 0, face: FACE_UP }, { w: 5, h: 3, d: 7 }, 0, out);
    const b = box(out[0]!, out[1]!, out[2]!);
    expect(b.x0 + b.w).toBeGreaterThan(524_288);
    expect(step(h, b)).toBe('it would cross the world\'s edge');
    h.timers.advance(200);
    expect(h.posted).toEqual([]);
  });

  test('a box whose 3 × 3 is not loaded: `part of it is not loaded`, no `copy`', () => {
    const h = readerHarness();
    // Column (1, 0)'s 3 × 3 is not loaded (its editState is 1); the box covers columns 0-1 along x.
    const es = (cx: number, cz: number): 0 | 1 | 2 => (cx === 1 && cz === 0 ? 1 : 0);
    expect(step(h, box(12, 70, 2), es)).toBe('part of it is not loaded');
    h.timers.advance(200);
    expect(h.posted).toEqual([]);
    // The same box once loaded is read after 100 ms.
    expect(step(h, box(12, 70, 2))).toBeNull();
    h.timers.advance(TARGET_READ_SETTLE_MS);
    expect(h.posted).toEqual([box(12, 70, 2)]);
  });
});

describe('the throttled target read (SP5c spec §2.5, D7)', () => {
  test('the settle is 100 ms', () => {
    expect(TARGET_READ_SETTLE_MS).toBe(100);
  });

  test('the target read is posted only after 100 ms still (injected timers)', async () => {
    const h = readerHarness();
    h.reader.moved(box(0));
    h.timers.advance(99);
    expect(h.posted).toEqual([]);
    h.timers.advance(1);
    expect(h.posted).toEqual([box(0)]);
    h.replies[0]!.resolve(copied(new Uint32Array(105)));
    await flush();
    expect(h.reads).toEqual([box(0)]);
    // Still: nothing more is read.
    h.timers.advance(1_000);
    expect(h.posted.length).toBe(1);
  });

  test('a box moved every 50 ms for 2 s posts none; the last is read 100 ms after it rests', () => {
    const h = readerHarness();
    for (let i = 0; i < 40; i++) {
      h.reader.moved(box(i));
      h.timers.advance(50);
    }
    expect(h.posted).toEqual([]);
    h.timers.advance(50);
    expect(h.posted).toEqual([box(39)]);
  });

  test('with one in flight and one queued, a third box replaces the queued one; the stale reply is dropped', async () => {
    const h = readerHarness();
    h.reader.moved(box(1));
    h.timers.advance(100);
    expect(h.posted).toEqual([box(1)]);
    h.reader.moved(box(2));
    h.timers.advance(100);
    // One in flight: box 2 waits as the queued one.
    expect(h.posted).toEqual([box(1)]);
    h.reader.moved(box(3));
    h.timers.advance(100);
    expect(h.posted).toEqual([box(1)]);
    h.replies[0]!.resolve(copied(new Uint32Array(105)));
    await flush();
    // Box 1's reply is stale (dropped); the queued box 3 is posted, never box 2.
    expect(h.reads).toEqual([]);
    expect(h.posted).toEqual([box(1), box(3)]);
    h.replies[1]!.resolve(copied(new Uint32Array(105)));
    await flush();
    expect(h.reads).toEqual([box(3)]);
  });

  test('a reply for a stale box is dropped; the new box is read at its own settle', async () => {
    const h = readerHarness();
    h.reader.moved(box(1));
    h.timers.advance(100);
    h.reader.moved(box(2));
    h.replies[0]!.resolve(copied(new Uint32Array(105)));
    await flush();
    expect(h.reads).toEqual([]);
    expect(h.posted).toEqual([box(1)]);
    h.timers.advance(100);
    expect(h.posted).toEqual([box(1), box(2)]);
  });

  test('`moved(null)` cancels the settle and drops the in-flight reply, even when the same box comes back', async () => {
    const h = readerHarness();
    h.reader.moved(box(1));
    h.timers.advance(50);
    h.reader.moved(null);
    h.timers.advance(200);
    expect(h.posted).toEqual([]);
    h.reader.moved(box(1));
    h.timers.advance(100);
    expect(h.posted).toEqual([box(1)]);
    h.reader.moved(null);
    h.reader.moved(box(1));
    h.timers.advance(100);
    h.replies[0]!.resolve(copied(new Uint32Array(105)));
    await flush();
    // The reply posted before the `moved(null)` is dropped; the box read again after it is posted then.
    expect(h.reads).toEqual([]);
    expect(h.posted).toEqual([box(1), box(1)]);
    h.replies[1]!.resolve(copied(new Uint32Array(105)));
    await flush();
    expect(h.reads).toEqual([box(1)]);
  });

  test('a `copy` rejected with SimFailed is dropped: no `onRead`, nothing queued posted, no unhandled rejection (ruling P2)', async () => {
    const h = readerHarness();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      h.reader.moved(box(1));
      h.timers.advance(100);
      h.reader.moved(box(2));
      h.timers.advance(100);
      h.replies[0]!.reject(new SimFailed('the sim is gone'));
      await flush();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.reads).toEqual([]);
      expect(h.posted).toEqual([box(1)]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('after `dispose`, a pending settle posts no `copy` and an in-flight reply reaches nobody', async () => {
    const h = readerHarness();
    h.reader.moved(box(1));
    h.timers.advance(100);
    h.reader.moved(box(2));
    h.reader.dispose();
    expect(h.timers.pending).toBe(0);
    h.timers.advance(200);
    h.replies[0]!.resolve(copied(new Uint32Array(105)));
    await flush();
    expect(h.reads).toEqual([]);
    expect(h.posted).toEqual([box(1)]);
    h.reader.moved(box(3));
    h.timers.advance(200);
    expect(h.posted).toEqual([box(1)]);
  });

  test('`readRefusal`: a `copied` with `why` `\'unloaded\'` gives `part of it is not loaded`; one with values, null', () => {
    const r = readRefusal(copied(null, 'unloaded'));
    expect(r).not.toBeNull();
    expect(refusalText(r!)).toBe('part of it is not loaded');
    expect(readRefusal(copied(new Uint32Array(105)))).toBeNull();
  });
});

describe('the placing label (SP5c spec §2.5, D11)', () => {
  const size = { w: 5, h: 3, d: 7 };
  const ghost = (counts: GhostState['counts'] = null, refusal: GhostState['refusal'] = null): GhostState =>
    ({ box: box(0), refusal, counts });
  const placing = (kind: 'paste' | 'move' = 'paste', turns = 0): SelectTool => {
    const t = kind === 'move' ? withCorners() : createSelectTool();
    t.place(kind);
    for (let i = 0; i < turns; i++) t.turn(1);
    return t;
  };
  const TAIL = ' · RMB pastes, LMB cancels · Wheel turns · ↑ ↓ raise or lower';

  test('the default map\'s turn keys are the plain wheel\'s two directions', () => {
    expect([keyName('turn'), keyName('turnBack')]).toEqual(['Wheel down', 'Wheel up']);
  });

  test('`counting…` until a read; with the default map it ends `· RMB pastes, LMB cancels · Wheel turns · ↑ ↓ raise or lower`', () => {
    expect(placingLabel(placing(), size, ghost(), keyName, false)).toBe(`Paste 5 × 3 × 7 · counting…${TAIL}`);
  });

  test('`turned 90°`, 180° and 270°', () => {
    expect(placingLabel(placing('paste', 1), size, ghost(), keyName, false)).toBe(`Paste 5 × 3 × 7 · turned 90° · counting…${TAIL}`);
    expect(placingLabel(placing('paste', 2), size, ghost(), keyName, false)).toBe(`Paste 5 × 3 × 7 · turned 180° · counting…${TAIL}`);
    expect(placingLabel(placing('paste', 3), size, ghost(), keyName, false)).toBe(`Paste 5 × 3 × 7 · turned 270° · counting…${TAIL}`);
  });

  test('the counts with a thousands separator: `12,345 blocks change, 40 replaced`', () => {
    expect(placingLabel(placing(), size, ghost({ n: 12_345, m: 40 }), keyName, false))
      .toBe(`Paste 5 × 3 × 7 · 12,345 blocks change, 40 replaced${TAIL}`);
  });

  test('a refusal\'s text replaces the counts', () => {
    expect(placingLabel(placing(), size, ghost({ n: 3, m: 1 }, { why: 'outsideY' }), keyName, false))
      .toBe(`Paste 5 × 3 × 7 · it would leave the world (y −64 … 319)${TAIL}`);
    expect(placingLabel(placing(), size, ghost(null, { why: 'unloaded' }), keyName, false))
      .toBe(`Paste 5 × 3 × 7 · part of it is not loaded${TAIL}`);
  });

  test('the move\'s: `Move …`, RMB moves', () => {
    expect(placingLabel(placing('move', 1), size, ghost({ n: 1_000, m: 0 }), keyName, false))
      .toBe('Move 5 × 3 × 7 · turned 90° · 1,000 blocks change, 0 replaced · RMB moves, LMB cancels · Wheel turns · ↑ ↓ raise or lower');
  });

  test('`no preview: too many faces` appended', () => {
    expect(placingLabel(placing(), size, ghost({ n: 5, m: 2 }), keyName, true))
      .toBe(`Paste 5 × 3 × 7 · 5 blocks change, 2 replaced${TAIL} · no preview: too many faces`);
  });

  test('with `turn` remapped to a key: its name and `turnBack`\'s', () => {
    const remapped = (a: Action): string => (a === 'turn' ? 'R' : keyName(a));
    expect(placingLabel(placing(), size, ghost(), remapped, false))
      .toBe('Paste 5 × 3 × 7 · counting… · RMB pastes, LMB cancels · R / Wheel up turn · ↑ ↓ raise or lower');
    const both = (a: Action): string => (a === 'turn' ? 'R' : a === 'turnBack' ? 'F' : keyName(a));
    expect(placingLabel(placing(), size, ghost(), both, false))
      .toBe('Paste 5 × 3 × 7 · counting… · RMB pastes, LMB cancels · R / F turn · ↑ ↓ raise or lower');
    const ctrlWheel = (a: Action): string => (a === 'turn' ? 'Ctrl+Wheel down' : a === 'turnBack' ? 'Ctrl+Wheel up' : keyName(a));
    expect(placingLabel(placing(), size, ghost(), ctrlWheel, false))
      .toBe('Paste 5 × 3 × 7 · counting… · RMB pastes, LMB cancels · Ctrl+Wheel down / Ctrl+Wheel up turn · ↑ ↓ raise or lower');
  });
});

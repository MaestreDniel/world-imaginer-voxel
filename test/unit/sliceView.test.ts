/**
 * The slice viewer's DOM rules, extracted as pure helpers of `sliceModel.ts` (SP3d spec §4.3, §3.6, §3.7, §4.5; the DOM is
 * `sliceView.ts` and the page wiring `mapPage.ts`): the pointer offset → sample `⌊(px / side) · n⌋` in a square box whose
 * side is the smaller of its cell's width and height (at least 128 px), the slice hover readout (the sample's voxel and
 * the shown field's value, from the slice buffer), the map hover's voxel at the y control, the horizontal centre and
 * extent changes (clamped into the window) and the y control, the map's square overlay, the field select's label of
 * `selected`, the status line, the form's hover line, and the params of the draft the pool's resolved configure holds.
 */
import { describe, expect, test } from 'vitest';
import { WINDOW_HALF } from '../../src/core/coords';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import type { FieldSliceResult } from '../../src/engine/workerPool';
import { sliceSampleVoxel, type SliceGeometry } from '../../src/gen/inspect/fieldSlice';
import type { Segment } from '../../src/metrics/crossSection';
import type { Selection } from '../../src/ui/inspector/model';
import {
  createDraftLog, fieldOptionLabel, formatSliceValue, hoverLineText, initialSliceState, mapHoverVoxel, parseSliceY, pixelVoxel,
  pointerPixel, RULE_NA, SLICE_BOX_MIN_PX, sliceBoxSide, sliceGeometryOf, sliceHoverText, slicePixel, sliceSquare, sliceStatusText, withCentre,
  slicePointer, withExtent, type SliceShown, type SliceState,
} from '../../src/ui/inspector/sliceModel';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, REGISTRY, STONE } from '../../src/world/blocks/index';

const W = WINDOW_HALF;
const LINE: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const HORIZONTAL: SliceState = { plane: 'horizontal', field: 'density', y: 63, extent: 256, cx: 100, cz: -40 };
const VERTICAL: SliceState = { ...HORIZONTAL, plane: 'vertical' };
const DENSITY_SEL: Selection = { leaf: 'density.defs', path: 'root.b.x' };
const RULE_SEL: Selection = { leaf: 'surface.rules', path: 'root.rules[1]' };

const geometryOf = (s: SliceState, line: Segment | null, n: number): SliceGeometry => {
  const g = sliceGeometryOf(s, line, n);
  if (!g.ok) throw new Error(g.problem);
  return g.geometry;
};
const shownOf = (geometry: SliceGeometry, result: FieldSliceResult, sessionEpoch = 3, key = 'k'): SliceShown => ({ sessionEpoch, key, geometry, result });
const ramp = (n: number): Float64Array<ArrayBuffer> => Float64Array.from({ length: n * n }, (_, i) => i / 8 - 7);

describe('pointer → sample (§4.3: ⌊(px / side) · n⌋ inside the box, null outside)', () => {
  test('a 256 px box showing 128 samples', () => {
    expect([0, 1.999, 2, 3.5, 128, 255.99].map((px) => slicePixel(px, 256, 128))).toEqual([0, 0, 1, 1, 64, 127]);
    for (const px of [-0.001, 256, 300, Number.NaN, Infinity]) expect(slicePixel(px, 256, 128), String(px)).toBeNull();
    expect(slicePixel(10, 0, 128)).toBeNull();
    expect(slicePixel(10, Number.NaN, 128)).toBeNull();
    // nothing drawn yet (n = 0): no pixel, not -1 (a pin box hovered before its first draft lands)
    expect(slicePixel(10, 256, 0)).toBeNull();
  });

  test('the pointer is kept as fractions of the box, so a slice of another size reads the sample under it', () => {
    // SP3d final review (Task 26 M1 / Task 27): the indices of the last move named another voxel once a 128² slice
    // replaced the 32² draft under a still pointer (the readout at (−616, 63, −616) for a pointer over (616, 63, 616)).
    const at = slicePointer(320, 240, 400, 300);
    expect(at).toEqual({ fx: 0.8, fy: 0.8 });
    expect(pointerPixel(at, 32)).toEqual({ px: 25, py: 25 });
    expect(pointerPixel(at, 128)).toEqual({ px: 102, py: 102 });
    // The same pixel as slicePixel on the box's own size, for every offset and size.
    for (const n of [32, 128]) {
      for (let x = 0; x < 400; x += 0.75) {
        expect(pointerPixel(slicePointer(x, 0, 400, 300), n)?.px).toBe(slicePixel(x, 400, n));
      }
    }
    for (const [x, y] of [[-1, 10], [400, 10], [10, 300], [Number.NaN, 0]] as const) expect(slicePointer(x, y, 400, 300)).toBeNull();
    expect(slicePointer(10, 10, 0, 300)).toBeNull();
    expect(pointerPixel(null, 128)).toBeNull();
    expect(pointerPixel(at, 0)).toBeNull(); // nothing drawn yet
  });

  test('a 200 px box showing a 32² draft: every offset gives ⌊(px / side) · n⌋ and every sample is reached', () => {
    const seen = new Set<number>();
    for (let px = 0; px < 200; px += 0.25) {
      const s = slicePixel(px, 200, 32);
      expect(s).toBe(Math.floor((px / 200) * 32));
      seen.add(s!);
    }
    expect(seen.size).toBe(32);
    expect(slicePixel(199.9999, 200, 32)).toBe(31);
  });

  test('composed with pixelVoxel, the pointer names the voxel that was evaluated', () => {
    const g = geometryOf(HORIZONTAL, null, 128);
    // The box's centre: sample (64, 64), the block just east and south of the centre (x_i = cx − E/2 + ⌊(2i + 1)E / 2n⌋).
    const px = slicePixel(150, 300, 128)!;
    const py = slicePixel(150, 300, 128)!;
    expect([px, py]).toEqual([64, 64]);
    expect(pixelVoxel(g, px, py)).toEqual([100 - 128 + 129, 63, -40 - 128 + 129]);
    // The top-left corner pixel is the north-west sample.
    expect(pixelVoxel(g, slicePixel(0, 300, 128)!, slicePixel(0.5, 300, 128)!)).toEqual([100 - 128 + 1, 63, -40 - 128 + 1]);
  });
});

describe('the slice box (§4.3: the smaller of its cell\'s width and height, at least 128 px)', () => {
  test('sides', () => {
    expect(SLICE_BOX_MIN_PX).toBe(128);
    expect(sliceBoxSide(300, 200)).toBe(200);
    expect(sliceBoxSide(200.7, 512)).toBe(200);
    expect(sliceBoxSide(100, 400)).toBe(128);
    expect(sliceBoxSide(0, 0)).toBe(128);
    expect(sliceBoxSide(Number.NaN, 300)).toBe(128);
  });
});

describe('the slice hover readout (§3.6: the sample\'s voxel and the shown field\'s value, from the slice buffer)', () => {
  test('horizontal density: sample column = row z, sample = column x', () => {
    const n = 32;
    const g = geometryOf(HORIZONTAL, null, n);
    const values = ramp(n);
    const shown = shownOf(g, { field: 'density', values, fluid: null, n });
    const h = sliceHoverText(shown, 5, 9);
    const [x, y, z] = sliceSampleVoxel(g, 9, 5);
    expect(h.voxel).toEqual({ x, y, z });
    expect(y).toBe(63);
    expect(h.text).toBe(`(${x}, 63, ${z}) · density ${formatSliceValue(values[9 * n + 5]!)}`);
  });

  test('vertical node: sample column = pixel column (A on the left), sample = row (y 319 at the top); non-finite values', () => {
    const n = 32;
    const g = geometryOf(VERTICAL, LINE, n);
    const values = ramp(n);
    values[3 * n + 0] = Number.NaN;
    const shown = shownOf(g, { field: 'node', values, fluid: null, n });
    const h = sliceHoverText(shown, 3, 7);
    const [x, y, z] = sliceSampleVoxel(g, 3, 7);
    expect(h.voxel).toEqual({ x, y, z });
    expect(h.text).toBe(`(${x}, ${y}, ${z}) · node ${formatSliceValue(values[3 * n + 7]!)}`);
    expect(sliceHoverText(shown, 3, 0).text).toMatch(/· node NaN$/);
    expect(sliceHoverText(shown, 0, 0).voxel.y).toBe(313);
  });

  test('blocks name the state, or water; a rule mask reads yes, no or n/a', () => {
    const n = 32;
    const g = geometryOf(VERTICAL, LINE, n);
    const states = new Uint16Array(n * n).fill(STONE);
    const fluid = new Uint8Array(n * n);
    states[1 * n + 2] = AIR;
    fluid[1 * n + 2] = WATER_SOURCE;
    states[1 * n + 3] = AIR;
    const blocks = shownOf(g, { field: 'blocks', values: states, fluid, n });
    expect(sliceHoverText(blocks, 0, 0).text).toMatch(new RegExp(`· blocks ${REGISTRY.stateKey(STONE)}$`));
    expect(sliceHoverText(blocks, 1, 2).text).toMatch(/· blocks water$/);
    expect(sliceHoverText(blocks, 1, 3).text).toMatch(new RegExp(`· blocks ${REGISTRY.stateKey(AIR)}$`));
    const mask = new Uint8Array(n * n);
    mask[0] = 1;
    mask[1] = RULE_NA;
    const rule = shownOf(g, { field: 'rule', values: mask, fluid: null, n });
    expect([0, 1, 2].map((py) => sliceHoverText(rule, 0, py).text.split(' · ')[1])).toEqual(['rule yes', 'rule n/a', 'rule no']);
  });

  test('outside the slice\'s size it throws (the pointer helper never gives such a pixel)', () => {
    const g = geometryOf(HORIZONTAL, null, 32);
    const shown = shownOf(g, { field: 'density', values: ramp(32), fluid: null, n: 32 });
    expect(() => sliceHoverText(shown, 32, 0)).toThrow(RangeError);
  });
});

describe('the map hover\'s voxel while Density is shown (§3.6: the hovered block at the y control)', () => {
  test('floored block, the y control, null outside the half-open world window', () => {
    expect(mapHoverVoxel(10.7, -3.2, 63)).toEqual({ x: 10, y: 63, z: -4 });
    expect(mapHoverVoxel(-0.5, 0.5, -64)).toEqual({ x: -1, y: -64, z: 0 });
    expect(mapHoverVoxel(W - 0.5, -W, 319)).toEqual({ x: W - 1, y: 319, z: -W });
    expect(mapHoverVoxel(W, 0, 63)).toBeNull();
    expect(mapHoverVoxel(0, -W - 0.01, 63)).toBeNull();
    expect(mapHoverVoxel(Number.NaN, 0, 63)).toBeNull();
  });
});

describe('the plane controls (§4.2, §3.7)', () => {
  test('a map click sets the horizontal centre, floored and clamped into the window', () => {
    expect(withCentre(HORIZONTAL, 12.9, -7.1)).toEqual({ ...HORIZONTAL, cx: 12, cz: -8 });
    expect(withCentre(HORIZONTAL, W + 5, -W - 5)).toEqual({ ...HORIZONTAL, cx: W - 128, cz: -W + 128 });
    expect(withCentre(VERTICAL, 3, 4)).toEqual({ ...VERTICAL, cx: 3, cz: 4 });
  });

  test('an extent change keeps the centre where it fits and clamps it otherwise', () => {
    expect(withExtent(HORIZONTAL, 8192)).toEqual({ ...HORIZONTAL, extent: 8192 });
    const edge = { ...HORIZONTAL, cx: W - 1024, cz: -W + 1024, extent: 2048 };
    expect(withExtent(edge, 8192)).toEqual({ ...edge, extent: 8192, cx: W - 4096, cz: -W + 4096 });
    expect(() => withExtent(HORIZONTAL, 300)).toThrow(RangeError);
  });

  test('the y control takes an integer in −64 … 319', () => {
    expect(['63', ' -64 ', '319', '0'].map(parseSliceY)).toEqual([63, -64, 319, 0]);
    for (const t of ['320', '-65', '1.5', '', 'abc', '1e2x', 'Infinity']) expect(parseSliceY(t), t).toBeNull();
  });

  test('the square overlay is the horizontal plane\'s (blocks [cx − E/2, cx + E/2)), none on the vertical plane', () => {
    expect(sliceSquare(HORIZONTAL)).toEqual({ cx: 100, cz: -40, extent: 256 });
    expect(sliceSquare(VERTICAL)).toBeNull();
    expect(sliceSquare(null)).toBeNull();
    const first = initialSliceState({ line: null, viewCentre: [0.5, 0.5], pin: [33.3, -9.9] });
    expect(sliceSquare(first)).toEqual({ cx: 33, cz: -10, extent: 2048 });
  });

  test('the field select names the selected node', () => {
    expect(fieldOptionLabel('selected', DENSITY_SEL)).toBe('selected (root.b.x)');
    expect(fieldOptionLabel('selected', RULE_SEL)).toBe('selected (root.rules[1])');
    expect(fieldOptionLabel('density', DENSITY_SEL)).toBe('density');
    expect(fieldOptionLabel('blocks', RULE_SEL)).toBe('blocks');
  });
});

describe('the status line and the form\'s hover line', () => {
  test('status: the stage in flight, else stale or the shown size', () => {
    const g = geometryOf(HORIZONTAL, null, 32);
    const shown = shownOf(g, { field: 'density', values: ramp(32), fluid: null, n: 32 }, 3, 'k');
    expect(sliceStatusText({ key: null, shown: null, pending: null }, 3)).toBe('');
    expect(sliceStatusText({ key: 'k', shown: null, pending: { sessionEpoch: 3, key: 'k', n: 32 } }, 3)).toBe('slicing 32² …');
    expect(sliceStatusText({ key: 'k', shown, pending: { sessionEpoch: 3, key: 'k', n: 128 } }, 3)).toBe('32² · slicing 128² …');
    expect(sliceStatusText({ key: 'k', shown, pending: null }, 3)).toBe('32²');
    expect(sliceStatusText({ key: 'k', shown, pending: null }, 4)).toBe('stale');
    expect(sliceStatusText({ key: 'other', shown, pending: { sessionEpoch: 3, key: 'other', n: 32 } }, 3)).toBe('stale · slicing 32² …');
  });

  test('hover line: the value (and a rule node\'s rule suffix) at the voxel; nothing without a voxel or a value', () => {
    expect(hoverLineText({ x: 1, y: 63, z: -2 }, '0.5', '')).toBe('0.5 at (1, 63, -2)');
    expect(hoverLineText({ x: 1, y: 63, z: -2 }, 'yes', ' · rule root.rules[1].then')).toBe('yes · rule root.rules[1].then at (1, 63, -2)');
    expect(hoverLineText(null, '0.5', '')).toBeNull();
    expect(hoverLineText({ x: 1, y: 63, z: -2 }, '', '')).toBeNull();
  });
});

describe('the draft the pool\'s resolved configure holds (§4.5: requests run on it, its params cost the slice)', () => {
  test('params by session epoch; null before a configure or for an unknown draft; older drafts are dropped', () => {
    const log = createDraftLog();
    const p1: Params = { ...DEFAULTS };
    const p2: Params = { ...DEFAULTS };
    log.remember(1, p1, null);
    log.remember(2, p2, null);
    expect(log.configured({ poolEpoch: null, sessionEpoch: null })).toBeNull();
    const c1 = log.configured({ poolEpoch: 4, sessionEpoch: 1 });
    expect(c1).toEqual({ poolEpoch: 4, sessionEpoch: 1, params: p1 });
    expect(c1!.params).toBe(p1);
    expect(log.configured({ poolEpoch: 5, sessionEpoch: 2 })!.params).toBe(p2);
    // Configures resolve in session order: the drafts before the one configured are never configured again.
    expect(log.configured({ poolEpoch: 4, sessionEpoch: 1 })).toBeNull();
    expect(log.configured({ poolEpoch: 6, sessionEpoch: 7 })).toBeNull();
    expect(log.size).toBe(1);
  });

  test('remember drops the drafts below the resolved one, so a page that never shows Density keeps only the in-flight drafts', () => {
    // SP3d final review (Task 26 M2): configured() runs only while the slice view requests; every session change remembers.
    const log = createDraftLog();
    const p: Params = { ...DEFAULTS };
    log.remember(0, p, null);
    for (let e = 1; e <= 500; e++) log.remember(e, p, e - 3); // a slider gesture: the pool resolves 3 drafts behind
    expect(log.size).toBe(4); // epochs 497 (resolved) … 500
    expect(log.configured({ poolEpoch: 9, sessionEpoch: 497 })!.params).toBe(p);
    expect(log.configured({ poolEpoch: 9, sessionEpoch: 496 })).toBeNull();
    // The resolved draft itself is kept (its params cost the slice); null (no configure yet) prunes nothing.
    const fresh = createDraftLog();
    fresh.remember(1, p, null);
    fresh.remember(2, p, null);
    fresh.remember(3, p, 2);
    expect(fresh.size).toBe(2);
    expect(fresh.configured({ poolEpoch: 1, sessionEpoch: 2 })!.params).toBe(p);
  });
});

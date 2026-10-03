import { describe, expect, test } from 'vitest';
import { SEA_LEVEL } from '../../src/core/constants';
import { JobCancelled, type SliceResult, type WorkerPool } from '../../src/engine/workerPool';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { genRegionInProcess } from '../../src/metrics/region';
import { createSliceRequests, sectionStatus, SECTION_MODES } from '../../src/ui/crossSection/model';
import {
  blockName, fluidText, sliceRgba, sliceSummary, SEA_LEVEL_Y, VOXEL_COLORS, voxelCell, voxelPlots, voxelReadout, voxelRgb,
} from '../../src/ui/crossSection/voxels';
import { toPx } from '../../src/ui/splineEditor/model';
import { FLUID_LAVA, FLUID_WATER, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { SLICE_POINTS, SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
import { createSliceJob } from '../../src/workers/sliceJob';
import * as png from '../harness/png';
import { ctxFor } from '../harness/gen';
import { regionView } from '../harness/region';

const MiB = 1 << 20;

/** An empty slice (air, no fluid) and a writer of one sample column: `fill(i, y)` gives [state, fluid] for y −64 … 319. */
function slice(columns: Record<number, (y: number) => readonly [number, number]> = {}): SliceResult {
  const blocks = new Uint16Array(SLICE_SAMPLES);
  const fluid = new Uint8Array(SLICE_SAMPLES);
  for (const [k, f] of Object.entries(columns)) {
    for (let y = -64; y <= 319; y++) {
      const [s, b] = f(y);
      blocks[sliceIndex(Number(k), y)] = s;
      fluid[sliceIndex(Number(k), y)] = b;
    }
  }
  return { blocks, fluid };
}
/** Bedrock at −64, stone up to `top`, water sources up to `water`, air above. */
const ground = (top: number, water = -Infinity) => (y: number): readonly [number, number] =>
  y === -64 ? [BEDROCK, 0] : y <= top ? [STONE, 0] : y <= water ? [AIR, WATER_SOURCE] : [AIR, 0];
const pixel = (rgba: Uint8ClampedArray, i: number, y: number): number[] => Array.from(rgba.subarray(4 * sliceIndex(i, y), 4 * sliceIndex(i, y) + 4));
const opaque = (c: readonly [number, number, number]): number[] => [...c, 255];

describe('the Voxels palette (SP3a spec §5.2)', () => {
  test('one palette: the harness PNG slices use the cut line\'s colours', () => {
    expect(png.VOXEL_COLORS).toBe(VOXEL_COLORS);
    expect(png.voxelRgb).toBe(voxelRgb);
    expect(SEA_LEVEL_Y).toBe(SEA_LEVEL);
  });
  test('air sky, stone grey, bedrock near black, an unknown state magenta; a fluid on a block keeps the block\'s colour', () => {
    expect(voxelRgb(AIR, 0, 0)).toEqual(VOXEL_COLORS.sky);
    expect(voxelRgb(STONE, 0, 0)).toEqual(VOXEL_COLORS.stone);
    expect(voxelRgb(BEDROCK, 0, 0)).toEqual(VOXEL_COLORS.bedrock);
    expect(voxelRgb(STONE, WATER_SOURCE, 3)).toEqual(VOXEL_COLORS.stone);
    expect(voxelRgb(7, 0, 0)).toEqual(VOXEL_COLORS.unknown);
    const [r, g, b] = VOXEL_COLORS.stone;
    expect(r === g && g === b).toBe(true);
    expect(Math.max(...VOXEL_COLORS.bedrock)).toBeLessThan(40);
  });
  test('water is blue and darkens by 1/48 per block below its surface, down to 30 %', () => {
    const [r, g, b] = VOXEL_COLORS.water;
    expect(b).toBeGreaterThan(Math.max(r, g));
    expect(voxelRgb(AIR, WATER_SOURCE, 0)).toEqual(VOXEL_COLORS.water);
    expect(voxelRgb(AIR, WATER_SOURCE, -2)).toEqual(VOXEL_COLORS.water);
    expect(voxelRgb(AIR, WATER_SOURCE, 24)).toEqual([r, g, b].map((v) => Math.round(v * 0.5)));
    expect(voxelRgb(AIR, WATER_SOURCE, 34)).toEqual([r, g, b].map((v) => Math.round(v * 0.3)));
    expect(voxelRgb(AIR, WATER_SOURCE, 300)).toEqual([r, g, b].map((v) => Math.round(v * 0.3)));
  });
});

describe('sliceRgba: one pixel per sample, row 0 at y 319', () => {
  test('colours by sample; water depth counts from the top of each run of fluid in its sample column', () => {
    const s = slice({
      0: ground(40, 63),
      // Water 100 … 90, stone 89 … 80 (an overhang), water 79 … 70: the lower run has its own surface.
      5: (y) => (y <= 100 && y >= 90) || (y <= 79 && y >= 70) ? [AIR, WATER_SOURCE] : y < 90 && y >= 80 ? [STONE, 0] : [AIR, 0],
      // A block holding water (waterlogged) is drawn as the block.
      9: (y) => y === 10 ? [STONE, WATER_SOURCE] : [AIR, 0],
      511: ground(200),
    });
    const rgba = sliceRgba(s);
    expect(rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(rgba.length).toBe(4 * SLICE_SAMPLES);
    for (let k = 3; k < rgba.length; k += 4) if (rgba[k] !== 255) throw new Error(`alpha ${rgba[k]} at byte ${k}`);
    expect(pixel(rgba, 0, -64)).toEqual(opaque(VOXEL_COLORS.bedrock));
    expect(pixel(rgba, 0, 40)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 0, 63)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 0)));
    expect(pixel(rgba, 0, 41)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 22)));
    expect(pixel(rgba, 0, 64)).toEqual(opaque(VOXEL_COLORS.sky));
    expect(pixel(rgba, 0, 319)).toEqual(opaque(VOXEL_COLORS.sky));
    expect(pixel(rgba, 5, 100)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 0)));
    expect(pixel(rgba, 5, 90)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 10)));
    expect(pixel(rgba, 5, 85)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 5, 79)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 0)));
    expect(pixel(rgba, 5, 70)).toEqual(opaque(voxelRgb(AIR, WATER_SOURCE, 9)));
    expect(pixel(rgba, 9, 10)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 511, 200)).toEqual(opaque(VOXEL_COLORS.stone));
    expect(pixel(rgba, 511, 201)).toEqual(opaque(VOXEL_COLORS.sky));
    expect(pixel(rgba, 300, 0)).toEqual(opaque(VOXEL_COLORS.sky));
  });
  test('a real slice across a coast equals the harness PNG colours of the same voxels (depth below worldSurfaceWG)', () => {
    // Seed '42', default profile: sea at (−2000, −2000), land at (−1963, −2000) (Task 9's columns).
    const line: Segment = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
    const ctx = ctxFor('42');
    const r = createSliceJob().run(ctx, 0, line, () => false);
    if (r === null) throw new Error('slice stopped');
    const rgba = sliceRgba(r);
    const store = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
    const cx0 = -128;
    const cz0 = -126;
    genRegionInProcess(store, ctx, cx0, cz0, 7, 2);
    const view = regionView(store, cx0, cz0, 7, 2);
    let water = 0;
    for (let i = 0; i < SLICE_POINTS; i++) {
      const [px, pz] = segmentPointAt(line, i);
      const x = Math.floor(px);
      const z = Math.floor(pz);
      for (let y = -64; y <= 319; y++) {
        const want = png.voxelRgb(view.block(x, y, z), view.fluid(x, y, z), view.worldSurfaceWG(x, z) - 1 - y);
        const got = pixel(rgba, i, y);
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) throw new Error(`sample (${i}, ${y}) at (${x}, ${z}): ${got} ≠ ${want}`);
        if (view.fluid(x, y, z) !== 0) water++;
      }
    }
    expect(water).toBeGreaterThan(1000);
  });
});

describe('the Voxels plot and hover (SP3a spec §5.2)', () => {
  const box = { left: 10, top: 20, width: 1024, height: 768 };
  test('voxelPlots: cells over 512 × [−64, 320); distances put point i at the centre of its pixel column', () => {
    const { cells, distance } = voxelPlots(box, 1022);
    expect(cells).toEqual({ ...box, xMin: 0, xMax: 512, yMin: -64, yMax: 320 });
    expect(toPx(distance, 0, 0).px).toBe(11);
    expect(toPx(distance, 1022, 0).px).toBeCloseTo(1033, 9);
    expect(toPx(distance, 2 * 100, 0).px).toBeCloseTo(10 + 2 * 100 + 1, 9);
    expect(toPx(cells, 0, 320).py).toBe(20);
    expect(toPx(cells, 0, -64).py).toBe(788);
  });
  test('voxelCell: the sample (i, y) under a pixel; clamped within 2 px of the plot, null further out', () => {
    const { cells } = voxelPlots(box, 100);
    expect(voxelCell(cells, 10, 20)).toEqual({ i: 0, y: 319 });
    expect(voxelCell(cells, 11.9, 21.9)).toEqual({ i: 0, y: 319 });
    expect(voxelCell(cells, 12, 22)).toEqual({ i: 1, y: 318 });
    expect(voxelCell(cells, 1033.9, 787.9)).toEqual({ i: 511, y: -64 });
    expect(voxelCell(cells, 1035, 789)).toEqual({ i: 511, y: -64 });
    expect(voxelCell(cells, 8.5, 400)).toEqual({ i: 0, y: 129 });
    expect(voxelCell(cells, 7.9, 400)).toBeNull();
    expect(voxelCell(cells, 500, 17.9)).toBeNull();
    expect(voxelCell(cells, 500, 790.1)).toBeNull();
    expect(voxelCell(cells, Number.NaN, 400)).toBeNull();
    const at63 = toPx(cells, 0, 63.5).py;
    expect(voxelCell(cells, 500, at63)?.y).toBe(63);
  });
  test('blockName: the state\'s canonical key; fluidText: type, level, source and falling', () => {
    expect([blockName(AIR), blockName(STONE), blockName(BEDROCK), blockName(4095)]).toEqual(['air', 'stone', 'bedrock', 'unknown state 4095']);
    expect(fluidText(0)).toBe('no fluid');
    expect(fluidText(WATER_SOURCE)).toBe('water, level 0 (source)');
    expect(fluidText(packFluid(FLUID_WATER, 3, true))).toBe('water, level 3, falling');
    expect(fluidText(packFluid(FLUID_LAVA, 0))).toBe('lava, level 0 (source)');
    expect(fluidText(packFluid(3, 5))).toBe('fluid 3, level 5');
  });
  test('voxelReadout: the integer (⌊xᵢ⌋, y, ⌊zᵢ⌋), the block, the fluid and the point', () => {
    const line: Segment = { ax: -3, az: 0, bx: 7, bz: 5 };
    const s = slice({ 0: ground(10, 63), 511: ground(70) });
    expect(voxelReadout(line, s, 0, 63)).toBe('(-3, 63, 0) · air · water, level 0 (source) · point 0, 0.0 blocks from A');
    expect(voxelReadout(line, s, 0, 64)).toBe('(-3, 64, 0) · air · no fluid · point 0, 0.0 blocks from A');
    expect(voxelReadout(line, s, 511, 70)).toBe('(7, 70, 5) · stone · no fluid · point 511, 11.2 blocks from A');
    // Point 1 is (−3 + 10/511, 5/511): its block is (−3, 0).
    expect(voxelReadout(line, s, 1, -64)).toBe('(-3, -64, 0) · air · no fluid · point 1, 0.0 blocks from A');
    const neg: Segment = { ax: -0.5, az: -10.5, bx: -0.5, bz: -20.5 };
    expect(voxelReadout(neg, s, 0, 0).startsWith('(-1, 0, -11) · ')).toBe(true);
  });
  test('sliceSummary: the ground top range and the water along the line', () => {
    const cols: Record<number, (y: number) => readonly [number, number]> = {};
    for (let i = 0; i < SLICE_POINTS; i++) cols[i] = i < 128 ? ground(40, 63) : ground(i < 256 ? 70 : 90);
    expect(sliceSummary(slice(cols))).toBe('ground top y 40 to 90 · water on 25.0 % of the line, up to 23 deep');
    expect(sliceSummary(slice({}))).toBe('no ground · no water');
    const dry: Record<number, (y: number) => readonly [number, number]> = {};
    for (let i = 0; i < SLICE_POINTS; i++) dry[i] = ground(-64);
    expect(sliceSummary(slice(dry))).toBe('ground top y -64 to -64 · no water');
  });
});

describe('the Voxels requests (SP3a spec §5.2: the profile\'s rules)', () => {
  test('the modes and their status lines', () => {
    expect(SECTION_MODES).toEqual(['profile', 'voxels']);
    expect(sectionStatus('none', false, true, 'voxels')).toBe('the slice follows when the preview settles');
    expect(sectionStatus('none', true, true, 'voxels')).toBe('computing…');
    expect(sectionStatus('stale', false, true, 'voxels')).toBe('stale: updates when the preview settles');
    expect(sectionStatus('none', false, false, 'voxels')).toBe('no line: press Cut line in the toolbar, then click A and B on the map');
  });

  interface SliceCall { readonly segment: Segment; resolve(v: SliceResult): void; reject(e: unknown): void }
  const harness = () => {
    const calls: SliceCall[] = [];
    const session = { state: { epoch: 7 }, inGesture: false };
    const failures: string[] = [];
    let visible = true;
    const pool: Pick<WorkerPool, 'slice'> = {
      slice: (segment) => new Promise<SliceResult>((resolve, reject) => { calls.push({ segment, resolve, reject }); }),
    };
    const r = createSliceRequests({ session, pool, visible: () => visible, changed: () => undefined, failed: (m) => { failures.push(m); } });
    return { r, calls, session, failures, show: (v: boolean) => { visible = v; } };
  };
  const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });
  const LINE: Segment = { ax: 0, az: 0, bx: 100, bz: 0 };

  test('one pool.slice per session epoch and line, only when settled, on screen, outside a gesture and with a line', async () => {
    const h = harness();
    h.r.request(true);
    h.r.setLine(LINE);
    h.r.request(false);
    h.show(false);
    h.r.request(true);
    h.show(true);
    h.session.inGesture = true;
    h.r.request(true);
    expect(h.calls).toHaveLength(0);
    h.session.inGesture = false;
    h.r.request(true);
    h.r.request(true);
    expect(h.calls.map((c) => c.segment)).toEqual([LINE]);
    expect(h.r.pending).toBe(7);
    const s = slice({ 0: ground(10) });
    h.calls[0]!.resolve(s);
    await flush();
    expect([h.r.pending, h.r.shown?.epoch, h.r.shown?.value]).toEqual([null, 7, s]);
    h.r.request(true);
    expect(h.calls).toHaveLength(1);
    h.session.state = { epoch: 8 };
    h.r.request(true);
    expect(h.calls).toHaveLength(2);
  });
  test('JobCancelled keeps the last slice silently, another error reports it; a new line drops the slice', async () => {
    const h = harness();
    h.r.setLine(LINE);
    h.r.request(true);
    const s = slice();
    h.calls[0]!.resolve(s);
    await flush();
    h.session.state = { epoch: 8 };
    h.r.request(true);
    h.calls[1]!.reject(new JobCancelled());
    await flush();
    expect([h.r.shown?.value, h.r.pending, h.failures]).toEqual([s, null, []]);
    h.r.request(true);
    h.calls[2]!.reject(new Error('BAD_ARGS: B is A'));
    await flush();
    expect([h.r.shown?.value, h.failures]).toEqual([s, ['BAD_ARGS: B is A']]);
    h.r.setLine({ ...LINE, bx: 50 });
    expect([h.r.shown, h.r.pending]).toEqual([null, null]);
  });
  test('a slice superseded by a param edit or a new line is never shown, even when it settles after its successor', async () => {
    const h = harness();
    h.r.setLine(LINE);
    h.r.request(true); // call 0, epoch 7
    h.session.state = { epoch: 8 }; // a param edit while it runs
    h.r.request(true); // call 1, epoch 8
    expect(h.r.pending).toBe(8);
    const s8 = slice({ 0: ground(20) });
    h.calls[1]!.resolve(s8);
    await flush();
    expect([h.r.shown?.epoch, h.r.shown?.value, h.r.pending]).toEqual([8, s8, null]);
    // The superseded slice settles late: dropped.
    h.calls[0]!.resolve(slice({ 0: ground(10) }));
    await flush();
    expect([h.r.shown?.epoch, h.r.shown?.value]).toEqual([8, s8]);
    // Superseded before its successor settles: dropped too, and the successor stays pending.
    h.session.state = { epoch: 9 };
    h.r.request(true); // call 2
    h.session.state = { epoch: 10 };
    h.r.request(true); // call 3
    h.calls[2]!.resolve(slice({ 0: ground(30) }));
    await flush();
    expect([h.r.shown?.epoch, h.r.shown?.value, h.r.pending]).toEqual([8, s8, 10]);
    // A new line while call 3 runs: its late failure is not reported, and only the new line's slice is shown.
    const other: Segment = { ...LINE, bx: 50 };
    h.r.setLine(other);
    h.r.request(true); // call 4
    h.calls[3]!.reject(new Error('INTERNAL: boom'));
    await flush();
    expect([h.failures, h.r.shown, h.r.pending]).toEqual([[], null, 10]);
    const s10 = slice({ 0: ground(40) });
    h.calls[4]!.resolve(s10);
    await flush();
    expect([h.r.line, h.r.shown?.epoch, h.r.shown?.value, h.r.pending]).toEqual([other, 10, s10, null]);
    expect(h.calls.map((c) => c.segment)).toEqual([LINE, LINE, LINE, LINE, other]);
  });
});


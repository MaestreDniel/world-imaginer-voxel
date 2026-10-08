/**
 * The Voxels mode's pure parts (SP3a spec §5.2), unit-tested:
 * - the palette, shared with the harness PNG slices (`test/harness/png.ts` re-exports it): air in a sky colour,
 *   stone grey, bedrock near black, one flat colour per SP3c terrain block (SP3c spec §6), water blue darkening with
 *   depth below its surface; the legend's block keys (every registry state in state order);
 * - the slice image: one RGBA pixel per sample of a `pool.slice` result (512 × 384, row 0 at y 319);
 * - the plot: sample cells over the drawer, a distance axis whose point i sits at the centre of pixel column i,
 *   and the hover mapping from a pixel to the sample (i, y) under it;
 * - the hover readout (the integer (⌊xᵢ⌋, y, ⌊zᵢ⌋), the block's canonical key and the fluid) and the summary line;
 * - the hover rule id (SP3c spec §6): one `surfaceProbe` job at a time for the hovered voxel, the latest hovered voxel
 *   wins, and the readout's ` · rule …` suffix becomes ` · rule <leaf id>` or ` · rule none` when the probe answers.
 */
import { MIN_Y, SEA_LEVEL } from '../../core/constants';
import { MAX_Y } from '../../core/coords';
import { JobCancelled, type SliceResult, type SurfaceProbeResult } from '../../engine/workerPool';
import { segmentLength, segmentPointAt, type Segment } from '../../metrics/crossSection';
import { FLUID_LAVA, FLUID_WATER, fluidFalling, fluidLevel, fluidType } from '../../world/blocks/fluid';
import { AIR, REGISTRY } from '../../world/blocks/index';
import { SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES } from '../../workers/protocol';
import type { Plot, PlotBox } from '../splineEditor/model';

export type Rgb = readonly [number, number, number];

/**
 * The Voxels palette. `sky` is air's colour, `seaLevel` the sea-level line, `water` a water surface; every other block
 * type's colour sits under its type name (each state of a type takes it). `unknown` marks a state id outside the
 * registry (every registered state has a colour, pairwise ≥ 24 apart in summed |ΔRGB|, SP3c spec §8).
 */
export const VOXEL_COLORS = {
  sky: [168, 204, 255],
  seaLevel: [112, 150, 206],
  stone: [125, 125, 125],
  bedrock: [28, 28, 30],
  water: [40, 92, 222],
  unknown: [255, 0, 255],
  // The SP3c terrain palette (SP3c spec §2.1, §6), in state order.
  grass_block: [95, 159, 53],
  dirt: [122, 88, 58],
  coarse_dirt: [100, 72, 50],
  podzol: [91, 63, 24],
  mud: [60, 57, 61],
  sand: [219, 207, 160],
  red_sand: [214, 120, 46],
  sandstone: [190, 174, 120],
  red_sandstone: [160, 80, 28],
  gravel: [152, 143, 140],
  clay: [160, 166, 180],
  calcite: [222, 223, 218],
  snow_block: [250, 253, 255],
  packed_ice: [142, 180, 250],
  deepslate: [78, 78, 84],
  terracotta: [152, 94, 67],
  white_terracotta: [214, 180, 168],
  orange_terracotta: [184, 104, 40],
  yellow_terracotta: [186, 133, 35],
  brown_terracotta: [77, 51, 36],
  red_terracotta: [143, 61, 47],
  light_gray_terracotta: [135, 107, 98],
} as const satisfies Record<string, Rgb>;

const COLOR_OF_TYPE: Readonly<Record<string, Rgb | undefined>> = VOXEL_COLORS;
/** Each registry state's colour, by state id: air's is the sky, any other state's its type's (unknown if none). */
const STATE_RGB: readonly Rgb[] = Array.from({ length: REGISTRY.stateCount }, (_, s) =>
  s === AIR ? VOXEL_COLORS.sky : (COLOR_OF_TYPE[REGISTRY.typeName(REGISTRY.STATE_TYPE[s]!)] ?? VOXEL_COLORS.unknown));

/** The sea-level line's y. */
export const SEA_LEVEL_Y = SEA_LEVEL;
/** Water loses this share of its brightness per block of depth, down to `WATER_FLOOR`. */
const WATER_FADE = 1 / 48;
const WATER_FLOOR = 0.3;

/**
 * The colour of a voxel: its block state's, or water's when the fluid byte holds a fluid on air, darkened with
 * `depth` (blocks below the water surface, 0 at the surface).
 */
export function voxelRgb(state: number, fluid: number, depth: number): Rgb {
  if (state === AIR && fluidType(fluid) !== 0) {
    const f = Math.max(WATER_FLOOR, 1 - Math.max(0, depth) * WATER_FADE);
    const [r, g, b] = VOXEL_COLORS.water;
    return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
  }
  return Number.isInteger(state) && state >= 0 && state < STATE_RGB.length ? STATE_RGB[state]! : VOXEL_COLORS.unknown;
}

/** A block key of the Voxels legend: a registry state, its canonical key and its colour. */
export interface VoxelLegendKey {
  readonly state: number;
  readonly label: string;
  readonly rgb: Rgb;
}

/** The legend's block keys: every registry state in state order (air first, in the sky colour). */
export function voxelLegend(): readonly VoxelLegendKey[] {
  return STATE_RGB.map((rgb, state) => ({ state, label: REGISTRY.stateKey(state), rgb }));
}

const isWater = (state: number, fluid: number): boolean => state === AIR && fluidType(fluid) !== 0;

/**
 * The slice as an RGBA image, 512 × 384, pixel (i, row) at `sliceIndex(i, y)` (row 0 is y 319). A water voxel's depth
 * counts from the top of its run of water in the sample column (the voxel under air or a block), which equals the
 * harness's `worldSurfaceWG − 1 − y` except under an overhang (SP3b's T fills air under stone near the water line).
 */
export function sliceRgba(s: SliceResult): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(4 * SLICE_SAMPLES);
  for (let i = 0; i < SLICE_POINTS; i++) {
    let surface = 0;
    let wet = false;
    for (let row = 0; row < SLICE_ROWS; row++) {
      const k = row * SLICE_POINTS + i;
      const y = MAX_Y - row;
      const state = s.blocks[k]!;
      const fluid = s.fluid[k]!;
      const water = isWater(state, fluid);
      if (water && !wet) surface = y;
      wet = water;
      const c = voxelRgb(state, fluid, water ? surface - y : 0);
      out[4 * k] = c[0];
      out[4 * k + 1] = c[1];
      out[4 * k + 2] = c[2];
      out[4 * k + 3] = 255;
    }
  }
  return out;
}

/** The plots of the Voxels mode over `box`: sample cells, and distance from A in blocks along a line of `length`. */
export interface VoxelPlots {
  /** x: sample i covers [i, i + 1); y: voxel y covers [y, y + 1). */
  readonly cells: Plot;
  /** x: distance from A, point i (i·length/511 blocks) at the centre of its cell; y as `cells`. */
  readonly distance: Plot;
}

export function voxelPlots(box: PlotBox, length: number): VoxelPlots {
  const cells: Plot = { left: box.left, top: box.top, width: box.width, height: box.height, xMin: 0, xMax: SLICE_POINTS, yMin: MIN_Y, yMax: MAX_Y + 1 };
  const half = length / (2 * (SLICE_POINTS - 1));
  return { cells, distance: { ...cells, xMin: -half, xMax: length + half } };
}

/** A sample of the slice: point i along the line, voxel y. */
export interface VoxelCell {
  readonly i: number;
  readonly y: number;
}

/** Hover tolerance around the plot in CSS px: a pointer this close to the edge reads the edge sample. */
const EDGE_PX = 2;

/** The sample under plot pixel (px, py), clamped to the slice within 2 px of the plot; null further out. */
export function voxelCell(cells: Plot, px: number, py: number): VoxelCell | null {
  const dx = px - cells.left;
  const dy = py - cells.top;
  if (!(dx >= -EDGE_PX && dx <= cells.width + EDGE_PX && dy >= -EDGE_PX && dy <= cells.height + EDGE_PX)) return null;
  const i = Math.min(SLICE_POINTS - 1, Math.max(0, Math.floor((dx * SLICE_POINTS) / cells.width)));
  const row = Math.min(SLICE_ROWS - 1, Math.max(0, Math.floor((dy * SLICE_ROWS) / cells.height)));
  return { i, y: MAX_Y - row };
}

/** The block state's canonical key (`stone`, `log[axis=y]`), or `unknown state N`. */
export function blockName(state: number): string {
  return Number.isInteger(state) && state >= 0 && state < REGISTRY.stateCount ? REGISTRY.stateKey(state) : `unknown state ${state}`;
}

const FLUID_NAMES: Readonly<Record<number, string>> = { [FLUID_WATER]: 'water', [FLUID_LAVA]: 'lava' };

/** `no fluid`, or the fluid's type and level: `water, level 0 (source)`, `water, level 3, falling`. */
export function fluidText(b: number): string {
  const type = fluidType(b);
  if (type === 0) return 'no fluid';
  const level = fluidLevel(b);
  return `${FLUID_NAMES[type] ?? `fluid ${type}`}, level ${level}${level === 0 ? ' (source)' : ''}${fluidFalling(b) ? ', falling' : ''}`;
}

/** A world voxel position. */
export interface VoxelPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The voxel of sample (i, y): (⌊xᵢ⌋, y, ⌊zᵢ⌋), the one the slice job reads and the readout names. */
export function voxelPosition(line: Segment, i: number, y: number): VoxelPosition {
  const [px, pz] = segmentPointAt(line, i);
  return { x: Math.floor(px), y, z: Math.floor(pz) };
}

/** The hover readout of sample (i, y): `(x, y, z) · block · fluid · point i, D blocks from A`. */
export function voxelReadout(line: Segment, s: SliceResult, i: number, y: number): string {
  const v = voxelPosition(line, i, y);
  const k = (MAX_Y - y) * SLICE_POINTS + i;
  const d = (segmentLength(line) * i) / (SLICE_POINTS - 1);
  return `(${v.x}, ${y}, ${v.z}) · ${blockName(s.blocks[k]!)} · ${fluidText(s.fluid[k]!)} · point ${i}, ${d.toFixed(1)} blocks from A`;
}

/** The readout's rule suffix while the hovered voxel's probe runs. */
export const RULE_WAITING = ' · rule …';

/** The readout's rule suffix for a branch path: ` · rule <leaf id>` (its last id), or ` · rule none` for []. */
export function ruleSuffix(path: readonly string[]): string {
  return ` · rule ${path.length === 0 ? 'none' : path[path.length - 1]!}`;
}

/** A voxel whose rule the readout asks for, and the session epoch of the slice it was read from. */
export interface RuleCell extends VoxelPosition {
  readonly epoch: number;
}

/** Whether two rule cells are the same voxel at the same epoch. */
export const sameRuleCell = (a: RuleCell, b: RuleCell): boolean => a.epoch === b.epoch && a.x === b.x && a.y === b.y && a.z === b.z;

export interface RuleReadout {
  /**
   * The pointer is over `cell` (null: off the slice). Returns the rule suffix to show at once: the answer (or the
   * failure) when this voxel was answered at its epoch, RULE_WAITING while its probe is queued or in flight, and '' for null or for a cell
   * of a slice that is not the current session epoch's (a stale slice: no probe, the pool runs another draft).
   */
  hover(cell: RuleCell | null): string;
}

/**
 * The Voxels mode's hover rule id (SP3c spec §6), as the map hover's point jobs (`hoverPanel.ts`): one probe in flight,
 * the latest hovered voxel waits and wins. `epoch()` is the session's current epoch. `show(cell, suffix)` reports an
 * answer for the voxel still hovered at the epoch it was asked for; an answer for a voxel the pointer left, or that
 * lands after the epoch moved, is dropped. JobCancelled at the same epoch asks again; any other error is shown as
 * ` · rule failed: <message>` and kept as the voxel's answer, so it is not retried at that epoch.
 */
export function createRuleReadout(pool: { surfaceProbe(x: number, y: number, z: number): Promise<SurfaceProbeResult> }, epoch: () => number,
  show: (cell: RuleCell, suffix: string) => void): RuleReadout {
  let busy: RuleCell | null = null;
  let next: RuleCell | null = null;
  let current: RuleCell | null = null;
  let answered: { readonly cell: RuleCell; readonly suffix: string } | null = null;
  const live = (cell: RuleCell): boolean => current !== null && sameRuleCell(current, cell) && cell.epoch === epoch();

  const run = (cell: RuleCell) => {
    busy = cell;
    pool.surfaceProbe(cell.x, cell.y, cell.z).then((r) => {
      if (cell.epoch !== epoch()) return;
      const suffix = ruleSuffix(r.path);
      answered = { cell, suffix };
      if (live(cell)) show(cell, suffix);
    }, (e: unknown) => {
      if (cell.epoch !== epoch()) return;
      if (e instanceof JobCancelled) {
        if (live(cell)) next ??= cell;
        return;
      }
      // Kept as an answer is, so the pointer moving inside the failed voxel does not probe it again at this epoch.
      const suffix = ` · rule failed: ${e instanceof Error ? e.message : String(e)}`;
      answered = { cell, suffix };
      if (live(cell)) show(cell, suffix);
    }).finally(() => {
      busy = null;
      const n = next;
      next = null;
      if (n !== null && live(n)) run(n);
    });
  };

  return {
    hover(cell) {
      if (cell === null || cell.epoch !== epoch()) {
        current = null;
        next = null;
        return '';
      }
      current = cell;
      if (answered !== null && sameRuleCell(answered.cell, cell)) {
        next = null;
        return answered.suffix;
      }
      if (busy === null) run(cell);
      else next = sameRuleCell(busy, cell) ? null : cell;
      return RULE_WAITING;
    },
  };
}

/**
 * `ground top y LO to HI · water on P % of the line, up to D deep`: the range of the highest block (not air) of each
 * sample column, the share of sample columns holding water and the longest run of water from the top of a column.
 */
export function sliceSummary(s: SliceResult): string {
  let lo = Infinity;
  let hi = -Infinity;
  let wetColumns = 0;
  let deepest = 0;
  for (let i = 0; i < SLICE_POINTS; i++) {
    let top: number | null = null;
    let run = 0;
    let firstRun = -1;
    for (let row = 0; row < SLICE_ROWS; row++) {
      const k = row * SLICE_POINTS + i;
      const state = s.blocks[k]!;
      if (isWater(state, s.fluid[k]!)) run++;
      else if (run > 0 && firstRun < 0) firstRun = run;
      if (state !== AIR && top === null) top = MAX_Y - row;
    }
    if (run > 0 && firstRun < 0) firstRun = run;
    if (top !== null) {
      lo = Math.min(lo, top);
      hi = Math.max(hi, top);
    }
    if (firstRun > 0) {
      wetColumns++;
      deepest = Math.max(deepest, firstRun);
    }
  }
  const ground = lo === Infinity ? 'no ground' : `ground top y ${lo} to ${hi}`;
  const water = wetColumns === 0 ? 'no water' : `water on ${((wetColumns / SLICE_POINTS) * 100).toFixed(1)} % of the line, up to ${deepest} deep`;
  return `${ground} · ${water}`;
}

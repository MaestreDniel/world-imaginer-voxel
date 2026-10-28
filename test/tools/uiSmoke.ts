/**
 * The SP2b §8 UI smoke test (not in CI): drives the ?map editor in headless Chrome through the DevTools protocol
 * with real pointer and key input, and checks each editor end to end through the page's DOM and its URL state.
 * Run it with `node test/tools/uiSmoke.ts [options]`: Node 24 strips the types, CDP runs over the global
 * WebSocket, and nothing is added to the dependencies.
 *
 * Processes (helpers in cdp.ts, shared with measureChrome.ts), as in mapLatency.ts: `npm run build`; its own
 * `vite preview --host 127.0.0.1 --port <P> --strictPort` on a free port P found by binding port 0 (never 5183), ready
 * only when that child prints its URL; its own headless Chrome with a temporary profile (in the OS temp directory or
 * --profile-dir; Chrome's singleton socket stays in $TMPDIR, whose path must be short), DevTools port 0 and WebGL2
 * through SwiftShader (`SWIFTSHADER_ARGS`, SP4a spec §9.6). At the end it stops only what it started and removes the
 * profile (downloads included).
 *
 * The page is 1400 × 900 CSS px at DPR 1. The steps, in order, each with its checks:
 * - selftest: `?selftest=1` matches every golden in a real module worker;
 * - load: `?map` at seed 42, the default profile and view (0, 0, 64 blocks/px) settles its first preview;
 * - number: `rivers.gorgeDepth` typed in the Parameters tab;
 * - knot: a knot of `shape.offset` dragged in the spline drawer (one undo step; the statistics refresh);
 * - slider: the biome-size slider dragged from 5 to 8 (one undo step);
 * - box: the desert T interval typed in the Biomes tab (the share chart refreshes);
 * - profile: a switch to large_biomes with the modified draft: the inline confirmation, Switch, then the
 *   notice's Undo;
 * - presets: export to a real download, the JSON patch box applies {}, then the file is imported;
 * - undo/redo: Ctrl+Z through the whole history, then Ctrl+Shift+Z and Ctrl+Y back;
 * - reload: the draft, the controls and the stored layout come back;
 * - cut line: a two-click line on the map and its profile in the drawer's Cross-section tab;
 * - voxels: the tab's Voxels mode (SP3a spec §5.2): a fresh, non-empty slice, its legend (every registry state, water and
 *   the sea line: SP3c spec §6), the hover readout, back to Profile;
 * - tabs: ArrowRight, ArrowLeft, Home and End move the selection and the focus on both tab bars;
 * - rule: the Voxels mode on the mountain line (SP3c spec §6): the pointer on the top solid voxel of a sample (found in
 *   the slice image, not at a fixed height) shows the readout at once, then its surface rule id ` · rule root.…`;
 * - the Density tab (SP3d spec §6 steps 1-7), on that mountain page:
 *   - density tab: opened with the line drawn (the vertical plane), the field set to `density`; the slice hover and the
 *     node form's "value at the hover" (a `fieldProbe` job) agree;
 *   - density node: the `islands` const `root.b.x` edited from −1e6 to −10, committed by the blur of a click on the root
 *     row (no Enter): that one click selects the root; the slice's p1 becomes −10, its share below 0 (solidity) is
 *     unchanged;
 *   - density mute: the `terrain` tap muted from its row (0, under an add) while the root is selected with the field on
 *     `selected`: the selection stays on the root (a row's mute is a plain edit, §3.2), its slice changes and equals the
 *     `density` field's; the URL length with the edited tree;
 *   - density json: an unknown op typed at the islands tap's child: the issue `root.b.x: UNKNOWN_OP`, the session, URL
 *     and slice untouched; Escape reverts the buffer; the toolbar Undo twice: the start state, the default tree rows
 *     and a clean buffer;
 *   - density narrow: the viewport narrowed until the tab is 1,000 px wide (the Slice/JSON sub-tabs, "Slice" shown): a
 *     row selected there, then the JSON sub-tab: the node's highlighted text is inside the editor's view (§3.2, the
 *     scroll owed while the text was hidden), and stays there across a Slice/JSON switch;
 *   - density horizontal: the horizontal plane; a map click moves its centre (the square's centre cross follows on the
 *     map, a fresh slice arrives); a cut line drawn while Density is shown keeps it shown;
 *   - density drag: the biome-size slider dragged 5 → 6, held, → 7: at least one 32² draft is drawn during the drag;
 *   - density times: the browser wall times of the vertical 128² slice and of the horizontal one at extent 8192 (a
 *     control change, and three tree edits each, to the fresh 128²), and the URL length;
 * - preset profiles (SP3e spec §8): archipelago, amplified and floating_islands, each opened by URL
 *   (`mapHash({...START, profile, view})`) on its 1,024-block line along x centred on its golden window's centre
 *   (`sp3eWindow`, seed 42; the review slice is the line's middle half): the profile select shows it among the five
 *   ready profiles, the URL and the World tab name it, no page error, and the Voxels summary reports a ground top
 *   ≥ 250 (amplified), ≥ 193 (floating_islands) or water on the line (archipelago); floating_islands' line holds an
 *   island over ground whose top voxel takes a surface rule (D21 (b)), and its `islandMask` layer over 4096² blocks
 *   around the window (16 blocks/px) draws ≥ 2 colours; archipelago's `biome` layer there holds ocean and land colours;
 * - the 3D world (SP4a spec §9.6), on pages of their own:
 *   - start: bare `/` shows the start screen with seed 42, the default profile and both buttons, nothing loading and no
 *     page error (`start.png`); `/#<seed 7's hash>` names seed 7; "Enter the world" on a bare `/` brings up the loading
 *     screen in the same page (the URL and the history unchanged), and the step stops there;
 *   - world: `/?rd=4` shows no start screen and reveals (`window.__wiWorld.revealed`, set by the page), with no page
 *     error (`world.png`); the canvas's `data-renderer` is the page's choice (`expectedRenderer`: RegionBatch where the
 *     browser has `WEBGL_multi_draw`, SP4b spec §8.6);
 *   - world-mesh: `?renderer=mesh` and `?renderer=batch` at RD 4 and two fixed cameras (`PARITY_VIEWS`: seed 42's
 *     spawn, and the ocean site over open water and a shore), in the capture mode (`&shot=1`: 08:00 paused, no HUD, no
 *     overlay), each read back after the reveal and three frames (`__wiWorld.frames`): the canvas's `data-renderer` is
 *     the forced one; per view, at most 1 % of the pixels may differ by more than 2/255 in a channel
 *     (`pixelDiffShare`); `world-mesh.png` and `world-mesh-water.png` are the RegionMesh images;
 *   - stream (SP4b spec §8.6): `/?rd=4&renderer=batch`, then `…=mesh` (`STREAM_RUNS`): `data-renderer` is the forced
 *     one; after the reveal a click on the canvas and W held for 4 s with real key input: the HUD's position moved
 *     more than 40 blocks (12 blocks/s × 4 s ≈ 47) and, within 5 s of releasing W, its `revealed` count grew, with no
 *     page error; then the help (H), whose `#setting-rd` shows the RD in force, 4, even with the batch run's 6 saved
 *     (rulings R8), and 6 chosen there: within 30 s the HUD shows `RD 6` and a larger `revealed`, with no navigation (a token set on `window` after the
 *     reveal is still there); `stream.png` and `stream-mesh.png`;
 *   - overlay (SP4c spec §8.6), `/?rd=4&renderer=batch&wiTest=1` at 1920 × 1080 (`OVERLAY_VIEWPORT`, put back to
 *     `VIEWPORT` at the step's end), through the page's test hook `window.__wiTest` (`?wiTest=1` only): the leak
 *     baseline before the first M (CDP's listeners on window and document, the session's listeners, the pending
 *     timers); M opens the map in full screen (one `canvas[data-renderer]`, the tiles within 5 s and the arrow at the
 *     camera with no edit, the Density tab's slice through "Edit in Density"); a click 300 px east of the arrow
 *     teleports (the camera within 1 block of the clicked point, y = min(400, max(surface, water) + 24), the map closed,
 *     the search's `at` rewritten, the revealed count falling then growing within 10 s); side by side (the 3D half the
 *     window, stored; the panel beside the map at 960 px, stacked at 800 px); live edits (`density.detailAmpHi`, Ctrl+Z,
 *     `climate.C`'s wavelength, the desert T bound; then Ctrl+Z and Ctrl+Y from the 3D with their notices), each with
 *     the stale count above 0 then 0 within 30 s; the pointer lock on the 3D half (W moves the camera with the map open,
 *     Esc gives the map the controls with the drawer open; skipped with the reason when refused); the leak check (the
 *     overlay closed and the tool disposed through the hook: listeners, session listeners and timers equal the
 *     baseline, no tile request over 1 s); a reload keeping side by side and the edits; a forced fatal with the map
 *     open (the overlay closed, the failure panel with "Copy details", no page error);
 *   - overlay-mesh, `…&renderer=mesh&wiTest=1`: the map in full screen, the teleport and the terrain Apply, side by side;
 *     both overlay steps print the in-world preview's `lastLatencyMs` from the toolbar (information only, §6.4);
 * - console: no exception, console error or failed load, except the known favicon.ico 404 and Chrome's notice that it
 *   blocked a world page's `beforeunload` prompt when a step left it (`leaveGuardLog`); every step ran.
 * With --shots DIR it then writes the spec §12 screenshots into DIR, at seed 42 from a newly loaded page (the
 * repository keeps them re-saved as 256-colour palette PNGs, as SP1 and SP2a did), then the Voxels mode on the
 * mountain line (SP3b spec §7: `cross-section-voxels-mountain.png`; the line text is checked, and the slice summary
 * must show a ground top above y 200 and no water) with the pointer on the rule step's top voxel and its readout
 * showing the surface rule id (SP3c spec §6, §9: "a Voxels-mode screenshot with a hover rule id"), and last the
 * Density tab on the same line with the drawer at its tallest (SP3d spec §6 step 7, §11's review):
 * `density-vertical-hover.png` (the vertical density slice, the pointer on a ground voxel: the readout and the form's
 * value at the hover agree), `density-muted-terrain.png`, `density-broken-json.png` (the issue line, the world
 * untouched), `density-horizontal-8192.png` and `density-stacked-800.png` (the viewport narrowed until the tab is
 * 800 px wide: the stacked layout), and last the SP3e preset shots (spec §8, committed to `assets/sp3e/`):
 * `preset-archipelago.png`, `preset-amplified.png` and `preset-floating_islands.png` (the Voxels mode on each preset's
 * line, the drawer at its tallest, the pointer on a top voxel — floating_islands' on the ground under an island), then
 * `preset-archipelago-map.png` (`biome`) and `preset-floating_islands-islandMask.png` (`islandMask`): 4096 × 4096
 * blocks centred on the window at 16 blocks/px, a 256 × 256 px clip of the map.
 * The 3D steps save `start.png`, `world.png`, `world-mesh.png`, `world-mesh-water.png`, `stream.png`,
 * `stream-mesh.png`, `review-overlay-full.png` and `review-overlay-split.png` (SP4c spec §8.7, 1920 × 1080) into DIR as
 * they run, with --shots only.
 * Options: --skip-build, --profile-dir DIR, --shots DIR. The exit code is 0 only when every check passes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  connect, freePort, ignoredLog, npmBuild, ROOT, running, sleep, startChrome, startPreview, stopStarted, type Cdp, type ChromeHandle,
} from './cdp.ts';

export const VIEWPORT = { width: 1400, height: 900 } as const;
/** BIOME_SIZE_SCALE[7]: biome-size position 8 (src/ui/map/biomeSize.ts; a unit test keeps them equal). */
export const SIZE_8 = 2.29739670999407;
const SETTLE_MS = 30000;

// ---------------------------------------------------------------- pure parts (unit-tested)

export interface MapUrlView { readonly x: number; readonly z: number; readonly bpp: number; readonly layer: string }
export interface MapUrlState { readonly v: 1; readonly seed: string; readonly profile: string; readonly patch: unknown; readonly view: MapUrlView }

/** JSON with object keys sorted at every level (the page's canonical JSON for the values the smoke test uses). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** The URL fragment the page writes for `s` (without the '#'). */
export function mapHash(s: MapUrlState): string {
  return Buffer.from(canonicalJson(s), 'utf8').toString('base64url');
}

/** The state in a `?map` URL fragment (with or without the '#'), or null when it is not one. */
export function readMapHash(hash: string): MapUrlState | null {
  try {
    const j = JSON.parse(Buffer.from(hash.replace(/^#/, ''), 'base64url').toString('utf8')) as Partial<MapUrlState> | null;
    return j !== null && typeof j === 'object' && j.v === 1 && typeof j.seed === 'string' && typeof j.profile === 'string' && typeof j.view === 'object' ? j as MapUrlState : null;
  } catch {
    return null;
  }
}

/**
 * The number of goldens in test/goldens.json: every key of the build, which `?selftest=1` recomputes (SP3a spec §6.4;
 * this tool runs under plain Node and cannot import `src/` to count `allGoldenKeys()`).
 */
export function goldenCount(goldensJson: string): number {
  const entries = (JSON.parse(goldensJson) as { entries?: unknown }).entries;
  if (entries === null || typeof entries !== 'object') throw new Error('goldens.json has no entries object');
  return Object.keys(entries).length;
}

/** True when the selftest page's summary reports all `count` goldens matching. */
export function selftestAllMatch(summary: string, count: number): boolean {
  const m = /^✓ all (\d+) goldens match/.exec(summary);
  return m !== null && Number(m[1]) === count;
}

/** A surface-rule id (SP3c spec §3.1): `root`, then `.rules[k]` and `.then` steps. */
const RULE_ID = String.raw`root(?:\.rules\[\d+\]|\.then)*`;
const VOXEL_READOUT = String.raw`\(-?\d+, -?\d+, -?\d+\) · (?:[a-z][a-z0-9_]*(?:\[[a-z0-9_=,]+\])?|unknown state \d+) · (?:no fluid|[a-z0-9 ]+, level [0-7](?: \(source\))?(?:, falling)?) · point \d+, \d+\.\d blocks from A`;

/**
 * The Voxels mode's hover readout: `(x, y, z) · block · fluid · point i, D blocks from A` (SP3a spec §5.2), with the
 * optional hover rule suffix ` · rule …` (the probe runs), ` · rule none` or ` · rule <rule id>` (SP3c spec §6).
 */
export function voxelReadoutOk(text: string): boolean {
  return new RegExp(`^${VOXEL_READOUT}(?: · rule (?:…|none|${RULE_ID}))?$`).test(text);
}

/** The rule id a Voxels readout ends with (` · rule root…`), or null while it waits, for none, or without one. */
export function voxelRuleId(text: string): string | null {
  const m = new RegExp(`^${VOXEL_READOUT} · rule (${RULE_ID})$`).exec(text);
  return m === null ? null : m[1]!;
}

/**
 * The Voxels legend's labels the page must show (SP3c spec §6): every state of the state-id lock (`test/stateIds.lock.json`,
 * the canonical keys) in state-id order, then the water and the sea-level keys. Throws when the lock's ids are not 0 … n − 1.
 */
export function voxelLegendLabels(stateIdsLockJson: string): string[] {
  const lock = JSON.parse(stateIdsLockJson) as Record<string, number>;
  const keys = Object.keys(lock).sort((a, b) => lock[a]! - lock[b]!);
  if (!keys.every((k, i) => lock[k] === i)) throw new Error('the state-id lock\'s state ids are not 0 … n − 1');
  return [...keys, 'water, darker with depth', 'sea level 63'];
}

/** Air's colour in the Voxels slice image (`VOXEL_COLORS.sky`; a unit test keeps them equal). */
export const SKY_RGB = [168, 204, 255] as const;

/**
 * The row (0 at y 319) of the top solid voxel of one sample column of the slice image, given as its 384 RGBA pixels top
 * down (`getImageData(i, 0, 1, 384).data`): the first pixel that is not air's colour (on a dry line, the column's ground
 * top), or null when the column is all air.
 */
export function groundTopRow(column: ArrayLike<number>): number | null {
  if (column.length !== 4 * 384) throw new Error(`a sample column of the slice image is 384 RGBA pixels, not ${column.length} bytes`);
  for (let row = 0; row < 384; row++) {
    const k = 4 * row;
    if (column[k] !== SKY_RGB[0] || column[k + 1] !== SKY_RGB[1] || column[k + 2] !== SKY_RGB[2]) return row;
  }
  return null;
}

/** The sample the rule step and the mountain screenshot hover: 40 % of the line's 512 samples. */
export const RULE_SAMPLE = 205;

/**
 * The page point (CSS px) at the centre of the cell (sample i, image row `row`, 0 at y 319) of the 512 × 384 Voxels
 * slice image drawn in `box` (the `.cs-voxels` canvas's box).
 */
export function sliceCellPoint(box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, i: number, row: number): [number, number] {
  if (!Number.isInteger(i) || i < 0 || i > 511 || !Number.isInteger(row) || row < 0 || row > 383) throw new RangeError(`sliceCellPoint: cell (${i}, ${row}) outside the 512 × 384 slice`);
  return [box.x + ((i + 0.5) * box.width) / 512, box.y + ((row + 0.5) * box.height) / 384];
}

/** The Voxels mode's summary of a non-empty slice: `ground top y LO to HI · …water…`. */
export function voxelSummaryOk(text: string): boolean {
  return /^ground top y -?\d+ to -?\d+ · (?:no water|water on \d+\.\d % of the line, up to \d+ deep)$/.test(text);
}

/**
 * The Voxels mode's summary of the mountain line (SP3b spec §7, §11): the format of `voxelSummaryOk`, a ground top
 * above y 200 (the review mountain's `topMax` > 200, as `reviewSlices.test` requires) and no water.
 */
export function mountainSummaryOk(text: string): boolean {
  const m = /^ground top y (-?\d+) to (-?\d+) · no water$/.exec(text);
  return m !== null && voxelSummaryOk(text) && Number(m[2]) > 200;
}

/** A cut line's ends, as the cross-section's line text writes them. */
export interface Segment { readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }

/** The segment of the cross-section's line text `A (ax, az) → B (bx, bz) · N blocks`, or null. */
export function parseSegment(text: string): Segment | null {
  const m = /^A \((-?\d+), (-?\d+)\) → B \((-?\d+), (-?\d+)\) · [\d ]+ blocks$/.exec(text);
  return m === null ? null : { ax: Number(m[1]), az: Number(m[2]), bx: Number(m[3]), bz: Number(m[4]) };
}

/**
 * The mountain line of the Voxels-mode screenshot (SP3b spec §7 uiSmoke, §11): the review slices' mountain site
 * (`test/harness/reviewSlices.ts`, a highland row with σ > 8 found by a scan; a unit test keeps them equal), from
 * A (−1664, 8) to B (−640, 8), clicked at ± 256 CSS px around the centre of a view at 2 blocks/px.
 */
export const MOUNTAIN_LINE = {
  view: { x: -1152, z: 8, bpp: 2, layer: 'relief' },
  a: [-1664, 8],
  b: [-640, 8],
} as const satisfies { readonly view: MapUrlView; readonly a: readonly [number, number]; readonly b: readonly [number, number] };

// ---------------------------------------------------------------- the draft presets (SP3e spec §8)

/** The page's start state: seed 42, the default profile, view (0, 0, 64 blocks/px) on the biome layer. */
export const START: MapUrlState = { v: 1, seed: '42', profile: 'default', patch: {}, view: { x: 0, z: 0, bpp: 64, layer: 'biome' } };

/** The draft presets, in `PROFILE_IDS` order (a unit test keeps them equal to `WINDOW_PRESETS`). */
export const SMOKE_PRESETS = ['archipelago', 'amplified', 'floating_islands'] as const;
export type SmokePreset = (typeof SMOKE_PRESETS)[number];

/** The profile select's options at SP3e: every ready profile in `PROFILE_IDS` order (`profileOptions()`; a unit test keeps them equal). */
export const READY_PROFILES = ['default', 'large_biomes', 'archipelago', 'amplified', 'floating_islands'] as const;

/**
 * Each draft preset's golden window centre block on seed 42 (`sp3eWindow(p).centreX`, `.centreZ` of
 * `src/metrics/sp3eGoldens.ts`; this tool runs under plain Node and cannot import `src/`, so a unit test keeps them equal).
 */
const PRESET_CENTRES = new Map<SmokePreset, readonly [number, number]>([
  ['archipelago', [128, -128]],
  ['amplified', [-640, 0]],
  ['floating_islands', [-768, -1408]],
]);

/** A cut line the smoke draws: the map view it is drawn on and its ends A and B (blocks). */
export interface SmokeLine { readonly view: MapUrlView; readonly a: readonly [number, number]; readonly b: readonly [number, number] }

/** The window centre block of a draft preset (seed 42). */
export function presetCentre(preset: SmokePreset): readonly [number, number] {
  const c = PRESET_CENTRES.get(preset);
  if (c === undefined) throw new RangeError(`${String(preset)} is not a draft preset`);
  return c;
}

/**
 * A preset's smoke line (SP3e spec §8 "The line"): 1,024 blocks along x centred on its window centre, drawn as the
 * mountain line is (± 256 CSS px around the centre of a view at 2 blocks/px on the relief layer); the review slice's
 * 512 blocks are its middle half.
 */
export function presetLine(preset: SmokePreset): SmokeLine {
  const [x, z] = presetCentre(preset);
  return { view: { x, z, bpp: 2, layer: 'relief' }, a: [x - 512, z], b: [x + 512, z] };
}

/** The URL state opening `profile` at `view`: the start state with that profile (`mapHash({...START, profile, view})`). */
export function presetState(profile: string, view: MapUrlView): MapUrlState {
  return { ...START, profile, view };
}

/** The highest ground top of a Voxels summary `ground top y LO to HI · …`, or null when the text is not a summary. */
export function summaryTopMax(text: string): number | null {
  const m = /^ground top y (-?\d+) to (-?\d+) · /.exec(text);
  return m === null || !voxelSummaryOk(text) ? null : Number(m[2]);
}

/** The lowest highest-ground-top each preset's Voxels summary must report on its line (SP3e spec §8; none for archipelago). */
export const PRESET_TOP_MIN = { amplified: 250, floating_islands: 193 } as const;

/**
 * A preset's Voxels summary on its line (SP3e spec §8): the summary format, then amplified a ground top ≥ 250 (its
 * review line's top ≥ 250 is asserted by `goldens.sp3e.test.ts`), floating_islands a top ≥ 193 (an island: island
 * voxels lie in y 193-263), archipelago water on the line (its window holds sea and land on the line).
 */
export function presetSummaryOk(preset: SmokePreset, text: string): boolean {
  const top = summaryTopMax(text);
  if (top === null) return false;
  if (preset === 'amplified') return top >= PRESET_TOP_MIN.amplified;
  if (preset === 'floating_islands') return top >= PRESET_TOP_MIN.floating_islands;
  return / · water on /.test(text);
}

/** Column `i` of a 512 × 384 RGBA slice image (row-major), as `getImageData(i, 0, 1, 384).data` reads it: 384 pixels top down. */
export function sliceColumn(rgba: ArrayLike<number>, i: number): number[] {
  if (rgba.length !== 4 * 512 * 384) throw new Error(`a slice image is 512 × 384 RGBA pixels, not ${rgba.length} bytes`);
  if (!Number.isInteger(i) || i < 0 || i > 511) throw new RangeError(`sliceColumn: sample ${i} outside 0 … 511`);
  const out = new Array<number>(4 * 384);
  for (let row = 0; row < 384; row++) for (let c = 0; c < 4; c++) out[4 * row + c] = rgba[4 * (row * 512 + i) + c]!;
  return out;
}

/** A water surface's colour in the Voxels slice image (`VOXEL_COLORS.water`; a unit test keeps them equal). */
export const WATER_RGB = [40, 92, 222] as const;

/** True for a water pixel of the slice image: `WATER_RGB` darkened by a factor in [0.3, 1] (`voxelRgb`'s depth fade). */
export function waterPixel(r: number, g: number, b: number): boolean {
  const f = b / WATER_RGB[2];
  return f >= 0.29 && f <= 1 && Math.abs(r - WATER_RGB[0] * f) <= 1 && Math.abs(g - WATER_RGB[1] * f) <= 1;
}

/** The lowest bottom voxel of an island run (`ISLAND_RUN_MIN_BOTTOM` in `src/core/constants.ts`; a unit test keeps them equal). */
export const ISLAND_MIN_BOTTOM_Y = 181;

/**
 * In one sample column of the Voxels slice image (384 RGBA pixels top down, row 0 at y 319): the highest solid run,
 * when it is an island (its bottom voxel at y ≥ `ISLAND_MIN_BOTTOM_Y`) with only air and water below it down to more
 * ground, and the row of that ground's top voxel (the ground under the island, D21's shadow). Null otherwise.
 */
export function islandOverGround(column: ArrayLike<number>): { readonly islandTop: number; readonly islandBottom: number; readonly groundRow: number } | null {
  if (column.length !== 4 * 384) throw new Error(`a sample column of the slice image is 384 RGBA pixels, not ${column.length} bytes`);
  const sky = (row: number) => column[4 * row] === SKY_RGB[0] && column[4 * row + 1] === SKY_RGB[1] && column[4 * row + 2] === SKY_RGB[2];
  const water = (row: number) => waterPixel(column[4 * row]!, column[4 * row + 1]!, column[4 * row + 2]!);
  let row = 0;
  while (row < 384 && sky(row)) row++;
  if (row === 384 || water(row)) return null;
  const top = row;
  while (row < 384 && !sky(row) && !water(row)) row++;
  const bottom = row - 1;
  if (319 - bottom < ISLAND_MIN_BOTTOM_Y || row === 384) return null;
  while (row < 384 && (sky(row) || water(row))) row++;
  return row === 384 ? null : { islandTop: 319 - top, islandBottom: 319 - bottom, groundRow: row };
}

/** The biome layer's colours (`biomeColor`), with each biome's family, in `SURFACE_BIOMES` order (a unit test keeps them equal). */
export const BIOME_RGB: ReadonlyArray<readonly ['ocean' | 'coast' | 'river' | 'lowland' | 'highland', number]> = [
  ['ocean', 0x1f4f9a], ['ocean', 0x0f2f6a], ['ocean', 0x2a8fb0], ['ocean', 0x8fb4d8],
  ['coast', 0xe8dca0], ['coast', 0xf2f0e6], ['coast', 0x8a8a84],
  ['river', 0x3f76e4], ['river', 0xa0c4f0],
  ['lowland', 0x8db360], ['lowland', 0xa8c96a], ['lowland', 0x3f7a2a], ['lowland', 0x6fa04a], ['lowland', 0x2a4a1c],
  ['lowland', 0x3a6b4a], ['lowland', 0x5a7a6a], ['lowland', 0xe8eef2],
  ['lowland', 0xe0c878], ['lowland', 0xbfb055], ['lowland', 0x4c6b3a], ['lowland', 0x2f8a1e], ['highland', 0xc1653a],
  ['highland', 0x7c8a6a], ['highland', 0xd8e2ea], ['highland', 0x9a9a9a], ['highland', 0xc8d0dc], ['highland', 0xaec4e0],
  ['highland', 0x5a2a24],
];

/**
 * The pixels of an RGBA image whose colour is within `tol` per channel of a biome colour of the ocean family (`ocean`) or
 * of a land family — coast, lowland, highland (`land`); river colours and every other pixel (a tile edge blended by the
 * canvas's scaling, an overlay) count as `other`. The nearest biome colour decides.
 */
export function biomePixels(rgba: ArrayLike<number>, tol = 6): { readonly ocean: number; readonly land: number; readonly other: number } {
  let ocean = 0;
  let land = 0;
  let other = 0;
  for (let k = 0; k + 3 < rgba.length; k += 4) {
    let best = Infinity;
    let family = '';
    for (const [f, c] of BIOME_RGB) {
      const d = Math.max(Math.abs(rgba[k]! - (c >> 16)), Math.abs(rgba[k + 1]! - ((c >> 8) & 255)), Math.abs(rgba[k + 2]! - (c & 255)));
      if (d < best) { best = d; family = f; }
    }
    if (best > tol || family === 'river') other++;
    else if (family === 'ocean') ocean++;
    else land++;
  }
  return { ocean, land, other };
}

/** The biome map region holds both ocean and land: each at least 1 % of its pixels (SP3e spec §8, archipelago's tile). */
export function oceanAndLandOk(counts: { readonly ocean: number; readonly land: number; readonly other: number }): boolean {
  const n = counts.ocean + counts.land + counts.other;
  return n > 0 && counts.ocean >= 0.01 * n && counts.land >= 0.01 * n;
}

/** The number of distinct RGB colours covering at least `minPixels` pixels each (alpha ignored). */
export function distinctColours(rgba: ArrayLike<number>, minPixels = 16): number {
  const n = new Map<number, number>();
  for (let k = 0; k + 3 < rgba.length; k += 4) {
    const c = rgba[k]! * 65536 + rgba[k + 1]! * 256 + rgba[k + 2]!;
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  let out = 0;
  for (const v of n.values()) if (v >= minPixels) out++;
  return out;
}

/** The map region of the preset shots and checks (SP3e spec §8): 4096 × 4096 blocks centred on the window, 16 blocks/px. */
export const PRESET_MAP = { bpp: 16, px: 256 } as const;

/** The five preset screenshots `--shots` writes (SP3e spec §8), in the order they are taken. */
export const PRESET_SHOTS = [
  'preset-archipelago.png', 'preset-amplified.png', 'preset-floating_islands.png', 'preset-archipelago-map.png', 'preset-floating_islands-islandMask.png',
] as const;

/** A page log entry the smoke test does not count: the favicon.ico 404 (index.html declares no icon); shared with measureChrome. */
export { ignoredLog };

/** What is wrong with a downloaded preset file, compared with the draft it was exported from. */
export function presetProblems(text: string, expected: { readonly name: string; readonly profile: string; readonly patch: unknown }): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return [`not JSON: ${e instanceof Error ? e.message : String(e)}`];
  }
  const out: string[] = [];
  if (doc['format'] !== 'wi10-preset') out.push(`format ${JSON.stringify(doc['format'])}`);
  if (doc['name'] !== expected.name) out.push(`name ${JSON.stringify(doc['name'])}`);
  if (doc['profile'] !== expected.profile) out.push(`profile ${JSON.stringify(doc['profile'])}`);
  if (typeof doc['schemaVersion'] !== 'number') out.push(`schemaVersion ${JSON.stringify(doc['schemaVersion'])}`);
  if (!sameJson(doc['params'], expected.patch)) out.push('params differ from the draft\'s patch');
  return out;
}

// ---------------------------------------------------------------- the Density tab steps (SP3d spec §6)

/**
 * Every step in its order: a step title is `<id>: <what>`, and the runner checks that the ids come in this order. The
 * Density steps run after `rule` and before `console`, on the mountain page the rule step opened, so the earlier
 * history and "4 modified" checks are untouched; SP3e's `preset profiles` step (its own id: `presets` is the preset-file
 * step) follows them on pages of its own. SP4a's 3D steps `start`, `world` and `world-mesh` (spec §9.6) come next, on
 * pages of their own, inside `runSmoke`, then SP4b's `stream` (spec §8.6: one step for both renderers, since the runner
 * refuses a repeated id), then SP4c's `overlay` and `overlay-mesh` (spec §8.6: one step per renderer, each on its own
 * page), then SP5a's `build` and `walk` (SP5a spec §6.4, each on its own page); `console` stays last, the closing step
 * main() runs after `runSmoke` (ruling P52).
 */
export const SMOKE_STEPS = [
  'selftest', 'load', 'number', 'knot', 'slider', 'box', 'profile', 'presets', 'undo/redo', 'reload', 'cut line', 'voxels', 'tabs', 'rule',
  'density tab', 'density node', 'density mute', 'density json', 'density narrow', 'density horizontal', 'density drag', 'density times',
  'preset profiles', 'start', 'world', 'world-mesh', 'stream', 'overlay', 'overlay-mesh', 'build', 'walk', 'console',
] as const;
export type SmokeStep = (typeof SMOKE_STEPS)[number];

/** The step id of a step title `<id>: <what>`. */
export function stepId(title: string): SmokeStep {
  const i = title.indexOf(': ');
  if (i < 0) throw new Error(`a step title is "<step>: <what>", not ${JSON.stringify(title)}`);
  const id = title.slice(0, i);
  const step = SMOKE_STEPS.find((s) => s === id);
  if (step === undefined) throw new Error(`${JSON.stringify(id)} is not a smoke step`);
  return step;
}

// ---------------------------------------------------------------- the 3D world steps (SP4a spec §9.6)

/** The smoke Chrome's WebGL2 through SwiftShader, whatever GPU the machine has (SP4a spec §9.6, ruling P4). */
export const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] as const;

/** The `start` step's second URL fragment: `?map`'s encoding of seed 7, the default profile (a unit test decodes it). */
export const START_SEED_7_HASH = `#${mapHash({ ...START, seed: '7' })}`;

/** The render distance of the `world` and `world-mesh` loads: the smallest (spec §8.1), so SwiftShader loads it quickly. */
export const WORLD_RD = 4;

/**
 * The parity view of `world-mesh`: seed 42's spawn (x, z) as `findSpawn` gives it (a unit test pins the literal; this
 * tool cannot import `src/`), with the camera above it looking down across the terrain, so both renderers draw the
 * same opaque, water and sky pixels: 15 blocks above the spawn's ground, pitched 45° down, so the loaded terrain
 * (not the sky or the fog) fills most of the image.
 */
export const PARITY_VIEW = { at: { x: 0, z: 0 }, y: 112, yaw: 45, pitch: -45 } as const;

/**
 * The water parity view of `world-mesh` (final review B-I1): the ocean site of `review-ocean.png` (−939, −782), 11
 * blocks above the sea, looking north-west and 35° down over open water with the shore beside the camera, so both
 * renderers draw translucent water (RegionMesh's water shader, its per-region `renderOrder` and the double-sided
 * two-pass draw) inside RD 4's fog. A unit test checks with the generator's surface estimate that the centre ray meets
 * open water and that land lies near the camera.
 */
export const PARITY_WATER_VIEW = { at: { x: -939, z: -782 }, y: 74, yaw: 311, pitch: -35 } as const;

/** One parity view: its camera, as `?at`, `y`, `yaw` and `pitch` (degrees) give it. */
export type ParityView = { readonly at: { readonly x: number; readonly z: number }; readonly y: number; readonly yaw: number; readonly pitch: number };

/** The views `world-mesh` compares, in order, with the file its RegionMesh image is saved as (--shots). */
export const PARITY_VIEWS: ReadonlyArray<{ readonly name: 'spawn' | 'water'; readonly view: ParityView; readonly file: string }> = [
  { name: 'spawn', view: PARITY_VIEW, file: 'world-mesh.png' },
  { name: 'water', view: PARITY_WATER_VIEW, file: 'world-mesh-water.png' },
];

/** Spec §9.6's parity check: at most 1 % of the pixels may differ by more than 2/255 in a channel. */
export const PARITY_TOL = 2;
export const PARITY_MAX_SHARE = 0.01;

/**
 * The query of one `world-mesh` load: RD 4 at a parity view (the spawn's by default), the section renderer forced, and
 * the capture mode (`shot=1`: no HUD, no overlay, the clock fixed at the opening 08:00; ruling P48).
 */
export function worldMeshQuery(renderer: 'batch' | 'mesh', v: ParityView = PARITY_VIEW): string {
  return `?rd=${WORLD_RD}&renderer=${renderer}&at=${v.at.x},${v.at.z}&y=${v.y}&yaw=${v.yaw}&pitch=${v.pitch}&shot=1`;
}

// ---------------------------------------------------------------- the overlay steps (SP4c spec §8.6)

/** The overlay steps' runs, in order: the step id and the forced section renderer. */
export const OVERLAY_RUNS: ReadonlyArray<{ readonly step: 'overlay' | 'overlay-mesh'; readonly renderer: 'batch' | 'mesh' }> = [
  { step: 'overlay', renderer: 'batch' },
  { step: 'overlay-mesh', renderer: 'mesh' },
];

/** The query of one overlay load: RD 4, the renderer forced, and the page's test hook (`window.__wiTest`). */
export function overlayQuery(renderer: 'batch' | 'mesh'): string {
  return `?rd=${WORLD_RD}&renderer=${renderer}&wiTest=1`;
}

/**
 * The overlay steps' viewport (spec §8.6, 1920 × 1080: each half of mode B 960 px wide, the panel beside the map), set
 * by `Emulation.setDeviceMetricsOverride` and put back to `VIEWPORT` at each step's end, as `density narrow` does.
 */
export const OVERLAY_VIEWPORT = { width: 1920, height: 1080 } as const;
/** The narrowed window of the split check: each half 800 px, under the map's 900 px container query (the panel stacks). */
export const OVERLAY_NARROW_WIDTH = 1600;
/** The review screenshots (`--shots`, spec §8.7): mode A over the world, mode B with the arrow. */
export const OVERLAY_SHOTS = { full: 'review-overlay-full.png', split: 'review-overlay-split.png' } as const;
/** How long the map has to draw its tiles after the first M, without any edit (the replayed source, spec §4.2). */
export const OVERLAY_TILES_MS = 5000;
/** How long the HUD's revealed count has to grow again after a teleport. */
export const OVERLAY_REVEAL_MS = 10_000;
/** How long the world has to settle (the stale count back to 0) after a live edit. */
export const OVERLAY_APPLY_MS = 30_000;

/** Blocks above the surface or the water a teleport arrives at (`LANDING_ABOVE` in `src/ui/world/teleport.ts`; a unit test keeps them equal). */
export const LANDING_ABOVE = 24;
/** The arrival's highest y (`LANDING_MAX_Y` in `src/ui/world/teleport.ts`; a unit test keeps them equal). */
export const LANDING_MAX_Y = 400;

/** The camera's y over a landing as `__wiTest.lastLanding()` reports it (`water` null for −∞): min(400, max(surface, water) + 24). */
export function smokeLandingY(l: { readonly surface: number; readonly water: number | null }): number {
  return Math.min(LANDING_MAX_Y, Math.max(l.surface, l.water ?? Number.NEGATIVE_INFINITY) + LANDING_ABOVE);
}

/** The map's zoom at its first opening in the world, blocks per px (`WORLD_MAP_BPP` in `src/ui/world/mapOverlay.ts`; a unit test keeps them equal). */
export const WORLD_MAP_BPP = 4;
/** How far east of the arrow (the canvas centre) the teleport click lands, CSS px. */
export const TELEPORT_EAST_PX = 300;

/**
 * The block a click at page point `click` targets on the map canvas `canvas` (its page box, DPR 1) showing a view
 * centred on `camera` at `bpp` blocks/px (`screenToWorld`).
 */
export function teleportTarget(camera: { readonly x: number; readonly z: number }, canvas: Box, click: { readonly x: number; readonly y: number }, bpp: number): { readonly x: number; readonly z: number } {
  return { x: camera.x + (click.x - canvas.x - canvas.width / 2) * bpp, z: camera.z + (click.y - canvas.y - canvas.height / 2) * bpp };
}

/** The HUD's "stale n / needed" row (SP4c spec §4.5), or null while the world is not stale. */
export function parseHudStale(text: string): { readonly stale: number; readonly needed: number } | null {
  const m = /^stale (\d+) \/ (\d+)$/m.exec(text);
  return m === null ? null : { stale: Number(m[1]), needed: Number(m[2]) };
}

/** The driver's `lastLatencyMs` as the map toolbar's status prints it (`last edit → preview N ms`), or null before one. */
export function previewMs(status: string): number | null {
  const m = /^last edit → preview (\d+) ms(?: · |$)/.exec(status);
  return m === null ? null : Number(m[1]);
}

/** The world settings' `localStorage` key (`SETTINGS_KEY` in `src/ui/settings.ts`; a unit test keeps them equal). */
export const SETTINGS_KEY = 'wi.world.settings';

/** The stored map mode in the world settings' JSON, or null when there is none or it is not one. */
export function storedMapMode(json: string | null): 'full' | 'split' | null {
  if (json === null) return null;
  try {
    const m = (JSON.parse(json) as { mapMode?: unknown } | null)?.mapMode;
    return m === 'full' || m === 'split' ? m : null;
  } catch {
    return null;
  }
}

/** One listener as CDP's `DOMDebugger.getEventListeners` describes it. */
export interface CdpListener {
  readonly type: string;
  readonly useCapture: boolean;
  readonly scriptId: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

/** A listener's identity for the leak check: its target, type, phase and handler location. */
export function listenerKey(target: 'window' | 'document', l: CdpListener): string {
  return `${target} ${l.type}${l.useCapture ? ' capture' : ''} @${l.scriptId}:${l.lineNumber}:${l.columnNumber}`;
}

/** The listeners added since the baseline and those gone from it (as multisets), each sorted. */
export function listenerDiff(baseline: readonly string[], now: readonly string[]): { readonly added: string[]; readonly gone: string[] } {
  const left = new Map<string, number>();
  for (const k of baseline) left.set(k, (left.get(k) ?? 0) + 1);
  const added: string[] = [];
  for (const k of now) {
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else added.push(k);
  }
  const gone: string[] = [];
  for (const [k, n] of left) for (let i = 0; i < n; i++) gone.push(k);
  return { added: added.sort(), gone: gone.sort() };
}

/**
 * The leak check's verdict on the listeners: nothing added, nothing gone, except that the click hint's
 * `pointerlockchange` listener on the document removes itself once the pointer locks (`worldPage.ts`), so it alone may
 * be gone when the step's lock was granted.
 */
export function listenersLeakFree(diff: { readonly added: readonly string[]; readonly gone: readonly string[] }, lockGranted: boolean): boolean {
  if (diff.added.length > 0) return false;
  if (diff.gone.length === 0) return true;
  return lockGranted && diff.gone.length === 1 && diff.gone[0]!.startsWith('document pointerlockchange @');
}

// ---------------------------------------------------------------- the build and walk steps (SP5a spec §6.4)

/**
 * The `build` page: RD 4 on batch with the test hook, pitched 60° down: the opening −10° from 2 blocks up meets the
 * ground about 11.5 blocks away, past reach 10 (`firstView.ts`); at −60° about 2.3 blocks away.
 */
export const BUILD_QUERY = `?rd=${WORLD_RD}&renderer=batch&wiTest=1&pitch=-60`;
/** The `walk` page: RD 4 on batch with the test hook, facing −z (yaw 0, ruling R30), so W walks the corridor. */
export const WALK_QUERY = `?rd=${WORLD_RD}&renderer=batch&wiTest=1&yaw=0`;
/** The states the steps edit with (`test/stateIds.lock.json`; a unit test keeps them the registry's). */
export const SMOKE_STATE = { air: 0, stone: 1, torch: 32 } as const;
/** A still water source's fluid byte (`WATER_SOURCE` in `src/world/blocks/fluid.ts`; a unit test keeps them equal). */
export const SMOKE_WATER_SOURCE = 16;
/** The hit faces (`FACE_*` in `src/world/blocks/kinds.ts`; a unit test keeps them equal). */
export const SMOKE_FACE = { north: 0, east: 1, south: 2, west: 3, up: 4, down: 5 } as const;
/** The palette's swatches: every `PLACEABLE` type (48) and the 3 buckets (a unit test counts them). */
export const PALETTE_SWATCHES = 51;
/** The least block light beside a torch: it emits 14, and the voxel beside it reads one step less. */
export const TORCH_MIN_LIGHT = 13;
/** The walk's corridor length along −z, past the feet's own row. */
export const WALK_PATH_BLOCKS = 16;
/** How long F has for the feet to reach the ground, how long W is held, the least it moves the feet, and a jump's least rise. */
export const WALK_GROUND_MS = 3000;
export const WALK_HOLD_MS = 4000;
export const WALK_MIN_MOVE = 12;
export const JUMP_MIN_RISE = 1;

/** The voxel across a hit's face: the face's normal added to the hit voxel (as `interaction.ts` places). */
export function acrossFace(hit: { readonly x: number; readonly y: number; readonly z: number; readonly face: number }): { readonly x: number; readonly y: number; readonly z: number } {
  const f = hit.face;
  return {
    x: hit.x + (f === SMOKE_FACE.east ? 1 : f === SMOKE_FACE.west ? -1 : 0),
    y: hit.y + (f === SMOKE_FACE.up ? 1 : f === SMOKE_FACE.down ? -1 : 0),
    z: hit.z + (f === SMOKE_FACE.south ? 1 : f === SMOKE_FACE.north ? -1 : 0),
  };
}

/** The edit count of the HUD's `edit p95 n ms (k)` row (SP5a spec §4.6), or null before the first edit. */
export function parseHudEdits(text: string): number | null {
  const m = /^edit p95 \d+ ms \((\d+)\)$/m.exec(text);
  return m === null ? null : Number(m[1]);
}

/** One voxel the smoke sets through the hook, with no fluid. */
export interface SmokeEdit { readonly x: number; readonly y: number; readonly z: number; readonly state: number }

/**
 * The walk's corridor (ruling R30): 3 voxels wide centred on the feet's block column, from the feet's own row along −z
 * for `length` more rows; in each cell stone at the feet's level − 1 and air in the 2 layers above it. The feet's
 * level is their y rounded (the swept clip can leave them a hair off the block top).
 */
export function walkCorridor(feet: { readonly x: number; readonly y: number; readonly z: number }, length: number): SmokeEdit[] {
  const bx = Math.floor(feet.x);
  const bz = Math.floor(feet.z);
  const gy = Math.round(feet.y);
  const out: SmokeEdit[] = [];
  for (let k = 0; k <= length; k++) {
    for (let dx = -1; dx <= 1; dx++) {
      out.push({ x: bx + dx, y: gy - 1, z: bz - k, state: SMOKE_STATE.stone });
      out.push({ x: bx + dx, y: gy, z: bz - k, state: SMOKE_STATE.air });
      out.push({ x: bx + dx, y: gy + 1, z: bz - k, state: SMOKE_STATE.air });
    }
  }
  return out;
}

/** The walk's feet as `__wiTest.feet()` returns them (null while flying). */
export interface FeetRead {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly onGround: boolean;
  readonly snapPending: boolean;
  readonly snapY: number | null;
}

/**
 * A walking teleport's landing (SP5a spec §3.4, ruling R29): the snap has cleared and set the feet to `height`
 * (`heightAt('motionBlocking')` at the feet's column); over land (`water` null, the landing's) the feet also rest on
 * the ground within 1e-3. Over water `motionBlocking` counts the fluid, so the snapped body sinks: only the snap's y.
 */
export function walkSnapOk(feet: FeetRead | null, height: number | null, water: number | null): boolean {
  if (feet === null || feet.snapPending || height === null || feet.snapY !== height) return false;
  return water !== null || (feet.onGround && Math.abs(feet.y - height) <= 1e-3);
}

// ---------------------------------------------------------------- the stream step (SP4b spec §8.6)

/** The section renderer the page draws with (`selectSectionRenderer`, mirrored: a unit test compares them). */
export function expectedRenderer(forced: 'batch' | 'mesh' | null, multiDraw: boolean): 'batch' | 'mesh' {
  return forced ?? (multiDraw ? 'batch' : 'mesh');
}

/** The `stream` step's runs, in order: the forced renderer and the file its image is saved as (--shots). */
export const STREAM_RUNS: ReadonlyArray<{ readonly renderer: 'batch' | 'mesh'; readonly file: string }> = [
  { renderer: 'batch', file: 'stream.png' },
  { renderer: 'mesh', file: 'stream-mesh.png' },
];

/** How long W is held (ms), and the least horizontal distance the HUD's position must move (12 blocks/s × 4 s ≈ 47). */
export const STREAM_HOLD_MS = 4000;
export const STREAM_MIN_MOVE = 40;
/** The render distance chosen live in the help, and how long the HUD has to show it with more columns revealed. */
export const STREAM_RD = 6;
export const STREAM_RD_MS = 30_000;
/**
 * How long, after W is released, the HUD has to show a larger `revealed` (final review GOV-9): the reveals W triggered
 * can land after a single reading on a slow or loaded machine (SwiftShader runs at about 25 fps), so the step polls.
 */
export const STREAM_REVEAL_MS = 5000;
/** How often `hudOnce` reads the HUD: as often as the HUD refreshes. */
export const HUD_POLL_MS = 250;

/** The query of one `stream` load: RD 4, the section renderer forced, the HUD and the overlay as a person sees them. */
export function streamQuery(renderer: 'batch' | 'mesh'): string {
  return `?rd=${WORLD_RD}&renderer=${renderer}`;
}

/** What the `stream` step reads from the world HUD (`src/ui/hud.ts`). */
export interface HudRead {
  readonly revealed: number;
  /** The target RD (`RD <n> (fog …)`), not the fog's. */
  readonly rd: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const HUD_REVEALED = /(?<![\w-])revealed (\d+)\b/;
const HUD_RD = /^RD (\d+) \(fog /m;
const HUD_POSITION = new RegExp(`^(?:(?:Walk|Fly) · )?x ${NUM} y ${NUM} z ${NUM} ·`, 'm');

/**
 * The world HUD's text, one row per line, as the page shows it: `revealed <n>` on the columns row, `RD <n> (fog …)`
 * and `x … y … z …`, after the mode's `Fly · ` or `Walk · ` since SP5a (SP5a spec §4.6); null unless all three are
 * there.
 */
export function parseHud(text: string): HudRead | null {
  const revealed = HUD_REVEALED.exec(text);
  const rd = HUD_RD.exec(text);
  const at = HUD_POSITION.exec(text);
  if (revealed === null || rd === null || at === null) return null;
  return { revealed: Number(revealed[1]), rd: Number(rd[1]), x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) };
}

/**
 * The HUD's reading once `pred` holds on it, read every HUD_POLL_MS from now (a missing reading is read again), or
 * null when it has not held after `ms`. `clock` is the real one in the tool and a fake in the tests.
 */
export async function hudOnce(
  read: () => Promise<HudRead | null>, pred: (h: HudRead) => boolean, ms: number,
  clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep },
): Promise<HudRead | null> {
  for (const t0 = clock.now(); clock.now() - t0 <= ms; await clock.sleep(HUD_POLL_MS)) {
    const h = await read();
    if (h !== null && pred(h)) return h;
  }
  return null;
}

/** The horizontal distance between two HUD positions, blocks. */
export function hudMoved(a: { readonly x: number; readonly z: number }, b: { readonly x: number; readonly z: number }): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/**
 * Chrome's console error when a page's `beforeunload` guard meets a navigation the tool started without a user gesture:
 * the world page arms its Ctrl+W guard after the reveal (SP4a spec §7.1), and the steps leave each world page (every
 * one loaded with `?rd`) by navigating. It is the guard working, not a page error, so it is ignored for those pages
 * only; the same message from any other page still counts.
 */
export function leaveGuardLog(text: string, url: string | undefined): boolean {
  if (!text.startsWith("Blocked attempt to show a 'beforeunload' confirmation panel") || url === undefined) return false;
  try {
    const u = new URL(url);
    return u.pathname === '/' && u.searchParams.has('rd') && !u.searchParams.has('map');
  } catch {
    return false;
  }
}

/**
 * The share of pixels of two same-sized RGBA images where any channel (alpha included) differs by more than `tol`;
 * 0 for two empty images. Throws RangeError when the lengths differ or are not whole pixels.
 */
export function pixelDiffShare(a: Uint8Array, b: Uint8Array, tol: number): number {
  if (a.length !== b.length) throw new RangeError(`images of ${a.length} and ${b.length} bytes`);
  if (a.length % 4 !== 0) throw new RangeError(`${a.length} bytes are not whole RGBA pixels`);
  const n = a.length / 4;
  if (n === 0) return 0;
  let differ = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i]! - b[i]!) > tol || Math.abs(a[i + 1]! - b[i + 1]!) > tol || Math.abs(a[i + 2]! - b[i + 2]!) > tol || Math.abs(a[i + 3]! - b[i + 3]!) > tol) differ++;
  }
  return differ / n;
}

/** BIOME_SIZE_SCALE[6]: biome-size position 7, where the Density step's drag ends (a unit test keeps them equal). */
export const SIZE_7 = 1.74110112659225;

/** The slice status line of a fresh n² slice with nothing in flight (`sliceStatusText`: `n²`, else `stale` / `slicing …`). */
export function freshSlice(status: string, n: number): boolean {
  return status === `${n}²`;
}

/** The histogram's statistics as the slice view prints them (`histogramLabels`); `below0` in % (one decimal), null when constant. */
export interface SliceStatsText {
  readonly p1: number;
  readonly p50: number;
  readonly p99: number;
  /** The value of a constant field (p1 = p99), else null. */
  readonly constant: number | null;
  readonly below0: number | null;
}

/** A value as `formatSliceValue` prints it, read back. */
const sliceNumber = (t: string): number => (t === '+∞' ? Infinity : t === '−∞' ? -Infinity : Number(t));

/** The statistics of the slice view's histogram text, or null (no finite value, or not that text). */
export function parseSliceStats(text: string): SliceStatsText | null {
  const lines = text.split('\n');
  const c = /^constant (\S+)$/.exec(lines[0] ?? '');
  if (c !== null) {
    const v = sliceNumber(c[1]!);
    return { p1: v, p50: v, p99: v, constant: v, below0: null };
  }
  const m = /^p1 (\S+) · p50 (\S+) · p99 (\S+)$/.exec(lines[0] ?? '');
  const s = /^sd \S+ · < 0: (\d+\.\d) %$/.exec(lines[1] ?? '');
  if (m === null || s === null) return null;
  return { p1: sliceNumber(m[1]!), p50: sliceNumber(m[2]!), p99: sliceNumber(m[3]!), constant: null, below0: Number(s[1]) };
}

/**
 * The islands const edited from −1e6 to `floor` (SP3d spec §6 step 2): the air values are floored there, so p1 becomes
 * `floor` (the slice holds more than 1 % air), and solidity is unchanged, so the share below 0 stays the same.
 */
export function islandsFloorOk(before: SliceStatsText, after: SliceStatsText, floor: number): boolean {
  return after.constant === null && before.below0 !== null && before.p1 < floor && after.p1 === floor && after.below0 === before.below0;
}

/** The slice hover readout `(x, y, z) · <field> <value>` (`sliceHoverText`), read back; null otherwise. */
export function parseSliceReadout(text: string): { readonly x: number; readonly y: number; readonly z: number; readonly field: string; readonly value: string } | null {
  const m = /^\((-?\d+), (-?\d+), (-?\d+)\) · (density|node|blocks|rule) (\S+)$/.exec(text);
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), field: m[4]!, value: m[5]! };
}

/**
 * The slice hover readout and the node form's line `value at the hover: <value> at (x, y, z)` name the same voxel and
 * the same value: the `fieldProbe` job agrees with the slice sample (SP3d spec §3.6, §5.3).
 */
export function hoverAgrees(readout: string, hoverLine: string): boolean {
  const r = parseSliceReadout(readout);
  const m = /^value at the hover: (\S+) at \((-?\d+), (-?\d+), (-?\d+)\)$/.exec(hoverLine);
  return r !== null && m !== null && m[1] === r.value && Number(m[2]) === r.x && Number(m[3]) === r.y && Number(m[4]) === r.z;
}

/**
 * The JSON editor's text of the density tree with the `islands` tap's child op replaced by `bogus` (SP3d spec §6 step
 * 4): the editor then reports `root.b.x: UNKNOWN_OP`. Throws when the text holds no islands tap with an `x` child.
 */
export function brokenIslandsJson(text: string): string {
  const tap = text.indexOf('"name": "islands"');
  const x = tap < 0 ? -1 : text.indexOf('"x": {', tap);
  const op = x < 0 ? -1 : text.indexOf('"op": "', x);
  if (op < 0) throw new Error('the text has no islands tap with an x child');
  const start = op + '"op": "'.length;
  return `${text.slice(0, start)}bogus${text.slice(text.indexOf('"', start))}`;
}

/** An editor issue line `<node path>: CODE — message` at exactly `path` with `code`. */
export function issueLineOk(line: string, path: string, code: string): boolean {
  return line.startsWith(`${path}: ${code} — `);
}

/** The slice extents (`SLICE_EXTENTS`) and the world window's half-size (`WINDOW_HALF`). */
const SLICE_EXTENTS = [256, 512, 1024, 2048, 4096, 8192] as const;
const WINDOW_HALF = 524288;

/**
 * The horizontal plane's centre after a map click at page point (sx, sy) on the map canvas `box` (its page position and
 * its canvas size in px, DPR 1) showing `view` (SP3d spec §3.7): the clicked block, clamped so the square of `extent`
 * stays in the world window, as the page's `withCentre` computes it.
 */
export function clickCentre(view: MapUrlView, box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, sx: number, sy: number, extent: number): [number, number] {
  if (!(SLICE_EXTENTS as readonly number[]).includes(extent)) throw new RangeError(`extent ${extent} is not a slice extent`);
  const h = extent / 2;
  const clamp = (v: number) => Math.min(Math.max(Math.floor(v), -WINDOW_HALF + h), WINDOW_HALF - h);
  return [clamp(view.x + (sx - box.x - box.width / 2) * view.bpp), clamp(view.z + (sy - box.y - box.height / 2) * view.bpp)];
}

/** The horizontal slice's axis end labels for the square of `extent` centred on (cx, cz) (`sliceAxisLabels`). */
export function squareLabels(cx: number, cz: number, extent: number): { readonly left: string; readonly right: string; readonly top: string; readonly bottom: string } {
  const h = extent / 2;
  return { left: `x ${cx - h}`, right: `x ${cx + h}`, top: `z ${cz - h}`, bottom: `z ${cz + h}` };
}

/** The colour of the horizontal plane's square and centre cross on the map (`mapView.ts`; a unit test keeps them equal). */
export const SQUARE_RGB = [127, 211, 236] as const;

/**
 * The pixels of the square's colour (within 24 per channel: antialiased edges) in the (2r + 1)² window around (sx, sy)
 * of an RGBA image `width` px wide, clipped at its edges (the map's centre cross is two 11 px strokes 2 px wide).
 */
export function crossPixels(rgba: ArrayLike<number>, width: number, sx: number, sy: number, r = 7): number {
  const height = Math.floor(rgba.length / (4 * width));
  const x0 = Math.round(sx);
  const y0 = Math.round(sy);
  let count = 0;
  for (let y = Math.max(0, y0 - r); y <= Math.min(height - 1, y0 + r); y++) {
    for (let x = Math.max(0, x0 - r); x <= Math.min(width - 1, x0 + r); x++) {
      const k = 4 * (y * width + x);
      if (SQUARE_RGB.every((c, i) => Math.abs(rgba[k + i]! - c) <= 24)) count++;
    }
  }
  return count;
}

/** The viewport width at which the Density tab (`drawer` px wide at `viewport`) is `want` px wide: the drawer spans the page. */
export function viewportForDrawer(now: { readonly viewport: number; readonly drawer: number }, want: number): number {
  if (!(now.drawer > 0) || !(now.viewport > 0)) throw new RangeError(`no drawer width at viewport ${now.viewport}: ${now.drawer}`);
  return now.viewport - now.drawer + want;
}

/** Wall times as `p50 M ms (a, b, …)`: the nearest-rank median and every run sorted, rounded to the ms. */
export function timesText(ms: readonly number[]): string {
  if (ms.length === 0) throw new RangeError('no times');
  const s = [...ms].sort((a, b) => a - b).map((v) => Math.round(v));
  return `p50 ${s[Math.ceil(s.length / 2) - 1]} ms (${s.join(', ')})`;
}

export interface SmokeArgs {
  readonly build: boolean;
  /** The parent of the temporary Chrome profile (default: the OS temp directory). */
  readonly profileDir: string | null;
  /** Where the spec §12 screenshots go; null: none. */
  readonly shots: string | null;
}

export function parseArgs(argv: readonly string[]): SmokeArgs {
  let build = true;
  let profileDir: string | null = null;
  let shots: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--skip-build') build = false;
    else if (a === '--profile-dir') profileDir = value();
    else if (a === '--shots') shots = value();
    else throw new Error(`unknown argument ${a}`);
  }
  return { build, profileDir, shots };
}

// ---------------------------------------------------------------- the page side (sent as source text)

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface SmokePage {
  /** The URL state, decoded from location.hash. */
  state(): MapUrlState | null;
  status(): string;
  /** The preview has landed and nothing is pending ("last edit → preview N ms"). */
  settled(): boolean;
  /** The World tab's session status. */
  world(): string;
  notices(): string[];
  /** The element's box in CSS px after scrolling it to the middle of its scroll container. */
  box(selector: string): Box | null;
  /** Resolves with the wait in ms once `pred` holds on an animation frame; rejects after `ms`. */
  until(pred: () => boolean, ms: number, what: string): Promise<number>;
  /** As `until`, resolving with `performance.now()` at the frame where `pred` held. */
  untilAt(pred: () => boolean, ms: number, what: string): Promise<number>;
  /** The Density tab's slice view as it reads (SP3d spec §4.3). */
  slice(): SliceRead;
  /** Sets a select's value and fires its change event (headless Chrome has no popup to pick an option from). */
  choose(selector: string, value: string): boolean;
  /** Starts recording every image the slice view draws (its histogram text is rewritten with each), with its size. */
  recordDraws(): boolean;
  /** The draws recorded since `recordDraws`: page time and n (the canvas size). */
  draws(): Array<{ t: number; n: number }>;
  /** The map canvas's RGBA pixels in the (2r + 1)² window around page point (sx, sy) (clipped), and the window's width. */
  mapPixels(sx: number, sy: number, r: number): { rgba: number[]; width: number; cx: number; cy: number };
  /** A PNG (base64) decoded by the browser: its size and its RGBA bytes (base64), unconverted and unpremultiplied. */
  pngRgba(png: string): Promise<{ width: number; height: number; rgba: string }>;
}

/** The slice view's texts (`.sv`): status, histogram, notice, the four axis labels, the controls, readout and canvas size. */
interface SliceRead {
  readonly status: string;
  readonly stats: string;
  readonly notice: string;
  readonly top: string;
  readonly bottom: string;
  readonly left: string;
  readonly right: string;
  readonly plane: string;
  readonly field: string;
  readonly readout: string | null;
  /** The node form's "value at the hover" line, null while hidden. */
  readonly hover: string | null;
  readonly n: number;
}

/** The Density tab's elements the smoke drives (`sliceView.ts`, `densityTab.ts`, `jsonEditor.ts`). */
const SV_PLANE = '.sv > .sv-controls > label:nth-of-type(1) > select';
const SV_FIELD = '.sv > .sv-controls > label:nth-of-type(2) > select';
const SV_EXTENT = '.sv > .sv-controls > label:nth-of-type(4) > select';
const SV_BOX = '.sv > .sv-body .sv-box';
const ROW = (path: string) => `.it-row[title="density.defs.${path}"]`;
const FORM_V = '.it-fields input.it-input[aria-label="v"]';
const JE_TEXT = '.je-text';
const DENSITY_SHOWN = `!document.querySelector('.map-drawer').hidden && document.getElementById('map-drawer-tab-density').getAttribute('aria-selected') === 'true'`;

/**
 * The page helpers, installed as `globalThis.__wiSmoke` on every new document from this function's source: it may
 * use nothing outside its body.
 */
function pageHelpers(): SmokePage {
  const q = (sel: string): HTMLElement | null => (sel.startsWith('#') ? document.getElementById(sel.slice(1)) : document.querySelector<HTMLElement>(sel));
  const drawLog: Array<{ t: number; n: number }> = [];
  let observer: MutationObserver | null = null;
  const untilAt = (pred: () => boolean, ms: number, what: string): Promise<number> => new Promise((resolve, reject) => {
    const t0 = performance.now();
    const step = () => {
      let ok = false;
      try { ok = pred(); } catch { ok = false; }
      const now = performance.now();
      if (ok) resolve(now);
      else if (now - t0 > ms) reject(new Error(`no ${what} within ${ms} ms`));
      else requestAnimationFrame(step);
    };
    step();
  });
  return {
    state() {
      const h = location.hash.slice(1);
      if (h === '') return null;
      try {
        const bin = atob(h.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as MapUrlState;
      } catch {
        return null;
      }
    },
    status: () => q('.map-status')?.textContent ?? '',
    settled() {
      const s = q('.map-status')?.textContent ?? '';
      return /preview \d+ ms/.test(s) && !s.includes('pending') && !s.includes('error');
    },
    world: () => document.querySelector('#map-tabpanel-world .map-readout')?.textContent ?? '',
    notices: () => [...document.querySelectorAll('.map-notices .notice-text')].map((n) => n.textContent ?? ''),
    box(sel) {
      const e = q(sel);
      if (e === null) return null;
      e.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    until(pred, ms, what) {
      const t0 = performance.now();
      return untilAt(pred, ms, what).then((t) => t - t0);
    },
    untilAt,
    slice() {
      const text = (sel: string): string => q(sel)?.textContent ?? '';
      const shown = (sel: string): string | null => { const e = q(sel); return e === null || e.hidden ? null : e.textContent ?? ''; };
      const axes = [...document.querySelectorAll('.sv > .sv-body > .sv-axis')].map((e) => e.textContent ?? '');
      const ends = [...document.querySelectorAll('.sv > .sv-body > .sv-ends > span')].map((e) => e.textContent ?? '');
      return {
        status: text('.sv > .sv-status'), stats: text('.sv > .sv-body .sv-stats'), notice: text('.sv > .sv-notice'),
        top: axes[0] ?? '', bottom: axes[1] ?? '', left: ends[0] ?? '', right: ends[1] ?? '',
        plane: (q('.sv > .sv-controls > label:nth-of-type(1) > select') as HTMLSelectElement | null)?.value ?? '',
        field: (q('.sv > .sv-controls > label:nth-of-type(2) > select') as HTMLSelectElement | null)?.value ?? '',
        readout: shown('.sv > .sv-body .sv-box > .sv-readout'), hover: shown('.it-hover'),
        n: (q('.sv > .sv-body .sv-box > canvas.sv-image') as HTMLCanvasElement | null)?.width ?? 0,
      };
    },
    choose(sel, value) {
      const e = q(sel) as HTMLSelectElement | null;
      if (e === null) throw new Error(`no select ${sel}`);
      if (![...e.options].some((o) => o.value === value && !o.disabled)) throw new Error(`${sel} has no enabled option ${value}`);
      e.focus();
      e.value = value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    recordDraws() {
      drawLog.length = 0;
      observer?.disconnect();
      const stats = q('.sv > .sv-body .sv-stats');
      const canvas = q('.sv > .sv-body .sv-box > canvas.sv-image') as HTMLCanvasElement | null;
      if (stats === null || canvas === null) throw new Error('no slice view');
      observer = new MutationObserver(() => { drawLog.push({ t: performance.now(), n: canvas.width }); });
      observer.observe(stats, { childList: true, characterData: true, subtree: true });
      return true;
    },
    draws: () => drawLog.slice(),
    mapPixels(sx, sy, r) {
      const c = q('.map-canvas') as HTMLCanvasElement;
      const b = c.getBoundingClientRect();
      const cx = Math.round(sx - b.left);
      const cy = Math.round(sy - b.top);
      const x0 = Math.max(0, cx - r);
      const y0 = Math.max(0, cy - r);
      const x1 = Math.min(c.width - 1, cx + r);
      const y1 = Math.min(c.height - 1, cy + r);
      const data = c.getContext('2d')!.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
      return { rgba: Array.from(data), width: x1 - x0 + 1, cx: cx - x0, cy: cy - y0 };
    },
    async pngRgba(png) {
      const bin = atob(png);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      const data = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let text = '';
      for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { width: bmp.width, height: bmp.height, rgba: btoa(text) };
    },
  };
}

// ---------------------------------------------------------------- driving the page

/** One page under test: evaluation, waits and real pointer and key input. */
class Page {
  /** Mouse button state for the moves of a drag. */
  private buttons = 0;
  readonly cdp: Cdp;
  readonly base: string;
  constructor(cdp: Cdp, base: string) {
    this.cdp = cdp;
    this.base = base;
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const ex = r['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
    if (ex !== undefined) throw new Error(`page: ${ex.exception?.description ?? ex.text ?? 'evaluation failed'}`);
    return (r['result'] as { value?: unknown }).value as T;
  }

  /** Waits until the page expression `pred` holds (checked once per animation frame). */
  until(pred: string, what: string, ms = SETTLE_MS): Promise<number> {
    return this.eval<number>(`__wiSmoke.until(() => (${pred}), ${ms}, ${JSON.stringify(what)})`);
  }

  /** Loads `url` as a new document (through about:blank, so that a `?map` hash never becomes a hashchange). */
  async goto(url: string, ready: string): Promise<void> {
    await this.cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await this.cdp.send('Page.navigate', { url });
    for (let i = 0; i < 300; i++) {
      if (await this.eval<boolean>(`typeof __wiSmoke === 'object' && document.readyState === 'complete' && (${ready})`).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`${url} was not ready after 30 s`);
  }

  async reload(ready: string): Promise<void> {
    await this.cdp.send('Page.reload', {});
    await sleep(300);
    for (let i = 0; i < 300; i++) {
      if (await this.eval<boolean>(`typeof __wiSmoke === 'object' && document.readyState === 'complete' && (${ready})`).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error('the page was not ready 30 s after the reload');
  }

  /** As `until`, resolving with the page's `performance.now()` at the frame where `pred` held. */
  untilAt(pred: string, what: string, ms = SETTLE_MS): Promise<number> {
    return this.eval<number>(`__wiSmoke.untilAt(() => (${pred}), ${ms}, ${JSON.stringify(what)})`);
  }

  now(): Promise<number> { return this.eval('performance.now()'); }

  /** The page expression "the slice view shows a fresh n² slice with nothing in flight" (`freshSlice`), and `extra`. */
  static fresh(n: number, extra = 'true'): string {
    return `document.querySelector('.sv > .sv-status').textContent === ${JSON.stringify(`${n}²`)} && (${extra})`;
  }

  slice(): Promise<SliceRead> { return this.eval('__wiSmoke.slice()'); }
  choose(selector: string, value: string): Promise<boolean> { return this.eval(`__wiSmoke.choose(${JSON.stringify(selector)}, ${JSON.stringify(value)})`); }

  state(): Promise<MapUrlState | null> { return this.eval('__wiSmoke.state()'); }
  hash(): Promise<string> { return this.eval('location.hash'); }

  /**
   * After an edit: the URL leaves `before`, then the preview settles and the URL stays the same for 300 ms (the
   * page writes it 200 ms after the last change, so a drag can write intermediate states first).
   */
  async changed(before: string, what: string): Promise<MapUrlState> {
    await this.until(`location.hash !== ${JSON.stringify(before)}`, `URL change after ${what}`, 5000);
    for (let i = 0; i < 20; i++) {
      await this.until('__wiSmoke.settled()', `settled preview after ${what}`);
      const h = await this.hash();
      await sleep(300);
      if ((await this.hash()) === h && (await this.eval<boolean>('__wiSmoke.settled()'))) {
        const s = await this.state();
        if (s === null) throw new Error(`no URL state after ${what}`);
        return s;
      }
    }
    throw new Error(`the URL kept changing after ${what}`);
  }

  async center(selector: string): Promise<{ readonly x: number; readonly y: number; readonly box: Box }> {
    const box = await this.eval<Box | null>(`__wiSmoke.box(${JSON.stringify(selector)})`);
    if (box === null) throw new Error(`no element ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  }

  mouse(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number): Promise<Record<string, unknown>> {
    if (type === 'mousePressed') this.buttons = 1;
    if (type === 'mouseReleased') this.buttons = 0;
    return this.cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' && this.buttons === 0 ? 'none' : 'left', buttons: this.buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }

  async click(selector: string): Promise<void> {
    const c = await this.center(selector);
    await this.clickAt(c.x, c.y);
  }

  /** A drag from (x0, y0) by `steps` moves of (dx, dy), one per animation frame, without the release. */
  async dragBy(x0: number, y0: number, dx: number, dy: number, steps: number): Promise<{ readonly x: number; readonly y: number }> {
    await this.mouse('mouseMoved', x0, y0);
    await this.mouse('mousePressed', x0, y0);
    let x = x0;
    let y = y0;
    for (let i = 0; i < steps; i++) {
      x += dx;
      y += dy;
      await this.mouse('mouseMoved', x, y);
      await sleep(16);
    }
    return { x, y };
  }

  async key(key: string, code: string, keyCode: number, modifiers = 0, text?: string): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(text === undefined ? {} : { text, unmodifiedText: text }) });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  enter(): Promise<void> { return this.key('Enter', 'Enter', 13, 0, '\r'); }
  undoKey(): Promise<void> { return this.key('z', 'KeyZ', 90, 2); }
  redoKey(): Promise<void> { return this.key('z', 'KeyZ', 90, 2 | 8); }
  redoKeyY(): Promise<void> { return this.key('y', 'KeyY', 89, 2); }

  /** Clicks a text field, selects its text and types `text` over it (no commit). */
  async typeInto(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.eval(`(() => { const e = ${selector.startsWith('#') ? `document.getElementById(${JSON.stringify(selector.slice(1))})` : `document.querySelector(${JSON.stringify(selector)})`}; e.select(); return true; })()`);
    await this.cdp.send('Input.insertText', { text });
  }

  /** Moves focus out of every field, so that Ctrl+Z reaches the page's shortcuts (§3.5). */
  blur(): Promise<boolean> { return this.eval('(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)'); }

  /** A PNG of the viewport, or of the page region `clip` (CSS px). */
  async shot(path: string, clip?: Box): Promise<void> {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip === undefined ? {} : { clip: { ...clip, scale: 1 } }) });
    writeFileSync(path, Buffer.from(String(r['data']), 'base64'));
  }

  /** The viewport as a PNG and as its RGBA pixels (decoded by the page's browser), read back from one capture. */
  async capture(): Promise<{ readonly png: Buffer; readonly width: number; readonly height: number; readonly rgba: Uint8Array }> {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const png = String(r['data']);
    const d = await this.eval<{ width: number; height: number; rgba: string }>(`__wiSmoke.pngRgba(${JSON.stringify(png)})`);
    return { png: Buffer.from(png, 'base64'), width: d.width, height: d.height, rgba: new Uint8Array(Buffer.from(d.rgba, 'base64')) };
  }
}

// ---------------------------------------------------------------- the smoke steps

const MAP_READY = `document.querySelector('.map-status') !== null && __wiSmoke.settled()`;

interface Check { readonly step: string; readonly ok: boolean; readonly what: string }

class Smoke {
  readonly checks: Check[] = [];
  /** The steps begun, in order (their ids). */
  readonly ran: SmokeStep[] = [];
  private stepName = '';
  readonly page: Page;
  readonly downloads: string;
  /** The page errors seen so far (exceptions, console errors, failed loads; the favicon 404 aside), appended as they come. */
  readonly errors: readonly string[];
  /** Where the 3D steps save `start.png`, `world.png`, `world-mesh.png` and `world-mesh-water.png` (--shots); null: none. */
  readonly shots: string | null;
  constructor(page: Page, downloads: string, errors: readonly string[], shots: string | null = null) {
    this.page = page;
    this.downloads = downloads;
    this.errors = errors;
    this.shots = shots;
  }

  /** Saves `png` as `name` in the --shots directory, if one was given. */
  save(name: string, png: Buffer): void {
    if (this.shots === null) return;
    mkdirSync(this.shots, { recursive: true });
    const f = join(this.shots, name);
    writeFileSync(f, png);
    console.log(`  saved ${f}`);
  }

  /** Begins the step titled `<id>: <what>`; its id must come after the last one's in SMOKE_STEPS. */
  step(name: string): void {
    const id = stepId(name);
    const last = this.ran.at(-1);
    this.stepName = name;
    console.log(`\n${name}`);
    if (last !== undefined && SMOKE_STEPS.indexOf(id) <= SMOKE_STEPS.indexOf(last)) this.check(false, `step ${id} runs after ${last}, out of SMOKE_STEPS order`);
    this.ran.push(id);
  }

  check(ok: boolean, what: string, detail?: unknown): void {
    this.checks.push({ step: this.stepName, ok, what });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}${ok || detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

const patchOf = (s: MapUrlState): Record<string, unknown> => s.patch as Record<string, unknown>;
const without = (patch: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(patch).filter(([k]) => k !== key));

async function runSmoke(t: Smoke): Promise<void> {
  const p = t.page;

  t.step('selftest: ?selftest=1');
  await p.goto(`${p.base}?selftest=1`, `document.querySelector('h2 + div') !== null`);
  await p.until(`/^[✓✗]/.test(document.querySelector('h2 + div').textContent)`, 'selftest summary', 180000);
  const summary = await p.eval<string>(`document.querySelector('h2 + div').textContent`);
  const goldens = goldenCount(readFileSync(join(ROOT, 'test/goldens.json'), 'utf8'));
  t.check(selftestAllMatch(summary, goldens), `selftest: ${summary} (test/goldens.json holds ${goldens})`, summary);

  t.step('load: ?map at seed 42, default profile, view (0, 0, 64 blocks/px)');
  await p.goto(`${p.base}?map#${mapHash(START)}`, MAP_READY);
  const loaded = await p.state();
  t.check(await p.eval<boolean>('crossOriginIsolated'), 'the page is cross-origin isolated');
  t.check(loaded !== null && sameJson(loaded, START), 'the URL holds the state it was opened with', loaded);
  const world0 = await p.eval<string>('__wiSmoke.world()');
  t.check(world0.includes('seed 42') && world0.includes('profile default\n'), 'the World tab shows seed 42, the default profile and no modified parameter', world0);
  t.check(/^last edit → preview \d+ ms$/.test(await p.eval<string>('__wiSmoke.status()')), `the first preview landed (${await p.eval<string>('__wiSmoke.status()')})`);
  const history: MapUrlState[] = [loaded ?? START];

  t.step('number: rivers.gorgeDepth typed in the Parameters tab');
  await p.click('#map-tab-parameters');
  await p.click('.pp-section[data-path="rivers"] > .pp-section-head > .pp-toggle');
  let before = await p.hash();
  await p.typeInto('#pp-rivers.gorgeDepth', '40');
  await p.enter();
  const s1 = await p.changed(before, 'the gorgeDepth edit');
  t.check(sameJson(s1.patch, { rivers: { gorgeDepth: 40 } }), 'the patch is {rivers: {gorgeDepth: 40}}', s1.patch);
  t.check(await p.eval<boolean>(`document.querySelector('.pp-control[data-path="rivers.gorgeDepth"] .pp-dot').classList.contains('on')`), 'the control shows its modified dot');
  t.check(await p.eval<string>(`document.querySelector('.pp-section[data-path="rivers"] .pp-count').textContent`) === '1 modified', 'the Rivers section counts 1 modified');
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('profile default, 1 modified'), 'the World tab counts 1 modified parameter');
  history.push(s1);

  t.step('knot: a shape.offset knot dragged in the spline drawer');
  await p.click('.pp-section[data-path="shape"] > .pp-section-head > .pp-toggle');
  await p.click('.pp-control[data-path="shape.offset"] .pp-edit');
  t.check(await p.eval<boolean>(`!document.querySelector('.map-drawer').hidden && document.getElementById('map-drawer-tab-spline').getAttribute('aria-selected') === 'true'`), 'Edit opens the drawer on the Spline tab');
  await p.until(`document.querySelector('.sd-stats').dataset.state === 'fresh'`, 'fresh spline statistics');
  t.check(true, `statistics: ${await p.eval<string>(`document.querySelector('.sd-stats').textContent`)}`);
  const knots = await p.eval<Array<{ k: number; nested: boolean; x: number; y: number }>>(`[...document.querySelectorAll('.sd-plot circle.sd-knot')].map((c) => { const r = c.getBoundingClientRect(); return { k: Number(c.dataset.k), nested: c.classList.contains('sd-nested'), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const knot = knots.find((k) => !k.nested) ?? knots[Math.floor(knots.length / 2)]!;
  before = await p.hash();
  const end = await p.dragBy(knot.x, knot.y, 0, -3, 12);
  t.check(await p.eval<boolean>(`document.querySelector('.sd-stats').dataset.state === 'stale'`), `the statistics are stale during the drag of knot ${knot.k}${knot.nested ? ' (nested: x only)' : ''}`);
  await p.mouse('mouseReleased', end.x, end.y);
  const s2 = await p.changed(before, 'the knot drag');
  t.check(patchOf(s2)['shape'] !== undefined && sameJson(without(patchOf(s2), 'shape'), s1.patch), 'the patch gains shape.offset and keeps gorgeDepth', s2.patch);
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('2 modified'), 'the World tab counts 2 modified parameters');
  await p.until(`document.querySelector('.sd-stats').dataset.state === 'fresh'`, 'fresh statistics after the drag');
  t.check(true, 'the statistics are fresh again once the preview settles');
  before = await p.hash();
  await p.undoKey();
  const s2u = await p.changed(before, 'Ctrl+Z after the drag');
  t.check(sameJson(s2u, s1), 'one Ctrl+Z undoes the whole drag', s2u.patch);
  before = await p.hash();
  await p.redoKey();
  const s2r = await p.changed(before, 'Ctrl+Shift+Z');
  t.check(sameJson(s2r, s2), 'Ctrl+Shift+Z redoes it');
  history.push(s2);

  t.step('slider: the biome-size slider dragged from 5 to 8');
  t.check(await p.eval<string>(`document.querySelector('.map-size').value`) === '5', 'the slider starts at 5');
  const sl = await p.center('.map-size');
  before = await p.hash();
  // Press at the thumb of 5, then move right one frame at a time until the slider shows 8.
  const x5 = sl.box.x + 8 + (4 / 9) * (sl.box.width - 16);
  await p.mouse('mouseMoved', x5, sl.y);
  await p.mouse('mousePressed', x5, sl.y);
  let x = x5;
  for (let i = 0; i < 200 && (await p.eval<string>(`document.querySelector('.map-size').value`)) !== '8'; i++) {
    x += 1;
    await p.mouse('mouseMoved', x, sl.y);
    await sleep(16);
  }
  const during = await p.eval<string>('__wiSmoke.status()');
  await p.mouse('mouseReleased', x, sl.y);
  const s3 = await p.changed(before, 'the slider drag');
  t.check(patchOf(s3)['climate'] !== undefined && sameJson(patchOf(s3)['climate'], { scaleMul: SIZE_8 }), `the patch gains climate.scaleMul ${SIZE_8} (status during the drag: ${during})`, s3.patch);
  t.check(await p.eval<string>(`document.querySelector('.map-size').value + '|' + document.querySelector('.map-approx').textContent`) === '8|', 'the slider shows 8 without "≈"');
  before = await p.hash();
  await p.click('.map-toolbar button[title^="Undo"]');
  const s3u = await p.changed(before, 'the toolbar Undo');
  t.check(sameJson(s3u, s2), 'the toolbar Undo takes back the whole drag', s3u.patch);
  before = await p.hash();
  await p.click('.map-toolbar button[title^="Redo"]');
  const s3r = await p.changed(before, 'the toolbar Redo');
  t.check(sameJson(s3r, s3), 'the toolbar Redo puts it back');
  history.push(s3);

  t.step('box: the desert T interval typed in the Biomes tab');
  await p.click('#map-tab-biomes');
  const was = await p.eval<string>(`document.getElementById('bt-desert-T').value`);
  const [lo, hi] = was.split(',').map((v) => Number(v.trim())) as [number, number];
  const mid = Math.round(((lo + hi) / 2) * 100) / 100;
  before = await p.hash();
  await p.typeInto('#bt-desert-T', `${lo}, ${mid}`);
  await p.enter();
  const s4 = await p.changed(before, 'the box edit');
  const table = (patchOf(s4)['biomes'] as { table?: Record<string, { T?: unknown }> } | undefined)?.table;
  t.check(sameJson(table?.['desert']?.T, [lo, mid]), `desert T ${was} → ${lo}, ${mid} in the patch (the whole table, the leaf is atomic)`, table?.['desert']);
  t.check(await p.eval<boolean>(`document.querySelector('.bt-row[data-biome="desert"] .bt-dot').classList.contains('on')`), 'the desert row shows its modified dot');
  await p.until(`document.querySelector('.bs').dataset.state === 'fresh'`, 'fresh biome shares');
  t.check(true, `the share chart is fresh: ${await p.eval<string>(`document.querySelector('.bs-totals').textContent`)}`);
  history.push(s4);

  t.step('profile: switch to large_biomes with 4 modified parameters, then Undo');
  await p.eval(`document.querySelector('.map-toolbar select[title="Profile"]').focus()`);
  await p.key('ArrowDown', 'ArrowDown', 40);
  await p.until(`__wiSmoke.notices().some((n) => n.startsWith('Switching to'))`, 'the inline confirmation', 5000);
  const confirmText = (await p.eval<string[]>('__wiSmoke.notices()')).find((n) => n.startsWith('Switching to'));
  t.check(confirmText === 'Switching to large_biomes clears 4 modified parameters', `the confirmation: ${confirmText}`, confirmText);
  t.check(await p.eval<string>(`document.querySelector('.map-toolbar select[title="Profile"]').value`) === 'default' && sameJson(await p.state(), s4), 'the select and the draft stay on default until Switch');
  before = await p.hash();
  await p.click('.map-notices .notice-confirm');
  const s5 = await p.changed(before, 'Switch');
  t.check(s5.profile === 'large_biomes' && sameJson(s5.patch, {}), 'Switch loads large_biomes with an empty patch', s5);
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('profile large_biomes\n'), 'the World tab shows large_biomes, nothing modified');
  t.check(await p.eval<boolean>(`[...document.querySelectorAll('.map-notices .notice')].some((n) => n.querySelector('.notice-text').textContent === 'profile switched' && n.querySelector('.notice-action')?.textContent === 'Undo')`), 'the notice "profile switched" offers Undo');
  before = await p.hash();
  await p.eval(`[...document.querySelectorAll('.map-notices .notice')].find((n) => n.querySelector('.notice-text').textContent === 'profile switched').querySelector('.notice-action').scrollIntoView(); true`);
  await p.click('.map-notices .notice-action');
  const s5u = await p.changed(before, 'the notice\'s Undo');
  t.check(sameJson(s5u, s4), 'Undo restores default with the 4 modified parameters', s5u);

  t.step('presets: export, apply {} in the patch box, import the exported file');
  await p.click('#map-tab-presets');
  await p.typeInto('#pt-name', 'smoke test');
  t.check(await p.eval<string>(`document.getElementById('pt-name-hint').textContent`) === 'saves smoke test.wi10-preset.json', 'the name hint names the file');
  await p.click('#pt-export');
  const file = join(t.downloads, 'smoke test.wi10-preset.json');
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
  t.check(existsSync(file), `the download arrives: ${file}`);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const problems = presetProblems(text, { name: 'smoke test', profile: 'default', patch: s4.patch });
  t.check(problems.length === 0, 'the file is a wi10-preset with the draft\'s profile and patch', problems);
  t.check(await p.eval<string>(`document.getElementById('pt-export-msg').textContent`) === 'exported smoke test.wi10-preset.json', 'the tab says the file was exported');
  before = await p.hash();
  await p.typeInto('#pt-patch', '{}');
  await p.click('#pt-apply');
  const s6 = await p.changed(before, 'Apply patch {}');
  t.check(s6.profile === 'default' && sameJson(s6.patch, {}), 'Apply replaces the whole patch with {}', s6.patch);
  history.push(s6);
  before = await p.hash();
  const doc = await p.cdp.send('DOM.getDocument', { depth: 0 });
  const node = await p.cdp.send('DOM.querySelector', { nodeId: (doc['root'] as { nodeId: number }).nodeId, selector: '#pt-file' });
  await p.cdp.send('DOM.setFileInputFiles', { nodeId: node['nodeId'], files: [file] });
  const s7 = await p.changed(before, 'the import');
  t.check(sameJson(s7, s4), 'the import loads the exported draft', s7.patch);
  t.check(await p.eval<string>(`document.getElementById('pt-import-msg').textContent`) === 'imported smoke test.wi10-preset.json', 'the tab says the file was imported');
  t.check((await p.eval<string[]>('__wiSmoke.notices()')).includes('loaded preset smoke test'), 'the notice "loaded preset smoke test"');
  history.push(s7);

  t.step(`undo/redo: Ctrl+Z through the ${history.length - 1} steps, then Ctrl+Shift+Z and Ctrl+Y back`);
  await p.blur();
  for (let i = history.length - 2; i >= 0; i--) {
    before = await p.hash();
    await p.undoKey();
    const s = await p.changed(before, `Ctrl+Z to step ${i}`);
    t.check(sameJson(s, history[i]), `Ctrl+Z → step ${i}: ${canonicalJson(s.patch).length} bytes of patch`, s.patch);
  }
  t.check(await p.eval<boolean>(`document.querySelector('.map-toolbar button[title^="Undo"]').disabled`), 'Undo is disabled at the first step');
  for (let i = 1; i < history.length; i++) {
    before = await p.hash();
    if (i % 2 === 1) await p.redoKey();
    else await p.redoKeyY();
    const s = await p.changed(before, `redo to step ${i}`);
    t.check(sameJson(s, history[i]), `${i % 2 === 1 ? 'Ctrl+Shift+Z' : 'Ctrl+Y'} → step ${i}`, s.patch);
  }
  t.check(await p.eval<boolean>(`document.querySelector('.map-toolbar button[title^="Redo"]').disabled`), 'Redo is disabled at the last step');

  t.step('reload: the draft, the controls and the layout come back');
  const final = await p.state();
  const typed = await p.eval<string>(`document.getElementById('bt-desert-T').value`);
  await p.reload(MAP_READY);
  t.check(sameJson(await p.state(), final), 'the URL state survives the reload');
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('profile default, 4 modified'), 'the World tab counts 4 modified parameters');
  t.check(await p.eval<string>(`document.getElementById('pp-rivers.gorgeDepth').value`) === '40', 'the gorgeDepth field shows 40');
  t.check(await p.eval<string>(`document.querySelector('.map-size').value`) === '8', 'the slider shows 8');
  t.check(await p.eval<string>(`document.getElementById('bt-desert-T').value`) === typed, `the desert T field shows ${typed}`);
  t.check(await p.eval<boolean>(`document.getElementById('map-tab-presets').getAttribute('aria-selected') === 'true' && !document.getElementById('pp-section-rivers').hidden && !document.getElementById('pp-section-shape').hidden`), 'the Presets tab and the open sections are restored from the stored layout');

  t.step('cut line: two clicks on the map, then the Cross-section tab');
  await p.click('.map-cut');
  t.check(await p.eval<string>(`document.querySelector('.map-cut').textContent`) === 'Cut line: click A', 'Cut line arms the tool');
  const cv = await p.center('.map-canvas');
  await p.clickAt(cv.x - 200, cv.y);
  await p.clickAt(cv.x + 200, cv.y);
  t.check(await p.eval<boolean>(`!document.querySelector('.map-drawer').hidden && document.getElementById('map-drawer-tab-section').getAttribute('aria-selected') === 'true'`), 'the second click opens the drawer on the Cross-section tab');
  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh cross-section');
  const line = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  t.check(/^A \(-?\d+, -?\d+\) → B \(-?\d+, -?\d+\) · [\d ]+ blocks$/.test(line), `the line: ${line}`, line);
  t.check(true, `the profile: ${await p.eval<string>(`document.querySelector('.cs-summary').textContent`)}`);

  t.step('voxels: the Cross-section tab\'s Voxels mode');
  await p.click('.cs-mode[data-mode="voxels"]');
  t.check(await p.eval<boolean>(`document.querySelector('.cs-mode[data-mode="voxels"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.cs').dataset.mode === 'voxels'`), 'the toggle selects Voxels');
  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice');
  const sliceSum = await p.eval<string>(`document.querySelector('.cs-summary').textContent`);
  t.check(voxelSummaryOk(sliceSum), `the slice: ${sliceSum}`, sliceSum);
  const colours = await p.eval<number>(`(() => { const c = document.querySelector('.cs-voxels'); if (c.hidden || c.width !== 512 || c.height !== 384) return -1; const d = c.getContext('2d').getImageData(0, 0, 512, 384).data; const s = new Set(); for (let k = 0; k < d.length; k += 4) s.add(d[k] * 65536 + d[k + 1] * 256 + d[k + 2]); return s.size; })()`);
  t.check(colours >= 3, `the 512 × 384 slice shows ${colours} colours (air, stone and bedrock at least)`, colours);
  const legendWant = voxelLegendLabels(readFileSync(join(ROOT, 'test/stateIds.lock.json'), 'utf8'));
  const legendGot = await p.eval<string[]>(`(() => { const l = document.querySelector('.cs-voxel-legend'); return l === null || l.hidden ? [] : [...l.querySelectorAll('.cs-key')].map((k) => k.textContent); })()`);
  t.check(sameJson(legendGot, legendWant), `the legend keys the ${legendWant.length - 2} registry states, water and the sea line (SP3c spec §6)`, legendGot);
  const covered = await p.eval<string[]>(`[...document.querySelectorAll('.cs-plot rect, .cs-plot path')].filter((e) => getComputedStyle(e).fill !== 'none').map((e) => e.getAttribute('class'))`);
  t.check(covered.length === 0, 'nothing in the SVG over the slice is filled', covered);
  const vox = await p.center('.cs-voxels');
  await p.mouse('mouseMoved', vox.x, vox.box.y + vox.box.height * 0.8);
  const voxRead = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
  t.check(voxelReadoutOk(voxRead), `hover: ${voxRead}`, voxRead);
  await p.mouse('mouseMoved', vox.x, vox.box.y - 200);
  await p.click('.cs-mode[data-mode="profile"]');
  await p.until(`document.querySelector('.cs').dataset.mode === 'profile' && document.querySelector('.cs').dataset.state === 'fresh'`, 'the profile again');
  t.check(await p.eval<boolean>(`document.querySelector('.cs-voxels').hidden && document.querySelector('.cs-plot .cs-offset') !== null`), 'Profile shows the profile again (kept for the same draft)');

  t.step('tabs: the arrow keys, Home and End on both tab bars');
  const shown = (bar: string) => p.eval<string>(`(() => { const s = document.querySelector('${bar} [aria-selected="true"]'); return s === document.activeElement && s.tabIndex === 0 && !document.getElementById(s.getAttribute('aria-controls')).hidden ? s.id : 'focus ' + document.activeElement?.id + ', selected ' + s?.id; })()`);
  await p.eval<boolean>(`(document.getElementById('map-tab-presets').focus(), true)`);
  for (const [name, key, code, keyCode, want] of [
    ['ArrowRight', 'ArrowRight', 'ArrowRight', 39, 'map-tab-world'], ['ArrowRight', 'ArrowRight', 'ArrowRight', 39, 'map-tab-parameters'],
    ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 37, 'map-tab-world'], ['End', 'End', 'End', 35, 'map-tab-presets'], ['Home', 'Home', 'Home', 36, 'map-tab-world'],
  ] as const) {
    await p.key(key, code, keyCode);
    const got = await shown('.map-tabs');
    t.check(got === want, `${name} on the side panel's tabs selects and focuses ${want}`, got);
  }
  await p.eval<boolean>(`(document.getElementById('map-drawer-tab-section').focus(), true)`);
  await p.key('ArrowLeft', 'ArrowLeft', 37);
  const toSpline = await shown('.map-drawer-tabs');
  t.check(toSpline === 'map-drawer-tab-spline', 'ArrowLeft on the drawer\'s Cross-section tab shows Spline', toSpline);
  await p.key('ArrowRight', 'ArrowRight', 39);
  const toSection = await shown('.map-drawer-tabs');
  t.check(toSection === 'map-drawer-tab-section', 'ArrowRight shows Cross-section again', toSection);

  t.step('rule: the hover rule id of a land top on the mountain line (SP3c spec §6)');
  const { text: lineText, summary: mountain } = await openMountainVoxels(p);
  t.check(mountainSummaryOk(mountain), `the mountain line ${lineText}: ${mountain}`, mountain);
  const hover = await hoverTopRule(p);
  t.check(hover !== null, `sample ${RULE_SAMPLE} has a ground top (row ${hover?.row ?? '-'}, y ${hover === null ? '-' : 319 - hover.row})`);
  if (hover !== null) {
    t.check(hover.firstOk, `hover on the top voxel: ${hover.first}`, hover.first);
    t.check(hover.ruledOk, `the rule of the land top: ${hover.ruled}`, hover.ruled);
  }

  await runDensity(t);
  await runPresetProfiles(t);
  await runWorld(t);
  await runOverlay(t);
  await runBuild(t);
  await runWalk(t);
}

const statsOf = (s: SliceRead): SliceStatsText | null => parseSliceStats(s.stats);

/**
 * The pointer on the live slice at (fx, fy) of its box (fractions), until the slice readout and the node form's "value
 * at the hover" line (the `fieldProbe` job) both show a value; then the pointer leaves the box. Null when they do not.
 */
async function hoverSlice(p: Page, fx: number, fy: number, leave = true): Promise<{ readonly readout: string; readonly hover: string } | null> {
  const box = await p.center(SV_BOX);
  await p.mouse('mouseMoved', box.box.x + fx * box.box.width, box.box.y + fy * box.box.height);
  try {
    await p.until(`(() => { const s = __wiSmoke.slice(); return s.readout !== null && s.hover !== null && !s.hover.includes('…') && s.hover.endsWith(s.readout.slice(0, s.readout.indexOf(')') + 1)); })()`, 'the slice readout and the value at the hover', 10000);
  } catch {
    return null;
  }
  const s = await p.slice();
  if (leave) await p.mouse('mouseMoved', box.box.x - 40, box.box.y - 40);
  return s.readout === null || s.hover === null ? null : { readout: s.readout, hover: s.hover };
}
const sliceLabels = (s: SliceRead) => ({ left: s.left, right: s.right, top: s.top, bottom: s.bottom });

/**
 * The Density tab's steps (SP3d spec §6 steps 1-7), on the mountain page the rule step opened: the mountain line drawn,
 * the drawer on Cross-section, nothing modified.
 */
async function runDensity(t: Smoke): Promise<void> {
  const p = t.page;
  const { view: mv, a, b } = MOUNTAIN_LINE;
  const startState = await p.state();

  t.step('density tab: the Density tab with the mountain cut line drawn, the field set to density');
  await p.click('#map-drawer-tab-density');
  t.check(await p.eval<boolean>(DENSITY_SHOWN), 'the drawer shows the Density tab');
  t.check((await p.slice()).plane === 'vertical', 'the first show is the vertical plane (a line exists, §3.7)');
  await p.choose(SV_FIELD, 'density');
  await p.until(Page.fresh(128), 'a fresh 128² density slice');
  const s0 = await p.slice();
  t.check(s0.field === 'density' && s0.n === 128, `field ${s0.field}, ${s0.status}`, s0);
  t.check(s0.left === `A (${a[0]}, ${a[1]})` && s0.right.startsWith(`B (${b[0]}, ${b[1]}) · `) && s0.top === 'y 319' && s0.bottom === 'y -64', `along the line: ${s0.left} … ${s0.right}, ${s0.top} … ${s0.bottom}`, sliceLabels(s0));
  const st0 = statsOf(s0);
  t.check(st0 !== null && st0.constant === null && st0.p1 < -10 && st0.p99 > 0, `the histogram: ${s0.stats.replace(/\n/g, ' · ')}`, s0.stats);
  const hovered = await hoverSlice(p, 0.4, 0.5);
  t.check(hovered !== null && hoverAgrees(hovered.readout, hovered.hover), `the slice hover and the form's value at the hover agree (probe == slice): ${hovered?.readout ?? '-'} | ${hovered?.hover ?? '-'}`, hovered);
  const rows0 = await p.eval<string[]>(`[...document.querySelectorAll('.it-row')].map((r) => r.title + ' ' + r.textContent)`);
  t.check(rows0.length > 0, `${rows0.length} tree rows`);

  t.step('density node: the islands const root.b.x edited from -1e6 to -10, committed by a click on the root row (no Enter)');
  await p.click(`${ROW('root.b.x')} .it-node`);
  t.check(await p.eval<string>(`document.querySelector('.it-path').textContent`) === 'density.defs.root.b.x', 'the row selects root.b.x');
  t.check(await p.eval<string>(`document.querySelector(${JSON.stringify(FORM_V)}).value`) === '-1000000', 'the form shows v -1000000');
  let before = await p.hash();
  await p.typeInto(FORM_V, '-10');
  // The mousedown blurs the field, whose change commits (the tree's rows change); the click must still reach the row
  // (SP3d final review: the re-rendered rows swallowed it).
  await p.click(`${ROW('root')} .it-node`);
  const n1 = await p.changed(before, 'the islands edit');
  t.check(await p.eval<string>(`document.querySelector('.it-path').textContent`) === 'density.defs.root'
    && await p.eval<string | null>(`document.querySelector('.it-node[aria-current]')?.closest('.it-row')?.title ?? null`) === 'density.defs.root',
  `one click on the root row after the blur commit selects the root (the form: ${await p.eval<string>(`document.querySelector('.it-path').textContent`)})`);
  const tree1 = (patchOf(n1)['density'] as { defs?: { root?: { b?: { x?: { v?: unknown } } } } } | undefined)?.defs;
  t.check(tree1?.root?.b?.x?.v === -10 && Object.keys(patchOf(n1)).join() === 'density', 'the patch holds the edited density tree (islands -10)', patchOf(n1));
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body .sv-stats').textContent !== ${JSON.stringify(s0.stats)}`), 'the density slice after the edit');
  const s1 = await p.slice();
  const st1 = statsOf(s1);
  t.check(st0 !== null && st1 !== null && islandsFloorOk(st0, st1, -10), `the air is floored at -10, solidity unchanged: ${s1.stats.replace(/\n/g, ' · ')}`, s1.stats);

  t.step('density mute: the terrain tap muted from its row, the root selected and the field on selected');
  await p.click(`${ROW('root')} .it-node`);
  await p.choose(SV_FIELD, 'selected');
  await p.until(Page.fresh(128, `document.querySelector('.it-path').textContent === 'density.defs.root'`), 'a fresh slice of the selected root');
  const s1sel = await p.slice();
  t.check(s1sel.stats === s1.stats, `the selected root's slice is the density's: ${s1sel.stats.replace(/\n/g, ' · ')}`, s1sel.stats);
  before = await p.hash();
  await p.click(`${ROW('root.a.a')} .it-mute`);
  const n2 = await p.changed(before, 'the mute');
  const tree2 = (patchOf(n2)['density'] as { defs?: { root?: { a?: { a?: { mute?: unknown } }; b?: { x?: { v?: unknown } } } } } | undefined)?.defs;
  t.check(tree2?.root?.a?.a?.mute === 0 && tree2.root.b?.x?.v === -10, 'the patch mutes terrain to 0 (its parent is an add) and keeps islands -10', tree2);
  t.check(await p.eval<boolean>(`document.querySelector(${JSON.stringify(ROW('root.a.a'))}).classList.contains('it-muted')`), `the row reads muted: ${await p.eval<string>(`document.querySelector(${JSON.stringify(ROW('root.a.a'))}).textContent`)}`);
  const current = await p.eval<string | null>(`document.querySelector('.it-node[aria-current]')?.closest('.it-row')?.title ?? null`);
  t.check(current === 'density.defs.root' && await p.eval<string>(`document.querySelector('.it-path').textContent`) === 'density.defs.root',
    `the row's mute keeps the selection on the root (the current row: ${current ?? 'none'})`);
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body .sv-stats').textContent !== ${JSON.stringify(s1.stats)}`), 'the selected root\'s slice after the mute');
  const s2sel = await p.slice();
  await p.choose(SV_FIELD, 'density');
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body .sv-stats').textContent !== ${JSON.stringify(s1.stats)}`), 'the density slice after the mute');
  const s2 = await p.slice();
  t.check(s2.stats !== s1.stats && s2sel.stats === s2.stats, `the slice changed, and the selected root's equals the density's: ${s2.stats.replace(/\n/g, ' · ')}`, [s2sel.stats, s2.stats]);
  const href2 = await p.eval<string>('location.href');
  const hash2 = await p.hash();
  t.check(hash2.length - 1 <= 65536 && !(await p.eval<string[]>('__wiSmoke.notices()')).some((n) => n.includes('too large for the URL')),
    `the URL with the edited density tree: ${href2.length} characters (hash ${hash2.length - 1}), under the 64 KiB cap`);

  t.step('density json: a broken JSON in the editor, Escape, then the toolbar Undo twice');
  const printed = await p.eval<string>(`document.querySelector('${JE_TEXT}').value`);
  t.check(await p.eval<string>(`document.querySelector('.je-status').dataset.status`) === 'clean', 'the editor holds the current tree, clean');
  before = await p.hash();
  await p.click(JE_TEXT);
  await p.eval(`(document.querySelector('${JE_TEXT}').select(), true)`);
  await p.cdp.send('Input.insertText', { text: brokenIslandsJson(printed) });
  await p.until(`document.querySelector('.je-status').dataset.status === 'invalid'`, 'the editor\'s verdict', 5000);
  const issues = await p.eval<string[]>(`[...document.querySelectorAll('.je-issues .je-issue')].map((e) => e.textContent)`);
  t.check(issues.length === 1 && issueLineOk(issues[0]!, 'root.b.x', 'UNKNOWN_OP'), `the issue: ${issues.join(' | ')}`, issues);
  const s3 = await p.slice();
  t.check((await p.hash()) === before && await p.eval<boolean>('__wiSmoke.settled()') && freshSlice(s3.status, 128) && s3.stats === s2.stats,
    `the map stays drawn: the session, the URL and the slice are unchanged (${await p.eval<string>('__wiSmoke.status()')})`);
  await p.key('Escape', 'Escape', 27);
  t.check(await p.eval<boolean>(`document.querySelector('.je-status').dataset.status === 'clean' && document.querySelector('${JE_TEXT}').value === ${JSON.stringify(printed)}`), 'Escape reverts the buffer: clean');
  t.check(await p.eval<boolean>(DENSITY_SHOWN), 'the drawer stays on Density after Escape');
  await p.blur();
  for (const what of ['the mute', 'the islands edit']) {
    before = await p.hash();
    await p.click('.map-toolbar button[title^="Undo"]');
    await p.changed(before, `the toolbar Undo of ${what}`);
  }
  t.check(sameJson(await p.state(), startState), 'both edits are undone: the URL holds the page\'s start state', await p.state());
  const rows = await p.eval<string[]>(`[...document.querySelectorAll('.it-row')].map((r) => r.title + ' ' + r.textContent)`);
  t.check(sameJson(rows, rows0) && await p.eval<number>(`document.querySelectorAll('.it-row.it-muted').length`) === 0
    && await p.eval<string>(`document.querySelector(${JSON.stringify(`${ROW('root.b.x')} .it-summary`)}).textContent`) === 'const -1000000', 'the tree rows show the default (islands -1000000, nothing muted)');
  t.check(await p.eval<string>(`document.querySelector('.je-status').dataset.status`) === 'clean', 'the buffer is clean');
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body .sv-stats').textContent === ${JSON.stringify(s0.stats)}`), 'the default slice again');
  t.check(true, 'the slice is the first one again (same histogram)');

  t.step('density narrow: the tab 1,000 px wide (Slice/JSON sub-tabs), a row selected under Slice, then the JSON sub-tab');
  // The root selected first, in the grid: its text starts the buffer, so the editor is scrolled to the top.
  await p.click(`${ROW('root')} .it-node`);
  await p.until(`document.querySelector('${JE_TEXT}').scrollTop === 0`, 'the editor scrolled to the root', 5000);
  let narrow: number = VIEWPORT.width;
  for (let i = 0; i < 4; i++) {
    const drawer = await p.eval<number>(`Math.round(document.querySelector('.it').getBoundingClientRect().width)`);
    if (drawer === 1000) break;
    narrow = viewportForDrawer({ viewport: narrow, drawer }, 1000);
    await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: narrow, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  }
  await p.until(`document.querySelector('.it').dataset.layout === 'tabs'`, 'the Slice/JSON sub-tabs at 1,000 px', 10000);
  t.check(await p.eval<boolean>(`document.querySelector('.it-json').hidden && !document.querySelector('.it-slice').hidden && document.querySelector('.it-subtabs button[aria-selected="true"]').textContent === 'Slice'`),
    `viewport ${narrow} px: the tab is ${await p.eval<number>(`Math.round(document.querySelector('.it').getBoundingClientRect().width)`)} px wide, the Slice sub-tab shown first`);
  await p.click(`${ROW('root.b.x')} .it-node`);
  await p.click('.it-subtabs button:nth-of-type(2)');
  await sleep(300);
  /** The highlighted node's text against the editor's view: its line's top in the text, the view's top and height. */
  const MARK_IN_VIEW = `(() => { const t = document.querySelector('${JE_TEXT}'); const pre = document.querySelector('.je-mirror'); const m = pre.querySelector('mark'); const tr = t.getBoundingClientRect(); const mr = m.getBoundingClientRect(); return { line: Math.round(mr.top - pre.getBoundingClientRect().top + pre.scrollTop), scroll: t.scrollTop, height: t.clientHeight, inView: m.textContent.length > 0 && mr.top >= tr.top - 1 && mr.top + 16 <= tr.bottom + 1 }; })()`;
  const mark1 = await p.eval<{ line: number; scroll: number; height: number; inView: boolean }>(MARK_IN_VIEW);
  t.check(!(await p.eval<boolean>(`document.querySelector('.it-json').hidden`)) && mark1.line > mark1.height && mark1.inView,
    `the JSON sub-tab shows root.b.x's highlighted text (its line at ${mark1.line} px, below the first view of ${mark1.height} px): scrolled to ${mark1.scroll} px`, mark1);
  await p.click('.it-subtabs button:nth-of-type(1)');
  await sleep(200);
  await p.click('.it-subtabs button:nth-of-type(2)');
  await sleep(300);
  const mark2 = await p.eval<{ line: number; scroll: number; height: number; inView: boolean }>(MARK_IN_VIEW);
  t.check(mark2.inView && mark2.scroll === mark1.scroll, `a Slice/JSON switch keeps the text's scroll (${mark2.scroll} px)`, mark2);
  await p.click('.it-subtabs button:nth-of-type(1)');
  await p.click(`${ROW('root')} .it-node`);
  await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await p.until(`document.querySelector('.it').dataset.layout === 'grid'`, 'the grid layout again', 10000);
  await p.until(Page.fresh(128), 'a fresh slice in the grid layout');

  t.step('density horizontal: the horizontal plane, a map click moves its centre, a cut line drawn with Density shown');
  await p.choose(SV_PLANE, 'horizontal');
  const sq0 = squareLabels(Math.floor(mv.x), Math.floor(mv.z), 2048);
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body > .sv-ends > span').textContent === ${JSON.stringify(sq0.left)}`), 'a fresh horizontal slice at the view centre');
  t.check(sameJson(sliceLabels(await p.slice()), sq0), `the square of 2048 at the view's centre (${Math.floor(mv.x)}, ${Math.floor(mv.z)})`, sliceLabels(await p.slice()));
  const mapBox = await p.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const c = document.querySelector('.map-canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: c.width, height: c.height }; })()`);
  const mid = [mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2] as const;
  const cross = async (sx: number, sy: number): Promise<number> => {
    const w = await p.eval<{ rgba: number[]; width: number; cx: number; cy: number }>(`__wiSmoke.mapPixels(${sx}, ${sy}, 7)`);
    return crossPixels(w.rgba, w.width, w.cx, w.cy);
  };
  const cross0 = await cross(mid[0], mid[1]);
  t.check(cross0 >= 4, `the square's centre cross is drawn at the view centre (${cross0} px; the cut line covers its horizontal arm)`);
  const click = [Math.round(mid[0] + 150), Math.round(mid[1] + 80)] as const;
  const centre = clickCentre(mv, mapBox, click[0], click[1], 2048);
  const sq1 = squareLabels(centre[0], centre[1], 2048);
  await p.clickAt(click[0], click[1]);
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body > .sv-ends > span').textContent === ${JSON.stringify(sq1.left)}`), 'a fresh slice at the clicked centre');
  t.check(sameJson(sliceLabels(await p.slice()), sq1), `the click moves the centre to (${centre[0]}, ${centre[1]}) and a fresh 128² slice arrives`, sliceLabels(await p.slice()));
  await sleep(300);
  const crossNew = await cross(click[0], click[1]);
  const crossOld = await cross(mid[0], mid[1]);
  t.check(crossNew >= 8 && crossOld < 3, `the square overlay follows: its centre cross at the click (${crossNew} px), none at the old centre (${crossOld} px)`);
  const lineBefore = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  await p.click('.map-cut');
  await p.clickAt(Math.round(mid[0] - 120), Math.round(mid[1] - 60));
  await p.clickAt(Math.round(mid[0] + 120), Math.round(mid[1] - 60));
  t.check(await p.eval<boolean>(DENSITY_SHOWN), 'a cut line drawn while Density is shown keeps Density shown (§3.7)');
  const lineAfter = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  t.check(lineAfter !== lineBefore && parseSegment(lineAfter) !== null, `the new line: ${lineAfter}`, lineAfter);
  t.check((await p.slice()).plane === 'horizontal', 'the plane stays horizontal');

  t.step('density drag: the biome-size slider dragged 5 → 6, held, then → 7, with Density shown');
  t.check(await p.eval<string>(`document.querySelector('.map-size').value`) === '5', 'the slider starts at 5');
  const sl = await p.center('.map-size');
  before = await p.hash();
  await p.eval('__wiSmoke.recordDraws()');
  let x = sl.box.x + 8 + (4 / 9) * (sl.box.width - 16);
  await p.mouse('mouseMoved', x, sl.y);
  await p.mouse('mousePressed', x, sl.y);
  const pressedAt = await p.now();
  const moveTo = async (value: string): Promise<void> => {
    for (let i = 0; i < 200 && (await p.eval<string>(`document.querySelector('.map-size').value`)) !== value; i++) {
      x += 1;
      await p.mouse('mouseMoved', x, sl.y);
      await sleep(16);
    }
  };
  await moveTo('6');
  const at6 = await p.now();
  let draftAt: number | null = null;
  try {
    draftAt = await p.untilAt(`__wiSmoke.draws().some((d) => d.n === 32 && d.t > ${at6})`, 'a draft drawn while the slider is held at 6', 15000);
  } catch { draftAt = null; }
  await moveTo('7');
  const releasedAt = await p.now();
  await p.mouse('mouseReleased', x, sl.y);
  const s6 = await p.changed(before, 'the slider drag');
  const during = (await p.eval<Array<{ t: number; n: number }>>('__wiSmoke.draws()')).filter((d) => d.t > pressedAt && d.t < releasedAt);
  t.check(sameJson(patchOf(s6), { climate: { scaleMul: SIZE_7 } }), `the patch gains climate.scaleMul ${SIZE_7}`, s6.patch);
  t.check(during.some((d) => d.n === 32), `drafts drawn during the drag: ${during.filter((d) => d.n === 32).length} of 32², ${during.filter((d) => d.n === 128).length} of 128²${draftAt === null ? '' : `; the first draft ${Math.round(draftAt - at6)} ms after the slider reached 6`}`, during);
  await p.until(Page.fresh(128), 'a fresh slice after the drag');

  t.step('density times: the URL length and the browser wall times of the 128² slices');
  const workers = /workers (\d+)/.exec(await p.eval<string>('__wiSmoke.world()'))?.[1] ?? '?';
  await p.click(`${ROW('root.b.x')} .it-node`);
  /** The time from a control change to the fresh 128² slice (the draft first), in the page's clock. */
  const timeChange = async (selector: string, value: string, extra: string): Promise<number> => {
    const t0 = await p.eval<number>(`(() => { const t0 = performance.now(); __wiSmoke.choose(${JSON.stringify(selector)}, ${JSON.stringify(value)}); return t0; })()`);
    return (await p.untilAt(Page.fresh(128, extra), `a fresh 128² slice after ${selector} = ${value}`)) - t0;
  };
  /** The time from a typed islands value (Enter) to the fresh 128² slice of the new session epoch. */
  const timeEdit = async (v: string): Promise<number> => {
    await p.typeInto(FORM_V, v);
    const t0 = await p.now();
    await p.enter();
    await p.until(`!(${Page.fresh(128)})`, 'the slice going stale after the edit', 5000);
    return (await p.untilAt(Page.fresh(128), `a fresh 128² slice after islands ${v}`)) - t0;
  };
  // The vertical slice on the mountain line again (the line of the bench's slice.vertical128), drawn with Density shown.
  await drawMountainLine(p);
  const mountain = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  t.check(await p.eval<boolean>(DENSITY_SHOWN) && mountain.startsWith(`A (${a[0]}, ${a[1]}) → B (${b[0]}, ${b[1]})`), `the mountain line again: ${mountain}`, mountain);
  const vSwitch = await timeChange(SV_PLANE, 'vertical', `document.querySelector('.sv > .sv-body > .sv-ends > span').textContent === ${JSON.stringify(`A (${a[0]}, ${a[1]})`)}`);
  const vEdits: number[] = [];
  for (const v of ['-999999', '-1000000', '-999999']) vEdits.push(await timeEdit(v));
  await p.choose(SV_PLANE, 'horizontal');
  await p.until(Page.fresh(128), 'a fresh horizontal slice');
  const sq8 = squareLabels(centre[0], centre[1], 8192);
  const hSwitch = await timeChange(SV_EXTENT, '8192', `document.querySelector('.sv > .sv-body > .sv-ends > span').textContent === ${JSON.stringify(sq8.left)}`);
  const hEdits: number[] = [];
  for (const v of ['-1000000', '-999999', '-1000000']) hEdits.push(await timeEdit(v));
  t.check(true, `browser wall times with ${workers} workers, change → fresh 128² (32² draft first, frame-polled): vertical along ${mountain}: plane switch ${Math.round(vSwitch)} ms, after an edit ${timesText(vEdits)}; horizontal extent 8192 at (${centre[0]}, ${centre[1]}): extent switch ${Math.round(hSwitch)} ms, after an edit ${timesText(hEdits)}`);
  // The page writes the URL 200 ms after the last change.
  await sleep(600);
  const href7 = await p.eval<string>('location.href');
  const hash7 = await p.hash();
  t.check(hash7.length - 1 <= 65536, `the URL at the end: ${href7.length} characters (hash ${hash7.length - 1}): ${canonicalJson(await p.state())}`);
}

/**
 * On the open Voxels slice: the pointer on the top solid voxel of sample RULE_SAMPLE, read from the slice image (not a
 * fixed height); the readout at once (`first`: SP3a's format, that voxel's y, not air) and, after waiting for
 * ` · rule root…`, with its rule id (`ruled`: a top voxel's rule is in the sky-open branch, `root.rules[1].then.…`).
 * Null when the sample column is all air.
 */
async function hoverTopRule(p: Page): Promise<{ readonly row: number; readonly first: string; readonly firstOk: boolean; readonly ruled: string; readonly ruledOk: boolean } | null> {
  const column = await p.eval<number[]>(`Array.from(document.querySelector('.cs-voxels').getContext('2d').getImageData(${RULE_SAMPLE}, 0, 1, 384).data)`);
  const row = groundTopRow(column);
  if (row === null) return null;
  await p.mouse('mouseMoved', ...sliceCellPoint((await p.center('.cs-voxels')).box, RULE_SAMPLE, row));
  const first = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
  const top = new RegExp(`^\\(-?\\d+, ${319 - row}, -?\\d+\\) · (?!air )`);
  await p.until(`/ · rule root\\S*$/.test(document.querySelector('.cs-readout').textContent)`, 'the hover rule id', 10000);
  const ruled = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
  const id = voxelRuleId(ruled);
  return {
    row, first, firstOk: voxelReadoutOk(first) && top.test(first),
    ruled, ruledOk: voxelReadoutOk(ruled) && top.test(ruled) && id !== null && id.startsWith('root.rules[1].then.'),
  };
}

/** Arms the cut tool and clicks a line's ends on a map showing its view (by default the mountain line). */
async function drawMountainLine(p: Page, line: SmokeLine = MOUNTAIN_LINE): Promise<void> {
  const { view: mv, a, b } = line;
  await p.click('.map-cut');
  const mc = await p.center('.map-canvas');
  const at = (x: number, z: number): [number, number] => [mc.x + (x - mv.x) / mv.bpp, mc.y + (z - mv.z) / mv.bpp];
  await p.clickAt(...at(a[0], a[1]));
  await p.clickAt(...at(b[0], b[1]));
}

/**
 * Opens the Voxels mode on the mountain line (SP3b spec §7, §11): a new page at MOUNTAIN_LINE's view, the cut line
 * clicked at its ends, Voxels selected, a fresh slice. Throws when the line drawn is not the mountain line; returns the
 * line text and the slice summary.
 */
function openMountainVoxels(p: Page): Promise<{ readonly text: string; readonly summary: string }> {
  return openLineVoxels(p, { ...START, view: MOUNTAIN_LINE.view }, MOUNTAIN_LINE, 'the mountain line');
}

/** As `openMountainVoxels`, for the page opened with `state` (its view is `line`'s) and the line `line`, named `name`. */
async function openLineVoxels(p: Page, state: MapUrlState, line: SmokeLine, name: string): Promise<{ readonly text: string; readonly summary: string }> {
  await p.goto(`${p.base}?map#${mapHash(state)}`, MAP_READY);
  await p.click('#map-tab-world');
  await drawMountainLine(p, line);
  const { a, b } = line;
  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, `a fresh cross-section of ${name}`);
  const text = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  const seg = parseSegment(text);
  if (seg === null || Math.max(Math.abs(seg.ax - a[0]), Math.abs(seg.az - a[1]), Math.abs(seg.bx - b[0]), Math.abs(seg.bz - b[1])) > 1) {
    throw new Error(`${name} is ${text}, expected A (${a[0]}, ${a[1]}) → B (${b[0]}, ${b[1]})`);
  }
  await p.click('.cs-mode[data-mode="voxels"]');
  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, `a fresh voxel slice of ${name}`);
  return { text, summary: await p.eval<string>(`document.querySelector('.cs-summary').textContent`) };
}

/** The Voxels slice image (512 × 384 RGBA, row-major) as the page draws it. */
function voxelImage(p: Page): Promise<number[]> {
  return p.eval<number[]>(`Array.from(document.querySelector('.cs-voxels').getContext('2d').getImageData(0, 0, 512, 384).data)`);
}

/** The sample nearest the line's middle whose column holds an island over ground (`islandOverGround`), or null. */
function islandSample(image: ArrayLike<number>): { readonly i: number; readonly islandTop: number; readonly islandBottom: number; readonly groundRow: number } | null {
  const order = [...Array(512).keys()].sort((x, y) => Math.abs(x - 256) - Math.abs(y - 256) || x - y);
  for (const i of order) {
    const hit = islandOverGround(sliceColumn(image, i));
    if (hit !== null) return { i, ...hit };
  }
  return null;
}

/** The sample whose ground top is highest (the first such from A), with its row, or null on an all-air slice. */
function highestSample(image: ArrayLike<number>): { readonly i: number; readonly row: number } | null {
  let best: { i: number; row: number } | null = null;
  for (let i = 0; i < 512; i++) {
    const row = groundTopRow(sliceColumn(image, i));
    if (row !== null && (best === null || row < best.row)) best = { i, row };
  }
  return best;
}

/** The pointer on the cell (sample i, image row `row`) of the Voxels slice; resolves with the readout once it names a rule (or after 10 s). */
async function hoverVoxel(p: Page, i: number, row: number): Promise<string> {
  await p.mouse('mouseMoved', ...sliceCellPoint((await p.center('.cs-voxels')).box, i, row));
  await p.until(`/ · rule (?:root\\S*|none)$/.test(document.querySelector('.cs-readout').textContent)`, 'the hover rule id', 10000).catch(() => undefined);
  return p.eval<string>(`document.querySelector('.cs-readout').textContent`);
}

/** The map canvas's pixels in the PRESET_MAP.px² square centred on the canvas centre (the view centre), RGBA row-major. */
async function presetMapPixels(p: Page): Promise<{ readonly rgba: number[]; readonly clip: Box }> {
  const mc = await p.center('.map-canvas');
  const half = PRESET_MAP.px / 2;
  const w = await p.eval<{ rgba: number[]; width: number; cx: number; cy: number }>(`__wiSmoke.mapPixels(${mc.x}, ${mc.y}, ${half})`);
  // mapPixels reads the (2·half + 1)² window around the centre; keep its first PRESET_MAP.px rows and columns.
  const rgba: number[] = [];
  for (let y = 0; y < PRESET_MAP.px; y++) rgba.push(...w.rgba.slice(4 * y * w.width, 4 * (y * w.width + PRESET_MAP.px)));
  return { rgba, clip: { x: Math.round(mc.x) - half, y: Math.round(mc.y) - half, width: PRESET_MAP.px, height: PRESET_MAP.px } };
}

/**
 * Opens `preset` on its window centre at PRESET_MAP's scale on `layer`, settled, and waits until the map square reads
 * the same twice 500 ms apart (the fine tiles replace the upscaled previews after the first preview lands); resolves
 * with that square.
 */
async function openPresetMap(p: Page, preset: SmokePreset, layer: string): Promise<{ readonly rgba: number[]; readonly clip: Box }> {
  const [x, z] = presetCentre(preset);
  await p.goto(`${p.base}?map#${mapHash(presetState(preset, { x, z, bpp: PRESET_MAP.bpp, layer }))}`, MAP_READY);
  let last = await presetMapPixels(p);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    await p.until('__wiSmoke.settled()', `the ${layer} map of ${preset}`);
    const now = await presetMapPixels(p);
    if (sameJson(now.rgba, last.rgba)) return now;
    last = now;
  }
  throw new Error(`the ${layer} map of ${preset} kept changing for 15 s`);
}

/**
 * The `preset profiles` step (SP3e spec §8): each draft preset opened by URL with its profile on its line — the select
 * shows it among the five ready profiles, the World tab and the URL name it, the Voxels summary holds what the preset
 * promises (`presetSummaryOk`), and no page error; floating_islands' line holds an island over ground whose top voxel
 * takes a surface rule (D21 (b)) and its `islandMask` layer draws ≥ 2 colours; archipelago's `biome` layer around its
 * window holds ocean and land.
 */
async function runPresetProfiles(t: Smoke): Promise<void> {
  const p = t.page;
  t.step('preset profiles: each draft preset opened by URL on its window line, its map layer around the window');
  for (const preset of SMOKE_PRESETS) {
    const errors0 = t.errors.length;
    const line = presetLine(preset);
    const state = presetState(preset, line.view);
    const { text, summary } = await openLineVoxels(p, state, line, `${preset}'s line`);
    const select = await p.eval<{ value: string; options: string[] }>(`(() => { const s = document.querySelector('.map-toolbar select[title="Profile"]'); return { value: s.value, options: [...s.options].filter((o) => !o.disabled).map((o) => o.value) }; })()`);
    t.check(select.value === preset && sameJson(select.options, READY_PROFILES), `${preset}: the profile select shows it among ${select.options.join(', ')}`, select);
    const url = await p.state();
    t.check(url !== null && url.profile === preset && sameJson(url.patch, {}), `${preset}: the URL holds the profile, nothing modified`, url);
    t.check((await p.eval<string>('__wiSmoke.world()')).includes(`profile ${preset}\n`), `${preset}: the World tab shows the profile`);
    t.check(presetSummaryOk(preset, summary), `${preset} on ${text}: ${summary}`, summary);
    if (preset === 'floating_islands') {
      const island = islandSample(await voxelImage(p));
      t.check(island !== null, `an island over ground on the line: ${island === null ? 'none' : `sample ${island.i}, island y ${island.islandBottom}-${island.islandTop}, ground top y ${319 - island.groundRow}`}`);
      if (island !== null) {
        const read = await hoverVoxel(p, island.i, island.groundRow);
        const id = voxelRuleId(read);
        t.check(voxelReadoutOk(read) && read.includes(`, ${319 - island.groundRow}, `) && id !== null, `the ground under the island takes a surface rule (D21 (b)): ${read}`, read);
        await p.mouse('mouseMoved', 5, 5);
      }
      // Each colour must cover >= 1 % of the square: the spawn marker ring (32 px, #ff3b30) is an overlay, not mask data.
      const minPx = Math.ceil(0.01 * PRESET_MAP.px * PRESET_MAP.px);
      const n = distinctColours((await openPresetMap(p, preset, 'islandMask')).rgba, minPx);
      t.check(n >= 2, `floating_islands' islandMask layer around the window (4096² blocks, 16 blocks/px) draws ${n} colours (≥ ${minPx} px = 1 % each)`, n);
    } else if (preset === 'archipelago') {
      const counts = biomePixels((await openPresetMap(p, preset, 'biome')).rgba);
      t.check(oceanAndLandOk(counts), `archipelago's biome layer around the window (4096² blocks): ocean ${counts.ocean}, land ${counts.land}, other ${counts.other} px`, counts);
    }
    t.check(t.errors.length === errors0, `${preset}: no page error`, t.errors.slice(errors0));
  }
}

// ---------------------------------------------------------------- the 3D world (SP4a spec §9.6)

/** The longest wait for a world load at RD 4 under SwiftShader, ms (the page's own watchdog fails a stall after 30 s). */
const WORLD_MS = 240000;
/** The page expression "the world page settled": revealed, or the failure panel or the error screen showing. */
const WORLD_SETTLED = `window.__wiWorld?.revealed === true || (document.getElementById('loading-fail')?.hidden === false) || document.getElementById('error-screen') !== null`;
/** The start screen's texts and buttons as they read. */
const START_READ = `(() => {
  const t = (id) => document.getElementById(id)?.textContent ?? null;
  const enter = document.getElementById('start-enter');
  const map = document.getElementById('start-map');
  return {
    seed: t('start-seed'), profile: t('start-profile'), error: document.getElementById('start-error')?.hidden === false ? t('start-error') : null,
    enter: enter === null ? null : { text: enter.textContent, disabled: enter.disabled }, map: map === null ? null : { text: map.textContent, href: map.getAttribute('href') },
    loading: document.getElementById('loading-screen') !== null, canvas: document.querySelector('canvas') !== null,
  };
})()`;
interface StartRead {
  readonly seed: string | null;
  readonly profile: string | null;
  readonly error: string | null;
  readonly enter: { readonly text: string; readonly disabled: boolean } | null;
  readonly map: { readonly text: string; readonly href: string | null } | null;
  readonly loading: boolean;
  readonly canvas: boolean;
}

/** The world canvas's `data-renderer` values (one canvas expected), read in the page. */
const DRAWN_BY = `[...document.querySelectorAll('canvas[data-renderer]')].map((c) => c.dataset.renderer)`;

/** Whether the page's browser has `WEBGL_multi_draw` on a WebGL2 context, as the page's capability probe asks. */
const MULTI_DRAW = `(() => { const g = document.createElement('canvas').getContext('webgl2'); const ok = g !== null && g.getExtension('WEBGL_multi_draw') !== null; g?.getExtension('WEBGL_lose_context')?.loseContext(); return ok; })()`;

/** The world HUD's rows, one per line (`parseHud`); '' without a HUD. */
const HUD_TEXT = `[...document.querySelectorAll('.world-hud > div')].map((d) => d.textContent).join('\\n')`;

/** Checks that the one world canvas names `expected` in `data-renderer` (SP4b spec §8.6). */
async function checkDrawnBy(t: Smoke, what: string, expected: 'batch' | 'mesh'): Promise<void> {
  const drawn = await t.page.eval<string[]>(DRAWN_BY);
  t.check(drawn.length === 1 && drawn[0] === expected, `${what}: the canvas's data-renderer is ${expected}`, drawn);
}

/** Waits for the world page to settle; true when it revealed, else a failed check names the cause. */
async function worldRevealed(t: Smoke, what: string): Promise<boolean> {
  const p = t.page;
  try {
    const ms = await p.until(WORLD_SETTLED, `${what} settled`, WORLD_MS);
    const revealed = await p.eval<boolean>('window.__wiWorld?.revealed === true');
    const cause = revealed ? '' : await p.eval<string>(`document.getElementById('loading-cause')?.textContent ?? document.getElementById('error-screen')?.textContent ?? ''`);
    t.check(revealed, `${what}: revealed after ${(ms / 1000).toFixed(1)} s`, cause);
    return revealed;
  } catch (e) {
    t.check(false, `${what}: revealed within ${WORLD_MS / 1000} s`, e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function runWorld(t: Smoke): Promise<void> {
  const p = t.page;

  t.step('start: bare / shows the start screen (seed 42, the default profile, both buttons), a hash names its seed, "Enter the world" brings up the loading screen');
  let errors0 = t.errors.length;
  await p.goto(p.base, `document.getElementById('start-enter') !== null`);
  // The backdrop fetches the panorama manifest; let it land before the console is read.
  await sleep(1000);
  const bare = await p.eval<StartRead>(START_READ);
  t.check(bare.seed === 'Seed: 42' && bare.profile === 'Profile: default' && bare.error === null, `bare /: ${bare.seed} · ${bare.profile}`, bare);
  t.check(bare.enter !== null && bare.enter.text === 'Enter the world' && !bare.enter.disabled && bare.map !== null && bare.map.text === 'Open the map' && bare.map.href === '?map',
    'both buttons: "Enter the world" and "Open the map" (?map)', bare);
  t.check(!bare.loading && !bare.canvas, 'nothing loads while the start screen shows (no loading screen, no canvas)', bare);
  t.check(t.errors.length === errors0, 'bare /: no page error', t.errors.slice(errors0));
  t.save('start.png', (await p.capture()).png);

  await p.goto(`${p.base}${START_SEED_7_HASH}`, `document.getElementById('start-seed') !== null`);
  const seven = await p.eval<StartRead>(START_READ);
  t.check(seven.seed === 'Seed: 7' && seven.profile === 'Profile: default' && seven.map?.href === `?map${START_SEED_7_HASH}`, `/#<seed 7>: ${seven.seed} · ${seven.profile}, the map link keeps the hash`, seven);

  await p.goto(p.base, `document.getElementById('start-enter') !== null`);
  errors0 = t.errors.length;
  const before = await p.eval<{ href: string; history: number }>('({ href: location.href, history: history.length })');
  await p.click('#start-enter');
  const ms = await p.until(`document.getElementById('loading-screen') !== null && document.getElementById('start-screen') === null`, 'the loading screen after "Enter the world"', 10000);
  const after = await p.eval<{ href: string; history: number }>('({ href: location.href, history: history.length })');
  t.check(after.href === before.href && after.history === before.history, `"Enter the world": the loading screen after ${Math.round(ms)} ms in the same page (URL ${after.href}, no history entry)`, { before, after });
  t.check(t.errors.length === errors0, '"Enter the world": no page error', t.errors.slice(errors0));

  t.step(`world: /?rd=${WORLD_RD} (no start screen) to the reveal, a clean console, world.png`);
  errors0 = t.errors.length;
  await p.goto(`${p.base}?rd=${WORLD_RD}`, `window.__wiWorld !== undefined`);
  t.check(await p.eval<boolean>(`document.getElementById('start-screen') === null && (document.getElementById('loading-screen') !== null || window.__wiWorld.revealed)`), `/?rd=${WORLD_RD}: the loading screen, no start screen`);
  if (await worldRevealed(t, `/?rd=${WORLD_RD}`)) {
    await checkDrawnBy(t, `/?rd=${WORLD_RD}`, expectedRenderer(null, await p.eval<boolean>(MULTI_DRAW)));
    // Past the 300 ms fade of the overlay.
    await p.until('window.__wiWorld.frames >= 3', 'three frames after the reveal', 30000);
    await sleep(500);
    t.save('world.png', (await p.capture()).png);
  }
  t.check(t.errors.length === errors0, `/?rd=${WORLD_RD}: no page error`, t.errors.slice(errors0));

  t.step('world-mesh: RegionMesh and RegionBatch at the same views (the spawn, the ocean) in the capture mode (08:00, no HUD), read back after the reveal and three frames');
  for (const { name, view, file } of PARITY_VIEWS) {
    const shots: Partial<Record<'mesh' | 'batch', { readonly png: Buffer; readonly width: number; readonly height: number; readonly rgba: Uint8Array }>> = {};
    for (const renderer of ['mesh', 'batch'] as const) {
      errors0 = t.errors.length;
      const url = `${p.base}${worldMeshQuery(renderer, view)}`;
      await p.goto(url, `window.__wiWorld !== undefined`);
      if (!(await worldRevealed(t, `${name}, renderer=${renderer}`))) continue;
      await p.until('window.__wiWorld.frames >= 3', `three frames after the ${name} ${renderer} reveal`, 30000);
      await checkDrawnBy(t, `${name}, renderer=${renderer}`, renderer);
      const bare3d = await p.eval<boolean>(`document.querySelector('.world-hud') === null && document.getElementById('loading-screen') === null && document.getElementById('world-click-hint') === null`);
      t.check(bare3d, `${name}, renderer=${renderer}: no HUD, no overlay, no "Click to fly"`);
      const shot = await p.capture();
      shots[renderer] = shot;
      // Not blank: the lit, fogged terrain and the sky draw many distinct colours (a cleared canvas draws one).
      const colours = distinctColours(shot.rgba, 1);
      t.check(colours >= 256, `${name}, renderer=${renderer}: the view is drawn (${colours} distinct colours)`, colours);
      t.check(t.errors.length === errors0, `${name}, renderer=${renderer}: no page error`, t.errors.slice(errors0));
    }
    const mesh = shots.mesh;
    const batch = shots.batch;
    if (mesh !== undefined && batch !== undefined) {
      const share = pixelDiffShare(mesh.rgba, batch.rgba, PARITY_TOL);
      t.check(share <= PARITY_MAX_SHARE, `parity (${name}): ${(share * 100).toFixed(3)} % of ${mesh.width} × ${mesh.height} pixels differ by more than ${PARITY_TOL}/255 (≤ ${PARITY_MAX_SHARE * 100} %)`, share);
      t.save(file, mesh.png);
    } else {
      t.check(false, `parity (${name}): both renderers revealed`);
    }
  }

  t.step(`stream: /?rd=${WORLD_RD} forced to batch, then mesh: W held ${STREAM_HOLD_MS / 1000} s with real key input (the camera moves, columns reveal), then RD ${STREAM_RD} live in the help (no reload)`);
  for (const { renderer, file } of STREAM_RUNS) {
    const what = `stream, renderer=${renderer}`;
    errors0 = t.errors.length;
    await p.goto(`${p.base}${streamQuery(renderer)}`, `window.__wiWorld !== undefined`);
    if (!(await worldRevealed(t, what))) continue;
    await checkDrawnBy(t, what, renderer);
    await p.until('window.__wiWorld.frames >= 3', `three frames after the ${what} reveal`, 30000);
    const token = `stream-${renderer}-${Date.now()}`;
    await p.eval(`(window.__wiStreamToken = ${JSON.stringify(token)}, true)`);
    const hud = async (): Promise<HudRead | null> => parseHud(await p.eval<string>(HUD_TEXT));
    const start = await hud();
    if (start === null) {
      t.check(false, `${what}: the HUD shows revealed, RD and the position`, await p.eval<string>(HUD_TEXT));
      continue;
    }
    // A click on the canvas (the hint lets it through) asks for the pointer, then W is held with real key input.
    await p.clickAt(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await sleep(300);
    const w = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 };
    await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...w, text: 'w', unmodifiedText: 'w' });
    await sleep(STREAM_HOLD_MS);
    await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...w });
    // The HUD refreshes every 250 ms: one reading after the hold gives the position (the camera stopped with W). The
    // reveals W triggered may land later on a slow machine, so the revealed count is polled (final review GOV-9).
    await sleep(600);
    const moved = await hud();
    const dist = moved === null ? 0 : hudMoved(start, moved);
    t.check(dist > STREAM_MIN_MOVE, `${what}: W for ${STREAM_HOLD_MS / 1000} s moved the camera ${dist.toFixed(1)} blocks (> ${STREAM_MIN_MOVE})`, { start, moved });
    const grown = await hudOnce(hud, (h) => h.revealed > start.revealed, STREAM_REVEAL_MS);
    t.check(grown !== null, `${what}: the HUD's revealed grew within ${STREAM_REVEAL_MS / 1000} s of releasing W (${start.revealed} → ${grown?.revealed ?? '?'})`, { start, moved, grown });
    t.check(t.errors.length === errors0, `${what}: no page error while flying`, t.errors.slice(errors0));

    // The help (H), then RD 6 in its settings: applied live, no reload.
    await p.key('h', 'KeyH', 72);
    await p.until(`document.getElementById('world-help')?.hidden === false`, `${what}: the help`, 5000);
    // The select shows the RD in force, not the saved one (the mesh run starts with the batch run's 6 saved).
    const shown = await p.eval<string>(`document.getElementById('setting-rd').value`);
    t.check(shown === String(WORLD_RD), `${what}: #setting-rd shows the RD in force, ${WORLD_RD} (rulings R8)`, shown);
    const before = (await hud()) ?? start;
    await p.choose('#setting-rd', String(STREAM_RD));
    const six = await hudOnce(hud, (h) => h.rd === STREAM_RD && h.revealed > before.revealed, STREAM_RD_MS);
    t.check(six !== null && six.rd === STREAM_RD && six.revealed > before.revealed,
      `${what}: RD ${STREAM_RD} chosen in the help: the HUD shows RD ${six?.rd ?? '?'} and revealed ${before.revealed} → ${six?.revealed ?? '?'} within ${STREAM_RD_MS / 1000} s`, { before, six });
    const same = await p.eval<boolean>(`window.__wiStreamToken === ${JSON.stringify(token)}`);
    t.check(same, `${what}: no navigation (the page's token is still there)`);
    await p.click('#help-close');
    await p.until(`document.getElementById('world-help')?.hidden === true`, `${what}: the help closed`, 5000);
    await sleep(500);
    t.save(file, (await p.capture()).png);
    t.check(t.errors.length === errors0, `${what}: no page error`, t.errors.slice(errors0));
  }
}

// ---------------------------------------------------------------- the overlay steps (SP4c spec §8.6)

/** The page expression "the map overlay is shown" (its host in `#app`, not `display: none`, with the tool's canvas). */
const OVERLAY_SHOWN = `(() => { const o = document.getElementById('map-overlay'); return o !== null && o.style.display !== 'none' && o.querySelector('.map-canvas') !== null; })()`;
/** The page expression "the map overlay is closed" (hidden, or removed by a dispose). */
const OVERLAY_CLOSED = `(() => { const o = document.getElementById('map-overlay'); return o === null || o.style.display === 'none'; })()`;
/** The page expression "mode B is shown" (`#world-host` on the right half). */
const WORLD_SPLIT = `document.getElementById('world-host').classList.contains('split')`;
/** The map canvas's page box (CSS px). */
const MAP_CANVAS_BOX = `(() => { const r = document.querySelector('#map-overlay .map-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`;
/**
 * The map canvas read in the page: the share of sampled pixels (every 6th px both ways) that are not the empty view's
 * background `#15171b` (the tiles drawn), and the white pixels of the arrow within 10 px of the centre (the camera).
 */
const MAP_DRAWN = `(() => {
  const c = document.querySelector('#map-overlay .map-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, drawn = 0, white = 0;
  for (let y = 0; y < c.height; y += 6) for (let x = 0; x < c.width; x += 6) {
    const k = 4 * (y * c.width + x);
    n++;
    if (d[k] !== 21 || d[k + 1] !== 23 || d[k + 2] !== 27) drawn++;
  }
  const cx = Math.floor(c.width / 2), cy = Math.floor(c.height / 2);
  for (let y = cy - 10; y <= cy + 10; y++) for (let x = cx - 10; x <= cx + 10; x++) {
    const k = 4 * (y * c.width + x);
    if (d[k] >= 250 && d[k + 1] >= 250 && d[k + 2] >= 250) white++;
  }
  return { share: n === 0 ? 0 : drawn / n, white, width: c.width, height: c.height };
})()`;
/** The world canvas's width in CSS px. */
const WORLD_CANVAS_WIDTH = `document.querySelector('canvas[data-renderer]').getBoundingClientRect().width`;
/** Whether the tool's side panel sits beside its map view (true), under it (false), or is missing (null). */
const PANEL_BESIDE = `(() => {
  const v = document.querySelector('#map-overlay .map-view')?.getBoundingClientRect();
  const s = document.querySelector('#map-overlay .map-side')?.getBoundingClientRect();
  if (v === undefined || s === undefined || s.width === 0) return null;
  if (s.left >= v.right - 1) return true;
  if (s.top >= v.bottom - 1) return false;
  return null;
})()`;
/** The density tree's "Edit in Density" link in the Parameters tab. */
const DENSITY_LINK = '.pp-control[data-path="density.defs"] .pp-link';
/** The world notices' texts (`.world-notices`), joined. */
const WORLD_NOTICES = `document.getElementById('world-notices')?.textContent ?? ''`;
/** The stored map mode, read from the page's settings. */
const STORED_MODE = `localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})`;

/** Opens the closed sections of the parameter panel around the element `find` evaluates to, outermost first (a click on each toggle). */
function revealParam(find: string): string {
  return `(() => {
    const e = ${find};
    if (e === null) return false;
    const closed = [];
    for (let b = e.closest('.pp-section-body'); b !== null; b = b.parentElement?.closest('.pp-section-body') ?? null) if (b.hidden) closed.push(b);
    for (const b of closed.reverse()) b.parentElement.querySelector(':scope > .pp-section-head > .pp-toggle').click();
    return true;
  })()`;
}

/** The listeners on `window` and `document` (CDP `DOMDebugger.getEventListeners`), as `listenerKey`s. */
async function pageListeners(p: Page): Promise<string[]> {
  const out: string[] = [];
  for (const target of ['window', 'document'] as const) {
    const r = await p.cdp.send('Runtime.evaluate', { expression: target, returnByValue: false });
    const objectId = (r['result'] as { objectId?: string }).objectId;
    if (objectId === undefined) throw new Error(`no remote object for ${target}`);
    const l = await p.cdp.send('DOMDebugger.getEventListeners', { objectId });
    out.push(...(l['listeners'] as CdpListener[]).map((x) => listenerKey(target, x)));
    await p.cdp.send('Runtime.releaseObject', { objectId });
  }
  return out;
}

async function setViewport(p: Page, width: number, height: number): Promise<void> {
  await p.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
}

/** M with real key input, the focus moved out of every field first (the key map's `map` action, SP4c spec §2.4). */
async function pressM(p: Page): Promise<void> {
  await p.blur();
  await p.key('m', 'KeyM', 77, 0, 'm');
}

/** The leak baseline (spec §8.6 step 1), read on the baseline's document. */
interface LeakBaseline { readonly listeners: string[]; readonly sessionListeners: number; readonly timers: number }

/**
 * Waits until the page's pending timers read the same twice 500 ms apart (the reveal's fade and the map chunk's 2 s
 * preload have fired), then returns that count.
 */
async function steadyTimers(p: Page): Promise<number> {
  let last = await p.eval<number>('__wiTest.timers()');
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const now = await p.eval<number>('__wiTest.timers()');
    if (now === last) return now;
    last = now;
  }
  return last;
}

/**
 * Steps 2 and 3 of the overlay (spec §8.6), shared by both runs: M opens the map in mode A over the world (switched
 * to it through the header when B is stored), one `canvas[data-renderer]`, the arrow at the camera, the tiles within
 * 5 s without an edit, the Density tab's slice without an edit; then a click 300 px east of the arrow teleports.
 */
async function overlayOpenAndTeleport(t: Smoke, what: string, shot: string | null): Promise<void> {
  const p = t.page;
  const hud = async (): Promise<HudRead | null> => parseHud(await p.eval<string>(HUD_TEXT));
  await pressM(p);
  await p.until(OVERLAY_SHOWN, `${what}: the overlay after M`, 15_000);
  if (await p.eval<boolean>(WORLD_SPLIT)) {
    await p.click('#map-mode-full');
    await p.until(`!(${WORLD_SPLIT})`, `${what}: full screen through the header`, 5000);
    console.log('  (the stored mode was side by side: switched to full screen through the header)');
  }
  t.check(await p.eval<string>('__wiTest.owner()') === 'map', `${what}: M opens the map in full screen, and the map owns the controls`);
  const drawn = await p.eval<string[]>(DRAWN_BY);
  t.check(drawn.length === 1, `${what}: exactly one canvas[data-renderer] with the overlay open (GOV-8)`, drawn);
  try {
    const ms = await p.until(`(${MAP_DRAWN}).share > 0.5`, `${what}: the map's tiles`, OVERLAY_TILES_MS);
    const m = await p.eval<{ share: number; white: number; width: number; height: number }>(MAP_DRAWN);
    t.check(true, `${what}: tiles drawn ${Math.round(ms)} ms after the map showed, without an edit (${(m.share * 100).toFixed(0)} % of the ${m.width} × ${m.height} view)`);
  } catch (e) {
    t.check(false, `${what}: tiles drawn within ${OVERLAY_TILES_MS / 1000} s without an edit`, e instanceof Error ? e.message : String(e));
  }
  // The arrow redraws at most 30 times a second: one more frame for it.
  await sleep(200);
  const arrow = await p.eval<{ share: number; white: number }>(MAP_DRAWN);
  t.check(arrow.white >= 20, `${what}: the arrow is drawn at the camera, the view's centre (${arrow.white} white px)`, arrow);
  // The drawer has no tab bar while closed: the panel's "Edit in Density" link opens it (`openTree`, SP3d spec §1.1).
  if (!(await p.eval<boolean>(DENSITY_SHOWN))) {
    await p.click('#map-tab-parameters');
    if (!(await p.eval<boolean>(revealParam(`document.querySelector(${JSON.stringify(DENSITY_LINK)})`)))) throw new Error(`no ${DENSITY_LINK}`);
    await p.click(DENSITY_LINK);
  }
  t.check(await p.eval<boolean>(DENSITY_SHOWN), `${what}: "Edit in Density" opens the drawer's Density tab`);
  try {
    await p.until(`/^\\d+²$/.test(document.querySelector('.sv > .sv-status').textContent)`, `${what}: the Density tab's slice`, 30_000);
    t.check(true, `${what}: the Density tab's slice draws without an edit (${(await p.slice()).status}, ${(await p.slice()).plane})`);
  } catch (e) {
    t.check(false, `${what}: the Density tab's slice draws without an edit`, e instanceof Error ? e.message : String(e));
  }
  if (shot !== null) {
    await sleep(300);
    t.save(shot, (await p.capture()).png);
  }

  // Step 3: the teleport.
  const before = await hud();
  if (before === null) {
    t.check(false, `${what}: the HUD shows the camera before the teleport`, await p.eval<string>(HUD_TEXT));
    return;
  }
  const box = await p.eval<Box>(MAP_CANVAS_BOX);
  const click = { x: Math.round(box.x + box.width / 2 + TELEPORT_EAST_PX), y: Math.round(box.y + box.height / 2) };
  const target = teleportTarget(before, box, click, WORLD_MAP_BPP);
  const search0 = await p.eval<string>('location.search');
  await p.clickAt(click.x, click.y);
  try {
    await p.until(`__wiTest.lastLanding() !== null && (${OVERLAY_CLOSED})`, `${what}: the arrival with the map closed`, 10_000);
  } catch (e) {
    t.check(false, `${what}: the click 300 px east of the arrow teleports and closes the map (full screen)`, e instanceof Error ? e.message : String(e));
    return;
  }
  t.check(true, `${what}: the click 300 px east of the arrow teleports and the map closes (full screen)`);
  // The HUD refreshes every 250 ms.
  await sleep(600);
  const after = await hud();
  const landing = await p.eval<{ surface: number; water: number | null; y: number } | null>('__wiTest.lastLanding()');
  const near = after !== null && Math.abs(after.x - target.x) <= 1 && Math.abs(after.z - target.z) <= 1;
  t.check(near, `${what}: the camera at (${after?.x ?? '?'}, ${after?.z ?? '?'}), within 1 block of the clicked point (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`, { before, after, target });
  const want = landing === null ? null : smokeLandingY(landing);
  t.check(landing !== null && landing.y === want, `${what}: the landing y ${landing?.y ?? '?'} = min(${LANDING_MAX_Y}, max(surface ${landing?.surface ?? '?'}, water ${landing?.water ?? '−∞'}) + ${LANDING_ABOVE})`, landing);
  t.check(after !== null && landing !== null && Math.abs(after.y - landing.y) <= 0.05 + 1e-9, `${what}: the HUD's y ${after?.y ?? '?'} is the landing's ${landing?.y ?? '?'}`, { after, landing });
  if (after !== null) {
    const at = `${Math.round(after.x)},${Math.round(after.z)}`;
    try {
      await p.until(`new URLSearchParams(location.search).get('at') === ${JSON.stringify(at)}`, `${what}: the search's at`, 3000);
      t.check(true, `${what}: the search's at is rewritten to the arrival (${search0} → ${await p.eval<string>('location.search')})`);
    } catch {
      t.check(false, `${what}: the search's at is rewritten to ${at}`, await p.eval<string>('location.search'));
    }
  }
  // The old place is removed (the revealed count falls), then the new place fills (it grows above its lowest reading).
  let low = before.revealed;
  let grown: number | null = null;
  for (const t0 = Date.now(); Date.now() - t0 <= OVERLAY_REVEAL_MS; await sleep(HUD_POLL_MS)) {
    const h = await hud();
    if (h === null) continue;
    if (h.revealed < low) low = h.revealed;
    else if (low < before.revealed && h.revealed > low) {
      grown = h.revealed;
      break;
    }
  }
  t.check(low < before.revealed && grown !== null, `${what}: the revealed count falls (${before.revealed} → ${low}: the old place removed), then grows (→ ${grown ?? '?'}) within ${OVERLAY_REVEAL_MS / 1000} s`, { before: before.revealed, low, grown });
}

/**
 * liveEdit's HUD check (spec §8.6 step 5, D26): the row "stale n / needed" with 0 < n ≤ needed; no row passes only when
 * the world already settled (`stale()` read 0) before the HUD's 250 ms refresh could show it (final review GOV-5).
 */
export function hudStaleRowOk(row: { readonly stale: number; readonly needed: number } | null, settled: boolean): boolean {
  return row === null ? settled : row.stale > 0 && row.stale <= row.needed;
}

/**
 * One live edit (spec §8.6 step 5): `act` changes the session; `notice`, when given, shows in `.world-notices` (it
 * lives 1.5 s from the Apply, so it is waited for right after `act`, before the waits that could outlast it; final
 * review GOV-5); the world's stale count rises above 0, the HUD shows its row (unless the world settled before the
 * HUD's refresh), and the count falls back to 0 within 30 s, with no page error.
 */
async function liveEdit(t: Smoke, what: string, act: () => Promise<void>, notice: string | null = null): Promise<void> {
  const p = t.page;
  const errors0 = t.errors.length;
  await act();
  if (notice !== null) {
    // Bounded as the stale count's rise: the notice shows at the Apply and is only there for its 1.5 s.
    try {
      await p.until(`(${WORLD_NOTICES}).includes(${JSON.stringify(notice)})`, `${what}: "${notice}" in .world-notices`, 15_000);
      t.check(true, `${what}: "${notice}" shows in .world-notices`);
    } catch (e) {
      t.check(false, `${what}: "${notice}" shows in .world-notices`, e instanceof Error ? e.message : String(e));
    }
  }
  let rose = false;
  try {
    await p.until('__wiTest.stale() > 0', `${what}: the stale count above 0`, 15_000);
    rose = true;
    // The HUD's "stale n / needed" row (D26), refreshed every 250 ms, while the world regenerates.
    await p.until(`/^stale \\d+ \\/ \\d+$/m.test(${HUD_TEXT}) || __wiTest.stale() === 0`, `${what}: the HUD's stale row`, OVERLAY_APPLY_MS);
    const row = parseHudStale(await p.eval<string>(HUD_TEXT));
    const settled = row === null && (await p.eval<number>('__wiTest.stale()')) === 0;
    t.check(
      hudStaleRowOk(row, settled),
      row === null && settled
        ? `${what}: the HUD's stale row not read: the world settled before the HUD's 250 ms refresh`
        : `${what}: the HUD shows "stale ${row?.stale ?? '?'} / ${row?.needed ?? '?'}"`,
      row,
    );
    const ms = await p.until('__wiTest.stale() === 0', `${what}: the world settled`, OVERLAY_APPLY_MS);
    t.check(true, `${what}: applies live (the stale count above 0, then 0 after ${(ms / 1000).toFixed(1)} s)`);
  } catch (e) {
    t.check(false, `${what}: the stale count ${rose ? 'back to 0 within 30 s' : 'above 0'}`, e instanceof Error ? e.message : String(e));
  }
  t.check(t.errors.length === errors0, `${what}: no page error`, t.errors.slice(errors0));
}

/** Types `value` into the parameter field `#id` (its sections opened) and commits it with Enter. */
async function typeParam(p: Page, id: string, value: string): Promise<void> {
  await p.click('#map-tab-parameters');
  if (!(await p.eval<boolean>(revealParam(`document.getElementById(${JSON.stringify(id)})`)))) throw new Error(`no parameter field #${id}`);
  await p.typeInto(`#${id}`, value);
  await p.enter();
  await p.blur();
}

/** Prints the driver's lastLatencyMs from the tool's toolbar once the preview landed (information only, spec §6.4). */
async function printPreviewMs(p: Page, what: string): Promise<void> {
  try {
    await p.until('__wiSmoke.settled()', `${what}: the preview`, 30_000);
  } catch { /* printed as unknown below */ }
  const status = await p.eval<string>('__wiSmoke.status()');
  console.log(`  info ${what}: the in-world preview's lastLatencyMs ${previewMs(status) ?? '?'} ms ("${status}"; SwiftShader, information only: it does not decide the cut line, §6.4)`);
}

async function overlayBatch(t: Smoke, what: string): Promise<void> {
  const p = t.page;
  const hud = async (): Promise<HudRead | null> => parseHud(await p.eval<string>(HUD_TEXT));

  // 1. The leak baseline, after the reveal and before the first M (the map chunk's 2 s preload fired).
  await sleep(2500);
  const baseline: LeakBaseline = {
    timers: await steadyTimers(p),
    listeners: await pageListeners(p),
    sessionListeners: await p.eval<number>('__wiTest.listenerCount()'),
  };
  console.log(`  leak baseline: ${baseline.listeners.length} listeners on window and document, ${baseline.sessionListeners} session listeners, ${baseline.timers} pending timers`);

  // 2 and 3.
  await overlayOpenAndTeleport(t, what, OVERLAY_SHOTS.full);

  // 4. Mode B: half the window, stored; the panel beside the map at 960 px, under it at 800 px (the container query).
  await pressM(p);
  await p.until(OVERLAY_SHOWN, `${what}: the overlay after M`, 10_000);
  await p.click('#map-mode-split');
  await p.until(WORLD_SPLIT, `${what}: side by side`, 5000);
  await sleep(500);
  const half = await p.eval<number>(WORLD_CANVAS_WIDTH);
  t.check(Math.abs(half - OVERLAY_VIEWPORT.width / 2) <= 2, `${what}: side by side, the 3D canvas is ${half} px wide (half of ${OVERLAY_VIEWPORT.width} ± 2)`, half);
  t.check(storedMapMode(await p.eval<string | null>(STORED_MODE)) === 'split', `${what}: side by side is stored`, await p.eval<string | null>(STORED_MODE));
  t.check(await p.eval<boolean | null>(PANEL_BESIDE) === true, `${what}: at the ${OVERLAY_VIEWPORT.width / 2} px half the panel sits beside the map`, await p.eval<boolean | null>(PANEL_BESIDE));
  t.save(OVERLAY_SHOTS.split, (await p.capture()).png);
  await setViewport(p, OVERLAY_NARROW_WIDTH, OVERLAY_VIEWPORT.height);
  await sleep(500);
  const narrow = await p.eval<number>(WORLD_CANVAS_WIDTH);
  t.check(Math.abs(narrow - OVERLAY_NARROW_WIDTH / 2) <= 2, `${what}: at a ${OVERLAY_NARROW_WIDTH} px window the half is ${narrow} px (± 2)`, narrow);
  t.check(await p.eval<boolean | null>(PANEL_BESIDE) === false, `${what}: at the ${OVERLAY_NARROW_WIDTH / 2} px half the panel stacks under the map (the container query)`, await p.eval<boolean | null>(PANEL_BESIDE));
  await setViewport(p, OVERLAY_VIEWPORT.width, OVERLAY_VIEWPORT.height);
  await p.until(`Math.abs(${WORLD_CANVAS_WIDTH} - ${OVERLAY_VIEWPORT.width / 2}) <= 2`, `${what}: back at ${OVERLAY_VIEWPORT.width} px`, 5000);

  // 5. Live edits in mode B: terrain, its undo, climate, the biome table; then undo and redo from the 3D.
  await liveEdit(t, `${what}: density.detailAmpHi 1.5 → 4 typed`, () => typeParam(p, 'pp-density.detailAmpHi', '4'));
  await printPreviewMs(p, `${what}: the terrain edit in side by side`);
  await liveEdit(t, `${what}: Ctrl+Z`, async () => {
    await p.blur();
    await p.undoKey();
  });
  const wavelength = await p.eval<string>(`document.getElementById('pp-climate.C.wavelength')?.value ?? ''`);
  await liveEdit(t, `${what}: climate.C's wavelength ${wavelength} → 1800 typed`, () => typeParam(p, 'pp-climate.C.wavelength', '1800'));
  await p.click('#map-tab-biomes');
  const was = await p.eval<string>(`document.getElementById('bt-desert-T').value`);
  const [lo, hi] = was.split(',').map((v) => Number(v.trim())) as [number, number];
  const mid = Math.round(((lo + hi) / 2) * 100) / 100;
  await liveEdit(t, `${what}: the biome table's desert T ${was} → ${lo}, ${mid} typed`, async () => {
    await p.typeInto('#bt-desert-T', `${lo}, ${mid}`);
    await p.enter();
    await p.blur();
  });
  // Undo and redo by who has the controls (SP5a spec §4.5, D13; SP4c spec §2.4): with the map owning, Ctrl+Z undoes
  // the biome bound and Ctrl+Y redoes it, live (no notice while the map shows); M closes the map, and from the 3D Ctrl+Z
  // and Ctrl+Y undo and redo a block placed through the hook; M reopens the map.
  t.check(await p.eval<string>('__wiTest.owner()') === 'map', `${what}: the map owns the controls side by side`);
  await liveEdit(t, `${what}: Ctrl+Z with the map owning`, async () => {
    await p.blur();
    await p.undoKey();
  });
  await liveEdit(t, `${what}: Ctrl+Y with the map owning`, async () => {
    await p.blur();
    await p.redoKeyY();
  });
  await pressM(p);
  await p.until(OVERLAY_CLOSED, `${what}: M closes the map`, 5000);
  t.check(await p.eval<string>('__wiTest.owner()') === 'world', `${what}: M closes the map, and the world owns the controls`);
  await blockUndoFrom3d(t, what);
  await pressM(p);
  await p.until(`${OVERLAY_SHOWN} && ${WORLD_SPLIT}`, `${what}: M reopens the map side by side`, 5000);
  t.check(await p.eval<string>(`document.getElementById('bt-desert-T').value`) === `${lo}, ${mid}`, `${what}: the redone desert T shows in the reopened map`, await p.eval<string>(`document.getElementById('bt-desert-T').value`));

  // 6. The pointer lock in mode B: a click on the 3D half.
  const hint = await p.eval<boolean>(`document.getElementById('world-click-hint') !== null`);
  await p.clickAt(OVERLAY_VIEWPORT.width * 0.75, OVERLAY_VIEWPORT.height / 2);
  await sleep(500);
  const granted = await p.eval<boolean>(`document.pointerLockElement !== null && document.pointerLockElement === document.querySelector('canvas[data-renderer]')`);
  if (!granted) {
    console.log(`  skipped ${what}: the pointer lock: headless Chrome refused it (pointerLockElement ${await p.eval<string>('String(document.pointerLockElement)')}); the headful production check covers W and Esc in mode B (§14)`);
  } else {
    t.check(await p.eval<string>('__wiTest.owner()') === 'world', `${what}: the lock gives the world the controls, the map open`);
    const start = await hud();
    const w = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 };
    await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...w, text: 'w', unmodifiedText: 'w' });
    await sleep(1500);
    await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...w });
    await sleep(600);
    const moved = await hud();
    const dist = start === null || moved === null ? 0 : hudMoved(start, moved);
    t.check(dist > 5 && await p.eval<boolean>(OVERLAY_SHOWN), `${what}: W moves the camera ${dist.toFixed(1)} blocks with the map open`, { start, moved });
    await p.key('Escape', 'Escape', 27);
    let released = true;
    try {
      await p.until('document.pointerLockElement === null', `${what}: Esc releases the lock`, 1000);
    } catch {
      released = false;
      console.log(`  info ${what}: CDP's Esc did not release the lock in headless Chrome (the browser's own Esc does that); released through document.exitPointerLock() (§14 records the headful case)`);
      await p.eval('(document.exitPointerLock(), true)');
      await p.until('document.pointerLockElement === null', `${what}: the lock released`, 2000);
    }
    await sleep(300);
    const how = released ? 'Esc' : 'the release';
    t.check(await p.eval<string>('__wiTest.owner()') === 'map', `${what}: ${how} gives the controls back to the map`);
    t.check(await p.eval<boolean>(OVERLAY_SHOWN) && await p.eval<boolean>(DENSITY_SHOWN), `${what}: after ${how} the map is open with the drawer still open`);
  }

  // 7. The leak check, on the baseline's document: the overlay closed, then the tool disposed through the hook.
  await p.eval('(__wiTest.closeOverlay(), true)');
  await p.until(OVERLAY_CLOSED, `${what}: the overlay closed through the hook`, 5000);
  const tilesHidden = await p.eval<number>('__wiTest.tileRequests()');
  await sleep(1000);
  const tilesHidden1 = await p.eval<number>('__wiTest.tileRequests()');
  t.check(tilesHidden1 === tilesHidden, `${what}: no tile request over 1 s after hide (${tilesHidden} → ${tilesHidden1})`);
  await p.eval('(__wiTest.disposeTool(), true)');
  const tilesGone = await p.eval<number>('__wiTest.tileRequests()');
  await sleep(1000);
  const tilesGone1 = await p.eval<number>('__wiTest.tileRequests()');
  t.check(tilesGone1 === tilesGone, `${what}: no tile request over 1 s after dispose (${tilesGone} → ${tilesGone1})`);
  // Transient timers (a notice's timeout, the URL writer's debounce) end within a few seconds; a leaked one does not.
  let listeners = await pageListeners(p);
  let sessionListeners = await p.eval<number>('__wiTest.listenerCount()');
  let timers = await p.eval<number>('__wiTest.timers()');
  for (let i = 0; i < 20 && (timers !== baseline.timers || sessionListeners !== baseline.sessionListeners || !listenersLeakFree(listenerDiff(baseline.listeners, listeners), granted && hint)); i++) {
    await sleep(500);
    listeners = await pageListeners(p);
    sessionListeners = await p.eval<number>('__wiTest.listenerCount()');
    timers = await p.eval<number>('__wiTest.timers()');
  }
  const diff = listenerDiff(baseline.listeners, listeners);
  t.check(listenersLeakFree(diff, granted && hint), `${what}: the listeners on window and document equal the baseline (${listeners.length} vs ${baseline.listeners.length}${diff.gone.length > 0 ? `; the click hint's own pointerlockchange removed at the lock` : ''})`, diff);
  t.check(sessionListeners === baseline.sessionListeners, `${what}: session.listenerCount() equals the baseline (${sessionListeners} vs ${baseline.sessionListeners})`);
  t.check(timers === baseline.timers, `${what}: the pending timers equal the baseline (${timers} vs ${baseline.timers})`);

  // 8. The reload keeps side by side and the edited values (the URL follows the session).
  const kept = await p.state();
  const patch = (kept?.patch ?? {}) as { climate?: { C?: { wavelength?: unknown } }; biomes?: { table?: Record<string, { T?: unknown }> } };
  t.check(patch.climate?.C?.wavelength === 1800 && sameJson(patch.biomes?.table?.['desert']?.T, [lo, mid]), `${what}: the URL carries the edits (climate.C wavelength 1800, desert T ${lo}, ${mid})`, kept?.patch);
  await p.reload('window.__wiWorld !== undefined');
  if (!(await worldRevealed(t, `${what}: the reload`))) return;
  await p.until('window.__wiWorld.frames >= 3', `${what}: three frames after the reload`, 30_000);
  const reloaded = await p.state();
  t.check(reloaded !== null && kept !== null && sameJson(reloaded.patch, kept.patch) && reloaded.seed === kept.seed && reloaded.profile === kept.profile, `${what}: the reload keeps the edited values`, { kept, reloaded });
  t.check(storedMapMode(await p.eval<string | null>(STORED_MODE)) === 'split', `${what}: side by side is still stored after the reload`);

  // 9. A failure with the map open, on the reloaded page (a fresh tool): M opens side by side, Full screen, the fatal.
  await pressM(p);
  await p.until(OVERLAY_SHOWN, `${what}: the overlay after M on the reloaded page`, 15_000);
  t.check(await p.eval<boolean>(WORLD_SPLIT), `${what}: M opens side by side, the stored mode`);
  t.check(await p.eval<string>(`document.getElementById('pp-climate.C.wavelength')?.value ?? ''`) === '1800', `${what}: the reloaded tool shows the edited wavelength`, await p.eval<string>(`document.getElementById('pp-climate.C.wavelength')?.value ?? ''`));
  await p.click('#map-mode-full');
  await p.until(`!(${WORLD_SPLIT})`, `${what}: full screen through the header`, 5000);
  t.check(storedMapMode(await p.eval<string | null>(STORED_MODE)) === 'full', `${what}: the header's Full screen is stored`);
  const errors0 = t.errors.length;
  await p.eval('(__wiTest.forceFatal(), true)');
  try {
    await p.until(`document.getElementById('world-failed') !== null`, `${what}: the failure panel`, 5000);
  } catch { /* checked below */ }
  await sleep(1000);
  const panel = await p.eval<{ shown: boolean; copy: string | null; overlay: boolean }>(`({
    shown: document.getElementById('world-failed') !== null && document.getElementById('world-failed').offsetParent !== null,
    copy: document.getElementById('world-failed-copy')?.textContent ?? null,
    overlay: document.getElementById('map-overlay') !== null,
  })`);
  t.check(!panel.overlay && panel.shown && panel.copy === 'Copy details', `${what}: a forced fatal with the map open: the overlay closed, the failure panel visible with "Copy details"`, panel);
  t.check(t.errors.length === errors0, `${what}: no page error after the fatal`, t.errors.slice(errors0));
}

async function overlayMesh(t: Smoke, what: string): Promise<void> {
  const p = t.page;
  // 2 and 3, the map closed on arrival (full screen; the step switches to it when B is stored).
  await overlayOpenAndTeleport(t, what, null);
  // The terrain Apply of 5, side by side, with the preview's latency printed.
  await pressM(p);
  await p.until(OVERLAY_SHOWN, `${what}: the overlay after M`, 10_000);
  await p.click('#map-mode-split');
  await p.until(WORLD_SPLIT, `${what}: side by side`, 5000);
  await liveEdit(t, `${what}: density.detailAmpHi 1.5 → 4 typed`, () => typeParam(p, 'pp-density.detailAmpHi', '4'));
  await printPreviewMs(p, `${what}: the terrain edit in side by side`);
}

async function runOverlay(t: Smoke): Promise<void> {
  const p = t.page;
  for (const { step, renderer } of OVERLAY_RUNS) {
    const what = `${step}, renderer=${renderer}`;
    t.step(step === 'overlay'
      ? `overlay: ${overlayQuery('batch')} at ${OVERLAY_VIEWPORT.width} × ${OVERLAY_VIEWPORT.height}: the leak baseline, M (tiles and the arrow, no edit), a teleport, side by side, live edits with undo and redo, the pointer lock, the leak check, a reload, a fatal with the map open`
      : `overlay-mesh: ${overlayQuery('mesh')} at ${OVERLAY_VIEWPORT.width} × ${OVERLAY_VIEWPORT.height}: M, a teleport, a terrain Apply side by side`);
    const errors0 = t.errors.length;
    await setViewport(p, OVERLAY_VIEWPORT.width, OVERLAY_VIEWPORT.height);
    try {
      await p.goto(`${p.base}${overlayQuery(renderer)}`, `window.__wiWorld !== undefined`);
      if (!(await worldRevealed(t, what))) continue;
      await checkDrawnBy(t, what, renderer);
      await p.until('window.__wiWorld.frames >= 3', `three frames after the ${what} reveal`, 30_000);
      t.check(await p.eval<boolean>(`typeof window.__wiTest === 'object' && typeof window.__wiTest.forceFatal === 'function'`), `${what}: the test hook is installed (?wiTest=1)`);
      if (step === 'overlay') await overlayBatch(t, what);
      else await overlayMesh(t, what);
    } catch (e) {
      t.check(false, `${what}: the step stopped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await setViewport(p, VIEWPORT.width, VIEWPORT.height);
    }
    // The forced fatal is the batch run's last act; any other page error fails the step.
    t.check(t.errors.length === errors0, `${what}: no page error`, t.errors.slice(errors0));
  }
}

// ---------------------------------------------------------------- the build and walk steps (SP5a spec §6.4)

/** The hook's aim (`WiTest.aim`). */
interface AimRead { readonly hit: boolean; readonly x: number; readonly y: number; readonly z: number; readonly face: number; readonly outline: boolean }
type Voxel = { readonly x: number; readonly y: number; readonly z: number };

const xyz = (v: Voxel): string => `${v.x}, ${v.y}, ${v.z}`;
const sameVoxel = (a: Voxel, b: Voxel): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
/** Sets voxel `v` to `state` with fluid byte `fluid` through the hook: 'ok' or the refusal. */
const hookEdit = (p: Page, v: Voxel, state: number, fluid = 0): Promise<string> => p.eval<string>(`__wiTest.edit(${xyz(v)}, ${state}, ${fluid})`);
const hookBlock = (p: Page, v: Voxel): Promise<number> => p.eval<number>(`__wiTest.blockAt(${xyz(v)})`);
const hookAim = (p: Page): Promise<AimRead> => p.eval<AimRead>('__wiTest.aim()');
const hookHistory = (p: Page): Promise<{ size: number; redo: number }> => p.eval('__wiTest.blockHistory()');
const hookFeet = (p: Page): Promise<FeetRead | null> => p.eval<FeetRead | null>('__wiTest.feet()');
/** The page expression "voxel `v` holds `state`". */
const blockIs = (v: Voxel, state: number): string => `__wiTest.blockAt(${xyz(v)}) === ${state}`;
/**
 * The page expression "the block history holds `size` steps to undo and `redo` to redo": an undo's or redo's voxel reads
 * back from the store before the reply moves its step, so a check waits for both.
 */
const historyIs = (size: number, redo: number): string => `(() => { const h = __wiTest.blockHistory(); return h.size === ${size} && h.redo === ${redo}; })()`;
/** Whether the world canvas holds the pointer lock. */
const LOCKED = `document.pointerLockElement !== null && document.pointerLockElement === document.querySelector('canvas[data-renderer]')`;

/** Waits for `n` more rendered frames (`__wiWorld.frames`). */
async function frames(p: Page, n: number, what: string): Promise<void> {
  const f0 = await p.eval<number>('window.__wiWorld.frames');
  await p.until(`window.__wiWorld.frames >= ${f0 + n}`, what, 10_000);
}

/** A mouse button pressed and released at the viewport's centre with no move (the locked pointer's look is untouched). */
async function pressButton(p: Page, button: 'left' | 'right'): Promise<void> {
  const at = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  await p.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await p.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button, buttons: 0, clickCount: 1 });
}

/** A click on the canvas centre asks for the pointer lock; true when headless Chrome granted it. */
async function takeLock(p: Page): Promise<boolean> {
  await p.clickAt(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await sleep(500);
  return p.eval<boolean>(LOCKED);
}

/** The HUD's edit count once it is above `n`, polled every HUD_POLL_MS for `ms`; null when it has not grown. */
async function hudEditsAbove(p: Page, n: number, ms: number): Promise<number | null> {
  for (const t0 = Date.now(); Date.now() - t0 <= ms; await sleep(HUD_POLL_MS)) {
    const k = parseHudEdits(await p.eval<string>(HUD_TEXT));
    if (k !== null && k > n) return k;
  }
  return null;
}

/** Waits for the page expression `pred` within `ms`; true when it held, else a failed check `what` with `detail()`. */
async function holds(t: Smoke, pred: string, what: string, ms: number, detail: () => Promise<unknown>): Promise<boolean> {
  try {
    const waited = await t.page.until(pred, what, ms);
    t.check(true, `${what} (${Math.round(waited)} ms)`);
    return true;
  } catch {
    t.check(false, `${what} within ${ms / 1000} s`, await detail());
    return false;
  }
}

/**
 * `overlay`'s block undo from the 3D (SP5a spec §4.5, §6.4): stone through the hook on the camera's column, at the
 * first voxel above its `motionBlocking` top; Ctrl+Z restores the voxel and Ctrl+Y puts the stone back, both one
 * block-history step.
 */
async function blockUndoFrom3d(t: Smoke, what: string): Promise<void> {
  const p = t.page;
  const cam = parseHud(await p.eval<string>(HUD_TEXT));
  const x = Math.floor(cam?.x ?? 0);
  const z = Math.floor(cam?.z ?? 0);
  const top = cam === null ? null : await p.eval<number | null>(`__wiTest.heightAt(${x}, ${z})`);
  if (top === null) {
    t.check(false, `${what}: the camera's column (${x}, ${z}) is Published for the block undo`, cam);
    return;
  }
  const v = { x, y: top, z };
  const was = await hookBlock(p, v);
  const h0 = await hookHistory(p);
  const r = await hookEdit(p, v, SMOKE_STATE.stone);
  t.check(r === 'ok' && await hookBlock(p, v) === SMOKE_STATE.stone, `${what}: stone through the hook at (${xyz(v)}) (was ${was}): ${r}`);
  const history = () => hookHistory(p);
  await p.blur();
  await p.undoKey();
  await holds(t, `${blockIs(v, was)} && ${historyIs(h0.size, 1)}`, `${what}: Ctrl+Z from the 3D undoes the block (stone → ${was}), its step on the redo side`, 5000, history);
  await p.redoKeyY();
  await holds(t, `${blockIs(v, SMOKE_STATE.stone)} && ${historyIs(h0.size + 1, 0)}`, `${what}: Ctrl+Y from the 3D redoes it (→ stone), one block-history step again`, 5000, history);
}

/** The `build` step's checks on the revealed page (spec §6.4). */
async function buildChecks(t: Smoke): Promise<void> {
  const p = t.page;
  // 1. At −60° the aim meets the ground within reach; the voxel across its face is where the hook places.
  await holds(t, '__wiTest.aim().hit', 'build: at pitch −60 the aim hits a block within reach', 10_000, () => hookAim(p));
  const b = await hookAim(p);
  if (!b.hit) return;
  const at = acrossFace(b);
  const was = await hookBlock(p, at);
  console.log(`  aimed (${xyz(b)}) face ${b.face}; the hook edits (${xyz(at)}), which holds ${was}`);
  t.check(await p.eval<string>('__wiTest.owner()') === 'world', 'build: the world owns the controls');

  // 2. Place and break through the hook; the store reads each back, and the HUD's edit count grows.
  const edits0 = parseHudEdits(await p.eval<string>(HUD_TEXT)) ?? 0;
  const placed = await hookEdit(p, at, SMOKE_STATE.stone);
  const stone = await hookBlock(p, at);
  t.check(placed === 'ok' && stone === SMOKE_STATE.stone, `build: stone placed through the hook: ${placed}, blockAt reads ${stone}`);
  const edits1 = await hudEditsAbove(p, edits0, 10_000);
  t.check(edits1 !== null, `build: the HUD's edit count grows (${edits0} → ${edits1 ?? '?'})`, await p.eval<string>(HUD_TEXT));
  const broken = await hookEdit(p, at, SMOKE_STATE.air);
  const air = await hookBlock(p, at);
  t.check(broken === 'ok' && air === SMOKE_STATE.air, `build: broken through the hook: ${broken}, blockAt reads ${air}`);
  const h0 = await hookHistory(p);
  t.check(h0.size === 2 && h0.redo === 0, `build: the hook's place and break are 2 block-history steps (${h0.size}, redo ${h0.redo})`, h0);

  // 3. Ctrl+Z restores the stone, Ctrl+Y breaks it again: the hook's edits are block-history steps.
  await p.blur();
  await p.undoKey();
  await holds(t, `${blockIs(at, SMOKE_STATE.stone)} && ${historyIs(1, 1)}`, 'build: Ctrl+Z restores the stone (1 step to undo, 1 to redo)', 5000, () => hookHistory(p));
  await p.redoKeyY();
  await holds(t, `${blockIs(at, SMOKE_STATE.air)} && ${historyIs(2, 0)}`, 'build: Ctrl+Y breaks it again (2 steps to undo, none to redo)', 5000, () => hookHistory(p));

  // 4. With the mouse when headless Chrome grants the lock: LMB breaks the aimed block, RMB places the slot's stone.
  const granted = await takeLock(p);
  if (!granted) {
    console.log(`  skipped build: the mouse's break and place: headless Chrome refused the pointer lock (pointerLockElement ${await p.eval<string>('String(document.pointerLockElement)')}); the hook's edits stand for them, and the headful production check covers the mouse`);
  } else {
    await p.key('1', 'Digit1', 49, 0, '1');
    const bar = await p.eval<{ active: number; slots: string[] }>('__wiTest.hotbar()');
    t.check(bar.active === 0 && bar.slots[0] === 'Stone', `build: 1 selects slot 1, ${bar.slots[bar.active] ?? '?'}`, bar);
    const target = await hookAim(p);
    if (!target.hit) t.check(false, 'build: a block aimed for the mouse', target);
    else await pressButton(p, 'left');
    if (target.hit && await holds(t, blockIs(target, SMOKE_STATE.air), `build: LMB breaks the aimed block (${xyz(target)})`, 5000, () => hookAim(p))) {
      await p.until(`(() => { const a = __wiTest.aim(); return !a.hit || a.x !== ${target.x} || a.y !== ${target.y} || a.z !== ${target.z}; })()`, 'build: the aim past the broken block', 5000);
      const next = await hookAim(p);
      const dest = acrossFace(next);
      await pressButton(p, 'right');
      if (next.hit) await holds(t, blockIs(dest, SMOKE_STATE.stone), `build: RMB places stone across the aimed face (${xyz(dest)})`, 5000, () => hookAim(p));
      else t.check(false, 'build: a block to place against after the break', next);
    }
  }

  // 5. E opens the palette with every placeable type and the buckets; a swatch click sets the active slot; Esc closes.
  await p.key('e', 'KeyE', 69, 0, 'e');
  if (await holds(t, `document.getElementById('world-palette')?.hidden === false`, 'build: E opens the palette', 5000, () => p.eval<string>('String(document.getElementById(\'world-palette\')?.hidden)'))) {
    const n = await p.eval<number>(`document.querySelectorAll('#world-palette .palette-swatch').length`);
    t.check(n === PALETTE_SWATCHES, `build: the palette lists ${n} swatches (every placeable type and 3 buckets: ${PALETTE_SWATCHES})`, n);
    const before = await p.eval<{ active: number; slots: string[] }>('__wiTest.hotbar()');
    const label = await p.eval<string>(`document.getElementById('palette-slot-bricks').getAttribute('aria-label')`);
    await p.click('#palette-slot-bricks');
    const after = await p.eval<{ active: number; slots: string[] }>('__wiTest.hotbar()');
    t.check(after.active === before.active && after.slots[after.active] === label && after.slots.every((s, i) => i === after.active || s === before.slots[i]),
      `build: the ${label} swatch sets the active slot ${after.active + 1} (${before.slots[before.active] ?? '?'} → ${after.slots[after.active] ?? '?'})`, { before, after });
    await p.key('Escape', 'Escape', 27);
    await holds(t, `document.getElementById('world-palette')?.hidden === true`, 'build: Esc closes the palette', 5000, async () => null);
  }

  // 6. A torch through the hook raises the block light beside it (block light does not depend on the time of day).
  const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => [at.x + dx!, at.y + dy!, at.z + dz!]);
  const LIT = `Math.max(...${JSON.stringify(around)}.map(([x, y, z]) => { const l = __wiTest.lightAt(x, y, z); return __wiTest.blockAt(x, y, z) === ${SMOKE_STATE.air} && l >= 0 ? l & 15 : -1; }))`;
  const dark = await p.eval<number>(LIT);
  const torch = await hookEdit(p, at, SMOKE_STATE.torch);
  t.check(torch === 'ok', `build: a torch through the hook at (${xyz(at)}): ${torch}`);
  if (await holds(t, `(${LIT}) >= ${TORCH_MIN_LIGHT}`, `build: the torch raises the block light beside it to ≥ ${TORCH_MIN_LIGHT}`, 5000, () => p.eval<number>(LIT))) {
    console.log(`  the block light beside the torch: ${dark} → ${await p.eval<number>(LIT)}`);
  }
  const unlit = await hookEdit(p, at, SMOKE_STATE.air);
  t.check(unlit === 'ok', `build: the torch broken through the hook: ${unlit}`);

  // 7. A block under water stays aimed: water through the hook across the aimed face, and the aim still reports it.
  await frames(p, 3, 'build: three frames after the torch');
  const u = await hookAim(p);
  if (!u.hit) {
    t.check(false, 'build: a block aimed for the water check', u);
    return;
  }
  const w = acrossFace(u);
  const water = await hookEdit(p, w, SMOKE_STATE.air, SMOKE_WATER_SOURCE);
  t.check(water === 'ok', `build: water through the hook at (${xyz(w)}) over the aimed (${xyz(u)}): ${water}`);
  await frames(p, 3, 'build: three frames after the water');
  const under = await hookAim(p);
  t.check(under.hit && sameVoxel(under, u), `build: the block under water is still aimed (${under.hit ? xyz(under) : 'no hit'})`, { before: u, after: under });
  if (!granted || !(await takeLock(p))) {
    console.log(`  skipped build: the outline of the block under water: ${granted ? 'the lock was not granted again' : 'headless Chrome refused the pointer lock'} (the outline shows only while locked); the headful production check covers it`);
  } else {
    await frames(p, 3, 'build: three frames after the lock');
    const shown = await hookAim(p);
    t.check(shown.hit && sameVoxel(shown, u) && shown.outline, `build: the outline object is visible around the block under water`, shown);
    await p.eval('(document.exitPointerLock(), true)');
  }
}

async function runBuild(t: Smoke): Promise<void> {
  const p = t.page;
  t.step(`build: ${BUILD_QUERY}: place and break through the hook (and the mouse when the lock is granted), the HUD's edit count, Ctrl+Z and Ctrl+Y, the palette (E, a swatch, Esc), a torch's block light, a block under water still aimed`);
  const errors0 = t.errors.length;
  try {
    await p.goto(`${p.base}${BUILD_QUERY}`, `window.__wiWorld !== undefined`);
    if (await worldRevealed(t, 'build')) {
      await p.until('window.__wiWorld.frames >= 3', 'three frames after the build reveal', 30_000);
      await buildChecks(t);
    }
  } catch (e) {
    t.check(false, `build: the step stopped: ${e instanceof Error ? e.message : String(e)}`);
  }
  t.check(t.errors.length === errors0, 'build: no page error', t.errors.slice(errors0));
}

/** The `walk` step's checks on the revealed page (spec §6.4). */
async function walkChecks(t: Smoke): Promise<void> {
  const p = t.page;
  // 1. F: walking, the feet on the ground within 3 s, their y stable.
  await p.blur();
  await p.key('f', 'KeyF', 70, 0, 'f');
  const grounded = `__wiTest.mode() === 'walk' && __wiTest.feet()?.onGround === true`;
  if (!(await holds(t, grounded, 'walk: F walks, and the feet reach the ground', WALK_GROUND_MS, async () => ({ mode: await p.eval<string>('__wiTest.mode()'), feet: await hookFeet(p) })))) return;
  const f0 = await hookFeet(p);
  await sleep(300);
  const f1 = await hookFeet(p);
  t.check(f0 !== null && f1 !== null && f1.onGround && f1.y === f0.y, `walk: the feet stay on the ground at y ${f1?.y ?? '?'}`, { f0, f1 });
  if (f1 === null) return;

  // 2. The corridor (ruling R30), then W for 4 s along it with real key input.
  const corridor = walkCorridor(f1, WALK_PATH_BLOCKS);
  const refused = await p.eval<string[]>(`(async () => {
    const out = [];
    for (const [x, y, z, s] of ${JSON.stringify(corridor.map((e) => [e.x, e.y, e.z, e.state]))}) {
      const r = await __wiTest.edit(x, y, z, s, 0);
      if (r !== 'ok') out.push(x + ', ' + y + ', ' + z + ': ' + r);
    }
    return out;
  })()`);
  t.check(refused.length === 0, `walk: the ${WALK_PATH_BLOCKS}-block stone corridor along −z through the hook (${corridor.length} edits)`, refused);
  const start = (await hookFeet(p)) ?? f1;
  const w = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 };
  await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...w, text: 'w', unmodifiedText: 'w' });
  await sleep(WALK_HOLD_MS);
  await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...w });
  await sleep(300);
  const end = await hookFeet(p);
  const moved = end === null ? 0 : hudMoved(start, end);
  if (moved > WALK_MIN_MOVE) {
    t.check(true, `walk: W for ${WALK_HOLD_MS / 1000} s moves the feet ${moved.toFixed(1)} blocks (> ${WALK_MIN_MOVE})`);
  } else {
    const gy = Math.round(start.y);
    const ahead = end === null ? null : await p.eval<number[][]>(`[1, 2, 3].map((k) => [${gy - 1}, ${gy}, ${gy + 1}].map((y) => __wiTest.blockAt(${Math.floor(end.x)}, y, ${Math.floor(end.z)} - k)))`);
    t.check(false, `walk: W for ${WALK_HOLD_MS / 1000} s moves the feet ${moved.toFixed(1)} blocks (> ${WALK_MIN_MOVE})`, { yaw: 0, start, end, ahead });
  }

  // 3. Space jumps: a page-side tracker of the feet's highest y (the HUD's 250 ms refresh would miss the 270 ms rise).
  if (!(await holds(t, grounded, 'walk: the feet on the ground before the jump', WALK_GROUND_MS, () => hookFeet(p)))) return;
  const y0 = (await hookFeet(p))?.y ?? Number.NaN;
  await p.eval(`(() => {
    const s = { max: -Infinity, run: true };
    window.__wiJump = s;
    const track = () => {
      const f = __wiTest.feet();
      if (f !== null && f.y > s.max) s.max = f.y;
      if (s.run) requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    return true;
  })()`);
  const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...space, text: ' ', unmodifiedText: ' ' });
  await sleep(150);
  await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
  await sleep(1000);
  const top = await p.eval<number>('(window.__wiJump.run = false, window.__wiJump.max)');
  t.check(top - y0 > JUMP_MIN_RISE, `walk: Space jumps: the feet rise ${(top - y0).toFixed(2)} (> ${JUMP_MIN_RISE}) above y ${y0}`, { y0, top });

  // 4. A walking teleport: M, full screen, a click 300 px east of the arrow; once the snap clears, the feet stand on
  // heightAt('motionBlocking') (ruling R29).
  await pressM(p);
  await p.until(OVERLAY_SHOWN, 'walk: the overlay after M', 15_000);
  if (await p.eval<boolean>(WORLD_SPLIT)) {
    await p.click('#map-mode-full');
    await p.until(`!(${WORLD_SPLIT})`, 'walk: full screen through the header', 5000);
  }
  const box = await p.eval<Box>(MAP_CANVAS_BOX);
  await p.clickAt(Math.round(box.x + box.width / 2 + TELEPORT_EAST_PX), Math.round(box.y + box.height / 2));
  if (!(await holds(t, `__wiTest.lastLanding() !== null && (${OVERLAY_CLOSED})`, 'walk: a click on the map teleports and the map closes', 10_000, () => p.eval('__wiTest.lastLanding()')))) return;
  t.check(await p.eval<string>('__wiTest.mode()') === 'walk', 'walk: still walking after the teleport');
  if (!(await holds(t, `(() => { const f = __wiTest.feet(); return f !== null && !f.snapPending; })()`, 'walk: the snap clears once the column is Published', 30_000, () => hookFeet(p)))) return;
  const landing = await p.eval<{ surface: number; water: number | null; y: number }>('__wiTest.lastLanding()');
  // On land the next tick's sweep finds the ground.
  if (landing.water === null) {
    try {
      await p.until('__wiTest.feet()?.onGround === true', 'walk: on the ground after the snap', 2000);
    } catch { /* checked below */ }
  }
  const feet = await hookFeet(p);
  const height = feet === null ? null : await p.eval<number | null>(`__wiTest.heightAt(${feet.x}, ${feet.z})`);
  t.check(walkSnapOk(feet, height, landing.water),
    `walk: the walking teleport lands on heightAt('motionBlocking') ${height ?? '?'}: the snap's y ${feet?.snapY ?? '?'}${landing.water === null ? `, the feet at y ${feet?.y ?? '?'} on the ground` : ` (over water at ${landing.water}: the body sinks)`}`,
    { feet, height, landing });
}

async function runWalk(t: Smoke): Promise<void> {
  const p = t.page;
  t.step(`walk: ${WALK_QUERY}: F, the feet on the ground within 3 s, W for 4 s along a ${WALK_PATH_BLOCKS}-block stone corridor, Space jumps, a walking teleport lands on heightAt('motionBlocking')`);
  const errors0 = t.errors.length;
  try {
    await p.goto(`${p.base}${WALK_QUERY}`, `window.__wiWorld !== undefined`);
    if (await worldRevealed(t, 'walk')) {
      await p.until('window.__wiWorld.frames >= 3', 'three frames after the walk reveal', 30_000);
      await walkChecks(t);
    }
  } catch (e) {
    t.check(false, `walk: the step stopped: ${e instanceof Error ? e.message : String(e)}`);
  }
  t.check(t.errors.length === errors0, 'walk: no page error', t.errors.slice(errors0));
}

// ---------------------------------------------------------------- screenshots (spec §12)

async function runShots(p: Page, dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const save = async (name: string) => {
    const f = join(dir, name);
    await p.shot(f);
    out.push(f);
    console.log(`  wrote ${f}`);
  };
  console.log('\nscreenshots');
  await p.goto(`${p.base}?map#${mapHash(START)}`, MAP_READY);

  // The panel: the Rivers section with widthMin 12 (modified dot and reset, section count, a noise sub-block).
  await p.click('#map-tab-parameters');
  if (await p.eval<boolean>(`document.getElementById('pp-section-rivers').hidden`)) await p.click('.pp-section[data-path="rivers"] > .pp-section-head > .pp-toggle');
  let before = await p.hash();
  await p.typeInto('#pp-rivers.widthMin', '12');
  await p.enter();
  await p.changed(before, 'the widthMin edit');
  await p.eval(`document.querySelector('.pp-section[data-path="rivers"]').scrollIntoView({ block: 'start' }); true`);
  await sleep(1500);
  await save('panel.png');
  await p.blur();
  before = await p.hash();
  await p.undoKey();
  await p.changed(before, 'Ctrl+Z');

  // The drawer with its overlays: shape.offset at the root, a knot selected.
  if (await p.eval<boolean>(`document.getElementById('pp-section-shape').hidden`)) await p.click('.pp-section[data-path="shape"] > .pp-section-head > .pp-toggle');
  await p.click('.pp-control[data-path="shape.offset"] .pp-edit');
  await p.until(`document.querySelector('.sd-stats').dataset.state === 'fresh'`, 'fresh spline statistics');
  const knots = await p.eval<Array<{ nested: boolean; x: number; y: number }>>(`[...document.querySelectorAll('.sd-plot circle.sd-knot')].map((c) => { const r = c.getBoundingClientRect(); return { nested: c.classList.contains('sd-nested'), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const knot = knots.find((k) => !k.nested) ?? knots[Math.floor(knots.length / 2)]!;
  await p.clickAt(knot.x, knot.y);
  await sleep(1500);
  await save('drawer-overlays.png');

  // The map during a drag: the selected knot held 30 px up while the previews land.
  const end = await p.dragBy(knot.x, knot.y, 0, -3, 10);
  await sleep(1200);
  await save('map-drag.png');
  await p.mouse('mouseReleased', end.x, end.y);
  await p.until('__wiSmoke.settled()', 'settled preview after the drag');
  before = await p.hash();
  await p.blur();
  await p.undoKey();
  await p.changed(before, 'Ctrl+Z');
  await p.key('Escape', 'Escape', 27);

  // The share chart, fresh, at the top of the Biomes tab.
  await p.click('#map-tab-biomes');
  await p.until(`document.querySelector('.bs').dataset.state === 'fresh'`, 'fresh biome shares');
  await p.eval(`document.querySelector('.bs').scrollIntoView({ block: 'start' }); true`);
  await sleep(500);
  await save('shares.png');

  // The biome table with a highlighted row: the chart folded, the pointer on the plains row.
  await p.click('.bs-head');
  const row = await p.center('.bt-row[data-biome="plains"]');
  await p.mouse('mouseMoved', row.x, row.y);
  await sleep(1500);
  await save('biome-table-highlight.png');
  await p.mouse('mouseMoved', row.x - 600, row.y);

  // The presets tab with a name typed.
  await p.click('#map-tab-presets');
  await p.typeInto('#pt-name', 'smoke test');
  await sleep(300);
  await save('presets.png');

  // The cross-section: the line of the Task 23 check across a coast with rivers, gorges and a lake (4 blocks/px).
  await p.goto(`${p.base}?map#${mapHash({ ...START, view: { x: 5888, z: 3072, bpp: 4, layer: 'biome' } })}`, MAP_READY);
  await p.click('#map-tab-world');
  await p.click('.map-cut');
  const cv = await p.center('.map-canvas');
  const cx = Math.round(cv.box.x + Math.round(cv.box.width / 2));
  await p.clickAt(cx - 192, Math.round(cv.box.y + Math.round(cv.box.height / 2)));
  await p.clickAt(cx + 192, Math.round(cv.box.y + Math.round(cv.box.height / 2)));
  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh cross-section');
  const frame = await p.center('.cs-plot .cs-frame');
  await p.mouse('mouseMoved', frame.box.x + (frame.box.width * 470) / 511, frame.y);
  await sleep(1500);
  await save('cross-section.png');

  // The same line in the Voxels mode (SP3a spec §5.2), the pointer under the sea near B.
  await p.click('.cs-mode[data-mode="voxels"]');
  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice');
  const vox = await p.center('.cs-voxels');
  await p.mouse('mouseMoved', vox.box.x + vox.box.width * 0.1, vox.box.y + (vox.box.height * (319 - 50)) / 384);
  await sleep(1000);
  await save('cross-section-voxels.png');

  // The Voxels mode on the mountain line (SP3b spec §7, §11): the real T's peaks, the pointer on the top voxel of the
  // rule step's sample and the readout with its surface rule id (SP3c spec §6, §9).
  const { text, summary } = await openMountainVoxels(p);
  if (!mountainSummaryOk(summary)) throw new Error(`the mountain slice: ${summary} (expected a ground top above y 200 and no water)`);
  console.log(`  mountain line: ${text}; ${summary}`);
  const hover = await hoverTopRule(p);
  if (hover === null || !hover.ruledOk) throw new Error(`the mountain screenshot's hover: ${hover?.ruled ?? `sample ${RULE_SAMPLE} is all air`}`);
  console.log(`  hover: ${hover.ruled}`);
  await sleep(1000);
  await save('cross-section-voxels-mountain.png');

  // The Density tab on the same line (SP3d spec §6 step 7, §11's review): the vertical density slice with the pointer
  // on a ground voxel near the top of sample 51 (40 % of the line), the readout and the form's value at the hover.
  await p.click('#map-drawer-tab-density');
  // The drawer dragged to its tallest (60 % of the viewport), so the slice box is large enough to read.
  const split = await p.center('.map-split-h');
  const top = await p.dragBy(split.x, split.y, 0, -15, 20);
  await p.mouse('mouseReleased', top.x, top.y);
  await p.choose(SV_FIELD, 'density');
  await p.until(Page.fresh(128), 'a fresh 128² density slice of the mountain line');
  console.log(`  drawer ${await p.eval<number>(`Math.round(document.querySelector('.map-drawer').getBoundingClientRect().height)`)} px, slice box ${await p.eval<number>(`Math.round(document.querySelector('${SV_BOX}').getBoundingClientRect().width)`)} px`);
  const groundRow = await p.eval<number>(`(() => { const d = document.querySelector('.sv > .sv-body .sv-box > canvas.sv-image').getContext('2d').getImageData(51, 0, 1, 128).data; for (let r = 0; r < 128; r++) if (d[4 * r] > d[4 * r + 2] + 8) return r; return -1; })()`);
  if (groundRow < 0) throw new Error('sample 51 of the mountain density slice has no solid voxel');
  const fy = (groundRow + 3.5) / 128;
  const vh = await hoverSlice(p, 51.5 / 128, fy, false);
  if (vh === null || !hoverAgrees(vh.readout, vh.hover)) throw new Error(`the Density hover: ${vh?.readout ?? '-'} | ${vh?.hover ?? '-'}`);
  console.log(`  density hover: ${vh.readout} | ${vh.hover}`);
  await sleep(500);
  await save('density-vertical-hover.png');

  // The terrain tap selected and muted from its row (the row's mute keeps the selection, so the form shows the tap):
  // the slice is the detail noise alone; the pointer back on the same voxel.
  await p.mouse('mouseMoved', 5, 5);
  await p.click(`${ROW('root.a.a')} .it-node`);
  await p.click(`${ROW('root.a.a')} .it-mute`);
  await p.until(Page.fresh(128, `document.querySelector(${JSON.stringify(ROW('root.a.a'))}).classList.contains('it-muted')`), 'the slice of the muted terrain');
  const mh = await hoverSlice(p, 51.5 / 128, fy, false);
  console.log(`  muted hover: ${mh?.readout ?? '-'} | ${mh?.hover ?? '-'}`);
  await sleep(500);
  await save('density-muted-terrain.png');

  // A broken JSON (an unknown op at the islands tap's child): the issue with its path, the world untouched.
  await p.mouse('mouseMoved', 5, 5);
  const printed = await p.eval<string>(`document.querySelector('${JE_TEXT}').value`);
  await p.click(JE_TEXT);
  await p.eval(`(document.querySelector('${JE_TEXT}').select(), true)`);
  await p.cdp.send('Input.insertText', { text: brokenIslandsJson(printed) });
  await p.until(`document.querySelector('.je-status').dataset.status === 'invalid'`, 'the editor\'s verdict', 5000);
  await sleep(500);
  await save('density-broken-json.png');
  await p.key('Escape', 'Escape', 27);
  await p.blur();
  before = await p.hash();
  await p.click('.map-toolbar button[title^="Undo"]');
  await p.changed(before, 'the toolbar Undo of the mute');

  // The horizontal plane at extent 8192 around the view centre, the root selected, the pointer at the slice's centre.
  await p.click(`${ROW('root')} .it-node`);
  await p.choose(SV_PLANE, 'horizontal');
  await p.choose(SV_EXTENT, '8192');
  await p.until(Page.fresh(128, `document.querySelector('.sv > .sv-body > .sv-ends > span').textContent === 'x -5248'`), 'a fresh horizontal slice at extent 8192');
  const hh = await hoverSlice(p, 0.5, 0.5, false);
  console.log(`  horizontal hover: ${hh?.readout ?? '-'} | ${hh?.hover ?? '-'}`);
  await sleep(500);
  await save('density-horizontal-8192.png');

  // The stacked layout: the viewport narrowed until the Density tab is 800 px wide, the vertical slice scrolled into view.
  await p.mouse('mouseMoved', 5, 5);
  await p.choose(SV_PLANE, 'vertical');
  await p.until(Page.fresh(128), 'a fresh vertical slice');
  // The narrow page scrolls, so its scrollbar takes width too: the viewport is corrected until the tab is 800 px.
  let width: number = VIEWPORT.width;
  for (let i = 0; i < 4; i++) {
    const drawer = await p.eval<number>(`Math.round(document.querySelector('.it').getBoundingClientRect().width)`);
    if (drawer === 800) break;
    width = viewportForDrawer({ viewport: width, drawer }, 800);
    await p.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  }
  await p.until(`document.querySelector('.it').dataset.layout === 'stack' && Math.round(document.querySelector('.it').getBoundingClientRect().width) === 800`, 'the stacked layout at 800 px', 10000);
  console.log(`  viewport ${width} × ${VIEWPORT.height}: the Density tab is 800 px wide`);
  await p.eval(`(document.querySelector('.it-slice').scrollIntoView({ block: 'end' }), true)`);
  await p.until(Page.fresh(128), 'a fresh slice in the stacked layout');
  await sleep(1000);
  await save('density-stacked-800.png');
  await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });

  // The draft presets (SP3e spec §8): the Voxels mode on each preset's line with the drawer at its tallest — archipelago
  // with the pointer on the top of the line's middle sample, amplified on its highest top, floating_islands on the
  // ground under the island nearest the middle (D21 (b): its palette and rule) —, then the two map layers.
  for (const preset of SMOKE_PRESETS) {
    const line = presetLine(preset);
    const { text: pl, summary: ps } = await openLineVoxels(p, presetState(preset, line.view), line, `${preset}'s line`);
    if (!presetSummaryOk(preset, ps)) throw new Error(`${preset}'s slice: ${ps}`);
    const split = await p.center('.map-split-h');
    const up = await p.dragBy(split.x, split.y, 0, -15, 25);
    await p.mouse('mouseReleased', up.x, up.y);
    await sleep(800);
    const image = await voxelImage(p);
    let at: { i: number; row: number } | null;
    if (preset === 'floating_islands') {
      const island = islandSample(image);
      at = island === null ? null : { i: island.i, row: island.groundRow };
    } else if (preset === 'amplified') {
      at = highestSample(image);
    } else {
      const row = groundTopRow(sliceColumn(image, 256));
      at = row === null ? null : { i: 256, row };
    }
    if (at === null) throw new Error(`${preset}'s line has no sample to hover`);
    const read = await hoverVoxel(p, at.i, at.row);
    console.log(`  ${preset} line: ${pl}; ${ps}; hover: ${read}`);
    await sleep(800);
    await save(`preset-${preset}.png`);
    await p.mouse('mouseMoved', 5, 5);
  }
  for (const [preset, layer, name] of [['archipelago', 'biome', 'preset-archipelago-map.png'], ['floating_islands', 'islandMask', 'preset-floating_islands-islandMask.png']] as const) {
    const { clip } = await openPresetMap(p, preset, layer);
    const f = join(dir, name);
    await p.shot(f, clip);
    out.push(f);
    console.log(`  wrote ${f} (${layer}, ${PRESET_MAP.px * PRESET_MAP.bpp}² blocks around ${presetCentre(preset).join(', ')})`);
  }
  return out;
}

// ---------------------------------------------------------------- main

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  let profile: string | null = null;
  const pageErrors: string[] = [];
  const ignored: string[] = [];
  const cleanup = async () => {
    cdp?.close();
    if (chrome !== null && running(chrome.proc)) {
      try {
        const browser = await connect(chrome.wsUrl);
        await Promise.race([browser.send('Browser.close'), sleep(3000)]).catch(() => undefined);
        browser.close();
      } catch { /* the stop below still ends it */ }
      if (running(chrome.proc)) await Promise.race([new Promise<void>((r) => chrome!.proc.once('exit', () => r())), sleep(5000)]);
    }
    await stopStarted();
    if (profile !== null) rmSync(profile, { recursive: true, force: true });
  };
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (args.build) await npmBuild();
    const port = await freePort();
    const server = await startPreview(port);
    console.log(`vite preview (pid ${server.proc.pid}) on ${server.url}`);
    profile = mkdtempSync(join(resolve(args.profileDir ?? tmpdir()), 'wi10-smoke-chrome-'));
    const downloads = join(profile, 'downloads');
    mkdirSync(downloads);
    chrome = await startChrome({ headless: true, profileDir: profile, args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`, ...SWIFTSHADER_ARGS], env: {} });
    console.log(`headless Chrome (pid ${chrome.proc.pid}) with DevTools on port ${chrome.port}, profile ${profile}`);
    const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json() as { Browser?: string };
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.type === 'page');
    if (target === undefined) throw new Error('Chrome has no page target');
    cdp = await connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', (e) => {
      const d = e['exceptionDetails'] as { text?: string; exception?: { description?: string } };
      pageErrors.push(`exception: ${d.exception?.description ?? d.text ?? ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', (e) => {
      if (e['type'] !== 'error' && e['type'] !== 'assert') return;
      pageErrors.push(`console.${String(e['type'])}: ${(e['args'] as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description)).join(' ')}`);
    });
    cdp.on('Log.entryAdded', (e) => {
      const entry = e['entry'] as { level: string; text: string; url?: string };
      if (entry.level !== 'error') return;
      const line = `log: ${entry.text}${entry.url === undefined ? '' : ` (${entry.url})`}`;
      if (ignoredLog(entry.text, entry.url) || leaveGuardLog(entry.text, entry.url)) ignored.push(line);
      else pageErrors.push(line);
    });
    // The world page arms a Ctrl+W guard (`beforeunload`) after its reveal (SP4a spec §7.1): the steps' own navigations
    // leave it, so its prompt is accepted; any other dialog stays unanswered (and the step times out).
    cdp.on('Page.javascriptDialogOpening', (e) => {
      if (e['type'] !== 'beforeunload') return;
      console.log('  (accepted the page\'s beforeunload prompt)');
      void cdp?.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__wiSmoke = (${pageHelpers.toString()})();` });
    console.log(`${version.Browser ?? 'Chrome'}, ${VIEWPORT.width} × ${VIEWPORT.height} CSS px at DPR 1`);

    const page = new Page(cdp, server.url);
    const smoke = new Smoke(page, downloads, pageErrors, args.shots);
    try {
      await runSmoke(smoke);
    } catch (e) {
      smoke.check(false, `the step stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
    smoke.step('console: no page errors (the favicon.ico 404 aside)');
    const missing = SMOKE_STEPS.filter((s) => !smoke.ran.includes(s));
    smoke.check(missing.length === 0, `every step of SMOKE_STEPS ran (${smoke.ran.length})`, missing);
    for (const l of ignored) console.log(`  ignored ${l}`);
    smoke.check(pageErrors.length === 0, `${pageErrors.length} page error(s)`, pageErrors);
    if (args.shots !== null) await runShots(page, args.shots);
    if (args.shots !== null && pageErrors.length > 0) smoke.check(false, 'page errors during the screenshots', pageErrors);
    const failed = smoke.checks.filter((c) => !c.ok);
    console.log(`\nsmoke: ${smoke.checks.length - failed.length}/${smoke.checks.length} checks pass${failed.length === 0 ? '' : `; failed: ${failed.map((c) => `${c.step} — ${c.what}`).join('; ')}`}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}

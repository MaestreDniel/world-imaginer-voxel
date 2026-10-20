import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { allGoldenKeys } from '../../src/metrics/sp2aGoldens';
import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
import { decodeMapState, DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
import { presetText } from '../../src/ui/presets/presetFile';
import { segmentText } from '../../src/ui/crossSection/model';
import { RULE_WAITING, ruleSuffix, sliceRgba, sliceSummary, VOXEL_COLORS, voxelLegend, voxelReadout, voxelRgb } from '../../src/ui/crossSection/voxels';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, GRASS_BLOCK, SNOW_BLOCK, STONE } from '../../src/world/blocks/index';
import { SLICE_SAMPLES, sliceIndex } from '../../src/workers/protocol';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { Segment } from '../../src/metrics/crossSection';
import { checkLeafCandidate, issueText } from '../../src/ui/inspector/editorModel';
import { parseTree, printTree } from '../../src/ui/inspector/jsonText';
import { densityLayout } from '../../src/ui/inspector/model';
import {
  clampCentre, formatSliceValue, histogramLabels, hoverLineText, sliceAxisLabels, sliceGeometryOf, sliceHoverText, sliceStats, sliceStatusText,
  type SliceShown,
} from '../../src/ui/inspector/sliceModel';
import { screenToWorld } from '../../src/ui/map/viewMath';
import { DRAFT_PRESETS, presetReviewSite, REVIEW_SITES, siteLine } from '../harness/reviewSlices';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { biomeColor, biomeFamily, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { sp3eWindow, WINDOW_PRESETS } from '../../src/metrics/sp3eGoldens';
import { profileOptions } from '../../src/ui/map/toolbar';
import {
  BIOME_RGB, biomePixels, brokenIslandsJson, canonicalJson, clickCentre, crossPixels, distinctColours, freshSlice, goldenCount, groundTopRow, hoverAgrees, ignoredLog,
  ISLAND_MIN_BOTTOM_Y, islandOverGround, islandsFloorOk, issueLineOk, mapHash, MOUNTAIN_LINE, mountainSummaryOk, oceanAndLandOk, parseArgs, parseSegment, parseSliceReadout,
  parseSliceStats, presetCentre, presetLine, PRESET_MAP, PRESET_SHOTS, PRESET_TOP_MIN, presetProblems, presetState, presetSummaryOk, readMapHash, READY_PROFILES,
  RULE_SAMPLE, sameJson, selftestAllMatch, SIZE_7, SIZE_8, SKY_RGB, sliceCellPoint, sliceColumn, SMOKE_PRESETS, SMOKE_STEPS, SQUARE_RGB, squareLabels, START, stepId,
  summaryTopMax, timesText, VIEWPORT, viewportForDrawer, voxelLegendLabels, voxelReadoutOk, voxelRuleId, voxelSummaryOk, WATER_RGB, waterPixel, type MapUrlState,
  type SmokePreset,
} from '../tools/uiSmoke';

const EDITED: MapState = {
  v: 1, seed: '42', profile: 'default',
  patch: { rivers: { gorgeDepth: 40, widthMin: 12 }, climate: { scaleMul: BIOME_SIZE_SCALE[7]! } },
  view: { x: 5888, z: -3072, bpp: 4, layer: 'relief' },
};

describe('UI smoke test: pure parts (SP2b spec §8 Tools, §12)', () => {
  test('screenshots and the page run at 1400 × 900 CSS px, as SP2a\'s', () => {
    expect(VIEWPORT).toEqual({ width: 1400, height: 900 });
  });

  test('the slider target is the biome-size table\'s position 8', () => {
    expect(SIZE_8).toBe(BIOME_SIZE_SCALE[7]);
  });

  test('the canonical JSON sorts keys at every level, as the page\'s canonicalJSON does', () => {
    for (const v of [EDITED, { b: [{ d: 1, c: null }, 'x'], a: true }, {}, [], 0.1]) expect(canonicalJson(v)).toBe(canonicalJSON(v));
    expect(sameJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });

  test('the URL fragment is the page\'s own encoding of a map state, and reads back', () => {
    for (const s of [DEFAULT_MAP_STATE, EDITED]) {
      expect(mapHash(s as MapUrlState)).toBe(encodeMapState(s));
      expect(readMapHash(`#${encodeMapState(s)}`)).toEqual(s);
      expect(readMapHash(encodeMapState(s))).toEqual(s);
    }
    expect(readMapHash('')).toBeNull();
    expect(readMapHash('#not-base64-json')).toBeNull();
    expect(readMapHash(`#${Buffer.from(JSON.stringify({ ...DEFAULT_MAP_STATE, v: 2 })).toString('base64url')}`)).toBeNull();
  });

  test('only the favicon.ico 404 is ignored among page log errors', () => {
    const notFound = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(ignoredLog(notFound, 'http://127.0.0.1:40000/favicon.ico')).toBe(true);
    expect(ignoredLog(notFound, 'http://127.0.0.1:40000/assets/task.worker-x.js')).toBe(false);
    expect(ignoredLog(notFound, undefined)).toBe(false);
    expect(ignoredLog('Failed to load resource: net::ERR_CONNECTION_REFUSED', 'http://127.0.0.1:40000/favicon.ico')).toBe(false);
  });

  test('a downloaded preset is checked against the draft it was exported from', () => {
    const patch = { rivers: { gorgeDepth: 40 }, biomes: { zoomJitter: 0.5 } };
    const r = applyPatch(SCHEMA, resolveProfile('default'), patch);
    if (!r.ok) throw new Error('bad test patch');
    const text = presetText('smoke test', 'default', r.value);
    expect(presetProblems(text, { name: 'smoke test', profile: 'default', patch })).toEqual([]);
    expect(presetProblems(text, { name: 'other', profile: 'large_biomes', patch: {} })).toEqual(['name "smoke test"', 'profile "default"', 'params differ from the draft\'s patch']);
    expect(presetProblems('{"format":"x"}', { name: 'a', profile: 'default', patch: {} })).toEqual(['format "x"', 'name undefined', 'profile undefined', 'schemaVersion undefined', 'params differ from the draft\'s patch']);
    expect(presetProblems('{', { name: 'a', profile: 'default', patch: {} })[0]).toMatch(/^not JSON: /);
  });

  // Skipped while `npm run test:goldens` records: test/goldens.json gains the new keys only after the run.
  test.skipIf(process.env.UPDATE_GOLDENS === '1')('test/goldens.json holds every golden key of the build, the count the selftest step expects', () => {
    const text = readFileSync(new URL('../goldens.json', import.meta.url), 'utf8');
    expect(goldenCount(text)).toBe(allGoldenKeys().length);
  });

  test('the selftest step counts the goldens of test/goldens.json and matches the page summary against it', () => {
    expect(goldenCount('{"generatorVersion":3,"entries":{"a":"1","b":"2"}}')).toBe(2);
    expect(() => goldenCount('{"generatorVersion":3}')).toThrow(/entries/);
    expect(selftestAllMatch('✓ all 54 goldens match (3.2 s)', 54)).toBe(true);
    expect(selftestAllMatch('✓ all 52 goldens match (3.2 s)', 54)).toBe(false);
    expect(selftestAllMatch('✗ 1 of 54 goldens differ (3.2 s)', 54)).toBe(false);
    expect(selftestAllMatch('computing 54/54…', 54)).toBe(false);
  });

  test('the Voxels step reads the page\'s hover readout and summary in the formats the cut line writes (SP3a spec §5.2)', () => {
    const blocks = new Uint16Array(SLICE_SAMPLES);
    const fluid = new Uint8Array(SLICE_SAMPLES);
    for (let i = 0; i < 512; i++) {
      for (let y = -64; y <= 70; y++) {
        blocks[sliceIndex(i, y)] = y === -64 ? BEDROCK : y <= (i < 100 ? 40 : 70) ? STONE : AIR;
        if (i < 100 && y > 40 && y <= 63) fluid[sliceIndex(i, y)] = WATER_SOURCE;
      }
    }
    const s = { blocks, fluid };
    const line = { ax: -2030, az: 7, bx: 1950, bz: -1990 };
    for (const [i, y] of [[0, 63], [0, 64], [0, 40], [511, -64], [300, 319]] as const) {
      const text = voxelReadout(line, s, i, y);
      expect(voxelReadoutOk(text), text).toBe(true);
    }
    expect(voxelReadoutOk('hover the voxels to read a block')).toBe(false);
    expect(voxelReadoutOk('12.0 blocks from A · x 1.0 z 2.0 · offset0 1.00')).toBe(false);
    expect(voxelSummaryOk(sliceSummary(s))).toBe(true);
    expect(voxelSummaryOk(sliceSummary({ blocks: new Uint16Array(SLICE_SAMPLES), fluid: new Uint8Array(SLICE_SAMPLES) }))).toBe(false);
    expect(voxelSummaryOk('offset 1.0 to 2.0 blocks · water on 0.0 % of the line')).toBe(false);
  });

  test('the Voxels readout may end with the hover rule id: … while the probe runs, none, or a rule id from root (SP3c spec §6)', () => {
    const blocks = new Uint16Array(SLICE_SAMPLES);
    const fluid = new Uint8Array(SLICE_SAMPLES);
    blocks[sliceIndex(3, 70)] = GRASS_BLOCK;
    const base = voxelReadout({ ax: -2030, az: 7, bx: 1950, bz: -1990 }, { blocks, fluid }, 3, 70);
    expect(base.includes(' · grass_block · ')).toBe(true);
    const grass = ruleSuffix(['root', 'root.rules[1]', 'root.rules[1].then', 'root.rules[1].then.rules[3]', 'root.rules[1].then.rules[3].then',
      'root.rules[1].then.rules[3].then.rules[6]', 'root.rules[1].then.rules[3].then.rules[6].then', 'root.rules[1].then.rules[3].then.rules[6].then.rules[7]']);
    for (const suffix of ['', RULE_WAITING, ruleSuffix([]), grass, ruleSuffix(['root', 'root.rules[2]', 'root.rules[2].then'])]) {
      expect(voxelReadoutOk(base + suffix), base + suffix).toBe(true);
    }
    for (const suffix of [' · rule ', ' · rule stone', ' · rule failed: BAD_ARGS: y', ' · rule root.rules[1] x', ' · rule none · rule none']) {
      expect(voxelReadoutOk(base + suffix), base + suffix).toBe(false);
    }
    expect(voxelRuleId(base + grass)).toBe('root.rules[1].then.rules[3].then.rules[6].then.rules[7]');
    expect(voxelRuleId(base + ruleSuffix(['root', 'root.rules[0]', 'root.rules[0].then']))).toBe('root.rules[0].then');
    for (const text of [base, base + RULE_WAITING, base + ruleSuffix([]), 'hover the voxels to read a block']) expect(voxelRuleId(text)).toBeNull();
  });

  test('the Voxels legend\'s labels: every state of the state-id lock in id order, as the page writes them, then water and the sea line', () => {
    const labels = voxelLegendLabels(readFileSync(new URL('../stateIds.lock.json', import.meta.url), 'utf8'));
    expect(labels).toEqual([...voxelLegend().map((k) => k.label), 'water, darker with depth', 'sea level 63']);
    expect(labels).toHaveLength(27);
    expect(labels.slice(0, 4)).toEqual(['air', 'stone', 'bedrock', 'grass_block']);
    expect(() => voxelLegendLabels('{"stone":1,"air":0,"bedrock":3}')).toThrow(/state ids/);
  });

  test('groundTopRow reads the top solid voxel of a sample column from the slice image: the first row not in the sky colour', () => {
    expect(SKY_RGB).toEqual(VOXEL_COLORS.sky);
    const blocks = new Uint16Array(SLICE_SAMPLES);
    const fluid = new Uint8Array(SLICE_SAMPLES);
    for (let y = -64; y <= 140; y++) blocks[sliceIndex(10, y)] = y === -64 ? BEDROCK : y === 140 ? SNOW_BLOCK : STONE;
    blocks[sliceIndex(11, 319)] = GRASS_BLOCK;
    blocks[sliceIndex(12, -64)] = BEDROCK;
    const rgba = sliceRgba({ blocks, fluid });
    // The page reads one sample column, getImageData(i, 0, 1, 384): its 384 pixels top down.
    const column = (i: number) => Array.from({ length: 4 * 384 }, (_, k) => rgba[4 * (Math.floor(k / 4) * 512 + i) + (k % 4)]!);
    expect(groundTopRow(column(10))).toBe(319 - 140);
    expect(groundTopRow(column(11))).toBe(0);
    expect(groundTopRow(column(12))).toBe(383);
    expect(groundTopRow(column(13))).toBeNull();
    expect(() => groundTopRow(new Uint8ClampedArray(16))).toThrow(/384 RGBA pixels/);
  });

  test('the rule step and the mountain screenshot hover the centre of the top voxel\'s cell of sample 205 (40 % of the line, SP3c spec §6, §9)', () => {
    expect(RULE_SAMPLE).toBe(Math.round(0.4 * 512));
    // The slice image drawn 1:1 at (100, 400), then stretched to 1024 × 768.
    expect(sliceCellPoint({ x: 100, y: 400, width: 512, height: 384 }, RULE_SAMPLE, 0)).toEqual([305.5, 400.5]);
    expect(sliceCellPoint({ x: 100, y: 400, width: 512, height: 384 }, 0, 383)).toEqual([100.5, 783.5]);
    expect(sliceCellPoint({ x: 0, y: 0, width: 1024, height: 768 }, 511, 319 - 120)).toEqual([1023, 399]);
    for (const [i, row] of [[-1, 0], [512, 0], [0, -1], [0, 384], [0.5, 0], [0, Number.NaN]] as const) {
      expect(() => sliceCellPoint({ x: 0, y: 0, width: 512, height: 384 }, i, row)).toThrow(RangeError);
    }
  });

  test('the cut line\'s text reads back as its segment', () => {
    for (const seg of [{ ax: -1664, az: 8, bx: -640, bz: 8 }, { ax: 5122, az: 3074, bx: 6658, bz: 3074 }, { ax: -2030, az: 7, bx: 1950, bz: -1990 }]) {
      expect(parseSegment(segmentText(seg))).toEqual(seg);
    }
    expect(parseSegment('')).toBeNull();
    expect(parseSegment('A (1, 2) → B (3, 4)')).toBeNull();
  });

  test('the mountain line (SP3b spec §7 uiSmoke) is the review mountain\'s line, drawn at 2 blocks/px from the view centre', () => {
    const m = REVIEW_SITES.find((s) => s.name === 'mountain')!;
    if (m.kind !== 'vertical') throw new Error('the mountain site is a vertical slice');
    const { view, a, b } = MOUNTAIN_LINE;
    expect(a).toEqual([16 * m.cx0, m.z]);
    expect(b).toEqual([16 * (m.cx0 + m.w), m.z]);
    expect(view).toEqual({ x: (a[0] + b[0]) / 2, z: m.z, bpp: 2, layer: 'relief' });
    // ± 256 CSS px from the canvas centre: inside the map canvas of the 1400 px wide page.
    expect((b[0] - a[0]) / view.bpp).toBe(512);
  });

  test('the mountain slice\'s summary needs a ground top above y 200 and no water, not only the format (SP3b spec §7, §11)', () => {
    // The recorded runs: "ground top y 140 to 257 · no water" and "ground top y 136 to 267 · no water".
    expect(mountainSummaryOk('ground top y 140 to 257 · no water')).toBe(true);
    expect(mountainSummaryOk('ground top y 136 to 267 · no water')).toBe(true);
    expect(mountainSummaryOk('ground top y -3 to 201 · no water')).toBe(true);
    // Well-formed, but flat (the highest top at or below 200) or wet.
    expect(mountainSummaryOk('ground top y 62 to 200 · no water')).toBe(false);
    expect(mountainSummaryOk('ground top y 62 to 90 · no water')).toBe(false);
    expect(mountainSummaryOk('ground top y 140 to 257 · water on 3.1 % of the line, up to 4 deep')).toBe(false);
    expect(mountainSummaryOk('no ground · no water')).toBe(false);
    expect(mountainSummaryOk('')).toBe(false);
    // A real summary of a flat, partly wet slice fails although its format passes.
    const blocks = new Uint16Array(SLICE_SAMPLES);
    const fluid = new Uint8Array(SLICE_SAMPLES);
    for (let i = 0; i < 512; i++) {
      for (let y = -64; y <= 70; y++) {
        blocks[sliceIndex(i, y)] = y === -64 ? BEDROCK : y <= (i < 100 ? 40 : 70) ? STONE : AIR;
        if (i < 100 && y > 40 && y <= 63) fluid[sliceIndex(i, y)] = WATER_SOURCE;
      }
    }
    const flat = sliceSummary({ blocks, fluid });
    expect(voxelSummaryOk(flat)).toBe(true);
    expect(mountainSummaryOk(flat), flat).toBe(false);
  });

  test('the steps run in SMOKE_STEPS order: the Density steps after rule, then preset profiles (SP3e) before console (SP3d spec §6, SP3e spec §8)', () => {
    expect(SMOKE_STEPS).toEqual([
      'selftest', 'load', 'number', 'knot', 'slider', 'box', 'profile', 'presets', 'undo/redo', 'reload', 'cut line', 'voxels', 'tabs', 'rule',
      'density tab', 'density node', 'density mute', 'density json', 'density narrow', 'density horizontal', 'density drag', 'density times',
      'preset profiles', 'console',
    ]);
    expect(SMOKE_STEPS.indexOf('density tab')).toBe(SMOKE_STEPS.indexOf('rule') + 1);
    expect(SMOKE_STEPS.indexOf('preset profiles')).toBe(SMOKE_STEPS.indexOf('console') - 1);
    expect(SMOKE_STEPS.indexOf('console')).toBe(SMOKE_STEPS.length - 1);
    // Its own id: `presets` is the preset-file step.
    expect(stepId('preset profiles: each draft preset opened by URL')).toBe('preset profiles');
    expect(stepId('presets: export, apply {} in the patch box, import the exported file')).toBe('presets');
    expect(stepId('density node: the islands const root.b.x edited from -1e6 to -10')).toBe('density node');
    expect(stepId('undo/redo: Ctrl+Z through the 6 steps')).toBe('undo/redo');
    expect(() => stepId('no step name here')).toThrow(/step title/);
    expect(() => stepId('density: an unknown step')).toThrow(/not a smoke step/);
  });

  test('the Density drag ends at biome-size position 7, after a hold at 6', () => {
    expect(SIZE_7).toBe(BIOME_SIZE_SCALE[6]);
  });
});

/** A vertical slice on the mountain line at n, with `values` in sample order, as the page shows it. */
function mountainShown(values: Float64Array<ArrayBuffer>, n: number): SliceShown {
  const line: Segment = { ax: MOUNTAIN_LINE.a[0], az: MOUNTAIN_LINE.a[1], bx: MOUNTAIN_LINE.b[0], bz: MOUNTAIN_LINE.b[1] };
  const g = sliceGeometryOf({ plane: 'vertical', field: 'density', y: 63, extent: 2048, cx: 0, cz: 0 }, line, n);
  if (!g.ok) throw new Error(g.problem);
  return { sessionEpoch: 1, key: 'k', geometry: g.geometry, result: { field: 'density', values, fluid: null, n } };
}

/** Slice-like values: air (negative) above a surface, solid (positive) below, one value per sample. */
function airAndGround(n: number, seed: number): Float64Array<ArrayBuffer> {
  const v = new Float64Array(n * n);
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < n; k++) v[c * n + k] = (k - n / 2 - ((c * seed) % 7)) * 2.37 + ((c * 31 + k * seed) % 11) / 10;
  }
  return v;
}

describe('UI smoke test: the Density tab steps\' pure parts (SP3d spec §6)', () => {
  test('the slice status is fresh at n exactly when it reads "n²" with nothing in flight, as sliceStatusText writes it', () => {
    const shown = mountainShown(airAndGround(128, 3), 128);
    const draft = mountainShown(airAndGround(32, 3), 32);
    const text = (s: SliceShown | null, key: string | null, pending: { sessionEpoch: number; key: string; n: number } | null, epoch: number) =>
      sliceStatusText({ shown: s, key, pending }, epoch);
    expect(freshSlice(text(shown, 'k', null, 1), 128)).toBe(true);
    expect(freshSlice(text(draft, 'k', null, 1), 32)).toBe(true);
    expect(freshSlice(text(draft, 'k', { sessionEpoch: 1, key: 'k', n: 128 }, 1), 128)).toBe(false);
    expect(freshSlice(text(draft, 'k', { sessionEpoch: 1, key: 'k', n: 128 }, 1), 32)).toBe(false);
    expect(freshSlice(text(shown, 'k', null, 2), 128)).toBe(false);
    expect(freshSlice(text(shown, 'other', null, 1), 128)).toBe(false);
    expect(freshSlice(text(null, 'k', { sessionEpoch: 1, key: 'k', n: 32 }, 1), 128)).toBe(false);
  });

  test('the histogram text reads back as the statistics it prints, constant fields included', () => {
    for (const values of [airAndGround(128, 3), airAndGround(32, 5), Float64Array.from([1e-7, 2.5, -1e9, 0.1234567, 7e12, -3])]) {
      const st = sliceStats(values)!;
      const got = parseSliceStats(histogramLabels(st).join('\n'));
      expect(got).toEqual({
        p1: Number(formatSliceValue(st.p1)), p50: Number(formatSliceValue(st.p50)), p99: Number(formatSliceValue(st.p99)),
        constant: null, below0: Number((100 * st.below0).toFixed(1)),
      });
    }
    expect(parseSliceStats(histogramLabels(sliceStats(new Float64Array(16).fill(-1e6))).join('\n'))).toEqual({ p1: -1e6, p50: -1e6, p99: -1e6, constant: -1e6, below0: null });
    expect(parseSliceStats(histogramLabels(sliceStats(Float64Array.from([Number.NaN, 1, Infinity]))).join('\n'))?.constant).toBe(1);
    expect(parseSliceStats('no finite value')).toBeNull();
    expect(parseSliceStats('')).toBeNull();
  });

  test('the islands const at -10 floors the air at -10 and keeps every sign: p1 is -10 and the share below 0 is unchanged', () => {
    const before = airAndGround(128, 3);
    const after = before.map((v) => Math.max(v, -10));
    const b = parseSliceStats(histogramLabels(sliceStats(before)).join('\n'))!;
    const a = parseSliceStats(histogramLabels(sliceStats(after)).join('\n'))!;
    expect(islandsFloorOk(b, a, -10)).toBe(true);
    expect(islandsFloorOk(b, b, -10)).toBe(false);
    // A floor that changed the solidity (here 1: every air value becomes solid) fails.
    const solid = parseSliceStats(histogramLabels(sliceStats(before.map((v) => Math.max(v, 1)))).join('\n'))!;
    expect(islandsFloorOk(b, solid, 1)).toBe(false);
  });

  test('the slice hover readout and the form\'s "value at the hover" line name the same voxel and value (probe == slice)', () => {
    const shown = mountainShown(airAndGround(128, 3), 128);
    for (const [px, py] of [[0, 0], [51, 40], [127, 127], [64, 100]] as const) {
      const h = sliceHoverText(shown, px, py);
      const r = parseSliceReadout(h.text);
      expect(r).not.toBeNull();
      expect([r!.x, r!.y, r!.z]).toEqual([h.voxel.x, h.voxel.y, h.voxel.z]);
      expect(r!.field).toBe('density');
      const line = `value at the hover: ${hoverLineText(h.voxel, r!.value, '')!}`;
      expect(hoverAgrees(h.text, line)).toBe(true);
      expect(hoverAgrees(h.text, `value at the hover: ${hoverLineText({ ...h.voxel, y: h.voxel.y + 1 }, r!.value, '')!}`)).toBe(false);
      expect(hoverAgrees(h.text, `value at the hover: ${hoverLineText(h.voxel, `${r!.value}1`, '')!}`)).toBe(false);
    }
    expect(parseSliceReadout('(1, 2, 3) · density NaN')).toEqual({ x: 1, y: 2, z: 3, field: 'density', value: 'NaN' });
    expect(parseSliceReadout('(1, 2, 3) · node −∞')?.value).toBe('−∞');
    expect(parseSliceReadout('hover the slice')).toBeNull();
    expect(hoverAgrees('(1, 2, 3) · density 4', 'value at the hover: …')).toBe(false);
  });

  test('the broken JSON replaces the islands tap\'s child op: the editor reports root.b.x UNKNOWN_OP (expr.ts reports it at the node)', () => {
    const r = applyPatch(SCHEMA, resolveProfile('default'), {});
    if (!r.ok) throw new Error('bad params');
    // The default tree, and the tree the smoke has at that step: islands -10, terrain muted to 0.
    const stepTree = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { a: { a: Record<string, unknown> }; b: { x: { v: number } } } };
    stepTree.root.b.x.v = -10;
    stepTree.root.a.a['mute'] = 0;
    for (const tree of [DEFAULT_DENSITY_TREE, stepTree]) {
      const text = printTree(tree, 'density').text;
      const broken = brokenIslandsJson(text);
      expect(broken).not.toBe(text);
      const parsed = parseTree(broken, 'density');
      if (!parsed.ok) throw new Error(parsed.error.message);
      const checked = checkLeafCandidate(r.value, 'density.defs', parsed.value);
      expect(checked.issues.map((i) => [i.path, i.code])).toEqual([['root.b.x', 'UNKNOWN_OP']]);
      expect(issueLineOk(issueText(checked.issues[0]!, 'density.defs'), 'root.b.x', 'UNKNOWN_OP')).toBe(true);
    }
    expect(() => brokenIslandsJson('{"root": {"op": "y"}, "defs": {}}')).toThrow(/islands/);
    expect(issueLineOk('root.b.x: UNKNOWN_OPX — unknown op "bogus"', 'root.b.x', 'UNKNOWN_OP')).toBe(false);
    expect(issueLineOk('root.b.x.v: UNKNOWN_OP — unknown op "bogus"', 'root.b.x', 'UNKNOWN_OP')).toBe(false);
  });

  test('a horizontal map click: the centre is the clicked block, clamped for the extent, and the axis labels name its square', () => {
    const view = { x: -1152, z: 8, bpp: 2, layer: 'relief' } as const;
    const box = { x: 0, y: 70, width: 1031, height: 527 };
    for (const [dx, dy] of [[150, 80], [0, 0], [-201.5, 33.25]] as const) {
      const sx = box.x + box.width / 2 + dx;
      const sy = box.y + box.height / 2 + dy;
      const [wx, wz] = screenToWorld(view, box.width, box.height, sx - box.x, sy - box.y);
      expect(clickCentre(view, box, sx, sy, 2048)).toEqual(clampCentre(wx, wz, 2048));
    }
    expect(clickCentre({ ...view, x: 524000 }, box, box.width, box.height / 2, 8192)[0]).toBe(524288 - 4096);
    for (const [cx, cz, e] of [[-852, 168, 2048], [-1152, 8, 8192], [0, 0, 256]] as const) {
      const st = { plane: 'horizontal', field: 'density', y: 63, extent: e, cx, cz } as const;
      expect(squareLabels(cx, cz, e)).toEqual(sliceAxisLabels(st, null));
    }
  });

  test('the square\'s centre cross is counted in the map canvas by its colour, the map view\'s', () => {
    expect(readFileSync(new URL('../../src/ui/map/mapView.ts', import.meta.url), 'utf8')).toContain(`ctx2d.strokeStyle = '#${SQUARE_RGB.map((c) => c.toString(16).padStart(2, '0')).join('')}';`);
    const w = 40;
    const rgba = new Uint8ClampedArray(w * w * 4).fill(30);
    const paint = (x: number, y: number, c: readonly number[]) => { rgba.set([c[0]!, c[1]!, c[2]!, 255], 4 * (y * w + x)); };
    expect(crossPixels(rgba, w, 20, 20)).toBe(0);
    for (let d = -5; d <= 5; d++) { paint(20 + d, 20, SQUARE_RGB); paint(20, 20 + d, SQUARE_RGB); }
    expect(crossPixels(rgba, w, 20, 20)).toBe(21);
    expect(crossPixels(rgba, w, 30, 30)).toBe(0);
    // Antialiased pixels within 24 of the colour per channel count; the cut line's white does not.
    paint(19, 19, [140, 200, 225]);
    paint(21, 21, [255, 255, 255]);
    expect(crossPixels(rgba, w, 20, 20)).toBe(22);
    // The window is clipped at the canvas edges.
    expect(crossPixels(rgba, w, 0, 0)).toBe(0);
  });

  test('the stacked layout\'s screenshot: the viewport that makes the Density tab 800 px wide', () => {
    expect(densityLayout(800)).toBe('stack');
    expect(densityLayout(1400)).toBe('grid');
    expect(viewportForDrawer({ viewport: 1400, drawer: 1400 }, 800)).toBe(800);
    expect(viewportForDrawer({ viewport: 1400, drawer: 1384 }, 800)).toBe(816);
    expect(() => viewportForDrawer({ viewport: 1400, drawer: 0 }, 800)).toThrow(RangeError);
  });

  test('times are reported as their median and every run', () => {
    expect(timesText([300.4, 100.2, 200.7])).toBe('p50 201 ms (100, 201, 300)');
    expect(timesText([5])).toBe('p50 5 ms (5)');
    expect(timesText([4, 1, 3, 2])).toBe('p50 2 ms (1, 2, 3, 4)');
    expect(() => timesText([])).toThrow(RangeError);
  });
});

/** A slice with `fill(i, y)` → [state, water] per sample i and y (air and no fluid where it returns null). */
function slice(fill: (i: number, y: number) => readonly [number, boolean] | null): { blocks: Uint16Array<ArrayBuffer>; fluid: Uint8Array<ArrayBuffer> } {
  const blocks = new Uint16Array(SLICE_SAMPLES);
  const fluid = new Uint8Array(SLICE_SAMPLES);
  for (let i = 0; i < 512; i++) {
    for (let y = -64; y <= 319; y++) {
      const v = fill(i, y);
      if (v === null) continue;
      blocks[sliceIndex(i, y)] = v[0];
      if (v[1]) fluid[sliceIndex(i, y)] = WATER_SOURCE;
    }
  }
  return { blocks, fluid };
}

/** Ground (stone, bedrock at −64) up to `ground`, water above it to 63 when `ground` < 63, and an island run [lo, hi] (grass-topped). */
const islandColumn = (ground: number, island: readonly [number, number] | null) => (_i: number, y: number): readonly [number, boolean] | null => {
  if (y === -64) return [BEDROCK, false];
  if (y <= ground) return [STONE, false];
  if (island !== null && y >= island[0] && y <= island[1]) return [y === island[1] ? GRASS_BLOCK : STONE, false];
  if (y <= 63) return [AIR, true];
  return null;
};

describe('UI smoke test: the preset profiles step and the preset shots (SP3e spec §8)', () => {
  test('the presets are the three drafts in PROFILE_IDS order, and the select lists the five ready profiles', () => {
    expect(SMOKE_PRESETS).toEqual(WINDOW_PRESETS);
    expect(SMOKE_PRESETS).toEqual(DRAFT_PRESETS);
    expect(READY_PROFILES).toEqual(profileOptions());
  });

  test('each line is 1,024 blocks along x centred on the golden window\'s centre, drawn at 2 blocks/px; the review slice is its middle half', () => {
    for (const preset of SMOKE_PRESETS) {
      const w = sp3eWindow(preset);
      expect(presetCentre(preset)).toEqual([w.centreX, w.centreZ]);
      const { view, a, b } = presetLine(preset);
      expect(view).toEqual({ x: w.centreX, z: w.centreZ, bpp: 2, layer: 'relief' });
      expect(a).toEqual([w.centreX - 512, w.centreZ]);
      expect(b).toEqual([w.centreX + 512, w.centreZ]);
      // ± 256 CSS px from the canvas centre, as the mountain line.
      expect((b[0] - a[0]) / view.bpp).toBe(512);
      const site = siteLine(presetReviewSite(preset, { x: w.centreX, z: w.centreZ }));
      expect(site).toEqual({ z: w.centreZ, x0: a[0] + 256, n: 512 });
    }
    expect(presetLine('amplified').a).toEqual([-1152, 0]);
    expect(() => presetCentre('default' as SmokePreset)).toThrow(RangeError);
    expect(() => presetCentre('toString' as SmokePreset)).toThrow(RangeError);
  });

  test('a preset page opens by URL: mapHash({...START, profile, view}) is the page\'s encoding, and the page accepts the ready profile', () => {
    expect(START).toEqual(DEFAULT_MAP_STATE);
    for (const preset of SMOKE_PRESETS) {
      const [x, z] = presetCentre(preset);
      for (const view of [presetLine(preset).view, { x, z, bpp: PRESET_MAP.bpp, layer: 'biome' }, { x, z, bpp: PRESET_MAP.bpp, layer: 'islandMask' }]) {
        const s = presetState(preset, view);
        expect(s).toEqual({ ...START, profile: preset, view });
        expect(mapHash(s)).toBe(encodeMapState(s as MapState));
        expect(decodeMapState(mapHash(s))).toEqual({ state: s, error: null });
      }
    }
    // An unready profile is refused by the page (it would open the default instead).
    expect(decodeMapState(mapHash(presetState('cave_heavy', START.view))).error).toMatch(/not available yet/);
  });

  test('the maps cover 4096 × 4096 blocks at 16 blocks/px; the five preset shots in the order they are taken', () => {
    expect(PRESET_MAP.px * PRESET_MAP.bpp).toBe(4096);
    expect(PRESET_SHOTS).toEqual([
      'preset-archipelago.png', 'preset-amplified.png', 'preset-floating_islands.png', 'preset-archipelago-map.png', 'preset-floating_islands-islandMask.png',
    ]);
    expect(PRESET_SHOTS.slice(0, 3)).toEqual(SMOKE_PRESETS.map((p) => `preset-${p}.png`));
  });

  test('the five preset shots are committed in assets/sp3e: the Voxels pages at 1400 × 900, the maps as 256 × 256 clips', () => {
    for (const name of PRESET_SHOTS) {
      const png = readFileSync(new URL(`../../docs/superpowers/specs/assets/sp3e/${name}`, import.meta.url));
      expect(png.subarray(1, 4).toString('latin1'), name).toBe('PNG');
      const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
      expect(size, name).toEqual(name.endsWith('-map.png') || name.endsWith('-islandMask.png') ? [PRESET_MAP.px, PRESET_MAP.px] : [VIEWPORT.width, VIEWPORT.height]);
    }
  });

  test('the Voxels summary: amplified needs a ground top ≥ 250, floating_islands ≥ 193, archipelago water on the line', () => {
    expect(PRESET_TOP_MIN).toEqual({ amplified: 250, floating_islands: 193 });
    const summary = (ground: number, island: readonly [number, number] | null) => sliceSummary(slice(islandColumn(ground, island)));
    expect(summaryTopMax(summary(250, null))).toBe(250);
    expect(summaryTopMax(summary(40, [200, 230]))).toBe(230);
    expect(summaryTopMax('no ground · no water')).toBeNull();
    expect(summaryTopMax('ground top y 1 to 2')).toBeNull();
    expect(presetSummaryOk('amplified', summary(250, null))).toBe(true);
    expect(presetSummaryOk('amplified', summary(249, null))).toBe(false);
    expect(presetSummaryOk('floating_islands', summary(40, [181, 193]))).toBe(true);
    expect(presetSummaryOk('floating_islands', summary(40, [181, 192]))).toBe(false);
    expect(presetSummaryOk('floating_islands', summary(192, null))).toBe(false);
    expect(presetSummaryOk('archipelago', summary(40, null))).toBe(true);
    expect(presetSummaryOk('archipelago', summary(70, null))).toBe(false);
    // Summaries recorded in the before/after sets (Checkpoint M, Task 19).
    expect(presetSummaryOk('amplified', 'ground top y 104 to 308 · no water')).toBe(true);
    expect(presetSummaryOk('floating_islands', 'ground top y 23 to 251 · water on 97.5 % of the line, up to 40 deep')).toBe(true);
    expect(presetSummaryOk('archipelago', 'ground top y 20 to 86 · water on 44.5 % of the line, up to 43 deep')).toBe(true);
    for (const p of SMOKE_PRESETS) expect(presetSummaryOk(p, '')).toBe(false);
  });

  test('a slice image\'s column i is what getImageData(i, 0, 1, 384) reads', () => {
    const rgba = sliceRgba(slice((i, y) => (y <= (i % 50) ? [STONE, false] : null)));
    for (const i of [0, 7, 255, 511]) {
      const col = sliceColumn(rgba, i);
      expect(col).toHaveLength(4 * 384);
      expect(groundTopRow(col)).toBe(319 - (i % 50));
      expect(col.slice(4 * 383, 4 * 384)).toEqual(Array.from(rgba.slice(4 * (383 * 512 + i), 4 * (383 * 512 + i) + 4)));
    }
    expect(() => sliceColumn(rgba, 512)).toThrow(RangeError);
    expect(() => sliceColumn(new Uint8ClampedArray(16), 0)).toThrow(/512 × 384/);
  });

  test('water pixels are the water colour darkened with depth; no block, the sky nor the sea line is water', () => {
    expect(WATER_RGB).toEqual(VOXEL_COLORS.water);
    for (let depth = 0; depth <= 80; depth++) {
      const [r, g, b] = voxelRgb(AIR, WATER_SOURCE, depth);
      expect(waterPixel(r, g, b), `depth ${depth}`).toBe(true);
    }
    for (const k of voxelLegend()) expect(waterPixel(...k.rgb), k.label).toBe(false);
    expect(waterPixel(...VOXEL_COLORS.seaLevel)).toBe(false);
  });

  test('islandOverGround finds an island run (bottom ≥ 181) with air and water under it down to the ground, and the ground\'s top row', () => {
    expect(ISLAND_MIN_BOTTOM_Y).toBe(ISLAND_RUN_MIN_BOTTOM);
    const col = (ground: number, island: readonly [number, number] | null) => sliceColumn(sliceRgba(slice(islandColumn(ground, island))), 3);
    expect(islandOverGround(col(40, [200, 230]))).toEqual({ islandTop: 230, islandBottom: 200, groundRow: 319 - 40 });
    // Over land: only air under the island.
    expect(islandOverGround(col(90, [181, 181]))).toEqual({ islandTop: 181, islandBottom: 181, groundRow: 319 - 90 });
    // A run whose bottom is 180 is ground (a peak or an overhang lip), not an island.
    expect(islandOverGround(col(40, [180, 230]))).toBeNull();
    expect(islandOverGround(col(40, null))).toBeNull();
    expect(islandOverGround(col(150, null))).toBeNull();
    // An island over nothing, and an all-air column.
    expect(islandOverGround(sliceColumn(sliceRgba(slice((_i, y) => (y >= 200 && y <= 230 ? [STONE, false] : null))), 0))).toBeNull();
    expect(islandOverGround(sliceColumn(sliceRgba(slice(() => null)), 0))).toBeNull();
    expect(() => islandOverGround(new Uint8ClampedArray(16))).toThrow(/384 RGBA pixels/);
  });

  test('the biome layer\'s colours and families are the registry\'s; map pixels count as ocean, land or other (river, blends, overlays)', () => {
    expect(BIOME_RGB).toEqual(SURFACE_BIOMES.map((_, id) => [biomeFamily(id), biomeColor(id)]));
    const px = (c: number) => [c >> 16, (c >> 8) & 255, c & 255, 255];
    const color = (n: string) => biomeColor(SURFACE_BIOMES.findIndex((b) => b === n));
    const ocean = color('deep_ocean');
    const plains = color('plains');
    // Within 6 per channel of a colour counts (a smoothed tile edge); half-way between two colours does not.
    const near = [(ocean >> 16) + 5, ((ocean >> 8) & 255) - 4, (ocean & 255) + 6, 255];
    const mid = [16, 8, 0].map((s) => Math.round(((ocean >> s) & 255) / 2 + ((plains >> s) & 255) / 2));
    const rgba = [...px(ocean), ...px(color('warm_ocean')), ...near, ...px(plains), ...px(color('beach')), ...px(color('river')), ...mid, 255, ...px(0xff3b30)];
    expect(biomePixels(rgba)).toEqual({ ocean: 3, land: 2, other: 3 });
    expect(oceanAndLandOk({ ocean: 1, land: 1, other: 98 })).toBe(true);
    expect(oceanAndLandOk({ ocean: 1, land: 0, other: 99 })).toBe(false);
    expect(oceanAndLandOk({ ocean: 0, land: 50, other: 50 })).toBe(false);
    expect(oceanAndLandOk({ ocean: 0, land: 0, other: 0 })).toBe(false);
    // 1 % of 256²: 656 px of ocean among land passes, 655 does not.
    expect(oceanAndLandOk({ ocean: 656, land: 65536 - 656, other: 0 })).toBe(true);
    expect(oceanAndLandOk({ ocean: 655, land: 65536 - 655, other: 0 })).toBe(false);
  });

  test('distinct colours count those covering at least minPixels pixels (a stray overlay pixel does not make a second colour)', () => {
    const img = (counts: ReadonlyArray<readonly [number, number]>) => counts.flatMap(([c, n]) => Array.from({ length: n }, () => [c >> 16, (c >> 8) & 255, c & 255, 255]).flat());
    expect(distinctColours(img([[0x101010, 400]]))).toBe(1);
    expect(distinctColours(img([[0x101010, 400], [0xff3b30, 15]]))).toBe(1);
    expect(distinctColours(img([[0x101010, 400], [0xff3b30, 16]]))).toBe(2);
    expect(distinctColours(img([[0x101010, 4], [0x202020, 4], [0x303030, 4]]), 4)).toBe(3);
    expect(distinctColours([])).toBe(0);
  });
});

describe('UI smoke test: arguments', () => {
  test('arguments: build, the OS temp directory and no screenshots by default', () => {
    expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
    expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
    expect(() => parseArgs(['--shots'])).toThrow(/--shots needs a value/);
    expect(() => parseArgs(['--what'])).toThrow(/unknown argument --what/);
  });
});

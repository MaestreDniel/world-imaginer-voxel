import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { allGoldenKeys } from '../../src/metrics/sp2aGoldens';
import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
import { DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
import { presetText } from '../../src/ui/presets/presetFile';
import { segmentText } from '../../src/ui/crossSection/model';
import { RULE_WAITING, ruleSuffix, sliceRgba, sliceSummary, VOXEL_COLORS, voxelLegend, voxelReadout } from '../../src/ui/crossSection/voxels';
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
import { REVIEW_SITES } from '../harness/reviewSlices';
import {
  brokenIslandsJson, canonicalJson, clickCentre, crossPixels, freshSlice, goldenCount, groundTopRow, hoverAgrees, ignoredLog, islandsFloorOk, issueLineOk, mapHash,
  MOUNTAIN_LINE, mountainSummaryOk, parseArgs, parseSegment, parseSliceReadout, parseSliceStats, presetProblems, readMapHash, RULE_SAMPLE, sameJson,
  selftestAllMatch, SIZE_7, SIZE_8, SKY_RGB, sliceCellPoint, SMOKE_STEPS, SQUARE_RGB, squareLabels, stepId, timesText, VIEWPORT, viewportForDrawer,
  voxelLegendLabels, voxelReadoutOk, voxelRuleId, voxelSummaryOk, type MapUrlState,
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

  test('the steps run in SMOKE_STEPS order: the Density steps after rule and before console (SP3d spec §6)', () => {
    expect(SMOKE_STEPS).toEqual([
      'selftest', 'load', 'number', 'knot', 'slider', 'box', 'profile', 'presets', 'undo/redo', 'reload', 'cut line', 'voxels', 'tabs', 'rule',
      'density tab', 'density node', 'density mute', 'density json', 'density narrow', 'density horizontal', 'density drag', 'density times',
      'console',
    ]);
    expect(SMOKE_STEPS.indexOf('density tab')).toBe(SMOKE_STEPS.indexOf('rule') + 1);
    expect(SMOKE_STEPS.indexOf('console')).toBe(SMOKE_STEPS.length - 1);
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

describe('UI smoke test: arguments', () => {
  test('arguments: build, the OS temp directory and no screenshots by default', () => {
    expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
    expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
    expect(() => parseArgs(['--shots'])).toThrow(/--shots needs a value/);
    expect(() => parseArgs(['--what'])).toThrow(/unknown argument --what/);
  });
});

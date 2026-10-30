import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  RULE_SAMPLE, sameJson, selftestAllMatch, KV_CONTRACT_CASES, KV_SELFTEST_DONE, kvSelftestPassed, SIZE_7, SIZE_8, SKY_RGB, sliceCellPoint, sliceColumn, SMOKE_PRESETS, SMOKE_STEPS, SQUARE_RGB, squareLabels, START, stepId,
  summaryTopMax, timesText, VIEWPORT, viewportForDrawer, voxelLegendLabels, voxelReadoutOk, voxelRuleId, voxelSummaryOk, WATER_RGB, waterPixel, type MapUrlState,
  type SmokePreset, pixelDiffShare, SWIFTSHADER_ARGS, START_SEED_7_HASH, PARITY_VIEW, PARITY_WATER_VIEW, PARITY_VIEWS, WORLD_RD, worldMeshQuery, PARITY_TOL, PARITY_MAX_SHARE, leaveGuardLog,
  expectedRenderer, HUD_POLL_MS, hudMoved, hudOnce, parseHud, STREAM_HOLD_MS, STREAM_MIN_MOVE, STREAM_RD, STREAM_RD_MS, STREAM_REVEAL_MS, STREAM_RUNS, streamQuery,
  type HudRead,
  LANDING_ABOVE as SMOKE_LANDING_ABOVE, LANDING_MAX_Y as SMOKE_LANDING_MAX_Y, listenerDiff, listenerKey, listenersLeakFree, OVERLAY_APPLY_MS, OVERLAY_NARROW_WIDTH,
  OVERLAY_REVEAL_MS, OVERLAY_RUNS, OVERLAY_SHOTS, OVERLAY_TILES_MS, OVERLAY_VIEWPORT, overlayQuery, parseHudStale, hudStaleRowOk, previewMs, smokeLandingY, SETTINGS_KEY as SMOKE_SETTINGS_KEY,
  storedMapMode, TELEPORT_EAST_PX, teleportTarget, WORLD_MAP_BPP as SMOKE_WORLD_MAP_BPP,
  acrossFace, BUILD_QUERY, JUMP_MIN_RISE, PALETTE_SWATCHES, parseHudEdits, SMOKE_FACE, SMOKE_STATE, SMOKE_WATER_SOURCE, TORCH_MIN_LIGHT, WALK_GROUND_MS,
  WALK_HOLD_MS, WALK_MIN_MOVE, WALK_PATH_BLOCKS, WALK_QUERY, walkCorridor, walkSnapOk,
} from '../tools/uiSmoke';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';
import { EMIT, REGISTRY } from '../../src/world/blocks/index';
import { PLACEABLE } from '../../src/world/blocks/tags';
import { paletteGroups } from '../../src/ui/palette';
import { LANDING_ABOVE, LANDING_MAX_Y, landingY } from '../../src/ui/world/teleport';
import { WORLD_MAP_BPP } from '../../src/ui/world/mapOverlay';
import { SETTINGS_KEY, SETTINGS_DEFAULTS } from '../../src/ui/settings';
import { previewStatusText } from '../../src/ui/map/toolbar';
import { findSpawn } from '../../src/gen/column/spawn';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { SEA_LEVEL } from '../../src/core/constants';
import { lookVector } from '../../src/player/fly';
import { parseWorldQuery } from '../../src/ui/world/query';
import { OPENING_T } from '../../src/daynight/dayNight';
import { SPEED_DEFAULT } from '../../src/player/fly';
import { selectSectionRenderer } from '../../src/render/sectionRenderer';
import { mountWorldHud, type HudData } from '../../src/ui/hud';
import { installDom } from './fixtures/domShim';
import { ctxFor } from '../harness/gen';
import { KV_CONTRACT } from '../../src/persist/kvContract';

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

  test('the `selftest` step waits for `#selftest-kv` and expects `IndexedDB contract: n/n passed` with n = `KV_CONTRACT.length` (SP5b spec §6.4)', () => {
    expect(KV_CONTRACT_CASES).toBe(KV_CONTRACT.length);
    expect(KV_CONTRACT_CASES).toBe(8);
    expect(kvSelftestPassed('IndexedDB contract: 8/8 passed', 8)).toBe(true);
    expect(kvSelftestPassed('IndexedDB contract: 7/8 passed', 8)).toBe(false);
    expect(kvSelftestPassed('IndexedDB contract: 7/7 passed', 8)).toBe(false);
    expect(kvSelftestPassed('IndexedDB contract: running…', 8)).toBe(false);
    expect(kvSelftestPassed('IndexedDB contract: could not run: UnknownError', 8)).toBe(false);
    expect(KV_SELFTEST_DONE).toContain(`document.querySelector('#selftest-kv')`);
    const src = readFileSync(new URL('../tools/uiSmoke.ts', import.meta.url), 'utf8');
    const step = src.slice(src.indexOf("t.step('selftest: ?selftest=1');"), src.indexOf("t.step('load: ?map"));
    const goldens = step.indexOf('selftestAllMatch(summary, goldens)');
    const wait = step.indexOf('await p.until(KV_SELFTEST_DONE, ');
    const check = step.indexOf('t.check(kvSelftestPassed(kv, KV_CONTRACT_CASES), ');
    expect([goldens, wait, check].every((i) => i > -1)).toBe(true);
    expect(goldens).toBeLessThan(wait);
    expect(wait).toBeLessThan(check);
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
    expect(labels).toHaveLength(60);
    expect(labels.slice(0, 4)).toEqual(['air', 'stone', 'bedrock', 'grass_block']);
    // The 58 state keys (SP5a's 33 appended), then the two fluid and sea keys.
    expect(labels.slice(56, 58)).toEqual(['red_wool', 'black_wool']);
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

  test('the steps run in SMOKE_STEPS order: the Density steps after rule, then preset profiles (SP3e), then start, world and world-mesh (SP4a), then SP4b\'s stream, then SP4c\'s overlay and overlay-mesh, then SP5a\'s build and walk before console (SP3d spec §6, SP3e spec §8, SP4a spec §9.6, SP4b spec §8.6, SP4c spec §8.6, SP5a spec §6.4, ruling P52)', () => {
    expect(SMOKE_STEPS).toEqual([
      'selftest', 'load', 'number', 'knot', 'slider', 'box', 'profile', 'presets', 'undo/redo', 'reload', 'cut line', 'voxels', 'tabs', 'rule',
      'density tab', 'density node', 'density mute', 'density json', 'density narrow', 'density horizontal', 'density drag', 'density times',
      'preset profiles', 'start', 'world', 'world-mesh', 'stream', 'overlay', 'overlay-mesh', 'build', 'walk', 'console',
    ]);
    expect(SMOKE_STEPS.indexOf('density tab')).toBe(SMOKE_STEPS.indexOf('rule') + 1);
    expect(SMOKE_STEPS.indexOf('start')).toBe(SMOKE_STEPS.indexOf('preset profiles') + 1);
    expect(SMOKE_STEPS.indexOf('world')).toBe(SMOKE_STEPS.indexOf('start') + 1);
    expect(SMOKE_STEPS.indexOf('stream')).toBe(SMOKE_STEPS.indexOf('world-mesh') + 1);
    expect(SMOKE_STEPS.indexOf('overlay')).toBe(SMOKE_STEPS.indexOf('stream') + 1);
    expect(SMOKE_STEPS.indexOf('build')).toBe(SMOKE_STEPS.indexOf('overlay-mesh') + 1);
    expect(SMOKE_STEPS.indexOf('walk')).toBe(SMOKE_STEPS.indexOf('console') - 1);
    expect(SMOKE_STEPS.indexOf('console')).toBe(SMOKE_STEPS.length - 1);
    expect(stepId('world-mesh: the parity of mesh and batch')).toBe('world-mesh');
    expect(stepId('world: /?rd=4 to the reveal')).toBe('world');
    expect(stepId('stream: /?rd=4 on both renderers, W held for 4 s, then RD 6 live')).toBe('stream');
    expect(stepId('overlay: /?rd=4&renderer=batch&wiTest=1, M, teleport, split, live edits, leak checks')).toBe('overlay');
    expect(stepId('overlay-mesh: /?rd=4&renderer=mesh&wiTest=1, M, teleport, a terrain Apply')).toBe('overlay-mesh');
    expect(stepId('build: /?rd=4&renderer=batch&wiTest=1&pitch=-60, place, break, undo, the palette')).toBe('build');
    expect(stepId('walk: /?rd=4&renderer=batch&wiTest=1&yaw=0, F, W, Space, a walking teleport')).toBe('walk');
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
    // A flat mask layer plus the 32-px spawn marker ring is one colour at the 1 % threshold of the 256² square (656 px), not two.
    expect(distinctColours(img([[0x0d0887, 65536 - 32], [0xff3b30, 32]]), 656)).toBe(1);
    expect(distinctColours(img([[0x0d0887, 65536 - 656], [0xf0f921, 656]]), 656)).toBe(2);
  });
});

describe('UI smoke test: the 3D world steps (SP4a spec §9.6)', () => {
  test('pixelDiffShare: the share of pixels where any channel differs by more than tol', () => {
    const a = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    expect(pixelDiffShare(a, a.slice(), 2)).toBe(0);
    // Half the pixels differ by 3 (one channel each): 0.5 at tol 2; by 2: 0.
    const by = (d: number) => { const b = a.slice(); b[0]! += d; b[4 + 2]! -= d; return b; };
    expect(pixelDiffShare(a, by(3), 2)).toBe(0.5);
    expect(pixelDiffShare(a, by(2), 2)).toBe(0);
    // Every channel counts, alpha included, and a pixel counts once however many channels differ.
    const all = a.slice();
    for (let i = 0; i < 4; i++) all[12 + i]! -= 9;
    all[3] = 200;
    expect(pixelDiffShare(a, all, 2)).toBe(0.5);
    expect(pixelDiffShare(new Uint8Array(0), new Uint8Array(0), 2)).toBe(0);
    expect(() => pixelDiffShare(a, a.subarray(0, 12), 2)).toThrow(RangeError);
    expect(() => pixelDiffShare(a.subarray(0, 6), a.subarray(0, 6), 2)).toThrow(RangeError);
  });

  test('leaving a revealed world page: Chrome\'s blocked-beforeunload notice is ignored for the world pages only', () => {
    const text = "Blocked attempt to show a 'beforeunload' confirmation panel for a frame that never had a user gesture since its load. https://www.chromestatus.com/feature/5082396709879808";
    expect(leaveGuardLog(text, 'http://127.0.0.1:4000/?rd=4')).toBe(true);
    expect(leaveGuardLog(text, `http://127.0.0.1:4000/${worldMeshQuery('mesh')}`)).toBe(true);
    expect(leaveGuardLog(text, 'http://127.0.0.1:4000/')).toBe(false);
    expect(leaveGuardLog(text, 'http://127.0.0.1:4000/?map#abc')).toBe(false);
    expect(leaveGuardLog(text, undefined)).toBe(false);
    expect(leaveGuardLog('Uncaught TypeError: x', 'http://127.0.0.1:4000/?rd=4')).toBe(false);
  });

  test('the smoke Chrome renders through SwiftShader (spec §9.6)', () => {
    expect(SWIFTSHADER_ARGS).toEqual(['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']);
  });

  test('the start step\'s second hash names seed 7 in ?map\'s encoding', () => {
    const d = decodeMapState(START_SEED_7_HASH);
    expect(d.error).toBeNull();
    expect(d.state.seed).toBe('7');
    expect(d.state.profile).toBe('default');
  });

  test('world-mesh loads at seed 42\'s spawn (the literal is findSpawn\'s) with the capture mode, at RD 4, for both renderers', () => {
    const spawn = findSpawn(ctxFor('42'));
    expect([PARITY_VIEW.at.x, PARITY_VIEW.at.z]).toEqual([spawn.x, spawn.z]);
    expect(WORLD_RD).toBe(4);
    for (const renderer of ['mesh', 'batch'] as const) {
      const url = worldMeshQuery(renderer);
      expect(url.startsWith('?rd=4&')).toBe(true);
      const q = parseWorldQuery(new URLSearchParams(url));
      expect(q).toEqual({
        at: PARITY_VIEW.at, y: PARITY_VIEW.y, yaw: PARITY_VIEW.yaw, pitch: PARITY_VIEW.pitch, rd: 4, workers: null, renderer, shot: true, time: null, world: null,
      });
    }
    // The page's own default hour in the capture mode is the opening 08:00 (main.ts: q.time ?? 8).
    expect(PARITY_TOL).toBe(2);
    expect(PARITY_MAX_SHARE).toBe(0.01);
  });
});

describe('UI smoke test: the water parity view (final review B-I1)', () => {
  test('world-mesh also loads the ocean site of review-ocean.png at RD 4, both renderers, saved as world-mesh-water.png', () => {
    expect(PARITY_WATER_VIEW.at).toEqual({ x: -939, z: -782 });
    expect(PARITY_VIEWS.map((v) => [v.name, v.file])).toEqual([['spawn', 'world-mesh.png'], ['water', 'world-mesh-water.png']]);
    expect(PARITY_VIEWS[0]!.view).toBe(PARITY_VIEW);
    expect(PARITY_VIEWS[1]!.view).toBe(PARITY_WATER_VIEW);
    for (const renderer of ['mesh', 'batch'] as const) {
      const q = parseWorldQuery(new URLSearchParams(worldMeshQuery(renderer, PARITY_WATER_VIEW)));
      expect(q).toEqual({
        at: PARITY_WATER_VIEW.at, y: PARITY_WATER_VIEW.y, yaw: PARITY_WATER_VIEW.yaw, pitch: PARITY_WATER_VIEW.pitch, rd: 4, workers: null, renderer, shot: true, time: null, world: null,
      });
    }
    // The default view is still the spawn's.
    expect(worldMeshQuery('mesh')).toBe(worldMeshQuery('mesh', PARITY_VIEW));
  });

  test('the water view looks down at open water within the fog (RD 4: 0-56 blocks), with a shore near the camera', () => {
    const ctx = ctxFor('42');
    const v = PARITY_WATER_VIEW;
    expect(v.y).toBeGreaterThan(SEA_LEVEL);
    expect(v.pitch).toBeLessThan(0);
    // The centre ray meets the sea plane well inside the fog's end, over water (the 2D surface estimate below the sea).
    const [lx, ly, lz] = lookVector(v.yaw, v.pitch);
    const t = (SEA_LEVEL - v.y) / ly;
    const hit = { x: v.at.x + lx * t, z: v.at.z + lz * t, d: t };
    expect(hit.d).toBeLessThan(40);
    expect(columnPoint(ctx, Math.round(hit.x), Math.round(hit.z)).surfaceEst).toBeLessThan(SEA_LEVEL - 4);
    // A shore: land above the sea within 24 blocks of the camera.
    let land = false;
    for (let dz = -24; dz <= 24 && !land; dz += 4) for (let dx = -24; dx <= 24 && !land; dx += 4) land = columnPoint(ctx, v.at.x + dx, v.at.z + dz).surfaceEst >= SEA_LEVEL;
    expect(land).toBe(true);
  });
});

/** The world HUD's data as the page passes it, at a camera position, RD and revealed count. */
function hudData(o: { x: number; y: number; z: number; rd: number; revealed: number; kind: 'batch' | 'mesh'; mode?: HudData['mode'] }): HudData {
  const stage = { done: 69, needed: 69, inFlight: 0, queued: 0 };
  return {
    frame: { fps: 9.5, p50: 104.2, p95: 130.9, count: 40 },
    stages: { T: stage, D: stage, L: stage, MESH: stage },
    stale: 0,
    needed: 69,
    sections: 412,
    revealed: o.revealed,
    genCap: 3,
    dropped: 0,
    failed: 0,
    drawCalls: 33,
    triangles: 190_000,
    position: { x: o.x, y: o.y, z: o.z },
    mode: o.mode ?? 'fly',
    speed: SPEED_DEFAULT,
    time: OPENING_T,
    timeSpeed: 1,
    rdTarget: o.rd,
    rdFog: o.rd - 0.25,
    workers: 4,
    liveWorkers: 4,
    regions: 9,
    gpuMB: 31.4,
    sectionRenderer: o.kind,
    renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
    edit: null,
  };
}

describe('UI smoke test: the stream step and data-renderer (SP4b spec §8.6)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The HUD's rows as the smoke reads them in the page: each row's text, one per line. */
  const hudText = (d: HudData): string => {
    const h = mountWorldHud(dom.body as unknown as HTMLElement, () => d);
    const text = dom.body.querySelectorAll('div').filter((e) => e.className !== 'world-hud').map((e) => e.textContent).join('\n');
    h.dispose();
    return text;
  };

  test('parseHud reads the revealed count, the target RD and the camera position from the real HUD\'s rows', () => {
    expect(parseHud(hudText(hudData({ x: 0.5, y: 112, z: -47.25, rd: 4, revealed: 69, kind: 'batch' })))).toEqual({ revealed: 69, rd: 4, x: 0.5, y: 112, z: -47.3 });
    expect(parseHud(hudText(hudData({ x: -31249.5, y: -12, z: 1024, rd: 6, revealed: 1234, kind: 'mesh' })))).toEqual({ revealed: 1234, rd: 6, x: -31249.5, y: -12, z: 1024 });
  });

  test('parseHud reads the position from a `Fly · x …` and a `Walk · x …` row of `mountWorldHud` (SP5a spec §4.6)', () => {
    const fly = hudText(hudData({ x: 0.5, y: 112, z: -47.25, rd: 4, revealed: 69, kind: 'batch', mode: 'fly' }));
    expect(fly).toMatch(/^Fly · x 0\.5 y 112\.0 z -47\.3 · /m);
    expect(parseHud(fly)).toEqual({ revealed: 69, rd: 4, x: 0.5, y: 112, z: -47.3 });
    const walk = hudText(hudData({ x: -31249.5, y: 65.62, z: 1024, rd: 4, revealed: 69, kind: 'batch', mode: 'walk' }));
    expect(walk).toMatch(/^Walk · x -31249\.5 y 65\.6 z 1024\.0 · /m);
    expect(parseHud(walk)).toEqual({ revealed: 69, rd: 4, x: -31249.5, y: 65.6, z: 1024 });
    // The bare row (SP4b's) still reads; another prefix does not.
    expect(parseHud('revealed 1\nx 1.0 y 2.0 z 3.0 · column 0, 0\nRD 4 (fog 4.0)')).toEqual({ revealed: 1, rd: 4, x: 1, y: 2, z: 3 });
    expect(parseHud('revealed 1\nSwim · x 1.0 y 2.0 z 3.0 · column 0, 0\nRD 4 (fog 4.0)')).toBeNull();
  });

  test('parseHud: the RD is the target\'s (not the fog\'s), and a HUD without its rows reads null', () => {
    const text = hudText(hudData({ x: 1, y: 2, z: 3, rd: 6, revealed: 70, kind: 'batch' }));
    // The fog's 5.8 follows on the same row; the target is 6.
    expect(text).toContain('RD 6 (fog 5.8)');
    expect(parseHud(text)?.rd).toBe(6);
    expect(parseHud('')).toBeNull();
    expect(parseHud('columns T 1/1 · D 1/1 · L 1/1 · meshed 1/1 · revealed 1 · sections 2')).toBeNull();
    expect(parseHud('x 1.0 y 2.0 z 3.0 · column 0, 0\nRD 4 (fog 4.0) · workers 4/4 · batch')).toBeNull();
    // `revealed` alone, not part of another word.
    expect(parseHud('unrevealed 5\nx 1.0 y 2.0 z 3.0 · column 0, 0\nRD 4 (fog 4.0)')).toBeNull();
  });

  test('hudMoved is the horizontal distance: W at 12 blocks/s for 4 s moves about 47 blocks, more than the 40 asserted', () => {
    expect(hudMoved({ x: 0, z: 0 }, { x: 3, z: -4 })).toBe(5);
    expect(hudMoved({ x: 10, z: 10 }, { x: 10, z: 10 })).toBe(0);
    expect(STREAM_HOLD_MS).toBe(4000);
    expect(STREAM_MIN_MOVE).toBe(40);
    expect(SPEED_DEFAULT * (STREAM_HOLD_MS / 1000)).toBeGreaterThan(STREAM_MIN_MOVE);
  });

  test('the stream runs: /?rd=4 forced to batch, then mesh, saved as stream.png and stream-mesh.png; RD 6 within 30 s', () => {
    expect(STREAM_RUNS).toEqual([{ renderer: 'batch', file: 'stream.png' }, { renderer: 'mesh', file: 'stream-mesh.png' }]);
    for (const { renderer } of STREAM_RUNS) {
      expect(streamQuery(renderer)).toBe(`?rd=4&renderer=${renderer}`);
      const q = parseWorldQuery(new URLSearchParams(streamQuery(renderer)));
      expect(q.rd).toBe(4);
      expect(q.renderer).toBe(renderer);
      expect(q.shot).toBe(false);
    }
    expect(STREAM_RD).toBe(6);
    expect(STREAM_RD_MS).toBe(30_000);
  });

  /** A clock whose sleep advances its time, and a HUD whose `revealed` is `at(t)` at time t (null: no HUD rows). */
  const fakeHud = (at: (t: number) => number | null) => {
    let t = 0;
    const reads: number[] = [];
    return {
      reads,
      clock: { now: () => t, sleep: async (ms: number) => { t += ms; } },
      read: async (): Promise<HudRead | null> => {
        reads.push(t);
        const revealed = at(t);
        return revealed === null ? null : { revealed, rd: 4, x: 0, y: 100, z: -48 };
      },
    };
  };

  test('hudOnce: the stream step polls for the reveal W triggered, so a reveal landing after one 600 ms reading still counts (final review GOV-9)', async () => {
    // The reveal lands 1.6 s after W is released (a slow machine): a single reading at 600 ms sees 69, the poll sees 79.
    const h = fakeHud((t) => (t >= 1600 ? 79 : 69));
    const got = await hudOnce(h.read, (r) => r.revealed > 69, STREAM_REVEAL_MS, h.clock);
    expect(got?.revealed).toBe(79);
    expect(h.reads).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750]);
    expect(HUD_POLL_MS).toBe(250);
    expect(STREAM_REVEAL_MS).toBe(5000);
  });

  test('hudOnce: a missing HUD row is read again; null when the predicate never holds within the bound', async () => {
    const missing = fakeHud((t) => (t < 500 ? null : 70));
    expect((await hudOnce(missing.read, (r) => r.revealed > 69, STREAM_REVEAL_MS, missing.clock))?.revealed).toBe(70);
    expect(missing.reads).toEqual([0, 250, 500]);
    const never = fakeHud(() => 69);
    expect(await hudOnce(never.read, (r) => r.revealed > 69, STREAM_REVEAL_MS, never.clock)).toBeNull();
    expect(never.reads.at(-1)).toBe(STREAM_REVEAL_MS);
    expect(never.reads).toHaveLength(STREAM_REVEAL_MS / HUD_POLL_MS + 1);
  });

  test('expectedRenderer is the page\'s choice: the forced renderer, else batch with WEBGL_multi_draw and mesh without', () => {
    for (const forced of [null, 'batch', 'mesh'] as const) {
      for (const multiDraw of [true, false]) expect(expectedRenderer(forced, multiDraw)).toBe(selectSectionRenderer({ multiDraw }, forced));
    }
  });
});

describe('UI smoke test: the overlay steps (SP4c spec §8.6)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('the overlay runs: overlay on batch, overlay-mesh on mesh, at RD 4 with the test hook; 1920 × 1080, narrowed to 1,600 px for the stacked panel', () => {
    expect(OVERLAY_RUNS).toEqual([{ step: 'overlay', renderer: 'batch' }, { step: 'overlay-mesh', renderer: 'mesh' }]);
    for (const { step, renderer } of OVERLAY_RUNS) {
      expect(SMOKE_STEPS).toContain(step);
      expect(overlayQuery(renderer)).toBe(`?rd=4&renderer=${renderer}&wiTest=1`);
      const q = parseWorldQuery(new URLSearchParams(overlayQuery(renderer)));
      expect(q.rd).toBe(WORLD_RD);
    }
    expect(OVERLAY_VIEWPORT).toEqual({ width: 1920, height: 1080 });
    // Each half of the 1,920 px window is 960 px (the panel beside the map); at 1,600 px it is 800, under the
    // container query's 900 (the panel stacks), and B stays available (≥ 1,000 px).
    expect(OVERLAY_VIEWPORT.width / 2).toBeGreaterThanOrEqual(900);
    expect(OVERLAY_NARROW_WIDTH / 2).toBeLessThan(900);
    expect(OVERLAY_NARROW_WIDTH).toBeGreaterThanOrEqual(1000);
    // The smoke's own viewport is unchanged.
    expect(VIEWPORT).toEqual({ width: 1400, height: 900 });
    expect(OVERLAY_SHOTS).toEqual({ full: 'review-overlay-full.png', split: 'review-overlay-split.png' });
    expect([OVERLAY_TILES_MS, OVERLAY_REVEAL_MS, OVERLAY_APPLY_MS]).toEqual([5000, 10_000, 30_000]);
  });

  test('the landing literals are teleport.ts\'s (24 above the surface or the water, at most 400); smokeLandingY is landingY with null water for −∞', () => {
    expect(SMOKE_LANDING_ABOVE).toBe(LANDING_ABOVE);
    expect(SMOKE_LANDING_MAX_Y).toBe(LANDING_MAX_Y);
    expect([SMOKE_LANDING_ABOVE, SMOKE_LANDING_MAX_Y]).toEqual([24, 400]);
    for (const [surface, water] of [[66, null], [40, 63], [70, 63], [300, null], [390, null], [-20, 63]] as const) {
      expect(smokeLandingY({ surface, water })).toBe(landingY(surface, water ?? Number.NEGATIVE_INFINITY));
    }
    expect(smokeLandingY({ surface: 40, water: 63 })).toBe(87);
    expect(smokeLandingY({ surface: 390, water: null })).toBe(400);
  });

  test('the map opens at WORLD_MAP_BPP blocks/px centred on the camera: a click 300 px east of the arrow targets the block screenToWorld gives', () => {
    expect(SMOKE_WORLD_MAP_BPP).toBe(WORLD_MAP_BPP);
    expect(TELEPORT_EAST_PX).toBe(300);
    const canvas = { x: 0, y: 48, width: 1579, height: 700 };
    const camera = { x: 12.3, z: -40.7 };
    const click = { x: Math.round(canvas.x + canvas.width / 2 + TELEPORT_EAST_PX), y: Math.round(canvas.y + canvas.height / 2) };
    const got = teleportTarget(camera, canvas, click, SMOKE_WORLD_MAP_BPP);
    const [x, z] = screenToWorld({ x: camera.x, z: camera.z, bpp: WORLD_MAP_BPP, layer: 'biome' }, canvas.width, canvas.height, click.x - canvas.x, click.y - canvas.y);
    expect(got.x).toBeCloseTo(x, 9);
    expect(got.z).toBeCloseTo(z, 9);
    // About 1,200 blocks east: the old RD 4 disc is left behind.
    expect(got.x - camera.x).toBeGreaterThan(1190);
  });

  test('parseHudStale reads the real HUD\'s "stale n / needed" row; null while the world is not stale', () => {
    const hudText = (stale: number): string => {
      const h = mountWorldHud(dom.body as unknown as HTMLElement, () => ({ ...hudData({ x: 1, y: 90, z: 2, rd: 4, revealed: 81, kind: 'batch' }), stale, needed: 81 }));
      const text = dom.body.querySelectorAll('div').filter((e) => e.className !== 'world-hud').map((e) => e.textContent).join('\n');
      h.dispose();
      return text;
    };
    expect(parseHudStale(hudText(17))).toEqual({ stale: 17, needed: 81 });
    expect(parseHudStale(hudText(0))).toBeNull();
    expect(parseHud(hudText(17))?.revealed).toBe(81);
    expect(parseHudStale('unstale 3 / 4')).toBeNull();
  });

  test('hudStaleRowOk: the row with 0 < stale ≤ needed, or no row when the world already settled before the HUD\'s refresh (final review GOV-5)', () => {
    expect(hudStaleRowOk({ stale: 17, needed: 81 }, false)).toBe(true);
    expect(hudStaleRowOk({ stale: 81, needed: 81 }, false)).toBe(true);
    expect(hudStaleRowOk({ stale: 0, needed: 81 }, false)).toBe(false);
    expect(hudStaleRowOk({ stale: 82, needed: 81 }, false)).toBe(false);
    // No row: a pass only when stale() already read 0 (an undo that settled inside 250 ms), never while still stale.
    expect(hudStaleRowOk(null, true)).toBe(true);
    expect(hudStaleRowOk(null, false)).toBe(false);
  });

  test('liveEdit waits for the Undo/Redo notice (1.5 s) right after the act, before the stale and HUD waits (final review GOV-5)', () => {
    const src = readFileSync(new URL('../tools/uiSmoke.ts', import.meta.url), 'utf8');
    const start = src.indexOf('async function liveEdit(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const act = body.indexOf('await act();');
    const noticeWait = body.indexOf('(${WORLD_NOTICES}).includes(');
    const staleWait = body.indexOf("'__wiTest.stale() > 0'");
    const hudWait = body.indexOf('the HUD\'s stale row');
    expect([act, noticeWait, staleWait, hudWait].every((i) => i > -1)).toBe(true);
    expect(act).toBeLessThan(noticeWait);
    expect(noticeWait).toBeLessThan(staleWait);
    expect(staleWait).toBeLessThan(hudWait);
    expect(body).toMatch(/hudStaleRowOk\(row, /);
  });

  test('previewMs reads the driver\'s lastLatencyMs from the toolbar status text (previewStatusText)', () => {
    const base = { lastLatencyMs: 212.4, pending: false, error: null } as const;
    expect(previewMs(previewStatusText(base as Parameters<typeof previewStatusText>[0]))).toBe(212);
    expect(previewMs(previewStatusText({ ...base, pending: true } as Parameters<typeof previewStatusText>[0]))).toBe(212);
    expect(previewMs(previewStatusText({ ...base, lastLatencyMs: null } as Parameters<typeof previewStatusText>[0]))).toBeNull();
    expect(previewMs('')).toBeNull();
  });

  test('storedMapMode reads mapMode from the settings the page saves under SETTINGS_KEY', () => {
    expect(SMOKE_SETTINGS_KEY).toBe(SETTINGS_KEY);
    expect(storedMapMode(JSON.stringify({ ...SETTINGS_DEFAULTS, mapMode: 'split' }))).toBe('split');
    expect(storedMapMode(JSON.stringify(SETTINGS_DEFAULTS))).toBe('full');
    expect(storedMapMode(null)).toBeNull();
    expect(storedMapMode('{nope')).toBeNull();
    expect(storedMapMode('{"mapMode":"wide"}')).toBeNull();
  });

  test('the leak check compares the listeners on window and document by target, type, phase and handler location', () => {
    const l = (type: string, line: number, useCapture = false) => ({ type, useCapture, scriptId: '7', lineNumber: line, columnNumber: 3 });
    expect(listenerKey('document', l('keydown', 10, true))).toBe('document keydown capture @7:10:3');
    const base = [listenerKey('window', l('resize', 1)), listenerKey('document', l('pointerlockchange', 2)), listenerKey('document', l('pointerlockchange', 9))];
    expect(listenerDiff(base, [...base].reverse())).toEqual({ added: [], gone: [] });
    // A listener the tool left behind, and a second copy of one already there, are both added.
    const leaked = [...base, listenerKey('window', l('keydown', 40)), listenerKey('window', l('resize', 1))];
    expect(listenerDiff(base, leaked)).toEqual({ added: ['window keydown @7:40:3', 'window resize @7:1:3'], gone: [] });
    expect(listenersLeakFree(listenerDiff(base, leaked), false)).toBe(false);
    // The click hint removes its own pointerlockchange listener once the pointer locks (worldPage.ts): allowed only
    // when the step's lock was granted, and only that one.
    const hintGone = listenerDiff(base, base.slice(0, 2));
    expect(hintGone).toEqual({ added: [], gone: ['document pointerlockchange @7:9:3'] });
    expect(listenersLeakFree(hintGone, true)).toBe(true);
    expect(listenersLeakFree(hintGone, false)).toBe(false);
    expect(listenersLeakFree(listenerDiff(base, base.slice(1)), true)).toBe(false);
    expect(listenersLeakFree(listenerDiff(base, base), false)).toBe(true);
  });
});

describe('UI smoke test: the build and walk steps (SP5a spec §6.4)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('the build page looks 60° down (the ground about 2.3 blocks away, within reach), the walk page faces −z (yaw 0); both at RD 4 on batch with the test hook', () => {
    expect(BUILD_QUERY).toBe('?rd=4&renderer=batch&wiTest=1&pitch=-60');
    expect(WALK_QUERY).toBe('?rd=4&renderer=batch&wiTest=1&yaw=0');
    const build = parseWorldQuery(new URLSearchParams(BUILD_QUERY));
    expect([build.rd, build.renderer, build.pitch]).toEqual([WORLD_RD, 'batch', -60]);
    const walk = parseWorldQuery(new URLSearchParams(WALK_QUERY));
    expect([walk.rd, walk.renderer, walk.yaw]).toEqual([WORLD_RD, 'batch', 0]);
    // Yaw 0 faces −z (ruling P42): W walks along the corridor.
    const [x, , z] = lookVector(0, 0);
    expect(x).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(-1, 12);
  });

  test('the palette lists 51 swatches: PLACEABLE\'s 48 types and the 3 buckets', () => {
    const placeable = PLACEABLE.reduce((n, v) => n + v, 0);
    expect(placeable).toBe(48);
    expect(PALETTE_SWATCHES).toBe(placeable + 3);
    expect(PALETTE_SWATCHES).toBe(51);
    expect(paletteGroups('').reduce((n, g) => n + g.items.length, 0)).toBe(PALETTE_SWATCHES);
  });

  test('the state and fluid literals are the registry\'s (air, stone, torch, a water source)', () => {
    expect(SMOKE_STATE).toEqual({ air: AIR, stone: STONE, torch: REGISTRY.stateOf(REGISTRY.typeId('torch')) });
    expect(SMOKE_STATE).toEqual({ air: 0, stone: 1, torch: 32 });
    expect(SMOKE_WATER_SOURCE).toBe(WATER_SOURCE);
    // The voxel beside a torch reads one step of falloff below its emission (14 → 13; final review GOV-7).
    expect(TORCH_MIN_LIGHT).toBe(EMIT[REGISTRY.stateOf(REGISTRY.typeId('torch'))]! - 1);
    expect(TORCH_MIN_LIGHT).toBe(13);
  });

  test('the torch check needs the spot dark before the torch: `dark < TORCH_MIN_LIGHT` is checked before the torch is posted (final review GOV-7)', () => {
    const src = readFileSync(new URL('../tools/uiSmoke.ts', import.meta.url), 'utf8');
    const read = src.indexOf('const dark = await p.eval<number>(LIT);');
    const dark = src.indexOf('t.check(dark < TORCH_MIN_LIGHT, ');
    const torch = src.indexOf('const torch = await hookEdit(p, at, SMOKE_STATE.torch);');
    expect([read, dark, torch].every((i) => i > -1)).toBe(true);
    expect(read).toBeLessThan(dark);
    expect(dark).toBeLessThan(torch);
  });

  test('acrossFace: the voxel across the hit face, the face literals FACE_*', () => {
    expect(SMOKE_FACE).toEqual({ north: FACE_NORTH, east: FACE_EAST, south: FACE_SOUTH, west: FACE_WEST, up: FACE_UP, down: FACE_DOWN });
    const at = (face: number) => acrossFace({ x: 5, y: 70, z: -3, face });
    expect(at(FACE_NORTH)).toEqual({ x: 5, y: 70, z: -4 });
    expect(at(FACE_SOUTH)).toEqual({ x: 5, y: 70, z: -2 });
    expect(at(FACE_EAST)).toEqual({ x: 6, y: 70, z: -3 });
    expect(at(FACE_WEST)).toEqual({ x: 4, y: 70, z: -3 });
    expect(at(FACE_UP)).toEqual({ x: 5, y: 71, z: -3 });
    expect(at(FACE_DOWN)).toEqual({ x: 5, y: 69, z: -3 });
  });

  test('parseHudEdits reads the edit count of the real HUD\'s "edit p95 n ms (k)" row; null before the first edit', () => {
    const hudText = (edit: HudData['edit']): string => {
      const h = mountWorldHud(dom.body as unknown as HTMLElement, () => ({ ...hudData({ x: 1, y: 90, z: 2, rd: 4, revealed: 81, kind: 'batch' }), edit }));
      const text = dom.body.querySelectorAll('div').filter((e) => e.className !== 'world-hud').map((e) => e.textContent).join('\n');
      h.dispose();
      return text;
    };
    expect(parseHudEdits(hudText({ p95: 41.7, count: 3 }))).toBe(3);
    expect(parseHudEdits(hudText({ p95: 120, count: 12 }))).toBe(12);
    expect(parseHudEdits(hudText(null))).toBeNull();
    expect(parseHudEdits('edit p95 ms (3)')).toBeNull();
  });

  test('walkCorridor: 3 voxels wide centred on the feet\'s column, along −z from the feet\'s row for 16 blocks: stone under the feet\'s level, air in the 2 layers above (ruling R30)', () => {
    expect(WALK_PATH_BLOCKS).toBe(16);
    const edits = walkCorridor({ x: -10.3, y: 70, z: 5.8 }, WALK_PATH_BLOCKS);
    // 17 rows (the feet's and 16 ahead) × 3 columns × 3 layers.
    expect(edits).toHaveLength(17 * 3 * 3);
    const at = (x: number, y: number, z: number) => edits.filter((e) => e.x === x && e.y === y && e.z === z).map((e) => e.state);
    for (let k = 0; k <= 16; k++) {
      for (const x of [-12, -11, -10]) {
        expect(at(x, 69, 5 - k)).toEqual([SMOKE_STATE.stone]);
        expect(at(x, 70, 5 - k)).toEqual([SMOKE_STATE.air]);
        expect(at(x, 71, 5 - k)).toEqual([SMOKE_STATE.air]);
      }
    }
    expect(edits.every((e) => e.x >= -12 && e.x <= -10 && e.z <= 5 && e.z >= -11 && e.y >= 69 && e.y <= 71)).toBe(true);
    // Feet a hair off the block top (the swept clip) still name its level.
    expect(walkCorridor({ x: 0.5, y: 64.0000001, z: 0.5 }, 1)[0]).toEqual({ x: -1, y: 63, z: 0, state: SMOKE_STATE.stone });
    expect(walkCorridor({ x: 0.5, y: 63.9999999, z: 0.5 }, 1)[0]).toEqual({ x: -1, y: 63, z: 0, state: SMOKE_STATE.stone });
  });

  test('the walk\'s pins: the ground within 3 s, W for 4 s moves more than 12 blocks, a jump rises more than 1', () => {
    expect([WALK_GROUND_MS, WALK_HOLD_MS, WALK_MIN_MOVE, JUMP_MIN_RISE]).toEqual([3000, 4000, 12, 1]);
  });

  test('walkSnapOk: once the snap clears, its y is heightAt; on land the feet also rest on the ground within 1e-3 (ruling R29)', () => {
    const feet = (o: Partial<{ y: number; onGround: boolean; snapPending: boolean; snapY: number | null }>) => ({
      x: 3.5, y: 71, z: -2.5, onGround: true, snapPending: false, snapY: 71, ...o,
    });
    expect(walkSnapOk(feet({}), 71, null)).toBe(true);
    expect(walkSnapOk(feet({ y: 71.0000001 }), 71, null)).toBe(true);
    expect(walkSnapOk(feet({ snapPending: true }), 71, null)).toBe(false);
    expect(walkSnapOk(feet({ snapY: null }), 71, null)).toBe(false);
    expect(walkSnapOk(feet({ snapY: 70 }), 71, null)).toBe(false);
    expect(walkSnapOk(feet({}), null, null)).toBe(false);
    // On land: still falling, or off the ground by more than 1e-3.
    expect(walkSnapOk(feet({ onGround: false }), 71, null)).toBe(false);
    expect(walkSnapOk(feet({ y: 71.01 }), 71, null)).toBe(false);
    // Over water (motionBlocking counts the fluid) the snapped body sinks: only the snap's y is checked.
    expect(walkSnapOk(feet({ y: 62.4, onGround: false }), 71, 63)).toBe(true);
    expect(walkSnapOk(null, 71, null)).toBe(false);
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

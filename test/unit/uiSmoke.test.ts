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
import { REVIEW_SITES } from '../harness/reviewSlices';
import {
  canonicalJson, goldenCount, groundTopRow, ignoredLog, mapHash, MOUNTAIN_LINE, mountainSummaryOk, parseArgs, parseSegment, presetProblems, readMapHash, sameJson, selftestAllMatch,
  SIZE_8, SKY_RGB, VIEWPORT, voxelLegendLabels, voxelReadoutOk, voxelRuleId, voxelSummaryOk, type MapUrlState,
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

  test('arguments: build, the OS temp directory and no screenshots by default', () => {
    expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
    expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
    expect(() => parseArgs(['--shots'])).toThrow(/--shots needs a value/);
    expect(() => parseArgs(['--what'])).toThrow(/unknown argument --what/);
  });
});

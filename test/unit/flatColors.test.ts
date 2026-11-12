import { NearestFilter, SRGBColorSpace } from 'three';
import { describe, expect, test } from 'vitest';
import { LAVA_LAYER, LOG_END_LAYER } from '../../src/mesh/greedy';
import { createFlatColorArray, flatColorLayers, LOG_END_COLOR } from '../../src/render/textureArray';
import { FLAT_COLORS, LAVA_COLOR } from '../../src/textures/flatColors';
import { VOXEL_COLORS } from '../../src/ui/crossSection/voxels';
import { AIR, PACKED_ICE, REGISTRY } from '../../src/world/blocks/index';

type Rgb = readonly [number, number, number];
const dist = (a: Rgb, b: Rgb): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
/** The registry's block type names: every type but air (ruling P13). */
const BLOCK_NAMES = REGISTRY.TYPE_NAMES.filter((n) => n !== 'air');
/** One type name per state id, s = 0 … stateCount − 1. */
const NAME_OF_STATE = Array.from({ length: REGISTRY.stateCount }, (_, s) => REGISTRY.TYPE_NAMES[REGISTRY.STATE_TYPE[s]!]!);
const layer = (data: Uint8Array, s: number): number[] => Array.from(data.subarray(4 * s, 4 * s + 4));

describe('the flat-colour table (SP4a spec §6.3, D14)', () => {
  test('packed_ice is [100, 146, 226]', () => {
    expect(FLAT_COLORS.get('packed_ice')).toEqual([100, 146, 226]);
  });

  test('packed_ice is 155 from the sky, ≥ 24 from every other block colour and 36 from the sea-level line', () => {
    const ice = FLAT_COLORS.get('packed_ice')!;
    expect(dist(ice, VOXEL_COLORS.sky)).toBe(155);
    expect(dist(ice, VOXEL_COLORS.seaLevel)).toBe(36);
    for (const [name, c] of FLAT_COLORS) {
      if (name === 'packed_ice') continue;
      expect(dist(ice, c), name).toBeGreaterThanOrEqual(24);
    }
  });

  test('every registry block type except air has an entry, and nothing else does', () => {
    expect(BLOCK_NAMES).toHaveLength(56);
    expect([...FLAT_COLORS.keys()].sort()).toEqual([...BLOCK_NAMES].sort());
    expect(FLAT_COLORS.has('air')).toBe(false);
    // Lava is no type (air plus a fluid byte): its colour lives outside the table (SP5a spec §1.3).
    expect(FLAT_COLORS.has('lava')).toBe(false);
  });

  test('SP6b\'s seven colours are §4\'s, each ≥ 24 from every other type, the sky, water, lava and unknown (SP6b spec §4)', () => {
    const sp6b: [string, Rgb][] = [
      ['moss_block', [78, 112, 52]], ['dripstone_block', [150, 120, 96]], ['abyss_stone', [36, 34, 44]],
      ['abyss_stone_veined', [58, 48, 74]], ['cracked_abyss_stone', [50, 44, 46]], ['abyss_shale', [70, 64, 48]],
      ['abyss_ash', [92, 88, 86]],
    ];
    for (const [name, c] of sp6b) expect(FLAT_COLORS.get(name), name).toEqual(c);
    expect([...FLAT_COLORS.keys()].slice(-7)).toEqual(sp6b.map(([n]) => n));
    const others: [string, Rgb][] = [
      ...FLAT_COLORS, ['sky', VOXEL_COLORS.sky], ['water', VOXEL_COLORS.water], ['lava', LAVA_COLOR], ['unknown', VOXEL_COLORS.unknown],
    ];
    for (const [name, c] of sp6b) {
      for (const [other, o] of others) if (other !== name) expect(dist(c, o), `${name} / ${other}`).toBeGreaterThanOrEqual(24);
    }
    // The abyss's rock stays darker than deepslate (the brief's "very dark stone").
    const deepslate = Math.max(...FLAT_COLORS.get('deepslate')!);
    for (const name of ['abyss_stone', 'abyss_stone_veined', 'cracked_abyss_stone', 'abyss_shale']) {
      expect(Math.max(...FLAT_COLORS.get(name)!), name).toBeLessThan(deepslate);
    }
  });

  test('the Voxels palette reads every block colour from FLAT_COLORS', () => {
    const voxel = VOXEL_COLORS as Readonly<Record<string, Rgb | undefined>>;
    for (const name of BLOCK_NAMES) expect(voxel[name], name).toBe(FLAT_COLORS.get(name));
    expect('air' in VOXEL_COLORS).toBe(false);
    expect(VOXEL_COLORS.lava).toBe(LAVA_COLOR);
  });
});

describe('the flat-colour texture array (SP4a spec §6.3, D14)', () => {
  test('flatColorLayers: layer = state id, RGBA; packed_ice ice blue, a missing name magenta', () => {
    const data = flatColorLayers(NAME_OF_STATE);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(4 * REGISTRY.stateCount);
    expect(layer(data, PACKED_ICE)).toEqual([100, 146, 226, 255]);
    for (let s = 0; s < REGISTRY.stateCount; s++) {
      if (s !== AIR) expect(layer(data, s), NAME_OF_STATE[s]).toEqual([...FLAT_COLORS.get(NAME_OF_STATE[s]!)!, 255]);
    }
    expect(layer(flatColorLayers(['stone', 'no_such_block']), 1)).toEqual([255, 0, 255, 255]);
  });

  test('createFlatColorArray: 1 × 1 × (stateCount + 2), sRGB, nearest, no mipmaps; air (never meshed) is magenta', () => {
    const t = createFlatColorArray();
    expect(t.image.width).toBe(1);
    expect(t.image.height).toBe(1);
    expect(t.image.depth).toBe(REGISTRY.stateCount + 2);
    expect(t.colorSpace).toBe(SRGBColorSpace);
    expect(t.magFilter).toBe(NearestFilter);
    expect(t.minFilter).toBe(NearestFilter);
    expect(t.generateMipmaps).toBe(false);
    const data = t.image.data as Uint8Array;
    expect(layer(data, PACKED_ICE)).toEqual([100, 146, 226, 255]);
    expect(layer(data, AIR)).toEqual([255, 0, 255, 255]);
    // Layers 0 … stateCount − 1 stay one per state (layer = state).
    expect(Array.from(data.subarray(0, 4 * REGISTRY.stateCount))).toEqual(Array.from(flatColorLayers(NAME_OF_STATE)));
  });

  test('the array has 67 layers; layer 65\'s colour is the log end\'s, layer 66 lava\'s (SP5a spec §1.3, SP6b spec §4)', () => {
    const t = createFlatColorArray();
    expect(t.image.depth).toBe(67);
    expect([LOG_END_LAYER, LAVA_LAYER]).toEqual([65, 66]);
    const data = t.image.data as Uint8Array;
    expect(data.length).toBe(4 * 67);
    expect(layer(data, LOG_END_LAYER)).toEqual([...LOG_END_COLOR, 255]);
    expect(layer(data, LAVA_LAYER)).toEqual([...LAVA_COLOR, 255]);
  });

  test('the log end is lighter than oak_log on every channel and ≥ 24 from every type, the sky, water, lava and unknown', () => {
    const log = FLAT_COLORS.get('oak_log')!;
    for (let k = 0; k < 3; k++) expect(LOG_END_COLOR[k]).toBeGreaterThan(log[k]!);
    const others: [string, Rgb][] = [
      ...FLAT_COLORS, ['sky', VOXEL_COLORS.sky], ['water', VOXEL_COLORS.water], ['lava', LAVA_COLOR], ['unknown', VOXEL_COLORS.unknown],
    ];
    for (const [name, c] of others) expect(dist(LOG_END_COLOR, c), name).toBeGreaterThanOrEqual(24);
  });
});

import { NearestFilter, SRGBColorSpace } from 'three';
import { describe, expect, test } from 'vitest';
import { createFlatColorArray, flatColorLayers } from '../../src/render/textureArray';
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
    expect(BLOCK_NAMES).toHaveLength(49);
    expect([...FLAT_COLORS.keys()].sort()).toEqual([...BLOCK_NAMES].sort());
    expect(FLAT_COLORS.has('air')).toBe(false);
    // Lava is no type (air plus a fluid byte): its colour lives outside the table (SP5a spec §1.3).
    expect(FLAT_COLORS.has('lava')).toBe(false);
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

  test('createFlatColorArray: 1 × 1 × stateCount, sRGB, nearest, no mipmaps; air (never meshed) is magenta', () => {
    const t = createFlatColorArray();
    expect(t.image.width).toBe(1);
    expect(t.image.height).toBe(1);
    expect(t.image.depth).toBe(REGISTRY.stateCount);
    expect(t.colorSpace).toBe(SRGBColorSpace);
    expect(t.magFilter).toBe(NearestFilter);
    expect(t.minFilter).toBe(NearestFilter);
    expect(t.generateMipmaps).toBe(false);
    const data = t.image.data as Uint8Array;
    expect(layer(data, PACKED_ICE)).toEqual([100, 146, 226, 255]);
    expect(layer(data, AIR)).toEqual([255, 0, 255, 255]);
  });
});

import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { encodePng, sliceX, sliceY, sliceZ, SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb, type RgbaImage } from '../harness/png';
import { regionView } from '../harness/region';

const MiB = 1 << 20;

interface Chunk {
  type: string;
  data: Buffer;
  crc: number;
}

/** Splits a PNG into its chunks after checking the signature. */
function chunks(png: Uint8Array): Chunk[] {
  const b = Buffer.from(png);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out: Chunk[] = [];
  let o = 8;
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    out.push({ type: b.toString('latin1', o + 4, o + 8), data: b.subarray(o + 8, o + 8 + len), crc: b.readUInt32BE(o + 8 + len) });
    o += 12 + len;
  }
  expect(o).toBe(b.length);
  return out;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG whose rows all use filter 0 (what `encodePng` writes). */
function decode(png: Uint8Array): RgbaImage {
  const cs = chunks(png);
  for (const c of cs) expect(c.crc, `${c.type} CRC`).toBe(crc32(Buffer.concat([Buffer.from(c.type, 'latin1'), c.data])));
  expect(cs[0]!.type).toBe('IHDR');
  expect(cs.at(-1)!.type).toBe('IEND');
  expect(cs.at(-1)!.data.length).toBe(0);
  const ihdr = cs[0]!.data;
  expect(ihdr.length).toBe(13);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  // bit depth 8, colour type 6 (RGBA), compression 0, filter 0, interlace 0
  expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  const raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  expect(raw.length).toBe(height * (1 + 4 * width));
  const rgba = new Uint8Array(4 * width * height);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + 4 * width);
    expect(raw[row]).toBe(0);
    rgba.set(raw.subarray(row + 1, row + 1 + 4 * width), 4 * width * y);
  }
  return { width, height, rgba };
}

describe('encodePng (§6.1)', () => {
  test('signature, IHDR, chunk CRCs, IEND; the pixels decode back exactly', () => {
    const width = 7;
    const height = 5;
    const rgba = new Uint8Array(4 * width * height);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 255;
    const img = decode(encodePng({ width, height, rgba }));
    expect([img.width, img.height]).toEqual([width, height]);
    expect(Buffer.from(img.rgba).equals(Buffer.from(rgba))).toBe(true);
  });

  test('a 1 × 1 image and a wide one round-trip', () => {
    for (const [width, height] of [[1, 1], [600, 2]] as const) {
      const rgba = new Uint8Array(4 * width * height).map((_, i) => (i * 13) & 255);
      expect(Buffer.from(decode(encodePng({ width, height, rgba })).rgba).equals(Buffer.from(rgba))).toBe(true);
    }
  });

  test('rejects empty sizes and a pixel buffer of the wrong length', () => {
    expect(() => encodePng({ width: 0, height: 1, rgba: new Uint8Array(0) })).toThrow(RangeError);
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => encodePng({ width: 1.5, height: 2, rgba: new Uint8Array(12) })).toThrow(RangeError);
  });
});

describe('the Voxels palette (§5.2, §6.1)', () => {
  test('air is sky, stone grey, bedrock near black; unknown states are flagged', () => {
    expect(voxelRgb(AIR, 0, 0)).toEqual(VOXEL_COLORS.sky);
    expect(voxelRgb(STONE, 0, 0)).toEqual(VOXEL_COLORS.stone);
    expect(voxelRgb(BEDROCK, 0, 0)).toEqual(VOXEL_COLORS.bedrock);
    expect(voxelRgb(999, 0, 0)).toEqual(VOXEL_COLORS.unknown);
    const [r, g, b] = VOXEL_COLORS.bedrock;
    expect(Math.max(r, g, b)).toBeLessThan(48);
  });

  test('water is blue and darkens with depth below the water surface, down to a floor', () => {
    const at = (d: number) => voxelRgb(AIR, WATER_SOURCE, d);
    expect(at(0)).toEqual(VOXEL_COLORS.water);
    const [r, g, b] = VOXEL_COLORS.water;
    expect(b).toBeGreaterThan(Math.max(r, g));
    for (let d = 0; d < 80; d++) {
      const [, , b0] = at(d);
      const [, , b1] = at(d + 1);
      expect(b1).toBeLessThanOrEqual(b0);
    }
    expect(at(10)[2]).toBeLessThan(at(0)[2]);
    expect(at(1000)[2]).toBeGreaterThan(0);
    expect(at(1000)).toEqual(at(2000));
  });
});

/**
 * A hand-written 2 × 1 region at (0, 0): column (0, 0) is a lake (bedrock, stone to y 10, water sources to y 20,
 * air), column (1, 0) is land (stone to y 30).
 */
function handRegion(): VoxelStore {
  const s = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
  const blocks = new Uint16Array(4096);
  const fluid = new Uint8Array(4096);
  for (const [cx, solidTop, waterTop] of [[0, 10, 20], [1, 30, 30]] as const) {
    const w = s.claimColumn(cx, 0, 0);
    for (let sy = 0; sy < 24; sy++) {
      for (let i = 0; i < 4096; i++) {
        const y = -64 + 16 * sy + (i >> 8);
        blocks[i] = y === -64 ? BEDROCK : y <= solidTop ? STONE : AIR;
        fluid[i] = y > solidTop && y <= waterTop ? WATER_SOURCE : 0;
      }
      w.setProto(sy, blocks, fluid);
    }
    const a = w.aux();
    a.worldSurfaceWG.fill(waterTop + 1);
    a.oceanFloorWG.fill(solidTop + 1);
    a.surfaceBiome.fill(7 + cx);
    w.commit(1);
  }
  return s;
}

const px = (img: RgbaImage, i: number, row: number) => [...img.rgba.subarray(4 * (row * img.width + i), 4 * (row * img.width + i) + 4)];
const rgb = (c: readonly [number, number, number]) => [...c, 255];

describe('PNG slices (§6.1)', () => {
  const view = regionView(handRegion(), 0, 0, 2, 1);
  const water = (depth: number) => rgb(voxelRgb(AIR, WATER_SOURCE, depth));

  test('sliceZ: a z plane, x across, row 0 at y 319; water depth from the column surface; sea-level line on air', () => {
    const img = sliceZ(view, 3);
    expect([img.width, img.height]).toEqual([32, 384]);
    const row = (y: number) => 319 - y;
    expect(px(img, 5, row(-64))).toEqual(rgb(VOXEL_COLORS.bedrock));
    expect(px(img, 5, row(0))).toEqual(rgb(VOXEL_COLORS.stone));
    expect(px(img, 5, row(10))).toEqual(rgb(VOXEL_COLORS.stone));
    expect(px(img, 5, row(11))).toEqual(water(9));
    expect(px(img, 5, row(15))).toEqual(water(5));
    expect(px(img, 5, row(20))).toEqual(water(0));
    expect(px(img, 5, row(21))).toEqual(rgb(VOXEL_COLORS.sky));
    expect(SEA_LEVEL_Y).toBe(63);
    expect(px(img, 5, row(SEA_LEVEL_Y))).toEqual(rgb(VOXEL_COLORS.seaLevel));
    expect(px(img, 20, row(30))).toEqual(rgb(VOXEL_COLORS.stone));
    expect(px(img, 20, row(31))).toEqual(rgb(VOXEL_COLORS.sky));
    expect(px(img, 20, row(319))).toEqual(rgb(VOXEL_COLORS.sky));
  });

  test('sliceX: an x plane, z across, cropped to [yMin, yMax]', () => {
    const img = sliceX(view, 20, { yMin: 0, yMax: 63 });
    expect([img.width, img.height]).toEqual([16, 64]);
    for (let i = 0; i < 16; i++) {
      expect(px(img, i, 0)).toEqual(rgb(VOXEL_COLORS.seaLevel));
      expect(px(img, i, 63 - 30)).toEqual(rgb(VOXEL_COLORS.stone));
      expect(px(img, i, 63 - 31)).toEqual(rgb(VOXEL_COLORS.sky));
    }
    expect(decode(encodePng(img)).rgba).toEqual(img.rgba);
  });

  test('sliceY: a y plane, x across and z down', () => {
    const img = sliceY(view, 15);
    expect([img.width, img.height]).toEqual([32, 16]);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 32; x++) expect(px(img, x, z)).toEqual(x < 16 ? water(5) : rgb(VOXEL_COLORS.stone));
    }
    expect(px(sliceY(view, 63), 0, 0)).toEqual(rgb(VOXEL_COLORS.sky));
  });

  test('planes and y ranges outside the region throw', () => {
    expect(() => sliceX(view, 32)).toThrow(RangeError);
    expect(() => sliceX(view, -1)).toThrow(RangeError);
    expect(() => sliceZ(view, 16)).toThrow(RangeError);
    expect(() => sliceY(view, 320)).toThrow(RangeError);
    expect(() => sliceZ(view, 0, { yMin: 10, yMax: 9 })).toThrow(RangeError);
    expect(() => sliceZ(view, 0, { yMin: -65 })).toThrow(RangeError);
  });
});

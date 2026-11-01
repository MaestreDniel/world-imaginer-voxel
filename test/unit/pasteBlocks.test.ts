import { describe, expect, test } from 'vitest';
import { pasteLitBlock, pasteMaxBlock, type PasteBlock } from '../../src/ui/world/pasteBlocks';
import { AIR, GLASS, OAK_LOG, OAK_PLANKS, REGISTRY, STONE, WALL_TORCH } from '../../src/world/blocks/index';

/** SP5c spec §10.3, D31 (Spec corrections 6 and 11; rulings P1): the two maximum paste blocks of the bench rows and L12c. */

const dry = (state: number): number => state << 8;
const at = (b: PasteBlock, x: number, y: number, z: number): number => b.values[(y * b.d + z) * b.w + x]!;
const nonAir = (b: PasteBlock): number => b.values.reduce((n, v) => n + (v !== dry(AIR) ? 1 : 0), 0);

/** `paste.max`'s cut order: the index order (y ascending, then z, then x). */
const maxOrder = (b: PasteBlock): number[] => Array.from({ length: b.values.length }, (_, i) => i);
/** `paste.maxLit`'s cut order: shell-major (shell (x ≥ 32) · 5 + ⌊y / 12⌋, then y, then z, then x within the shell). */
const litOrder = (b: PasteBlock): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    const sx = i >= 5 ? 32 : 0;
    const sy = (i % 5) * 12;
    for (let y = 0; y < 12; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) out.push(((sy + y) * b.d + z) * b.w + sx + x);
  }
  return out;
};
/** The indices of a block's non-air cells, in the given order. */
const cut = (b: PasteBlock, order: readonly number[]): number[] => order.filter((i) => b.values[i] !== dry(AIR));

describe.each([
  ['pasteMaxBlock', pasteMaxBlock, maxOrder],
  ['pasteLitBlock', pasteLitBlock, litOrder],
] as const)('%s', (_name, build, order) => {
  test('each block has exactly `changes` non-air cells for 32,768 and 16,384; the first 16,384 of the 32,768 cut are the 16,384 cut\'s cells', () => {
    const full = build();
    const half = build(16_384);
    expect(nonAir(full)).toBe(32_768);
    expect(nonAir(build(32_768))).toBe(32_768);
    expect(nonAir(half)).toBe(16_384);
    const fullCut = cut(full, order(full));
    const halfCut = cut(half, order(half));
    expect(fullCut.length).toBe(32_768);
    expect(fullCut.slice(0, 16_384)).toEqual(halfCut);
    // The same cells hold the same values.
    for (const i of halfCut) expect(half.values[i], `cell ${i}`).toBe(full.values[i]);
  });

  test('both cuts are at most 64 a side (a selection\'s bound, D12; rulings P1) and the same size; every value a dry state of the registry', () => {
    for (const b of [build(), build(16_384)]) {
      expect(Math.max(b.w, b.h, b.d)).toBeLessThanOrEqual(64);
      expect(b.values.length).toBe(b.w * b.h * b.d);
      for (const v of new Set(b.values)) {
        expect(v & 0xff, 'dry').toBe(0);
        expect(REGISTRY.stateKey(v >> 8)).not.toBe('');
      }
    }
    expect([build(16_384).w, build(16_384).h, build(16_384).d]).toEqual([build().w, build().h, build().d]);
  });

  test('a change count outside 0 … the block\'s cells, or not an integer, throws', () => {
    expect(() => build(-1)).toThrow(RangeError);
    expect(() => build(1.5)).toThrow(RangeError);
    expect(() => build(40_000)).toThrow(RangeError);
    expect(nonAir(build(0))).toBe(0);
  });
});

test('paste.max\'s block: 32³ of stone with an oak_log (axis y) at every index that is a multiple of 7', () => {
  const b = pasteMaxBlock();
  expect([b.w, b.h, b.d]).toEqual([32, 32, 32]);
  expect(REGISTRY.stateKey(OAK_LOG)).toBe('oak_log[axis=y]');
  for (let i = 0; i < b.values.length; i++) expect(b.values[i]).toBe(dry(i % 7 === 0 ? OAK_LOG : STONE));
  // The 16,384 cut is the lower half: y 0 … 15 pasted, y 16 … 31 air.
  const half = pasteMaxBlock(16_384);
  expect(at(half, 31, 15, 31)).toBe(dry(STONE));
  expect(at(half, 0, 16, 0)).toBe(dry(AIR));
});

test('paste.maxLit\'s block: 64 × 60 × 32, shells 2 across x by 5 high; a whole shell is 3,296 changes (planks, a glass band on row 4 with planks at the corners, 8 wall torches facing north on row 6 at z 30); 9 whole shells and 3,104 of the 10th', () => {
  const b = pasteLitBlock();
  expect([b.w, b.h, b.d]).toEqual([64, 60, 32]);
  expect(REGISTRY.stateKey(WALL_TORCH)).toBe('wall_torch[facing=north]');
  const shellCells = (sx: number, sy: number): Map<number, number> => {
    const m = new Map<number, number>();
    for (let y = 0; y < 12; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      const v = at(b, sx + x, sy + y, z);
      if (v !== dry(AIR)) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return m;
  };
  // Shell 0, whole: the shell's 3,288 wall, floor and roof cells (the glass band: 4 × 30 on row 4) and 8 torches.
  const s0 = shellCells(0, 0);
  expect([...s0.values()].reduce((a, n) => a + n, 0)).toBe(3_296);
  expect(s0.get(dry(GLASS))).toBe(120);
  expect(s0.get(dry(WALL_TORCH))).toBe(8);
  expect(s0.get(dry(OAK_PLANKS))).toBe(3_296 - 120 - 8);
  expect(at(b, 0, 4, 0)).toBe(dry(OAK_PLANKS));
  expect(at(b, 5, 4, 0)).toBe(dry(GLASS));
  for (let x = 2; x < 32; x += 4) expect(at(b, x, 6, 30), `torch at x ${x}`).toBe(dry(WALL_TORCH));
  expect(at(b, 5, 5, 5)).toBe(dry(AIR));
  // Shells 1 … 8 whole (shells 5 … 8 in the second column, x ≥ 32); shell 9 (x ≥ 32, y 48 … 59) holds the rest.
  for (const [sx, sy] of [[0, 12], [0, 24], [0, 36], [0, 48], [32, 0], [32, 12], [32, 24], [32, 36]] as const) {
    expect(shellCells(sx, sy), `shell at (${sx}, ${sy})`).toEqual(s0);
  }
  const s9 = [...shellCells(32, 48).values()].reduce((a, n) => a + n, 0);
  expect(s9).toBe(32_768 - 9 * 3_296);
  expect(s9).toBe(3_104);
  // The 10th shell's cut follows its y, z, x order: its floor (1,024), walls (10 × 124) and torches (8) are whole and its
  // roof holds the remaining 832 cells, rows z 0 … 25; z 26 … 31 stay air.
  expect(at(b, 63, 48, 31)).toBe(dry(OAK_PLANKS));
  expect(at(b, 63, 59, 25)).toBe(dry(OAK_PLANKS));
  expect(at(b, 32, 59, 26)).toBe(dry(AIR));
  // 16,384: 4 whole shells (13,184) and 3,200 of shell 4 (x < 32, y 48 …); the second column is air.
  const half = pasteLitBlock(16_384);
  let second = 0;
  for (let y = 0; y < 60; y++) for (let z = 0; z < 32; z++) for (let x = 32; x < 64; x++) if (at(half, x, y, z) !== dry(AIR)) second++;
  expect(second).toBe(0);
  expect(nonAir(half) - 4 * 3_296).toBe(3_200);
});

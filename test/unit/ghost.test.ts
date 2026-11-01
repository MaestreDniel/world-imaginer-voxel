/**
 * The ghost's mesh (SP5c spec §6.2, §6.4, D11, D25): `render/ghost.ts` meshes the clipboard cell by cell (16³) through
 * the section mesher, sliced on an injected clock, into one geometry uploaded once, and places it by its matrix. No
 * WebGL: the material system builds without a context, and the geometry is read as three holds it. The replaced-cell
 * overlay (§6.3) is read through its instance matrices.
 */
import * as v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Matrix4, Quaternion, Vector3, type BufferAttribute, type MeshBasicMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { PACK_LAYOUT } from '../../src/mesh/packing';
import {
  GHOST_MAX_QUADS, GHOST_SLICE_MS, REPLACED_GROW, REPLACED_MAX, REPLACED_OPACITY, createGhost, createReplacedOverlay, type Ghost,
} from '../../src/render/ghost';
import { createMaterialSystem } from '../../src/render/materials/index';
import { GHOST_ORDER, REFUSED_RED, VOLUME_DIM_ORDER } from '../../src/render/selection';
import { createFlatColorArray } from '../../src/render/textureArray';
import { AIR, GLASS, REGISTRY, STONE } from '../../src/world/blocks/index';

const WALL_TORCH = REGISTRY.parseStateKey('wall_torch[facing=north]');
const SOLID = PACK_LAYOUT.solid;
const layerOf = (word: number): number => (word >>> SOLID.layer.offset) & 0x3FF;
const frameOf = (word: number): number => (word >>> SOLID.frame.offset) & 1;

const materials = () => createMaterialSystem({ variant: 'mesh', ao: true, smoothLight: true }, createFlatColorArray());

/** A clipboard of W × H × D values `state << 8`, index `(y · d + z) · w + x`, from `stateAt`. */
function clip(w: number, h: number, d: number, stateAt: (x: number, y: number, z: number) => number): Uint32Array {
  const v = new Uint32Array(w * h * d);
  for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) v[(y * d + z) * w + x] = stateAt(x, y, z) << 8;
  return v;
}

/** Steps with a clock that never advances, until the build ends. */
function buildAll(g: Ghost): void {
  for (let i = 0; i < 10_000 && g.build === 'building'; i++) g.step(() => 0);
}

function quadsOf(g: Ghost): number {
  const p = g.object.geometry.getAttribute('position') as BufferAttribute | undefined;
  return p === undefined ? 0 : p.count / 4;
}

describe('the ghost\'s mesh (SP5c spec §6.2, D25)', () => {
  test('the constants: one slice past 1 ms at most, 131,072 quads', () => {
    expect(GHOST_SLICE_MS).toBe(1);
    expect(GHOST_MAX_QUADS).toBe(131_072);
  });

  test('a new ghost is empty and hidden, drawn with the ghost material at `GHOST_ORDER`', () => {
    const m = materials();
    const g = createGhost(m);
    expect(g.build).toBe('empty');
    expect(g.object.visible).toBe(false);
    expect(g.object.material).toBe(m.ghost);
    expect(g.object.renderOrder).toBe(GHOST_ORDER);
    g.step(() => { throw new Error('no clock read while empty'); });
    expect(g.build).toBe('empty');
    g.dispose();
  });

  test('a 1 × 1 × 1 stone clipboard builds 6 quads', () => {
    const g = createGhost(materials());
    g.setClipboard(1, 1, 1, clip(1, 1, 1, () => STONE));
    expect(g.build).toBe('building');
    buildAll(g);
    expect(g.build).toBe('ready');
    const geo = g.object.geometry;
    const pos = geo.getAttribute('position') as BufferAttribute;
    expect(pos.array).toBeInstanceOf(Uint16Array);
    expect(pos.itemSize).toBe(4);
    expect(quadsOf(g)).toBe(6);
    expect(geo.getIndex()!.count).toBe(36);
    expect(geo.getIndex()!.array).toBeInstanceOf(Uint32Array);
    expect(geo.getAttribute('data').array).toBeInstanceOf(Uint32Array);
    // Every corner on the unit cell's surface, in 1/8-block units.
    for (let i = 0; i < pos.count; i++) {
      for (const c of [pos.getX(i), pos.getY(i), pos.getZ(i)]) expect([0, 8]).toContain(c);
    }
    const data = geo.getAttribute('data') as BufferAttribute;
    for (let i = 0; i < data.count; i++) expect(layerOf(data.getX(i))).toBe(STONE);
    // Meshed as above the world: sky 15, block 0.
    for (let i = 0; i < data.count; i++) expect((data.getX(i) >>> SOLID.sky.offset) & 15).toBe(15);
    g.dispose();
  });

  test('a glass pane and a wall torch build cutout and box quads into the one geometry', () => {
    const g = createGhost(materials());
    // Glass at x 0, air at x 1, a wall torch at x 2.
    g.setClipboard(3, 1, 1, clip(3, 1, 1, (x) => (x === 0 ? GLASS : x === 2 ? WALL_TORCH : AIR)));
    buildAll(g);
    expect(g.build).toBe('ready');
    const geo = g.object.geometry;
    expect(geo.groups).toEqual([]);
    expect(geo.getIndex()!.count).toBe(6 * quadsOf(g));
    const data = geo.getAttribute('data') as BufferAttribute;
    const pos = geo.getAttribute('position') as BufferAttribute;
    let glass = 0;
    let torch = 0;
    for (let q = 0; q < data.count / 4; q++) {
      const word = data.getX(4 * q);
      if (layerOf(word) === GLASS) {
        glass++;
        expect(frameOf(word), 'glass shows its frame').toBe(1);
        for (let k = 0; k < 4; k++) expect(pos.getX(4 * q + k)).toBeLessThanOrEqual(8);
      } else if (layerOf(word) === WALL_TORCH) {
        torch++;
        for (let k = 0; k < 4; k++) {
          expect(pos.getX(4 * q + k)).toBeGreaterThanOrEqual(16);
          expect(pos.getX(4 * q + k)).toBeLessThanOrEqual(24);
        }
      } else throw new Error(`unexpected layer ${layerOf(word)}`);
    }
    expect([glass, torch]).toEqual([6, 6]);
    expect(quadsOf(g)).toBe(12);
    g.dispose();
  });

  test('fluids are not meshed: a water cell is air to the ghost, and glass shows its face beside it', () => {
    const g = createGhost(materials());
    const v = clip(2, 1, 1, (x) => (x === 0 ? GLASS : AIR));
    v[1] = (AIR << 8) | 16; // a water source
    g.setClipboard(2, 1, 1, v);
    buildAll(g);
    expect(quadsOf(g)).toBe(6);
    const data = g.object.geometry.getAttribute('data') as BufferAttribute;
    for (let i = 0; i < data.count; i++) expect(layerOf(data.getX(i))).toBe(GLASS);
    g.dispose();
  });

  test('a solid 64³ clipboard on an injected clock advancing 0.3 ms per cell: each slice stops after the cell that crosses 1 ms (4 cells), 64 cells in 16 slices, uploaded once at the end; `lastSliceMs` recorded per slice', () => {
    const g = createGhost(materials());
    g.setClipboard(64, 64, 64, clip(64, 64, 64, () => STONE));
    // The clock: 0.3 ms later at each read; the build reads it once per slice, once per cell and once after the upload.
    let t = 0;
    let reads = 0;
    const now = (): number => {
      reads++;
      const v = t;
      t += 0.3;
      return v;
    };
    const empty = g.object.geometry;
    const perSlice: number[] = [];
    const slices: number[] = [];
    const geometries = new Set([empty]);
    let steps = 0;
    while (g.build === 'building') {
      const before = reads;
      g.step(now);
      steps++;
      perSlice.push(reads - before);
      slices.push(g.lastSliceMs);
      geometries.add(g.object.geometry);
      if (g.build === 'building') {
        expect(g.object.geometry, 'nothing uploaded before the last cell').toBe(empty);
        expect(g.object.geometry.getAttribute('position')).toBeUndefined();
      }
      expect(steps).toBeLessThanOrEqual(64);
    }
    expect(g.build).toBe('ready');
    expect(steps).toBe(16);
    // The slice's first read, then one per cell: 4 cells (0.3, 0.6, 0.9, then 1.2 crosses 1 ms) and, in the last, one
    // read after the upload.
    expect(perSlice).toEqual([...Array<number>(15).fill(5), 6]);
    for (let s = 0; s < 15; s++) expect(slices[s]).toBeCloseTo(1.2, 9);
    expect(slices[15]).toBeCloseTo(1.5, 9);
    // One upload: the empty geometry, then the built one.
    expect(geometries.size).toBe(2);
    // The outer faces only, each cell's side one merged 16 × 16 quad: 6 sides × 16.
    expect(quadsOf(g)).toBe(96);
    // Each cell's quads at its own offset: the corners span the whole box, 0 … 512 eighths on every axis.
    const pos = g.object.geometry.getAttribute('position') as BufferAttribute;
    const ends = (get: (i: number) => number): [number, number] => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        lo = Math.min(lo, get(i));
        hi = Math.max(hi, get(i));
      }
      return [lo, hi];
    };
    expect([ends((i) => pos.getX(i)), ends((i) => pos.getY(i)), ends((i) => pos.getZ(i))]).toEqual([[0, 512], [0, 512], [0, 512]]);
    const corners = new Set<string>();
    for (let i = 0; i < pos.count; i++) corners.add(`${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`);
    for (const c of corners) for (const v of c.split(',')) expect(Number(v) % 128, `corner ${c} on a cell boundary`).toBe(0);
    // A step after the build reads no clock.
    const before = reads;
    g.step(now);
    expect(reads).toBe(before);
    g.dispose();
  });

  test('a clipboard whose quads pass 131,072 (a 64³ checkerboard) ends `\'tooMany\'` with no geometry', () => {
    const g = createGhost(materials());
    g.setClipboard(64, 64, 64, clip(64, 64, 64, (x, y, z) => (((x + y + z) & 1) === 0 ? STONE : AIR)));
    buildAll(g);
    expect(g.build).toBe('tooMany');
    expect(g.object.geometry.getAttribute('position')).toBeUndefined();
    expect(g.object.geometry.getIndex()).toBeNull();
    g.place(0, 64, 0, 0);
    expect(g.object.visible, 'no preview: the box only').toBe(false);
    g.dispose();
  });

  test('`setClipboard` during a build restarts it', () => {
    const g = createGhost(materials());
    g.setClipboard(64, 64, 64, clip(64, 64, 64, () => STONE));
    let t = 0;
    g.step(() => (t += 0.3));
    expect(g.build).toBe('building');
    g.setClipboard(1, 1, 1, clip(1, 1, 1, () => GLASS));
    expect(g.build).toBe('building');
    expect(g.lastSliceMs).toBe(0);
    buildAll(g);
    expect(g.build).toBe('ready');
    expect(quadsOf(g)).toBe(6);
    const data = g.object.geometry.getAttribute('data') as BufferAttribute;
    for (let i = 0; i < data.count; i++) expect(layerOf(data.getX(i))).toBe(GLASS);
    g.dispose();
  });

  test('`setClipboard` checks its sizes and length', () => {
    const g = createGhost(materials());
    expect(() => g.setClipboard(0, 1, 1, new Uint32Array(0))).toThrow(RangeError);
    expect(() => g.setClipboard(65, 1, 1, new Uint32Array(65))).toThrow(RangeError);
    expect(() => g.setClipboard(2, 2, 2, new Uint32Array(7))).toThrow(RangeError);
    g.dispose();
  });

  test('hidden until placed: `place` shows a ready ghost, `hide` hides it, a new clipboard hides it until placed again', () => {
    const g = createGhost(materials());
    g.setClipboard(1, 1, 1, clip(1, 1, 1, () => STONE));
    g.place(3, 70, 4, 0);
    expect(g.object.visible, 'nothing to draw while building').toBe(false);
    buildAll(g);
    expect(g.object.visible, 'placed before it was ready').toBe(true);
    g.hide();
    expect(g.object.visible).toBe(false);
    g.place(3, 70, 4, 1);
    expect(g.object.visible).toBe(true);
    g.setClipboard(2, 1, 1, clip(2, 1, 1, () => STONE));
    expect(g.object.visible).toBe(false);
    buildAll(g);
    expect(g.object.visible).toBe(false);
    g.place(3, 70, 4, 0);
    expect(g.object.visible).toBe(true);
    g.dispose();
  });

  test('`place` for q 0-3 maps the centre of cell (x, y, z) to the world cell §2.6 gives ((D − 1 − z, y, x) for q 1), checked through `object.matrixWorld`', () => {
    const m = materials();
    const g = createGhost(m);
    const W = 5;
    const H = 2;
    const D = 3;
    g.setClipboard(W, H, D, clip(W, H, D, () => STONE));
    buildAll(g);
    const [x0, y0, z0] = [100, 64, -40];
    /** §2.6's turn applied q times to (x, z) in a w × d box. */
    const turned = (x: number, z: number, q: number): [number, number] => {
      let [tx, tz, w, d] = [x, z, W, D];
      for (let k = 0; k < q; k++) [tx, tz, w, d] = [d - 1 - tz, tx, d, w];
      void w;
      return [tx, tz];
    };
    const v = new Vector3();
    for (let q = 0; q < 4; q++) {
      g.place(x0, y0, z0, q);
      expect(m.ghost.uniforms['ghostTurns']!.value, 'the face remap follows the turn').toBe(q);
      g.object.updateMatrixWorld(true);
      for (let y = 0; y < H; y++) {
        for (let z = 0; z < D; z++) {
          for (let x = 0; x < W; x++) {
            v.set(8 * (x + 0.5), 8 * (y + 0.5), 8 * (z + 0.5)).applyMatrix4(g.object.matrixWorld);
            const [tx, tz] = turned(x, z, q);
            expect([Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)], `q ${q}, cell (${x}, ${y}, ${z})`).toEqual([x0 + tx, y0 + y, z0 + tz]);
          }
        }
      }
    }
    g.dispose();
  });
});

describe('the replaced cells (SP5c spec §6.3, D11)', () => {
  /** n distinct cells of a 64³ box as x, y, z offset triples: cell i at (i mod 64, ⌊i / 4096⌋, ⌊i / 64⌋ mod 64). */
  const cellsOf = (n: number): Int32Array => {
    const c = new Int32Array(3 * n);
    for (let i = 0; i < n; i++) {
      c[3 * i] = i % 64;
      c[3 * i + 1] = Math.floor(i / 4096);
      c[3 * i + 2] = Math.floor(i / 64) % 64;
    }
    return c;
  };

  test('the constants and the overlay: 4,096 cubes of 256 KB of matrices, red at 0.3 through terrain, at `VOLUME_DIM_ORDER`, hidden until set', () => {
    expect([REPLACED_MAX, REPLACED_OPACITY, REPLACED_GROW]).toEqual([4096, 0.3, 0.01]);
    const r = createReplacedOverlay();
    expect(r.object.isInstancedMesh).toBe(true);
    expect(r.object.instanceMatrix.array.length).toBe(16 * 4096);
    expect(r.object.instanceMatrix.array.byteLength).toBe(256 * 1024);
    expect(r.object.renderOrder).toBe(VOLUME_DIM_ORDER);
    expect(r.object.visible).toBe(false);
    expect(r.object.count).toBe(0);
    const m = r.object.material as MeshBasicMaterial;
    expect(m.isMeshBasicMaterial).toBe(true);
    expect([m.color.getHex(), m.opacity, m.transparent, m.depthTest, m.depthWrite]).toEqual([REFUSED_RED, 0.3, true, false, false]);
    // A unit cube from (0, 0, 0) to (1, 1, 1): an instance's matrix grows and places it.
    r.object.geometry.computeBoundingBox();
    const b = r.object.geometry.boundingBox!;
    expect([b.min.toArray(), b.max.toArray()]).toEqual([[0, 0, 0], [1, 1, 1]]);
    r.dispose();
  });

  test('`setReplaced` with 5,000 cells draws 4,096 (`count`), each instance matrix at its cell grown by 0.01', () => {
    const r = createReplacedOverlay();
    const buffer = r.object.instanceMatrix.array;
    const cells = cellsOf(5000);
    const [x0, y0, z0] = [-20, 61, 7];
    r.set(x0, y0, z0, cells, 5000);
    expect(r.object.count).toBe(4096);
    expect(r.object.visible).toBe(true);
    expect(r.object.instanceMatrix.array, 'the buffer allocated once').toBe(buffer);
    const m = new Matrix4();
    const p = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    const lo = new Vector3();
    const hi = new Vector3();
    for (let i = 0; i < 4096; i++) {
      r.object.getMatrixAt(i, m);
      m.decompose(p, q, s);
      const [cx, cy, cz] = [x0 + cells[3 * i]!, y0 + cells[3 * i + 1]!, z0 + cells[3 * i + 2]!];
      expect(s.toArray().map((v) => Math.round(v * 1e6) / 1e6), `cell ${i}'s size`).toEqual([1.02, 1.02, 1.02]);
      expect(q.w, `cell ${i} unrotated`).toBeCloseTo(1, 9);
      // The cube's corners: the cell grown by 0.01 on every side.
      lo.set(0, 0, 0).applyMatrix4(m);
      hi.set(1, 1, 1).applyMatrix4(m);
      for (const [v, want] of [[lo.x, cx - 0.01], [lo.y, cy - 0.01], [lo.z, cz - 0.01], [hi.x, cx + 1.01], [hi.y, cy + 1.01], [hi.z, cz + 1.01]] as const) {
        expect(v, `cell ${i}`).toBeCloseTo(want, 4);
      }
    }
    // A smaller fill draws its own count over the same buffer; a count of 0 hides the overlay.
    r.set(0, 0, 0, cells, 40);
    expect([r.object.count, r.object.visible]).toEqual([40, true]);
    expect(r.object.instanceMatrix.array).toBe(buffer);
    r.set(0, 0, 0, cells, 0);
    expect([r.object.count, r.object.visible]).toEqual([0, false]);
    r.set(0, 0, 0, cells, 3);
    r.hide();
    expect(r.object.visible).toBe(false);
    r.dispose();
  });

  test('1,000 fills grow the heap by less than 256 KB', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    // The heap's used bytes without V8's code spaces (`zeroAlloc.test.ts`'s reading).
    const used = (): number => {
      let n = 0;
      for (const sp of v8.getHeapSpaceStatistics()) if (!/^(code|trusted|shared_trusted)_/.test(sp.space_name)) n += sp.space_used_size;
      return n;
    };
    const r = createReplacedOverlay();
    const cells = cellsOf(REPLACED_MAX);
    const fill = (i: number): void => r.set(i & 15, 64, -(i & 7), cells, REPLACED_MAX - (i & 255));
    for (let i = 0; i < 200; i++) fill(i);
    const readings: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      gc();
      gc();
      const before = used();
      for (let i = 0; i < 1000; i++) fill(i);
      readings.push(used() - before);
      if (readings.at(-1)! < 256 * 1024) break;
    }
    expect(readings.at(-1), `readings ${readings.join(', ')} B`).toBeLessThan(256 * 1024);
    r.dispose();
  });
});

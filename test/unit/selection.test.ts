/**
 * The block outline (SP5a spec §3.5, D8): a black `LineSegments` box enlarged by 0.002, depth-tested, opaque, at
 * `renderOrder` 3 (after the cutout pass, before the water), around the aimed cell or a box state's provisional box.
 * The volume box (SP5c spec §6.1, D3): the same unit cube drawn twice, depth-tested and dimmed through terrain.
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Box3, type LineBasicMaterial, type LineSegments } from 'three';
import { describe, expect, test } from 'vitest';
import {
  AFTER_WATER_ORDER, DIM_OPACITY, GHOST_CYAN, GHOST_ORDER, OUTLINE_GROW, OUTLINE_ORDER, REFUSED_RED, SELECTION_YELLOW,
  VOLUME_DIM_ORDER, createSelection, createVolumeBox, outlineBounds, type VolumeBox,
} from '../../src/render/selection';
import { STONE, TORCH } from '../../src/world/blocks/index';

describe('the block outline (SP5a spec §3.5)', () => {
  test('the box\'s bounds are the target\'s ± 0.002; its material is opaque with `depthTest` true at `renderOrder` 3', () => {
    const s = createSelection();
    expect(s.object.visible, 'hidden until a target is set').toBe(false);
    s.set(-3, 64, 7, -2, 65, 8);
    expect(s.object.visible).toBe(true);
    s.object.updateMatrixWorld(true);
    const b = new Box3().setFromObject(s.object);
    const want = [-3 - 0.002, 64 - 0.002, 7 - 0.002, -2 + 0.002, 65 + 0.002, 8 + 0.002];
    const got = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
    for (let i = 0; i < 6; i++) expect(got[i]!, `bound ${i}`).toBeCloseTo(want[i]!, 9);
    expect(OUTLINE_GROW).toBe(0.002);
    const m = s.object.material as LineBasicMaterial;
    expect(m.isLineBasicMaterial).toBe(true);
    expect(m.color.getHex()).toBe(0x000000);
    expect(m.transparent).toBe(false);
    expect(m.depthTest).toBe(true);
    expect(OUTLINE_ORDER).toBe(3);
    expect(s.object.renderOrder).toBe(3);
    // Twelve edges.
    expect(s.object.geometry.getAttribute('position').count).toBe(24);
    s.hide();
    expect(s.object.visible).toBe(false);
    s.dispose();
  });

  test('outlineBounds: a full block is its cell; a torch is its stick\'s provisional box (D8)', () => {
    const out = new Float64Array(6);
    outlineBounds(STONE, 10, 70, -5, out);
    expect([...out]).toEqual([10, 70, -5, 11, 71, -4]);
    outlineBounds(TORCH, 10, 70, -5, out);
    // The stick: 2/8 wide, 5/8 tall, centred (`BOXES.torch`, in eighths).
    expect([...out]).toEqual([10 + 3 / 8, 70, -5 + 3 / 8, 10 + 5 / 8, 70 + 5 / 8, -5 + 5 / 8]);
  });

  test('updating the outline box to a fixed target 10,000 times allocates nothing (rulings R16)', () => {
    const s = createSelection();
    const out = new Float64Array(6);
    const call = (): void => {
      outlineBounds(STONE, 1234, 70, -987, out);
      s.set(out[0]!, out[1]!, out[2]!, out[3]!, out[4]!, out[5]!);
    };
    for (let i = 0; i < 100_000; i++) call();
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
    const heapUsed = (): number => {
      let b = 0;
      for (const sp of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(sp.space_name)) b += sp.space_used_size;
      return b;
    };
    const readings: number[] = [];
    for (let t = 0; t < 3; t++) {
      gc();
      gc();
      const before = heapUsed();
      const profiler = new v8.GCProfiler();
      profiler.start();
      for (let i = 0; i < 10_000; i++) call();
      const after = heapUsed();
      const gcs = profiler.stop()?.statistics.length ?? 0;
      if (gcs > 0) continue;
      readings.push(after - before);
      if (after - before < 256 * 1024) break;
    }
    expect(s.object.visible).toBe(true);
    expect(readings.length, 'every attempt saw a GC').toBeGreaterThan(0);
    expect(readings[readings.length - 1]!, `heap growth over 10,000 updates (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
    s.dispose();
  });
});

describe('the volume box (SP5c spec §6.1, D3)', () => {
  const lines = (b: VolumeBox): [LineSegments, LineSegments] => b.object.children as [LineSegments, LineSegments];

  test('`createVolumeBox` holds two objects sharing one geometry; the first depth-tested and opaque at `OUTLINE_ORDER`, the second `depthTest` false, transparent, opacity 0.35, `renderOrder` `VOLUME_DIM_ORDER`', () => {
    const b = createVolumeBox();
    expect(b.object.isGroup).toBe(true);
    expect(b.object.children).toHaveLength(2);
    const [solid, dim] = lines(b);
    expect(solid.isLineSegments && dim.isLineSegments).toBe(true);
    expect(dim.geometry, 'one geometry for both').toBe(solid.geometry);
    // Twelve edges.
    expect(solid.geometry.getAttribute('position').count).toBe(24);
    const sm = solid.material as LineBasicMaterial;
    const dm = dim.material as LineBasicMaterial;
    expect(sm).not.toBe(dm);
    expect([sm.isLineBasicMaterial, sm.depthTest, sm.transparent, solid.renderOrder]).toEqual([true, true, false, OUTLINE_ORDER]);
    expect(DIM_OPACITY).toBe(0.35);
    expect([dm.isLineBasicMaterial, dm.depthTest, dm.transparent, dm.opacity, dim.renderOrder]).toEqual([true, false, true, 0.35, VOLUME_DIM_ORDER]);
    expect(dm.depthWrite, 'the dimmed lines write no depth').toBe(false);
    expect(b.object.visible, 'hidden until `set`').toBe(false);
    expect([SELECTION_YELLOW, GHOST_CYAN, REFUSED_RED]).toEqual([0xffd400, 0x3fd0ff, 0xff4040]);
    b.dispose();
  });

  test('`set` positions and scales both with `OUTLINE_GROW` and sets both colours', () => {
    const b = createVolumeBox();
    b.set(-3, 64, 7, 5, 70, 9, GHOST_CYAN);
    expect(b.object.visible).toBe(true);
    b.object.updateMatrixWorld(true);
    const want = [-3 - OUTLINE_GROW, 64 - OUTLINE_GROW, 7 - OUTLINE_GROW, 5 + OUTLINE_GROW, 70 + OUTLINE_GROW, 9 + OUTLINE_GROW];
    for (const line of lines(b)) {
      expect(line.visible).toBe(true);
      const box = new Box3().setFromObject(line);
      const got = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
      for (let i = 0; i < 6; i++) expect(got[i]!, `bound ${i}`).toBeCloseTo(want[i]!, 9);
      expect((line.material as LineBasicMaterial).color.getHex()).toBe(GHOST_CYAN);
    }
    b.set(0, 0, 0, 1, 1, 1, REFUSED_RED);
    for (const line of lines(b)) expect((line.material as LineBasicMaterial).color.getHex()).toBe(REFUSED_RED);
    b.dispose();
  });

  test('`hide` hides both', () => {
    const b = createVolumeBox();
    b.set(0, 0, 0, 2, 2, 2, SELECTION_YELLOW);
    const seen = (): number => {
      let n = 0;
      b.object.traverseVisible((o) => { if ((o as LineSegments).isLineSegments === true) n++; });
      return n;
    };
    expect(seen()).toBe(2);
    b.hide();
    expect(b.object.visible).toBe(false);
    expect(seen()).toBe(0);
    b.dispose();
  });

  test('`GHOST_ORDER` and `VOLUME_DIM_ORDER` are above 65,536', () => {
    // Above any translucent region's `renderOrder` (RegionMesh numbers them 0 … N − 1 every frame).
    expect(AFTER_WATER_ORDER).toBe(1 << 20);
    expect(GHOST_ORDER).toBe(AFTER_WATER_ORDER);
    expect(VOLUME_DIM_ORDER).toBe(AFTER_WATER_ORDER + 1);
    expect(GHOST_ORDER).toBeGreaterThan(65_536);
    expect(VOLUME_DIM_ORDER).toBeGreaterThan(65_536);
  });
});

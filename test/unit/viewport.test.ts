import { PerspectiveCamera } from 'three';
import { describe, expect, test, vi } from 'vitest';
import { createMaterialSystem } from '../../src/render/materials/index';
import { applyViewport, cameraFar, opaquePassSort, releaseGl } from '../../src/render/renderer';
import { createSky, SKY_RENDER_ORDER } from '../../src/render/sky';
import { createFlatColorArray } from '../../src/render/textureArray';

describe('applyViewport (SP4a spec §6.1, Review Focus 4)', () => {
  test('a host resize sets the camera aspect and the drawing-buffer size; a dpr change re-applies min(dpr, pixelRatioCap)', () => {
    const camera = new PerspectiveCamera(70, 1, 0.1, 336);
    const setSize = vi.fn();
    const setPixelRatio = vi.fn();
    applyViewport(camera, 1600, 900, 2, 1, setSize, setPixelRatio);
    expect(camera.aspect).toBeCloseTo(16 / 9, 12);
    expect(setSize).toHaveBeenLastCalledWith(1600, 900);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
    // The projection follows the aspect: x scales by 1 / aspect against y.
    const e = camera.projectionMatrix.elements;
    expect(e[0]! / e[5]!).toBeCloseTo(9 / 16, 12);

    // A resize.
    applyViewport(camera, 800, 800, 2, 1, setSize, setPixelRatio);
    expect(camera.aspect).toBe(1);
    expect(setSize).toHaveBeenLastCalledWith(800, 800);

    // A dpr change: the cap still applies, and a dpr under the cap is kept.
    applyViewport(camera, 1600, 900, 2, 0.85, setSize, setPixelRatio);
    expect(setPixelRatio).toHaveBeenLastCalledWith(0.85);
    applyViewport(camera, 1600, 900, 0.75, 1, setSize, setPixelRatio);
    expect(setPixelRatio).toHaveBeenLastCalledWith(0.75);
  });

  test('a collapsed host keeps a 1 × 1 drawing buffer and a finite aspect', () => {
    const camera = new PerspectiveCamera(70, 1, 0.1, 336);
    const setSize = vi.fn();
    applyViewport(camera, 0, 0, 1, 1, setSize, () => {});
    expect(setSize).toHaveBeenLastCalledWith(1, 1);
    expect(camera.aspect).toBe(1);
  });
});

describe('the world renderer helpers (SP4a spec §6.1)', () => {
  test('the camera far plane is (rd + 2)·16·1.5', () => {
    expect(cameraFar(12)).toBe(336);
    expect(cameraFar(4)).toBe(144);
  });

  const materials = createMaterialSystem({ variant: 'batch', ao: true, smoothLight: true }, createFlatColorArray());

  test('createSky: one full-screen triangle with the sky material, never culled, after the opaque pass', () => {
    const sky = createSky(materials);
    expect(sky.material).toBe(materials.sky);
    expect(sky.frustumCulled).toBe(false);
    expect(sky.renderOrder).toBe(SKY_RENDER_ORDER);
    expect(sky.renderOrder).toBeGreaterThan(0);
    expect(Array.from(sky.geometry.getAttribute('position').array)).toEqual([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
    sky.geometry.dispose();
  });

  test('the opaque list draws opaque front to back, then the sky, then cutout', () => {
    type Item = Parameters<ReturnType<typeof opaquePassSort>>[0];
    const sort = opaquePassSort(materials);
    const item = (name: string, material: object, z: number, renderOrder = 0): Item & { name: string } =>
      ({ name, material, z, renderOrder, groupOrder: 0, id: z }) as unknown as Item & { name: string };
    const items = [
      item('cutout near', materials.terrainCutout, 1),
      item('sky', materials.sky, 0, SKY_RENDER_ORDER),
      item('opaque far', materials.terrainOpaque, 9),
      item('cutout far', materials.terrainCutout, 8),
      item('opaque near', materials.terrainOpaque, 2),
    ];
    expect(items.sort(sort).map((i) => i.name)).toEqual(['opaque near', 'opaque far', 'sky', 'cutout near', 'cutout far']);
  });
});

describe('releaseGl (final review B-M4)', () => {
  test('disposes three\'s renderer, then loses the WebGL context, then detaches the canvas', () => {
    const order: string[] = [];
    releaseGl(
      { dispose: () => { order.push('dispose'); }, forceContextLoss: () => { order.push('forceContextLoss'); } },
      { remove: () => { order.push('remove'); } },
    );
    expect(order).toEqual(['dispose', 'forceContextLoss', 'remove']);
  });
});

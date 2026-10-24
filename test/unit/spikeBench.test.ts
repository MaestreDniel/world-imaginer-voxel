import { PerspectiveCamera, type BufferAttribute, type Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { buildScene, longFrames, uploadFrame } from '../../src/render/spike/spikeBench';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload } from './fixtures/payloads';
import { opaque, regionObjects, water } from './sectionRendererContract';

/**
 * The spike bench's long frames (SP4b spec §7.6): the gap ending at frame i is listed with frame i's main time and frame
 * i − 1's, which ran inside that gap (`spikeVerdict.test.ts` tests the verdict, not the bench).
 */
describe('spikeBench longFrames (SP4b spec §7.6)', () => {
  test('longFrames on frame deltas [16, 16, 50, 16] and main [1, 2, 9, 3] gives one entry { frame: 2, deltaMs: 50, mainMs: 9, prevMainMs: 2 }', () => {
    expect(longFrames(Float64Array.from([16, 16, 50, 16]), Float64Array.from([1, 2, 9, 3]))).toEqual({
      count: 1,
      first: [{ frame: 2, deltaMs: 50, mainMs: 9, prevMainMs: 2 }],
    });
  });

  test('a long first frame has no previous main time; 33 ms is not long', () => {
    expect(longFrames(Float64Array.from([40, 33, 34]), Float64Array.from([5, 1, 2]))).toEqual({
      count: 2,
      first: [{ frame: 0, deltaMs: 40, mainMs: 5, prevMainMs: null }, { frame: 2, deltaMs: 34, mainMs: 2, prevMainMs: 1 }],
    });
  });
});

describe('the spike restores frustum culling after its upload frame (SP4b spec §3.9; final review REN-1)', () => {
  /** three's first render of the scene: every attribute's upload ends in its onUploadCallback. */
  const threeUploads = {
    renderer: {
      render(scene: Object3D): void {
        for (const m of regionObjects(scene)) {
          const g = m.geometry;
          // The sky dome too (no index).
          for (const a of [...Object.values(g.attributes), g.getIndex()].filter((a) => a !== null) as BufferAttribute[]) a.onUploadCallback();
        }
      },
    },
  };

  for (const kind of ['batch', 'mesh'] as const) {
    test(`${kind}: the build leaves every region object unculled; uploadFrame renders once and culls them all again`, () => {
      const albedo = createFlatColorArray();
      const payloads = [];
      // Four regions, opaque and water rows.
      for (let cx = -12; cx < 12; cx += 5) for (let cz = -12; cz < 12; cz += 5) payloads.push(fakePayload(cx, cz, [opaque(2, 2), water(3)]));
      const b = buildScene(kind, albedo, payloads);
      try {
        const objects = regionObjects(b.sections.root);
        expect(objects.length).toBeGreaterThan(4);
        expect(objects.every((m) => !m.frustumCulled)).toBe(true);
        const ms = uploadFrame(threeUploads, b, new PerspectiveCamera());
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(objects.filter((m) => !m.frustumCulled).length).toBe(0);
      } finally {
        b.dispose();
        albedo.dispose();
      }
    });
  }
});

import { BoxGeometry, Group, LinearMipmapLinearFilter, Mesh, NearestFilter, PerspectiveCamera } from 'three';
import { describe, expect, test } from 'vitest';
import {
  applyRenderDistance, createGpuTimer, gpuEstimateOf, withRegionsUnculled, withSectionsShown, type GpuEstimate,
} from '../../src/render/renderer';

/** `EXT_disjoint_timer_query_webgl2`'s enums and WebGL2's query parameters (the fake reads them by value). */
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT = 0x8866;
const QUERY_RESULT_AVAILABLE = 0x8867;

interface FakeQuery {
  readonly id: number;
}

/** A WebGL2 context with only the timer query's surface: queries finish when the test says so. */
function fakeGl(withExtension: boolean) {
  const s = {
    disjoint: false,
    available: new Set<FakeQuery>(),
    results: new Map<FakeQuery, number>(),
    created: [] as FakeQuery[],
    deleted: [] as FakeQuery[],
  };
  const gl = {
    QUERY_RESULT,
    QUERY_RESULT_AVAILABLE,
    getExtension: (name: string) =>
      withExtension && name === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } : null,
    createQuery: (): FakeQuery => {
      const q = { id: s.created.length };
      s.created.push(q);
      return q;
    },
    beginQuery: () => {},
    endQuery: () => {},
    getParameter: (p: number) => (p === GPU_DISJOINT_EXT ? s.disjoint : null),
    getQueryParameter: (q: FakeQuery, p: number) => (p === QUERY_RESULT_AVAILABLE ? s.available.has(q) : s.results.get(q)),
    deleteQuery: (q: FakeQuery) => {
      s.deleted.push(q);
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, s };
}

/** A Group of two meshes and a sub-group of two more. */
function scene(): { root: Group; meshes: Mesh[]; sub: Group } {
  const root = new Group();
  const sub = new Group();
  const meshes = [0, 1, 2, 3].map(() => new Mesh(new BoxGeometry()));
  root.add(meshes[0]!, meshes[1]!, sub);
  sub.add(meshes[2]!, meshes[3]!);
  return { root, meshes, sub };
}

describe('createGpuTimer (SP4b spec §4.5)', () => {
  test('without the extension, null', () => {
    expect(createGpuTimer(fakeGl(false).gl)).toBeNull();
  });

  test('a finished query reports its ms; the newest of several finished ones wins', () => {
    const { gl, s } = fakeGl(true);
    const t = createGpuTimer(gl)!;
    for (let i = 0; i < 3; i++) {
      t.begin();
      t.end();
    }
    expect(t.poll()).toBeNull();
    s.results.set(s.created[0]!, 2_000_000);
    s.results.set(s.created[1]!, 3_500_000);
    s.available.add(s.created[0]!).add(s.created[1]!);
    expect(t.poll()).toBe(3.5);
    expect(s.deleted).toEqual([s.created[0], s.created[1]]);
    t.dispose();
  });

  test('a disjoint deletes every pending query, available or not, and poll returns null', () => {
    const { gl, s } = fakeGl(true);
    const t = createGpuTimer(gl)!;
    for (let i = 0; i < 4; i++) {
      t.begin();
      t.end();
    }
    // The first and third finished; the second and fourth did not.
    s.results.set(s.created[0]!, 1_000_000);
    s.results.set(s.created[2]!, 1_000_000);
    s.available.add(s.created[0]!).add(s.created[2]!);
    s.disjoint = true;
    expect(t.poll()).toBeNull();
    expect(new Set(s.deleted)).toEqual(new Set(s.created));
    expect(s.deleted).toHaveLength(4);
    // Nothing is left pending: the next queries are timed again, and the cap of pending queries is free.
    s.disjoint = false;
    for (let i = 0; i < 8; i++) {
      t.begin();
      t.end();
    }
    expect(s.created).toHaveLength(12);
    s.results.set(s.created[4]!, 4_000_000);
    s.available.add(s.created[4]!);
    expect(t.poll()).toBe(4);
    t.dispose();
    expect(s.deleted).toHaveLength(12);
  });

  test('drain hands every finished query, oldest first, with the draw it timed; draws counts begin\'s calls, a skipped one included (Task 26b)', () => {
    const { gl, s } = fakeGl(true);
    const t = createGpuTimer(gl)!;
    expect(t.draws()).toBe(0);
    for (let i = 0; i < 3; i++) {
      t.begin();
      t.end();
    }
    expect(t.draws()).toBe(3);
    const seen: Array<[number, number]> = [];
    const sink = (draw: number, ms: number): void => { seen.push([draw, ms]); };
    t.drain(sink);
    expect(seen).toEqual([]);
    // Draws 0 and 1 finished, 2 did not: both are handed over, not only the newest.
    s.results.set(s.created[0]!, 2_000_000);
    s.results.set(s.created[1]!, 3_500_000);
    s.available.add(s.created[0]!).add(s.created[1]!);
    t.drain(sink);
    expect(seen).toEqual([[0, 2], [1, 3.5]]);
    // Eight pending queries make begin skip a draw; the draw still counts, so the next query is tagged after it.
    for (let i = 0; i < 7; i++) {
      t.begin();
      t.end();
    }
    expect(s.created).toHaveLength(10);
    t.begin();
    t.end();
    expect([t.draws(), s.created.length]).toEqual([11, 10]);
    s.results.set(s.created[2]!, 1_000_000);
    s.available.add(s.created[2]!);
    t.drain(sink);
    expect(seen.at(-1)).toEqual([2, 1]);
    t.begin();
    t.end();
    s.results.set(s.created[10]!, 5_000_000);
    for (const q of s.created) if (!s.results.has(q)) s.results.set(q, 0);
    for (const q of s.created) s.available.add(q);
    seen.length = 0;
    t.drain(sink);
    expect(seen.map((x) => x[0])).toEqual([3, 4, 5, 6, 7, 8, 9, 11]);
    expect(seen.at(-1)).toEqual([11, 5]);
    // A disjoint hands nothing over and drops every pending query.
    t.begin();
    t.end();
    s.results.set(s.created[11]!, 1_000_000);
    s.available.add(s.created[11]!);
    s.disjoint = true;
    seen.length = 0;
    t.drain(sink);
    expect(seen).toEqual([]);
    s.disjoint = false;
    expect(t.poll()).toBeNull();
    t.dispose();
  });
});

describe('withSectionsShown (SP4a spec §6.4, SP4b spec §4.5)', () => {
  test('hidden objects are visible inside fn (compile, warmUp) and hidden again after fn and after a throw', () => {
    const { root, meshes, sub } = scene();
    meshes[1]!.visible = false;
    meshes[3]!.visible = false;
    sub.visible = false;
    const seen: boolean[] = [];
    const out = withSectionsShown(root, () => {
      root.traverse((o) => seen.push(o.visible));
      return 7;
    });
    expect(out).toBe(7);
    expect(seen.every((v) => v)).toBe(true);
    expect([meshes[0]!.visible, meshes[1]!.visible, sub.visible, meshes[2]!.visible, meshes[3]!.visible])
      .toEqual([true, false, false, true, false]);

    expect(() => withSectionsShown(root, () => {
      expect(meshes[1]!.visible && sub.visible && meshes[3]!.visible).toBe(true);
      throw new Error('compile failed');
    })).toThrow('compile failed');
    expect([meshes[0]!.visible, meshes[1]!.visible, sub.visible, meshes[2]!.visible, meshes[3]!.visible])
      .toEqual([true, false, false, true, false]);
  });
});

describe('withRegionsUnculled (SP4b spec §3.9, §4.5)', () => {
  test('frustum culling is off inside fn on every region object and restored after, also after a throw', () => {
    const { root, meshes } = scene();
    // A region still unculled for its pending upload keeps that after the warm-up.
    meshes[2]!.frustumCulled = false;
    const before = meshes.map((m) => m.frustumCulled);
    const inside: boolean[] = [];
    withRegionsUnculled(root, () => {
      for (const m of meshes) inside.push(m.frustumCulled);
    });
    expect(inside).toEqual([false, false, false, false]);
    expect(meshes.map((m) => m.frustumCulled)).toEqual(before);

    expect(() => withRegionsUnculled(root, () => {
      expect(meshes.every((m) => !m.frustumCulled)).toBe(true);
      throw new Error('render failed');
    })).toThrow('render failed');
    expect(meshes.map((m) => m.frustumCulled)).toEqual(before);
  });
});

describe('applyRenderDistance (SP4b spec §5)', () => {
  test('camera.far is 288 at RD 10 and the projection matrix updated', () => {
    const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 336);
    applyRenderDistance(camera, 10);
    expect(camera.far).toBe(288);
    const expected = new PerspectiveCamera(70, 16 / 9, 0.1, 288);
    expect(camera.projectionMatrix.elements).toEqual(expected.projectionMatrix.elements);
  });
});

describe('gpuEstimateOf (SP4b spec §8.4)', () => {
  const parts = (generateMipmaps: boolean, minFilter: number) => ({
    sections: { gpuBytes: () => 1_835_008 },
    sky: {
      attributes: { position: { array: new Float32Array(9) }, uv: { array: new Uint16Array(6) } },
      index: { array: new Uint16Array(3) },
    },
    textureArray: { image: { width: 4, height: 4, depth: 3 }, generateMipmaps, minFilter },
    lightmap: { image: { data: new Uint8Array(1024) } },
    canvas: { width: 1600, height: 900 },
  });

  test('each field from its object\'s sizes, written into out and returned', () => {
    const out: GpuEstimate = { sectionsBytes: -1, skyBytes: -1, textureBytes: -1, lightmapBytes: -1, drawingBufferBytes: -1 };
    expect(gpuEstimateOf(parts(false, NearestFilter), out)).toBe(out);
    expect(out).toEqual({
      sectionsBytes: 1_835_008,
      skyBytes: 36 + 12 + 6,
      textureBytes: 4 * 4 * 3 * 4,
      lightmapBytes: 1024,
      drawingBufferBytes: 1600 * 900 * 8,
    });
  });

  test('a mipmapped texture array counts every level down to 1 × 1; generateMipmaps under a nearest filter has none', () => {
    const out: GpuEstimate = { sectionsBytes: 0, skyBytes: 0, textureBytes: 0, lightmapBytes: 0, drawingBufferBytes: 0 };
    expect(gpuEstimateOf(parts(true, LinearMipmapLinearFilter), out).textureBytes).toBe((16 + 4 + 1) * 3 * 4);
    expect(gpuEstimateOf(parts(true, NearestFilter), out).textureBytes).toBe(16 * 3 * 4);
  });
});

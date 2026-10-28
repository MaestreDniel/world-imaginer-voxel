import {
  BoxGeometry, Group, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, NearestFilter, PerspectiveCamera, Scene,
  ShaderMaterial, type BatchedMesh, type Material, type Object3D, type RenderItem,
} from 'three';
import { describe, expect, test } from 'vitest';
import { createMaterialSystem } from '../../src/render/materials/index';
import {
  NEAR_FLY, NEAR_WALK, applyNear, applyRenderDistance, compileScene, createGpuTimer, gpuEstimateOf, opaquePassSort,
  withRegionsUnculled, withSectionsShown, type GpuEstimate,
} from '../../src/render/renderer';
import { createSelection } from '../../src/render/selection';
import { SKY_RENDER_ORDER } from '../../src/render/sky';
import { createSectionRenderer, type SectionRendererKind } from '../../src/render/sectionRenderer';
import { createSky } from '../../src/render/sky';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload } from './fixtures/payloads';
import { pumpAll } from './sectionRendererContract';

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
    /** Called on each availability read: a disjoint event may land between two of the timer's reads. */
    onAvailableRead: null as ((q: FakeQuery) => void) | null,
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
    getQueryParameter: (q: FakeQuery, p: number) => {
      if (p !== QUERY_RESULT_AVAILABLE) return s.results.get(q);
      s.onAvailableRead?.(q);
      return s.available.has(q);
    },
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

  test('availability is read before the disjoint flag: a disjoint landing after the availability reads hands nothing over (final review REN-2)', () => {
    const { gl, s } = fakeGl(true);
    const t = createGpuTimer(gl)!;
    for (let i = 0; i < 3; i++) {
      t.begin();
      t.end();
    }
    s.results.set(s.created[0]!, 2_000_000);
    s.results.set(s.created[1]!, 3_000_000);
    s.available.add(s.created[0]!).add(s.created[1]!);
    // The event lands while the timer reads the queries' availability, before it reads the flag.
    s.onAvailableRead = () => { s.disjoint = true; };
    const seen: Array<[number, number]> = [];
    t.drain((draw, ms) => { seen.push([draw, ms]); });
    expect(seen).toEqual([]);
    expect(s.deleted).toHaveLength(3);
    // Without an event the next query reports its time.
    s.onAvailableRead = null;
    s.disjoint = false;
    t.begin();
    t.end();
    s.available.add(s.created[3]!);
    s.results.set(s.created[3]!, 1_000_000);
    expect(t.poll()).toBe(1);
    expect(s.deleted).toHaveLength(4);
    t.dispose();
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

describe('compileScene: every pass\'s program at load, built or not (SP4b spec §8.4, rulings R11)', () => {
  /**
   * A renderer whose `compileAsync` walks the scene as three's `compile` does and records, for each visible mesh, its
   * object kind and material name (a hidden object would be skipped, so the walk proves the stand-ins are shown).
   */
  const walker = (fail = false) => {
    const seen: string[] = [];
    return {
      seen,
      compileAsync(scene: Object3D): Promise<unknown> {
        scene.traverseVisible((o) => {
          if ((o as Mesh).isMesh !== true) return;
          seen.push(`${(o as BatchedMesh).isBatchedMesh === true ? 'BatchedMesh' : 'Mesh'} ${((o as Mesh).material as Material).name}`);
        });
        if (fail) throw new Error('compile failed');
        return Promise.resolve(scene);
      },
    };
  };
  const world = (kind: SectionRendererKind) => {
    const materials = createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, createFlatColorArray());
    const sections = createSectionRenderer(kind, materials);
    // The first entry holds the reveals: the root is hidden while compile runs (SP4b spec §3.11).
    sections.holdReveals(true);
    const scene = new Scene();
    scene.add(sections.root, createSky(materials));
    return { sections, scene, camera: new PerspectiveCamera(70, 16 / 9, 0.1, 336) };
  };
  const object = (kind: SectionRendererKind): string => (kind === 'batch' ? 'BatchedMesh' : 'Mesh');

  for (const kind of ['batch', 'mesh'] as const) {
    test(`${kind}: on an empty world the walk sees the opaque, cutout and water materials on the ${object(kind)}, and the sky; the stand-ins are gone after it`, async () => {
      const { sections, scene, camera } = world(kind);
      const r = walker();
      await compileScene(r, scene, camera, sections);
      expect([...r.seen].sort()).toEqual([`${object(kind)} terrainCutout`, `${object(kind)} terrainOpaque`, `${object(kind)} waterFast`, 'Mesh sky'].sort());
      expect(sections.root.children).toEqual([]);
      expect(sections.root.visible, 'the reveals stay held').toBe(false);
      expect(sections.gpuBytes()).toBe(0);
      sections.dispose();
    });

    test(`${kind}: with an opaque region built, each pass material is seen on the ${object(kind)} exactly once (stand-ins for the cutout and water passes only)`, async () => {
      const { sections, scene, camera } = world(kind);
      sections.stage(fakePayload(0, 0, [{ sy: 4, pass: 0, quads: 2 }]), 1);
      pumpAll(sections);
      const built = [...sections.root.children];
      const r = walker();
      await compileScene(r, scene, camera, sections);
      expect([...r.seen].sort()).toEqual([`${object(kind)} terrainCutout`, `${object(kind)} terrainOpaque`, `${object(kind)} waterFast`, 'Mesh sky'].sort());
      expect(sections.root.children).toEqual(built);
      expect(built.every((o) => o.visible)).toBe(true);
      sections.dispose();
    });

    test(`${kind}: a compile that throws still removes the stand-ins and hides the root again`, async () => {
      const { sections, scene, camera } = world(kind);
      await expect(compileScene(walker(true), scene, camera, sections)).rejects.toThrow('compile failed');
      expect(sections.root.children).toEqual([]);
      expect(sections.root.visible).toBe(false);
      sections.dispose();
    });
  }
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

describe('the opaque list\'s order (spec §6.1; SP5a spec §3.5)', () => {
  test('`opaquePassSort` orders the outline after the cutout pass', () => {
    const terrainOpaque = new MeshBasicMaterial();
    const terrainCutout = new ShaderMaterial();
    const sky = new MeshBasicMaterial();
    const outline = createSelection().object;
    const item = (id: number, material: Material, renderOrder: number, z: number): RenderItem =>
      ({ id, groupOrder: 0, material, renderOrder, z }) as unknown as RenderItem;
    // The outline nearest the camera, the cutout farthest: the pass order wins over depth.
    const items = [
      item(1, outline.material as Material, outline.renderOrder, 1),
      item(2, terrainCutout, 0, 90),
      item(3, sky, SKY_RENDER_ORDER, 50),
      item(4, terrainOpaque, 0, 40),
    ];
    items.sort(opaquePassSort({ terrainCutout }));
    expect(items.map((i) => i.id)).toEqual([4, 3, 2, 1]);
  });
});

describe('applyNear (SP5a spec §3.5)', () => {
  test('`applyNear(camera, 0.05)` sets `near` 0.05 and updates `projectionMatrix`', () => {
    expect([NEAR_WALK, NEAR_FLY]).toEqual([0.05, 0.1]);
    const camera = new PerspectiveCamera(70, 16 / 9, NEAR_FLY, 336);
    applyNear(camera, 0.05);
    expect(camera.near).toBe(0.05);
    const expected = new PerspectiveCamera(70, 16 / 9, 0.05, 336);
    expect(camera.projectionMatrix.elements).toEqual(expected.projectionMatrix.elements);
    applyNear(camera, NEAR_FLY);
    expect(camera.projectionMatrix.elements).toEqual(new PerspectiveCamera(70, 16 / 9, 0.1, 336).projectionMatrix.elements);
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

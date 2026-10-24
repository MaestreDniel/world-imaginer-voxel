import {
  LinearFilter, NearestFilter, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer, type Mesh, type Object3D,
  type RenderItem,
} from 'three';
import { MEDIUM } from '../core/params/graphicsPresets';
import { OPENING_T } from '../daynight/dayNight';
import { firstOrigin, type FloatingOrigin } from './floatingOrigin';
import type { FrameState } from './frameState';
import { createMaterialSystem, type MaterialSystem } from './materials/index';
import { createSectionRenderer, type SectionRenderer, type SectionRendererKind } from './sectionRenderer';
import { createSky } from './sky';
import { createFlatColorArray } from './textureArray';

/**
 * The world renderer (SP4a spec §6.1): a `WebGLRenderer` with SP0's defaults (antialias off, pixel ratio
 * min(dpr, pixelRatioCap), output sRGB), a perspective camera (near 0.1, far (RD + 2)·16·1.5), and a scene holding the
 * section renderer's regions (§6.2) and the sky dome (§6.5). It builds the flat-colour array, the material system and
 * the section renderer itself, because the page (`ui`) may not touch `render/materials/`. It replaces SP0's sky page.
 * SP4b (spec §4.5, §5): the far plane follows a live render distance, the warm-up draws every region unculled, the
 * first floating origin is the snapped spawn, the GPU timer drops every query in flight on a disjoint, and the canvas
 * names its section renderer (`data-renderer`).
 *
 * Pass order (master §4.5): opaque (front side, front to back), the sky dome, cutout (double side, alpha test), then
 * translucent (blended, back to front). The first three share three's opaque list, ordered by `opaquePassSort`; the
 * water is in three's transparent list, which draws after it.
 */

/** The camera's near plane, in blocks (spec §6.1). */
const NEAR = 0.1;

/** The camera's far plane for render distance `rd`: (rd + 2)·16·1.5 blocks (spec §6.1). */
export function cameraFar(rd: number): number {
  return (rd + 2) * 16 * 1.5;
}

/** Moves the camera's far plane to render distance `rd` (`cameraFar`) and updates its projection (SP4b spec §5). */
export function applyRenderDistance(camera: PerspectiveCamera, rd: number): void {
  camera.far = cameraFar(rd);
  camera.updateProjectionMatrix();
}

/**
 * Fits the view to a `w` × `h` host at device pixel ratio `dpr` (Review Focus 4): the camera's aspect and projection,
 * the pixel ratio min(dpr, cap), then the drawing-buffer size. A collapsed host counts as 1 × 1.
 */
export function applyViewport(
  camera: PerspectiveCamera,
  w: number,
  h: number,
  dpr: number,
  cap: number,
  setSize: (w: number, h: number) => void,
  setPixelRatio: (r: number) => void,
): void {
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  setPixelRatio(Math.min(dpr, cap));
  setSize(width, height);
}

/** Where the cutout pass sits in the opaque list: after the opaque sections (0) and the sky (`SKY_RENDER_ORDER`). */
const CUTOUT_ORDER = 2;

/**
 * The opaque list's order (spec §6.1): by three's group order, then by pass (the cutout material at `CUTOUT_ORDER`,
 * everything else at its `renderOrder`: the opaque sections 0, the sky 1), then front to back. three's default sorts by
 * material before depth, which would draw cutout before the sky.
 */
export function opaquePassSort(m: Pick<MaterialSystem, 'terrainCutout'>): (a: RenderItem, b: RenderItem) => number {
  const order = (i: RenderItem): number => (i.material === m.terrainCutout ? CUTOUT_ORDER : i.renderOrder);
  return (a, b) => a.groupOrder - b.groupOrder || order(a) - order(b) || a.z - b.z || a.id - b.id;
}

/** GPU time per frame through `EXT_disjoint_timer_query_webgl2`. */
export interface GpuTimer {
  /** Starts a time query; a no-op while one is open or too many are pending. */
  begin(): void;
  /** Ends the open query. */
  end(): void;
  /** The GPU ms of the newest frame whose query finished since the last poll; null when none did (or it was disjoint). */
  poll(): number | null;
}

export interface WorldRenderer {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  /**
   * The floating origin (spec §6.8), first at the snapped spawn (`WorldRendererOptions.originAt`, SP4b spec §3.4); the
   * page calls `update` and, on true, `sections.setOrigin`.
   */
  readonly origin: FloatingOrigin;
  readonly sections: SectionRenderer;
  /**
   * Compiles every material behind the loading screen (`renderer.compileAsync`, spec §6.4, §8.4), for every built
   * section whether revealed or not: three compiles only visible objects, and a `BatchedMesh` or region mesh needs its
   * own program variant, so the sections are counted visible for the compile's synchronous walk.
   */
  compile(): Promise<void>;
  /** Sorts the translucent regions from the camera, writes the frame uniforms and renders (inside the GPU timer). */
  frame(state: FrameState): void;
  /**
   * One frame behind the opaque loading overlay (spec §8.4 step 5's three frames): as `frame`, with every built section
   * drawn whether revealed or not and every region unculled (three uploads only what passes culling, SP4b spec §4.5),
   * so its buffers reach the GPU before the reveal; the sections stay hidden and culling is restored after it.
   */
  warmUp(state: FrameState): void;
  /** The live render distance's far plane: `camera.far = cameraFar(rd)`, projection updated (SP4b spec §5). */
  setRenderDistance(rd: number): void;
  /** The GPU memory estimate's parts in bytes (SP4b spec §8.4), written into `out`. */
  gpuEstimate(out: GpuEstimate): GpuEstimate;
  /** The last frame's draw calls and triangles. */
  info(): { calls: number; triangles: number };
  /** The GPU timer, or null without `EXT_disjoint_timer_query_webgl2`; `frame` begins and ends it itself. */
  gpuTimer(): GpuTimer | null;
  /** Calls `fn` on `webglcontextlost`. */
  onContextLost(fn: () => void): void;
  dispose(): void;
}

export interface WorldRendererOptions {
  readonly kind: SectionRendererKind;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  /** Render distance in columns: sets the far plane until `setRenderDistance`. */
  readonly rd: number;
  /** The spawn (or `?at`), in blocks: the first floating origin is it snapped (`firstOrigin`, SP4b spec §3.4). */
  readonly originAt: { readonly x: number; readonly z: number };
  readonly pixelRatioCap: number;
  readonly ao: boolean;
  readonly smoothLight: boolean;
  /** The lightmap's brightness until the first `frame` (spec §6.7). */
  readonly brightness: number;
}

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Queries waiting for their result before `begin` skips a frame. */
const MAX_PENDING_QUERIES = 8;

/**
 * GPU time per frame through `EXT_disjoint_timer_query_webgl2`, or null without it. A disjoint event invalidates every
 * query in flight: `poll` then deletes every pending query, finished or not, and returns null (SP4b spec §4.5).
 */
export function createGpuTimer(gl: WebGL2RenderingContext): (GpuTimer & { dispose(): void }) | null {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  if (ext === null) return null;
  let open: WebGLQuery | null = null;
  const pending: WebGLQuery[] = [];
  return {
    begin() {
      if (open !== null || pending.length >= MAX_PENDING_QUERIES) return;
      open = gl.createQuery();
      if (open !== null) gl.beginQuery(ext.TIME_ELAPSED_EXT, open);
    },
    end() {
      if (open === null) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(open);
      open = null;
    },
    poll() {
      // A disjoint event (a clock change, a context switch) invalidates every query in flight, finished or not: an
      // unfinished one kept would report a meaningless time on a later poll.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean) {
        for (const q of pending) gl.deleteQuery(q);
        pending.length = 0;
        return null;
      }
      let latest: number | null = null;
      while (pending.length > 0) {
        const q = pending[0]!;
        if (!(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean)) break;
        latest = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        gl.deleteQuery(q);
        pending.shift();
      }
      return latest;
    },
    dispose() {
      if (open !== null) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.deleteQuery(open);
        open = null;
      }
      for (const q of pending) gl.deleteQuery(q);
      pending.length = 0;
    },
  };
}

/**
 * Runs `fn` with every hidden object under `root` counted visible, then hides them again, also after a throw: three
 * compiles and draws only visible objects (`compile`, `warmUp`).
 */
export function withSectionsShown<T>(root: Object3D, fn: () => T): T {
  const hidden: Object3D[] = [];
  root.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  try {
    return fn();
  } finally {
    for (const o of hidden) o.visible = false;
  }
}

/**
 * Runs `fn` with frustum culling off on every region object under `root` (each `Mesh`, a `BatchedMesh` included), then
 * restores each object's own flag, also after a throw (SP4b spec §4.5): three uploads an object's buffers only when it
 * passes culling (r186 `WebGLRenderer.js:1913-1915`), so the warm-up draws every region. A region the section renderer
 * keeps unculled for its pending upload (§3.9) stays so.
 */
export function withRegionsUnculled<T>(root: Object3D, fn: () => T): T {
  const culled: Object3D[] = [];
  root.traverse((o) => {
    if ((o as Partial<Mesh>).isMesh === true && o.frustumCulled) {
      culled.push(o);
      o.frustumCulled = false;
    }
  });
  try {
    return fn();
  } finally {
    for (const o of culled) o.frustumCulled = true;
  }
}

/** The GPU memory estimate's parts, in bytes (SP4b spec §8.4); `gpuMB` is their sum / 2^20. */
export interface GpuEstimate {
  /** `SectionRenderer.gpuBytes()`. */
  sectionsBytes: number;
  /** The sky geometry's attribute and index arrays. */
  skyBytes: number;
  /** The texture array: width × height × depth × 4, with every mip level when it has them. */
  textureBytes: number;
  /** The lightmap's data. */
  lightmapBytes: number;
  /** The drawing buffer: canvas width × height × (4 colour + 4 depth-stencil). */
  drawingBufferBytes: number;
}

interface ByteSized {
  readonly array: { readonly byteLength: number };
}

/** The objects `gpuEstimateOf` sizes: structural views of the renderer's own (a test passes fakes). */
export interface GpuEstimateParts {
  readonly sections: { gpuBytes(): number };
  readonly sky: { readonly attributes: Readonly<Record<string, ByteSized>>; readonly index: ByteSized | null };
  readonly textureArray: {
    readonly image: { readonly width: number; readonly height: number; readonly depth: number };
    readonly generateMipmaps: boolean;
    readonly minFilter: number;
  };
  readonly lightmap: { readonly image: { readonly data: { readonly byteLength: number } | null } };
  readonly canvas: { readonly width: number; readonly height: number };
}

/**
 * Each part of the GPU estimate from its object's own sizes (SP4b spec §8.4), written into `out`. three generates a
 * texture's mips only under a mipmap minification filter (`WebGLTextures`' `textureNeedsGenerateMipmaps`).
 */
export function gpuEstimateOf(parts: GpuEstimateParts, out: GpuEstimate): GpuEstimate {
  out.sectionsBytes = parts.sections.gpuBytes();
  let sky = parts.sky.index?.array.byteLength ?? 0;
  for (const name in parts.sky.attributes) sky += parts.sky.attributes[name]!.array.byteLength;
  out.skyBytes = sky;
  const t = parts.textureArray;
  const mips = t.generateMipmaps && t.minFilter !== NearestFilter && t.minFilter !== LinearFilter;
  let w = t.image.width;
  let h = t.image.height;
  let texels = w * h;
  while (mips && (w > 1 || h > 1)) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    texels += w * h;
  }
  out.textureBytes = texels * t.image.depth * 4;
  out.lightmapBytes = parts.lightmap.image.data?.byteLength ?? 0;
  out.drawingBufferBytes = parts.canvas.width * parts.canvas.height * 8;
  return out;
}

/**
 * Releases three's renderer and its WebGL context, then detaches the canvas. `dispose()` alone frees three's resources
 * but keeps the context, and browsers cap live contexts at about 16 (final review B-M4).
 */
export function releaseGl(renderer: Pick<WebGLRenderer, 'dispose' | 'forceContextLoss'>, canvas: { remove(): void }): void {
  renderer.dispose();
  renderer.forceContextLoss();
  canvas.remove();
}

/** The world renderer in `host`, with the section renderer of `o.kind` over its own materials (spec §6.1). */
export function createWorldRenderer(host: HTMLElement, o: WorldRendererOptions): WorldRenderer {
  const albedo = createFlatColorArray();
  const materials = createMaterialSystem({ variant: o.kind, ao: o.ao, smoothLight: o.smoothLight }, albedo);
  let sections: SectionRenderer;
  try {
    sections = createSectionRenderer(o.kind, materials);
  } catch (e) {
    materials.dispose();
    albedo.dispose();
    throw e;
  }
  const sky = createSky(materials);
  const scene = new Scene();
  scene.add(sections.root);
  scene.add(sky);
  // The first floating origin is the snapped spawn (SP4b spec §3.4), before anything is staged.
  const origin = firstOrigin(o.originAt);
  sections.setOrigin(origin.x, origin.y, origin.z);
  // Valid uniforms for `compile` and any frame before the page's first FrameState: the opening time and the load RD's fog.
  materials.setFrameUniforms({ t: OPENING_T, brightness: o.brightness, eyeSky: 15, rd: o.rd, fogBand: MEDIUM.fogBand });

  const renderer = new WebGLRenderer({ antialias: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setOpaqueSort(opaquePassSort(materials));
  const canvas = renderer.domElement;
  // Which section renderer draws (the browser smoke asserts it, SP4b spec §8.6).
  canvas.dataset['renderer'] = o.kind;
  // The canvas fills the host in CSS pixels whatever the drawing-buffer size (`setSize` leaves the style alone), so a
  // pixel ratio under 1 scales the image up instead of shrinking the canvas.
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);

  const camera = new PerspectiveCamera(o.fov, 1, NEAR, cameraFar(o.rd));
  const timer = createGpuTimer(renderer.getContext() as WebGL2RenderingContext);

  const resize = (): void =>
    applyViewport(camera, host.clientWidth, host.clientHeight, window.devicePixelRatio, o.pixelRatioCap,
      (w, h) => renderer.setSize(w, h, false), (r) => renderer.setPixelRatio(r));
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  // A move to a monitor with another devicePixelRatio: the query for the current ratio stops matching.
  let dprQuery: MediaQueryList | null = null;
  const onDprChange = (): void => {
    resize();
    watchDpr();
  };
  const watchDpr = (): void => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`) : null;
    dprQuery?.addEventListener('change', onDprChange);
  };
  watchDpr();
  resize();

  const draw = (state: FrameState): void => {
    // The camera in scene coordinates, relative to the floating origin (ruling P17).
    sections.sortTranslucent(camera.position.x, camera.position.y, camera.position.z);
    materials.setFrameUniforms(state);
    timer?.begin();
    renderer.render(scene, camera);
    timer?.end();
  };

  // The GPU estimate's parts, made once: the bench reads the estimate every frame (SP4b spec §3.10, §8.4).
  const estimateParts: GpuEstimateParts = { sections, sky: sky.geometry, textureArray: albedo, lightmap: materials.lightmap.texture, canvas };

  const lostListeners: Array<() => void> = [];
  const onLost = (): void => {
    for (const fn of lostListeners) fn();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    renderer,
    camera,
    origin,
    sections,
    async compile() {
      // compileAsync walks the scene synchronously (`compile`), then only waits for the programs.
      await withSectionsShown(sections.root, () => renderer.compileAsync(scene, camera));
    },
    frame(state) {
      draw(state);
    },
    warmUp(state) {
      withSectionsShown(sections.root, () => withRegionsUnculled(sections.root, () => draw(state)));
    },
    setRenderDistance(rd) {
      applyRenderDistance(camera, rd);
    },
    gpuEstimate(out) {
      return gpuEstimateOf(estimateParts, out);
    },
    info() {
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
    gpuTimer() {
      return timer;
    },
    onContextLost(fn) {
      lostListeners.push(fn);
    },
    dispose() {
      observer.disconnect();
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = null;
      canvas.removeEventListener('webglcontextlost', onLost);
      lostListeners.length = 0;
      timer?.dispose();
      sections.dispose();
      scene.clear();
      sky.geometry.dispose();
      materials.dispose();
      albedo.dispose();
      // The context-lost listener is already removed, so the forced loss below reaches no handler.
      releaseGl(renderer, canvas);
    },
  };
}

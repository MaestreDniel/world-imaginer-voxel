import { Color, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer, type RenderItem } from 'three';
import { MEDIUM } from '../core/params/graphicsPresets';
import { OPENING_T } from '../daynight/dayNight';
import { createFloatingOrigin } from './floatingOrigin';
import type { FrameState } from './frameState';
import { createMaterialSystem, type MaterialSystem } from './materials/index';
import { createSectionRenderer, type SectionRenderer, type SectionRendererKind } from './sectionRenderer';
import { createSky } from './sky';
import { createFlatColorArray } from './textureArray';

/**
 * The world renderer (SP4a spec §6.1): a `WebGLRenderer` with SP0's defaults (antialias off, pixel ratio
 * min(dpr, pixelRatioCap), output sRGB), a perspective camera (near 0.1, far (RD + 2)·16·1.5), and a scene holding the
 * section renderer's regions (§6.2) and the sky dome (§6.5). It builds the flat-colour array, the material system and
 * the section renderer itself, because the page (`ui`) may not touch `render/materials/`.
 *
 * Pass order (master §4.5): opaque (front side, front to back), the sky dome, cutout (double side, alpha test), then
 * translucent (blended, back to front). The first three share three's opaque list, ordered by `opaquePassSort`; the
 * water is in three's transparent list, which draws after it.
 */

const SKY = 0x87b8e8;

export interface SkyRenderer {
  dispose(): void;
}

/** SP0's sky page; Task 27 removes it with its only caller. */
export function startSkyRenderer(host: HTMLElement, onFrame: (frameMs: number) => void): SkyRenderer {
  const renderer = new WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color(SKY), 1);
  host.appendChild(renderer.domElement);

  const resize = () => renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  let last = performance.now();
  let raf = 0;
  const loop = (now: number) => {
    onFrame(now - last);
    last = now;
    renderer.clear();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// ---------------------------------------------------------------- the world renderer

/** The camera's near plane, in blocks (spec §6.1). */
const NEAR = 0.1;

/** The camera's far plane for render distance `rd`: (rd + 2)·16·1.5 blocks (spec §6.1). */
export function cameraFar(rd: number): number {
  return (rd + 2) * 16 * 1.5;
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
  /** The floating origin (spec §6.8); the page calls `update` and, on true, `sections.setOrigin`. */
  readonly origin: ReturnType<typeof createFloatingOrigin>;
  readonly sections: SectionRenderer;
  /** Compiles every material behind the loading screen (`renderer.compileAsync`, spec §6.4, §8.4). */
  compile(): Promise<void>;
  /** Sorts the translucent regions from the camera, writes the frame uniforms and renders (inside the GPU timer). */
  frame(state: FrameState): void;
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
  /** Render distance in columns: sets the far plane. */
  readonly rd: number;
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

function createGpuTimer(gl: WebGL2RenderingContext): (GpuTimer & { dispose(): void }) | null {
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
      // A disjoint event (a clock change, a context switch) invalidates every query in flight.
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      let latest: number | null = null;
      while (pending.length > 0) {
        const q = pending[0]!;
        if (!(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean)) break;
        if (!disjoint) latest = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        gl.deleteQuery(q);
        pending.shift();
      }
      return disjoint ? null : latest;
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
  // Valid uniforms for `compile` and any frame before the page's first FrameState: the opening time, no edge offset.
  materials.setFrameUniforms({ t: OPENING_T, brightness: o.brightness, eyeSky: 15, rd: o.rd, fogBand: MEDIUM.fogBand, edgeCentre: [0, 0] });

  const renderer = new WebGLRenderer({ antialias: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setOpaqueSort(opaquePassSort(materials));
  const canvas = renderer.domElement;
  // The canvas fills the host in CSS pixels whatever the drawing-buffer size (`setSize` leaves the style alone), so a
  // pixel ratio under 1 scales the image up instead of shrinking the canvas.
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);

  const camera = new PerspectiveCamera(o.fov, 1, NEAR, cameraFar(o.rd));
  const origin = createFloatingOrigin(0, 0, 0);
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
      await renderer.compileAsync(scene, camera);
    },
    frame(state) {
      // The camera in scene coordinates, relative to the floating origin (ruling P17).
      sections.sortTranslucent(camera.position.x, camera.position.y, camera.position.z);
      materials.setFrameUniforms(state);
      timer?.begin();
      renderer.render(scene, camera);
      timer?.end();
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
      renderer.dispose();
      canvas.remove();
    },
  };
}

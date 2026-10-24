import {
  BatchedMesh, Box3, BufferAttribute, BufferGeometry, Color, Matrix4, NearestFilter, OrthographicCamera, PerspectiveCamera,
  RGBAFormat, Scene, Sphere, UnsignedByteType, WebGLRenderer, WebGLRenderTarget, type DataArrayTexture,
} from 'three';
import { MEDIUM } from '../../core/params/graphicsPresets';
import { OPENING_T } from '../../daynight/dayNight';
import { packFluid, packSolid, PACK_LAYOUT } from '../../mesh/packing';
import type { FrameState } from '../frameState';
import { medianInterval, percentile, snapFrameTime } from '../frameTiming';
import { createMaterialSystem, type MaterialSystem } from '../materials/index';
import { createSectionRenderer, type SectionRenderer, type SectionRendererKind, type UploadGate } from '../sectionRenderer';
import { createSky } from '../sky';
import { createFlatColorArray } from '../textureArray';
import { stressPayloads } from './stressScene';

/**
 * The spike's render measurements (SP4a spec §1.2 items 1-5), in the browser, on the stress scene (`stressScene.ts`)
 * through the real attribute path: RegionBatch (or the section renderer `kind` names), materials v1, three's
 * `WebGLRenderer` on a 1920 × 1080 canvas at pixel ratio 1.
 * 1. decode: 1,024 known `data` words drawn as single-pixel quads into a 32 × 32 RGBA8 target with `decodeDebug`,
 *    read back; a pixel counts as a mismatch unless both readbacks (cleared to 0 and to all ones) give its word;
 * 2. static: the camera at (0, 100, 0), pitch −10°, the yaw turning 360° over 600 frames after 120 warm-up frames;
 *    rAF frame times snapped to the display interval (measured first over 120 idle frames), draw calls, main-thread
 *    ms from the callback's start to `render()`'s return;
 * 3. upload: the build's main-thread ms per 1k quads and the first render's ms (buffer upload), projected to RD12;
 * 4. churn (for SP4b, ruling P19): 32 `setGeometryAt` per frame for 120 frames, then 32 deletes, `optimize()`, the
 *    re-adds and `setGeometrySize` × 1.5;
 * 5. noMultiDraw: item 2 again on a context whose `getExtension('WEBGL_multi_draw')` returns null (`maskMultiDraw`),
 *    so three draws a BatchedMesh's instances one by one; without `maskMultiDraw` (the browser lacks the extension
 *    already) item 2 is repeated as it is.
 * Every item catches its own failure into `error`; `runRenderSpike` itself does not reject for a failed item.
 */

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface DecodeResult {
  readonly words: number;
  readonly mismatches: number;
  /** The first few mismatches, for the report. */
  readonly firstMismatches: ReadonlyArray<{ readonly index: number; readonly expected: number; readonly got: number }>;
  readonly error: string | null;
}

export interface StaticResult {
  readonly sectionRenderer: SectionRendererKind;
  /** True when this run's context reported no `WEBGL_multi_draw` because the spike masked it. */
  readonly multiDrawMasked: boolean;
  readonly canvas: { readonly width: number; readonly height: number; readonly pixelRatio: number };
  /** The median rAF delta of 120 idle frames: the display interval the frame times snap to. */
  readonly displayIntervalMs: number;
  readonly frames: number;
  /** Snapped frame times. */
  readonly frame: Percentiles;
  /** Main-thread ms per frame, from the rAF callback's start to `render()`'s return. */
  readonly main: Percentiles;
  /** `renderer.info.render.calls`: the max and the mean over the measured frames. */
  readonly drawCalls: number;
  readonly drawCallsMean: number;
  readonly trianglesMax: number;
  /**
   * Frames over 33 ms (spec §9.5's count), with the first few: measured frame index, its snapped delta, its own main ms
   * and the previous frame's, which ran inside that gap (null for the first frame) (SP4b spec §7.6).
   */
  readonly longFrames: LongFrames;
  readonly error: string | null;
}

/** Long frames: their count and the first 16, each with its own and the previous frame's main-thread ms. */
export interface LongFrames {
  readonly count: number;
  readonly first: ReadonlyArray<{ readonly frame: number; readonly deltaMs: number; readonly mainMs: number; readonly prevMainMs: number | null }>;
}

export interface UploadResult {
  readonly quads: number;
  readonly sections: number;
  /** Main-thread ms of the whole build (`pump`s until nothing is left: geometry wrapping, `addGeometry`, instances, matrices). */
  readonly buildMs: number;
  readonly msPer1kQuads: number;
  /** The first render after `compileAsync`: the buffer upload. */
  readonly firstRenderMs: number;
  /** (plan) ceil((msPer1kQuads·750 + firstRenderMs) / 12) / 60: frames of a 12 ms budget at 60 fps, in seconds. */
  readonly projectedRd12Seconds: number;
  readonly error: string | null;
}

export interface ChurnResult {
  readonly frames: number;
  readonly setGeometryPerFrame: number;
  readonly mainP95: number;
  readonly frameP95: number;
  readonly deleted: number;
  /** `optimize()` per BatchedMesh that had a delete: its ms and its buffers' MB (position, data and index). */
  readonly optimize: ReadonlyArray<{ readonly rx: number; readonly rz: number; readonly pass: number; readonly ms: number; readonly mb: number }>;
  readonly readdMs: number;
  readonly setGeometrySizeMs: number;
  readonly error: string | null;
}

export interface RenderSpikeResult {
  readonly scene: { readonly columns: number; readonly sections: number; readonly quads: number; readonly regions: number };
  readonly decode: DecodeResult;
  readonly static: StaticResult;
  readonly upload: UploadResult;
  readonly churn: ChurnResult;
  readonly noMultiDraw: StaticResult;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const IDLE_FRAMES = 120;
const WARM_FRAMES = 120;
const MEASURED_FRAMES = 600;
const CHURN_FRAMES = 120;
const CHURN_SECTIONS = 32;
const DECODE_SIDE = 32;
const RD = 12;
const PITCH_DEG = -10;
const DEG = Math.PI / 180;
const MIB = 1 << 20;
/** The loading screen's upload budget per frame (spec §6.2) and RD12's quads in thousands (spec §1.1). */
const UPLOAD_BUDGET_MS = 12;
const RD12_KQUADS = 750;
/** Both contexts get the attributes three would ask for, so the masked one differs only by the extension. */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
  powerPreference: 'default', failIfMajorPerformanceCaveat: false,
};
/** The frame the materials see: the opening 08:00, full eye light, RD12's fog (spec §6.6). */
const FRAME: FrameState = { t: OPENING_T, brightness: 0.5, eyeSky: 15, rd: RD, fogBand: MEDIUM.fogBand, edgeCentre: [0, 0] };

const text = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const stats = (values: ArrayLike<number>): Percentiles => {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]!);
  return { p50: percentile(values, 50), p95: percentile(values, 95), max: values.length === 0 ? Number.NaN : max };
};
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Calls `onFrame(i, now)` in `n` consecutive rAF callbacks; rejects with the first throw. */
function runFrames(n: number, onFrame: (i: number, now: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = (now: number): void => {
      try {
        onFrame(i, now);
      } catch (e) {
        reject(e);
        return;
      }
      if (++i >= n) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The display interval: the median rAF delta over IDLE_FRAMES frames that render nothing. */
async function displayInterval(): Promise<number> {
  const deltas: number[] = [];
  let prev = Number.NaN;
  await runFrames(IDLE_FRAMES + 1, (i, now) => {
    if (i > 0) deltas.push(now - prev);
    prev = now;
  });
  return medianInterval(deltas);
}

interface Gl {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  /** The extension was masked and three sees no multi-draw. */
  readonly masked: boolean;
  dispose(): void;
}

/** A 1920 × 1080 canvas at pixel ratio 1 in `host`, with a webgl2 context (multi-draw masked when `mask`). */
function createGl(host: HTMLElement, mask: boolean): Gl {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px;display:block`;
  host.appendChild(canvas);
  const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  if (gl === null) {
    canvas.remove();
    throw new Error('no webgl2 context');
  }
  if (mask) {
    // The wrapper of spec §1.2 item 5: this context answers null for WEBGL_multi_draw and as before for the rest.
    const get = gl.getExtension.bind(gl) as (name: string) => unknown;
    Object.defineProperty(gl, 'getExtension', { value: (name: string) => (name === 'WEBGL_multi_draw' ? null : get(name)), configurable: true });
  }
  const renderer = new WebGLRenderer({ canvas, context: gl, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  return {
    canvas,
    renderer,
    masked: mask && !renderer.extensions.has('WEBGL_multi_draw'),
    dispose() {
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------- 1. decode

/** 1,024 known words: 0, all ones, each field of both variants at its maximum, then a hash covering all 32 bits. */
export function decodeWords(): Uint32Array {
  const words = new Uint32Array(DECODE_SIDE * DECODE_SIDE);
  const known: number[] = [0, 0xffffffff];
  const zeroSolid = { layer: 0, face: 0, ao: 0, sky: 0, block: 0, tint: 0, flags: 0 };
  const zeroFluid = { layer: 0, face: 0, sky: 0, block: 0, depth: 0, tint: 0, cornerDrop: 0 };
  for (const [k, f] of Object.entries(PACK_LAYOUT.solid)) known.push(packSolid({ ...zeroSolid, [k]: 2 ** f.bits - 1 }));
  for (const [k, f] of Object.entries(PACK_LAYOUT.fluid)) known.push(packFluid({ ...zeroFluid, [k]: 2 ** f.bits - 1 }));
  for (let i = 0; i < words.length; i++) {
    words[i] = i < known.length ? known[i]! : (Math.imul(i, 0x9e3779b1) ^ Math.imul(i >>> 3, 0x85ebca6b) ^ (i << 21)) >>> 0;
  }
  return words;
}

function runDecode(renderer: WebGLRenderer, albedo: DataArrayTexture): DecodeResult {
  const words = decodeWords();
  const n = words.length;
  const position = new Uint8Array(16 * n);
  const data = new Uint32Array(4 * n);
  const index = new Uint32Array(6 * n);
  for (let k = 0; k < n; k++) {
    const x = k % DECODE_SIDE;
    const y = Math.floor(k / DECODE_SIDE);
    position.set([x, y, 0, 0, x + 1, y, 0, 0, x + 1, y + 1, 0, 0, x, y + 1, 0, 0], 16 * k);
    data.fill(words[k]!, 4 * k, 4 * k + 4);
    index.set([4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3], 6 * k);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 4));
  g.setAttribute('data', new BufferAttribute(data, 1));
  g.setIndex(new BufferAttribute(index, 1));
  const materials = createMaterialSystem({ variant: 'batch', ao: false, smoothLight: false }, albedo);
  const mesh = new BatchedMesh(1, 4 * n, 6 * n, materials.decodeDebug);
  mesh.addInstance(mesh.addGeometry(g));
  mesh.frustumCulled = false;
  mesh.perObjectFrustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  const camera = new OrthographicCamera(0, DECODE_SIDE, DECODE_SIDE, 0, 0.1, 10);
  camera.position.z = 1;
  const target = new WebGLRenderTarget(DECODE_SIDE, DECODE_SIDE, {
    type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false,
  });
  const clearColor = renderer.getClearColor(new Color());
  const clearAlpha = renderer.getClearAlpha();
  const read = (clear: 0 | 1): Uint8Array => {
    const out = new Uint8Array(4 * n);
    renderer.setRenderTarget(target);
    renderer.setClearColor(new Color(clear, clear, clear), clear);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, DECODE_SIDE, DECODE_SIDE, out);
    return out;
  };
  try {
    const reads = [read(0), read(1)];
    let mismatches = 0;
    const firstMismatches: Array<{ index: number; expected: number; got: number }> = [];
    for (let k = 0; k < n; k++) {
      // Pixel (x, y) of word k sits at row y from the bottom, the order readPixels returns.
      for (const bytes of reads) {
        const got = (bytes[4 * k]! | (bytes[4 * k + 1]! << 8) | (bytes[4 * k + 2]! << 16) | (bytes[4 * k + 3]! << 24)) >>> 0;
        if (got !== words[k]) {
          mismatches++;
          if (firstMismatches.length < 8) firstMismatches.push({ index: k, expected: words[k]!, got });
          break;
        }
      }
    }
    return { words: n, mismatches, firstMismatches, error: null };
  } finally {
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor, clearAlpha);
    target.dispose();
    mesh.dispose();
    g.dispose();
    materials.dispose();
  }
}

// ---------------------------------------------------------------- the scene

interface Built {
  readonly scene: Scene;
  readonly sections: SectionRenderer;
  readonly materials: MaterialSystem;
  readonly buildMs: number;
  dispose(): void;
}

/** No row cap and every structural operation granted: the spike builds its whole scene at once. */
const UNBOUNDED: UploadGate = { exhausted: () => false, spend() {}, structural: () => true };

/**
 * The stress scene staged, uploaded (timed: `pump` under an unbounded gate until nothing is left) and revealed in a
 * section renderer of `kind`, with the sky (SP4b spec §4.1: the spike on the streaming interface).
 */
function buildScene(kind: SectionRendererKind, albedo: DataArrayTexture, payloads: ReturnType<typeof stressPayloads>): Built {
  const materials = createMaterialSystem({ variant: kind, ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight }, albedo);
  let sections: SectionRenderer;
  try {
    sections = createSectionRenderer(kind, materials);
  } catch (e) {
    materials.dispose();
    throw e;
  }
  sections.holdReveals(true);
  for (const p of payloads) sections.stage(p, 1);
  const t0 = performance.now();
  while (sections.pump(UNBOUNDED, 0, 0, 0) > 0);
  const buildMs = performance.now() - t0;
  sections.revealAll();
  const scene = new Scene();
  scene.add(sections.root);
  // The world renderer's sky dome (render/sky.ts); the water draws in three's transparent list, after it.
  const sky = createSky(materials);
  scene.add(sky);
  materials.setFrameUniforms(FRAME);
  return {
    scene,
    sections,
    materials,
    buildMs,
    dispose() {
      sections.dispose();
      sky.geometry.dispose();
      materials.dispose();
    },
  };
}

function spikeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, WIDTH / HEIGHT, 0.1, (RD + 2) * 16 * 1.5);
  camera.position.set(0, 100, 0);
  aim(camera, 0);
  return camera;
}

/** Yaw 0 faces −z, yaw 90 faces +x; pitch positive upward (ruling P42). */
function aim(camera: PerspectiveCamera, yawDeg: number): void {
  camera.rotation.set(PITCH_DEG * DEG, -yawDeg * DEG, 0, 'YXZ');
}

function renderFrame(gl: Gl, b: Built, camera: PerspectiveCamera): void {
  b.materials.setFrameUniforms(FRAME);
  b.sections.sortTranslucent(camera.position.x, camera.position.y, camera.position.z);
  gl.renderer.render(b.scene, camera);
}

// ---------------------------------------------------------------- 2 and 5. static

async function runStatic(gl: Gl, b: Built, kind: SectionRendererKind, interval: number): Promise<StaticResult> {
  const camera = spikeCamera();
  const frame = new Float64Array(MEASURED_FRAMES);
  const main = new Float64Array(MEASURED_FRAMES);
  const calls = new Float64Array(MEASURED_FRAMES);
  let triangles = 0;
  let prev = Number.NaN;
  await runFrames(WARM_FRAMES + MEASURED_FRAMES, (i, now) => {
    const t0 = performance.now();
    const m = i - WARM_FRAMES;
    aim(camera, m >= 0 ? (360 * m) / MEASURED_FRAMES : 0);
    renderFrame(gl, b, camera);
    const t1 = performance.now();
    if (m >= 0) {
      frame[m] = snapFrameTime(now - prev, interval);
      main[m] = t1 - t0;
      calls[m] = gl.renderer.info.render.calls;
      triangles = Math.max(triangles, gl.renderer.info.render.triangles);
    }
    prev = now;
  });
  const callStats = stats(calls);
  return {
    sectionRenderer: kind,
    multiDrawMasked: gl.masked,
    canvas: { width: gl.canvas.width, height: gl.canvas.height, pixelRatio: gl.renderer.getPixelRatio() },
    displayIntervalMs: round3(interval),
    frames: MEASURED_FRAMES,
    frame: stats(frame),
    main: stats(main),
    drawCalls: callStats.max,
    drawCallsMean: calls.reduce((a, c) => a + c, 0) / MEASURED_FRAMES,
    trianglesMax: triangles,
    longFrames: longFrames(frame, main),
    error: null,
  };
}

/** Spec §9.5's long frame: over 33 ms. */
const LONG_FRAME_MS = 33;

/**
 * The frames whose snapped delta is over 33 ms. The delta of frame i is the gap from frame i − 1's callback to frame
 * i's, in which frame i − 1's work ran, so each entry carries both main times (SP4b spec §7.6: SP4a paired the gap with
 * frame i's alone).
 */
export function longFrames(frame: ArrayLike<number>, main: ArrayLike<number>): LongFrames {
  const first: Array<LongFrames['first'][number]> = [];
  let count = 0;
  for (let i = 0; i < frame.length; i++) {
    const ms = frame[i]!;
    if (ms <= LONG_FRAME_MS) continue;
    count++;
    if (first.length < 16) first.push({ frame: i, deltaMs: round3(ms), mainMs: round3(main[i]!), prevMainMs: i > 0 ? round3(main[i - 1]!) : null });
  }
  return { count, first };
}

const failedStatic = (kind: SectionRendererKind, masked: boolean, interval: number, error: string): StaticResult => ({
  sectionRenderer: kind, multiDrawMasked: masked, canvas: { width: WIDTH, height: HEIGHT, pixelRatio: 1 }, displayIntervalMs: round3(interval),
  frames: 0, frame: { p50: Number.NaN, p95: Number.NaN, max: Number.NaN }, main: { p50: Number.NaN, p95: Number.NaN, max: Number.NaN },
  drawCalls: Number.NaN, drawCallsMean: Number.NaN, trianglesMax: Number.NaN, longFrames: { count: 0, first: [] }, error,
});

// ---------------------------------------------------------------- 4. churn

function batchesOf(b: Built): BatchedMesh[] {
  const out: BatchedMesh[] = [];
  b.sections.root.traverse((o) => {
    if ((o as BatchedMesh).isBatchedMesh) out.push(o as BatchedMesh);
  });
  return out;
}

/** A copy of geometry `id` of `mesh`, as it was added: its own vertices, indices relative to it, and its bounds. */
function ownGeometry(mesh: BatchedMesh, id: number): BufferGeometry {
  const range = mesh.getGeometryRangeAt(id);
  if (range === null) throw new Error(`no geometry ${id} in ${mesh.name}`);
  const src = mesh.geometry;
  const pos = src.getAttribute('position').array as Uint8Array;
  const data = src.getAttribute('data').array as Uint32Array;
  const idx = src.getIndex()!.array as Uint32Array;
  const index = idx.slice(range.indexStart, range.indexStart + range.indexCount);
  for (let i = 0; i < index.length; i++) index[i] = index[i]! - range.vertexStart;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos.slice(4 * range.vertexStart, 4 * (range.vertexStart + range.vertexCount)), 4));
  g.setAttribute('data', new BufferAttribute(data.slice(range.vertexStart, range.vertexStart + range.vertexCount), 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.boundingSphere = mesh.getBoundingSphereAt(id, new Sphere());
  g.boundingBox = mesh.getBoundingBoxAt(id, new Box3());
  return g;
}

async function runChurn(gl: Gl, b: Built, interval: number): Promise<ChurnResult> {
  const batches = batchesOf(b);
  if (batches.length === 0) throw new Error(`churn needs RegionBatch's BatchedMesh; the '${b.sections.kind}' renderer has none`);
  const camera = spikeCamera();
  // 1. 32 setGeometryAt per frame, each section with its own geometry, round-robin over every section.
  const all: Array<{ mesh: BatchedMesh; id: number }> = [];
  for (const mesh of batches) for (let id = 0; id < mesh.instanceCount; id++) all.push({ mesh, id });
  const needed = Math.min(all.length, CHURN_FRAMES * CHURN_SECTIONS);
  const own = all.slice(0, needed).map(({ mesh, id }) => ownGeometry(mesh, id));
  const main = new Float64Array(CHURN_FRAMES);
  const frame = new Float64Array(CHURN_FRAMES);
  let prev = Number.NaN;
  let next = 0;
  await runFrames(CHURN_FRAMES + 1, (i, now) => {
    const t0 = performance.now();
    if (i > 0) {
      for (let k = 0; k < CHURN_SECTIONS; k++, next++) {
        const s = next % needed;
        all[s]!.mesh.setGeometryAt(all[s]!.id, own[s]!);
      }
    }
    renderFrame(gl, b, camera);
    if (i > 0) {
      main[i - 1] = performance.now() - t0;
      frame[i - 1] = snapFrameTime(now - prev, interval);
    }
    prev = now;
  });
  for (const g of own) g.dispose();
  // 2. 32 deletes in the largest batch, keeping each section's geometry and matrix for the re-add.
  const mesh = batches.reduce((a, c) => (c.instanceCount > a.instanceCount ? c : a));
  const deleted = Math.min(CHURN_SECTIONS, mesh.instanceCount);
  const kept: Array<{ g: BufferGeometry; m: Matrix4 }> = [];
  for (let id = 0; id < deleted; id++) {
    kept.push({ g: ownGeometry(mesh, id), m: mesh.getMatrixAt(id, new Matrix4()) });
    mesh.deleteGeometry(id);
  }
  // 3. optimize() compacts; MB is the batch's position, data and index buffers.
  const bytes = (): number => {
    const geo = mesh.geometry;
    return geo.getAttribute('position').array.byteLength + geo.getAttribute('data').array.byteLength + geo.getIndex()!.array.byteLength;
  };
  let t0 = performance.now();
  mesh.optimize();
  const optimizeMs = performance.now() - t0;
  // 4. The re-adds into the room optimize() made: bounds are already on each geometry (ownGeometry).
  t0 = performance.now();
  for (const { g, m } of kept) mesh.setMatrixAt(mesh.addInstance(mesh.addGeometry(g)), m);
  const readdMs = performance.now() - t0;
  // 5. setGeometrySize × 1.5.
  const geo = mesh.geometry;
  t0 = performance.now();
  mesh.setGeometrySize(Math.ceil(geo.getAttribute('position').count * 1.5), Math.ceil(geo.getIndex()!.count * 1.5));
  const setGeometrySizeMs = performance.now() - t0;
  for (const { g } of kept) g.dispose();
  renderFrame(gl, b, camera);
  return {
    frames: CHURN_FRAMES,
    setGeometryPerFrame: CHURN_SECTIONS,
    mainP95: percentile(main, 95),
    frameP95: percentile(frame, 95),
    deleted,
    optimize: [{
      rx: mesh.userData['rx'] as number, rz: mesh.userData['rz'] as number, pass: mesh.userData['pass'] as number,
      ms: optimizeMs, mb: round3(bytes() / MIB),
    }],
    readdMs,
    setGeometrySizeMs,
    error: null,
  };
}

const failedChurn = (error: string): ChurnResult => ({
  frames: 0, setGeometryPerFrame: CHURN_SECTIONS, mainP95: Number.NaN, frameP95: Number.NaN, deleted: 0, optimize: [], readdMs: Number.NaN,
  setGeometrySizeMs: Number.NaN, error,
});

// ---------------------------------------------------------------- the run

/**
 * Runs items 1-5 in `host` (a page-sized element; the canvases are fixed at its top left) with the section renderer
 * `kind`; `maskMultiDraw` masks `WEBGL_multi_draw` for item 5 (true where the browser has the extension).
 */
export async function runRenderSpike(host: HTMLElement, o: { readonly kind: SectionRendererKind; readonly maskMultiDraw: boolean }): Promise<RenderSpikeResult> {
  const payloads = stressPayloads();
  const quads = payloads.reduce((n, p) => n + p.index.length / 6, 0);
  const rows = payloads.reduce((n, p) => n + p.rows.length / 6, 0);
  const regions = new Set(payloads.map((p) => `${p.cx >> 3},${p.cz >> 3}`)).size;
  const albedo = createFlatColorArray();
  const interval = await displayInterval();

  let decode: DecodeResult = { words: 0, mismatches: 0, firstMismatches: [], error: 'not run' };
  let stat = failedStatic(o.kind, false, interval, 'not run');
  let upload: UploadResult = { quads, sections: rows, buildMs: Number.NaN, msPer1kQuads: Number.NaN, firstRenderMs: Number.NaN, projectedRd12Seconds: Number.NaN, error: 'not run' };
  let churn = failedChurn('not run');
  let gl: Gl | null = null;
  try {
    gl = createGl(host, false);
    try {
      decode = runDecode(gl.renderer, albedo);
    } catch (e) {
      decode = { words: 0, mismatches: 0, firstMismatches: [], error: text(e) };
    }
    let built: Built | null = null;
    try {
      built = buildScene(o.kind, albedo, payloads);
      const camera = spikeCamera();
      await gl.renderer.compileAsync(built.scene, camera);
      const t0 = performance.now();
      renderFrame(gl, built, camera);
      const firstRenderMs = performance.now() - t0;
      const msPer1kQuads = built.buildMs / (quads / 1000);
      upload = {
        quads, sections: rows, buildMs: built.buildMs, msPer1kQuads, firstRenderMs,
        projectedRd12Seconds: Math.ceil((msPer1kQuads * RD12_KQUADS + firstRenderMs) / UPLOAD_BUDGET_MS) / 60, error: null,
      };
      stat = await runStatic(gl, built, o.kind, interval);
      try {
        churn = await runChurn(gl, built, interval);
      } catch (e) {
        churn = failedChurn(text(e));
      }
    } catch (e) {
      const error = text(e);
      if (stat.error !== null) stat = failedStatic(o.kind, gl.masked, interval, error);
      if (upload.error !== null) upload = { ...upload, error };
      if (churn.error !== null) churn = failedChurn(error);
    } finally {
      built?.dispose();
    }
  } catch (e) {
    const error = text(e);
    decode = { ...decode, error: decode.error === 'not run' ? error : decode.error };
    stat = failedStatic(o.kind, false, interval, error);
    upload = { ...upload, error };
    churn = failedChurn(error);
  } finally {
    gl?.dispose();
  }

  let noMultiDraw: StaticResult;
  let masked: Gl | null = null;
  let built: Built | null = null;
  try {
    masked = createGl(host, o.maskMultiDraw);
    built = buildScene(o.kind, albedo, payloads);
    await masked.renderer.compileAsync(built.scene, spikeCamera());
    noMultiDraw = await runStatic(masked, built, o.kind, interval);
  } catch (e) {
    noMultiDraw = failedStatic(o.kind, masked?.masked ?? false, interval, text(e));
  } finally {
    built?.dispose();
    masked?.dispose();
    albedo.dispose();
  }
  return { scene: { columns: payloads.length, sections: rows, quads, regions }, decode, static: stat, upload, churn, noMultiDraw };
}

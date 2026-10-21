import { DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES } from '../world/store/pool';
import type { CapabilityReport, StoreReservation, WorkerProbe } from './capabilityRules';

const WORKER_TIMEOUT_MS = 5000;
/** The growable-SAB probe's maximum and its one growth. */
const GROW_PROBE_MAX = 1 << 20;
const GROW_PROBE_STEP = 1 << 16;
/** The smallest block-pool reservation tried (192 MiB; its byte pool is 128 MiB). */
const MIN_RESERVATION_BLOCK_BYTES = DEFAULT_MAX_BLOCK_BYTES / 4;

/**
 * Whether a `SharedArrayBuffer` is growable (SP4a spec §8.5): `new SharedArrayBuffer(0, {maxByteLength})` reports
 * `growable` and grows once. A browser that ignores the options returns a fixed buffer, which reads as false.
 */
export function probeGrowableSab(): boolean {
  if (typeof SharedArrayBuffer !== 'function') return false;
  try {
    const sab = new SharedArrayBuffer(0, { maxByteLength: GROW_PROBE_MAX });
    if (sab.growable !== true) return false;
    sab.grow(GROW_PROBE_STEP);
    return sab.byteLength === GROW_PROBE_STEP;
  } catch {
    return false;
  }
}

/**
 * The store reservation (SP4a spec §8.5, D4): the store's default maxima (768, 512) MiB, then halves, down to
 * (192, 128) MiB. A reservation is accepted when both growable buffers construct; they are dropped at once (the store
 * builds its own with these maxima). null when even the smallest is refused.
 */
export function probeStoreReservation(): StoreReservation | null {
  if (typeof SharedArrayBuffer !== 'function') return null;
  for (let blockBytes = DEFAULT_MAX_BLOCK_BYTES, byteBytes = DEFAULT_MAX_BYTE_BYTES; blockBytes >= MIN_RESERVATION_BLOCK_BYTES; blockBytes /= 2, byteBytes /= 2) {
    try {
      new SharedArrayBuffer(0, { maxByteLength: blockBytes });
      new SharedArrayBuffer(0, { maxByteLength: byteBytes });
      return { blockBytes, byteBytes };
    } catch {
      // Refused (RangeError): try the next half.
    }
  }
  return null;
}

interface WorkerResult {
  workerProbe: WorkerProbe;
  workerIsolated: boolean | null;
  sabShared: boolean;
}

function probeWorker(): Promise<WorkerResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/probe.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
      return;
    }
    const sab = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(8) : null;
    const view = sab === null ? null : new Int32Array(sab);
    let done = false;
    const finish = (result: WorkerResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ workerProbe: 'timeout', workerIsolated: null, sabShared: false }), WORKER_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{ isolated: boolean }>) => {
      const isolated = event.data.isolated;
      finish({ workerProbe: isolated ? 'ok' : 'not-isolated', workerIsolated: isolated, sabShared: view !== null && Atomics.load(view, 0) === 42 });
    };
    worker.onerror = () => finish({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
    worker.onmessageerror = () => finish({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
    try {
      worker.postMessage({ sab });
    } catch {
      // DataCloneError: some browsers throw synchronously instead of firing messageerror.
      finish({ workerProbe: 'load-error', workerIsolated: null, sabShared: false });
    }
  });
}

type GlResult = Pick<CapabilityReport, 'webgl2' | 'multiDraw' | 'timerQuery' | 'maxArrayTextureLayers' | 'maxTextureSize' | 'renderer' | 'vendor'>;

function probeWebgl(): GlResult {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl === null) {
    return { webgl2: false, multiDraw: false, timerQuery: false, maxArrayTextureLayers: null, maxTextureSize: null, renderer: null, vendor: null };
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const result: GlResult = {
    webgl2: true,
    multiDraw: gl.getExtension('WEBGL_multi_draw') !== null,
    timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return result;
}

export async function probeCapabilities(): Promise<CapabilityReport> {
  const worker = await probeWorker();
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    secureContext: isSecureContext,
    pageIsolated: crossOriginIsolated,
    ...worker,
    growableSab: probeGrowableSab(),
    reservation: probeStoreReservation(),
    ...probeWebgl(),
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
  };
}

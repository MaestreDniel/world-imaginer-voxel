import type { CapabilityReport, WorkerProbe } from './capabilityRules';

const WORKER_TIMEOUT_MS = 5000;

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
    worker.postMessage({ sab });
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
    ...probeWebgl(),
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
  };
}

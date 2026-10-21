export type WorkerProbe = 'ok' | 'not-isolated' | 'load-error' | 'timeout';

export interface CapabilityReport {
  secureContext: boolean;
  pageIsolated: boolean;
  workerProbe: WorkerProbe;
  /** null unless the worker replied. */
  workerIsolated: boolean | null;
  sabShared: boolean;
  /** `new SharedArrayBuffer(0, {maxByteLength})` is growable and grows once (SP4a spec §8.5). */
  growableSab: boolean;
  /**
   * The largest store reservation the browser accepted: (768, 512) MiB, then halves, down to (192, 128) MiB of block
   * and byte pool maxima; null when even the smallest was refused (SP4a spec §8.5).
   */
  reservation: StoreReservation | null;
  webgl2: boolean;
  multiDraw: boolean;
  timerQuery: boolean;
  maxArrayTextureLayers: number | null;
  maxTextureSize: number | null;
  renderer: string | null;
  vendor: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
}

/** The block and byte pools' maxima, in bytes (`createStore`'s `maxBlockBytes` and `maxByteBytes`). */
export interface StoreReservation {
  blockBytes: number;
  byteBytes: number;
}

export type CauseCode =
  | 'insecure-context' | 'page-not-isolated' | 'worker-not-isolated' | 'worker-load-error' | 'worker-timeout'
  | 'sab-not-shared' | 'no-webgl2' | 'no-growable-sab' | 'no-reservation' | 'no-multi-draw' | 'no-timer-query';

export interface Cause {
  code: CauseCode;
  message: string;
}

export interface Evaluation {
  ok: boolean;
  blocking: Cause[];
  warnings: Cause[];
}

const MESSAGES: Record<CauseCode, string> = {
  'insecure-context': 'Not a secure context: open the app via http://localhost:<port> or HTTPS.',
  'page-not-isolated': 'The page is not cross-origin isolated: the COOP/COEP headers are missing on the page.',
  'worker-not-isolated': 'Worker scripts are missing the COOP/COEP headers.',
  'worker-load-error': 'The worker script failed to load (see the browser console).',
  'worker-timeout': 'The worker did not answer within 5 s.',
  'sab-not-shared': 'SharedArrayBuffer is not shared between the page and its workers.',
  'no-webgl2': 'WebGL2 is not available in this browser.',
  'no-growable-sab': 'SharedArrayBuffer cannot grow (new SharedArrayBuffer(0, {maxByteLength}) failed): the 3D world needs a growable shared store.',
  'no-reservation': 'The browser refused even the smallest store reservation (192 MiB of blocks, 128 MiB of bytes): the 3D world cannot create its store.',
  'no-multi-draw': 'WEBGL_multi_draw is missing: the world renders through the per-region path (RegionMesh)',
  'no-timer-query': 'GPU time unavailable; frame timing is CPU-side only',
};

const WORKER_CAUSE: Record<Exclude<WorkerProbe, 'ok'>, CauseCode> = {
  'not-isolated': 'worker-not-isolated',
  'load-error': 'worker-load-error',
  timeout: 'worker-timeout',
};

const cause = (code: CauseCode): Cause => ({ code, message: MESSAGES[code] });

/** The base rules (today's boot page): isolation, a shared SAB and WebGL2 block; missing extensions only warn. */
export function evaluateCapabilities(report: CapabilityReport): Evaluation {
  const { blocking, warnings } = causesOf(report);
  return { ok: blocking.length === 0, blocking: blocking.map(cause), warnings: warnings.map(cause) };
}

/**
 * The 3D page's rules (SP4a spec §8.5, D23): today's blocking causes, then a SharedArrayBuffer that cannot grow and a
 * refused store reservation (even at 192/128 MiB). A reduced reservation does not block; it caps the render distance
 * (`renderDistance.ts`). The warnings are today's.
 */
export function evaluateWorldCapabilities(report: CapabilityReport): Evaluation {
  const { blocking, warnings } = causesOf(report);
  if (!report.growableSab) blocking.push('no-growable-sab');
  if (report.reservation === null) blocking.push('no-reservation');
  return { ok: blocking.length === 0, blocking: blocking.map(cause), warnings: warnings.map(cause) };
}

function causesOf(report: CapabilityReport): { blocking: CauseCode[]; warnings: CauseCode[] } {
  const blocking: CauseCode[] = [];
  const warnings: CauseCode[] = [];
  if (!report.secureContext) blocking.push('insecure-context');
  if (!report.pageIsolated) blocking.push('page-not-isolated');
  if (report.workerProbe !== 'ok') blocking.push(WORKER_CAUSE[report.workerProbe]);
  if (!report.sabShared) blocking.push('sab-not-shared');
  if (!report.webgl2) blocking.push('no-webgl2');
  else {
    if (!report.multiDraw) warnings.push('no-multi-draw');
    if (!report.timerQuery) warnings.push('no-timer-query');
  }
  return { blocking, warnings };
}

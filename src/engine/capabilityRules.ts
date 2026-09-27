export type WorkerProbe = 'ok' | 'not-isolated' | 'load-error' | 'timeout';

export interface CapabilityReport {
  secureContext: boolean;
  pageIsolated: boolean;
  workerProbe: WorkerProbe;
  /** null unless the worker replied. */
  workerIsolated: boolean | null;
  sabShared: boolean;
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

export type CauseCode =
  | 'insecure-context' | 'page-not-isolated' | 'worker-not-isolated' | 'worker-load-error' | 'worker-timeout'
  | 'sab-not-shared' | 'no-webgl2' | 'no-multi-draw' | 'no-timer-query';

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
  'no-multi-draw': 'WEBGL_multi_draw is missing: rendering will use the per-region fallback (SP4).',
  'no-timer-query': 'EXT_disjoint_timer_query_webgl2 is missing: GPU timings are unavailable.',
};

const WORKER_CAUSE: Record<Exclude<WorkerProbe, 'ok'>, CauseCode> = {
  'not-isolated': 'worker-not-isolated',
  'load-error': 'worker-load-error',
  timeout: 'worker-timeout',
};

export function evaluateCapabilities(report: CapabilityReport): Evaluation {
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
  const cause = (code: CauseCode): Cause => ({ code, message: MESSAGES[code] });
  return { ok: blocking.length === 0, blocking: blocking.map(cause), warnings: warnings.map(cause) };
}

/** SP1 bench gates (SP1 spec §7.5). Outside THRESHOLDS in SP1; changing them requires a spec amendment. */
export const P1_MAX_REGRESSION = 1.3;
export const KILL_RATIO_MAX = 1.6;
/** P1 column-stage budget (master §3.0): buildColumnSample p50 / p95 in ms on the reference machine (SP2a; p95 gated through p99). */
export const COLUMN_P50_MAX_MS = 0.7;
export const COLUMN_P95_MAX_MS = 1.2;

export interface BenchKernel {
  readonly nsPerEval: number;
  /** nsPerEval ÷ the calibration kernel's nsPerEval, measured in the same run. */
  readonly ratio: number;
}

export interface Baselines {
  readonly machine: string;
  readonly node: string;
  readonly date: string;
  readonly kernels: Readonly<Record<string, BenchKernel>>;
  readonly killRatio: number;
}

export function gateFailures(baseline: Baselines | null, kernels: Readonly<Record<string, BenchKernel>>, killRatio: number): string[] {
  const out: string[] = [];
  if (killRatio > KILL_RATIO_MAX) out.push(`kill criterion: lattice3/perm512 = ${killRatio.toFixed(3)} > ${KILL_RATIO_MAX}`);
  if (baseline !== null) {
    for (const [name, k] of Object.entries(kernels)) {
      const b = baseline.kernels[name];
      if (b === undefined) continue;
      if (k.ratio > b.ratio * P1_MAX_REGRESSION) out.push(`${name}: ratio ${k.ratio.toFixed(3)} > ${P1_MAX_REGRESSION} × baseline ${b.ratio.toFixed(3)}`);
    }
  }
  return out;
}

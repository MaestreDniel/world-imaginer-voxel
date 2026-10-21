import type { StoreSpikeResult } from '../../engine/spikeStore';
import type { RenderSpikeResult } from '../../render/spike/spikeBench';

/**
 * The spike's pass and fail (SP4a spec §1.3). `basicPass` is what every cell must meet: item 1 with no decode
 * mismatch and item 6 (the store) with no error and every read exact. `gatePass` is the gate machine's (Chrome on
 * the Iris Xe): basicPass, and item 2 with p95 ≤ 16.7 ms, ≤ 100 draw calls and main-thread p95 ≤ 3 ms, and item 3
 * projecting RD12's uploads to ≤ 2 s at ≤ 12 ms per frame. Items 4 and 5 are recorded for SP4b, never judged.
 */

/** What the verdict reads of the spike page's result. */
export interface SpikeResult {
  readonly items: Pick<RenderSpikeResult, 'decode' | 'static' | 'upload'>;
  readonly store: StoreSpikeResult;
}

export interface SpikeVerdict {
  readonly gatePass: boolean;
  readonly basicPass: boolean;
  /** One line per failed criterion, naming it and its value. */
  readonly failures: string[];
}

/** Spec §1.3's frame and upload limits on the gate machine. */
export const SPIKE_GATE = Object.freeze({ staticP95Ms: 16.7, drawCalls: 100, mainP95Ms: 3, projectedRd12Seconds: 2 });

export function spikeVerdict(r: SpikeResult): SpikeVerdict {
  const basic: string[] = [];
  const gate: string[] = [];
  const { decode, static: s, upload } = r.items;
  if (decode.error !== null) basic.push(`decode did not run: ${decode.error}`);
  else if (decode.mismatches !== 0) basic.push(`decode mismatches ${decode.mismatches} of ${decode.words} (expected 0)`);
  if (r.store.errors.length > 0) basic.push(`store errors (${r.store.errors.length}): ${r.store.errors.slice(0, 3).join('; ')}`);
  else if (r.store.crossReadsOk !== r.store.crossReadsTotal || r.store.crossReadsTotal === 0) {
    basic.push(`store reads ${r.store.crossReadsOk} of ${r.store.crossReadsTotal} exact`);
  }
  if (s.error !== null) {
    gate.push(`static frame did not run: ${s.error}`);
  } else {
    if (!(s.frame.p95 <= SPIKE_GATE.staticP95Ms)) gate.push(`static p95 ${s.frame.p95} ms > ${SPIKE_GATE.staticP95Ms} ms`);
    if (!(s.drawCalls <= SPIKE_GATE.drawCalls)) gate.push(`draw calls ${s.drawCalls} > ${SPIKE_GATE.drawCalls}`);
    if (!(s.main.p95 <= SPIKE_GATE.mainP95Ms)) gate.push(`main-thread p95 ${s.main.p95} ms > ${SPIKE_GATE.mainP95Ms} ms`);
  }
  if (upload.error !== null) gate.push(`upload did not run: ${upload.error}`);
  else if (!(upload.projectedRd12Seconds <= SPIKE_GATE.projectedRd12Seconds)) {
    gate.push(`projected RD12 upload ${upload.projectedRd12Seconds} s > ${SPIKE_GATE.projectedRd12Seconds} s`);
  }
  const basicPass = basic.length === 0;
  return { gatePass: basicPass && gate.length === 0, basicPass, failures: [...basic, ...gate] };
}

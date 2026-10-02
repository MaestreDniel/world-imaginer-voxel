/**
 * Cross-field lints of the parameter panel (SP2b spec §3.2). They are warnings, not validation: the
 * generator tolerates every inverted pair (a step instead of a fade, no lakes), so the draft stays valid.
 */
import { getPath } from '../../core/params/kit';
import { metaOf } from '../../core/params/meta';
import type { Params } from '../../core/params/schema';

export interface ParamLint {
  readonly paths: readonly string[];
  readonly message: string;
}

/** Leaf pairs that should satisfy lo < hi, with what the generator does when they do not. */
const ORDERED: ReadonlyArray<readonly [lo: string, hi: string, effect: string]> = [
  ['rivers.coastFadeLo', 'rivers.coastFadeHi', 'valleys switch on as a step instead of fading in from the coast'],
  ['rivers.altFadeLo', 'rivers.altFadeHi', 'channels turn into dry gorges as a step instead of fading'],
  ['lakes.offsetMin', 'lakes.offsetMax', 'lakes (almost) never form'],
];

export function paramLints(p: Params): ParamLint[] {
  const out: ParamLint[] = [];
  for (const [lo, hi, effect] of ORDERED) {
    const a = getPath(p, lo) as number;
    const b = getPath(p, hi) as number;
    if (a < b) continue;
    out.push({ paths: [lo, hi], message: `${metaOf(lo)!.label} (${a}) should be below ${metaOf(hi)!.label} (${b}): ${effect}.` });
  }
  return out;
}
